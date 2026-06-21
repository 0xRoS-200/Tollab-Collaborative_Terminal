/**
 * lockManager.js
 *
 * Implements terminal "control lock" semantics using Redis.
 *
 * Why Redis and not just an in-memory JS object?
 *  - If we ever run multiple server instances (horizontal scaling),
 *    an in-memory lock breaks instantly. Redis gives us a single
 *    source of truth shared across processes/instances.
 *  - Redis SET with NX + PX gives us atomic "acquire-if-free + auto-expire"
 *    in a single round trip, which prevents race conditions between
 *    "check if locked" and "set lock" (classic TOCTOU bug).
 *
 * Concurrency model:
 *  - Only ONE user may hold the lock for a given room at a time.
 *  - The lock VALUE is always an opaque token "<userId>:<uuid>". The
 *    userId is recoverable by splitting on ":" -- this means we don't
 *    need a second Redis key just to track "who currently holds it",
 *    so getHolder() is a single GET away.
 *  - Lock auto-expires (TTL) so a crashed/disconnected client doesn't
 *    permanently freeze the terminal for everyone else.
 *  - A waiting queue (Redis LIST) holds user IDs requesting control,
 *    served FIFO once the lock is released. When promoted, a waiter
 *    is issued a FRESH token (generated in JS) so they can later
 *    release/heartbeat their own lock -- the caller (WS layer) MUST
 *    push this token to that user's connection.
 */

const { randomUUID } = require('crypto');

function makeToken(userId) {
  return `${userId}:${randomUUID()}`;
}

function userIdFromToken(token) {
  if (!token) return null;
  const idx = token.indexOf(':');
  return idx === -1 ? token : token.slice(0, idx);
}

// ---- Lua scripts for atomic check-then-act operations ----

// Release lock ONLY if the caller is the current holder.
// Prevents user A from releasing user B's lock (e.g. after A's stale
// request arrives late over a slow connection).
const RELEASE_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    redis.call("DEL", KEYS[1])
    return 1
  else
    return 0
  end
`;

// Extend (heartbeat) the lock TTL ONLY if the caller still holds it.
// Used so an actively-typing user doesn't lose the lock mid-session.
const EXTEND_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    redis.call("PEXPIRE", KEYS[1], ARGV[2])
    return 1
  else
    return 0
  end
`;

// Pop the next waiting user and atomically hand them the lock.
// ARGV[1] = TTL ms, ARGV[2] = pre-generated token for the promoted user
// (generated in JS, not Lua, since Lua's RNG isn't cryptographically
// safe/portable). Returns the promoted userId, or false if queue empty.
const PROMOTE_NEXT_SCRIPT = `
  local nextUser = redis.call("LPOP", KEYS[2])
  if nextUser then
    redis.call("SET", KEYS[1], ARGV[2], "PX", ARGV[1])
    return nextUser
  else
    return false
  end
`;

const LOCK_TTL_MS = 30000; // 30s; client must heartbeat to keep holding it

class LockManager {
  /**
   * @param {import('ioredis')} redis - connected ioredis client
   */
  constructor(redis) {
    this.redis = redis;
  }

  _lockKey(roomId) {
    return `lock:${roomId}`;
  }

  _queueKey(roomId) {
    return `queue:${roomId}`;
  }

  /**
   * Attempt to acquire the lock immediately.
   * If already held by someone else, the caller is appended to the
   * waiting queue instead (unless skipQueue is true).
   *
   * @returns {Promise<{ granted: boolean, token?: string, position?: number }>}
   */
  async acquire(roomId, userId, { skipQueue = false } = {}) {
    const token = makeToken(userId);
    const lockKey = this._lockKey(roomId);

    // If the requester already holds the lock, return granted: true with the existing token
    const currentToken = await this.redis.get(lockKey);
    if (currentToken) {
      const holderId = userIdFromToken(currentToken);
      if (String(holderId) === String(userId)) {
        return { granted: true, token: currentToken };
      }
    }

    const result = await this.redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX');

    if (result === 'OK') {
      return { granted: true, token };
    }

    if (skipQueue) {
      return { granted: false };
    }

    // Lock busy -> join the FIFO queue (dedup: don't add if already queued)
    const queueKey = this._queueKey(roomId);
    const existing = await this.redis.lpos(queueKey, userId);
    if (existing === null) {
      await this.redis.rpush(queueKey, userId);
    }
    const position = await this.redis.lpos(queueKey, userId);
    return { granted: false, position: (position ?? 0) + 1 };
  }

  /**
   * Release the lock. Only succeeds if `token` matches the current
   * holder's token (prevents releasing someone else's lock).
   * On success, automatically promotes the next user in the queue
   * and issues them a fresh token.
   *
   * IMPORTANT: if `promoted` is present in the result, the caller
   * (WS layer) is responsible for delivering `promotedToken` to that
   * user's connection so they can later release/heartbeat their lock.
   *
   * @returns {Promise<{ released: boolean, promoted?: string, promotedToken?: string }>}
   */
  async release(roomId, token) {
    const lockKey = this._lockKey(roomId);
    const released = await this.redis.eval(RELEASE_SCRIPT, 1, lockKey, token);

    if (released !== 1) {
      return { released: false };
    }

    // Promote next waiter, if any
    const queueKey = this._queueKey(roomId);

    // Peek first so we know the userId to mint a token for; the Lua
    // script does the actual atomic LPOP + SET.
    const candidateUserId = await this.redis.lindex(queueKey, 0);
    if (!candidateUserId) {
      return { released: true };
    }

    const promotedToken = makeToken(candidateUserId);
    const promotedUserId = await this.redis.eval(
      PROMOTE_NEXT_SCRIPT,
      2,
      lockKey,
      queueKey,
      LOCK_TTL_MS,
      promotedToken
    );

    if (promotedUserId) {
      return { released: true, promoted: promotedUserId, promotedToken };
    }

    return { released: true };
  }

  /**
   * Heartbeat: extend TTL while user is actively typing.
   * Call this periodically (e.g. every 10s) from the client while
   * the user holds the lock, so a long edit session doesn't expire mid-use.
   */
  async heartbeat(roomId, token) {
    const lockKey = this._lockKey(roomId);
    const ok = await this.redis.eval(EXTEND_SCRIPT, 1, lockKey, token, LOCK_TTL_MS);
    return ok === 1;
  }

  /** Who currently holds the lock (userId), or null if free. */
  async getHolder(roomId) {
    const token = await this.redis.get(this._lockKey(roomId));
    return userIdFromToken(token);
  }

  /** Current FIFO queue of userIds waiting for control. */
  async getQueue(roomId) {
    return this.redis.lrange(this._queueKey(roomId), 0, -1);
  }

  /** Remove a user from the waiting queue (e.g. on disconnect). */
  async leaveQueue(roomId, userId) {
    await this.redis.lrem(this._queueKey(roomId), 0, userId);
  }

  /**
   * Call when a user disconnects: if they hold the lock, force-release
   * it immediately (don't make others wait for TTL expiry) and remove
   * them from the queue if they were waiting.
   */
  async handleDisconnect(roomId, userId, token) {
    await this.leaveQueue(roomId, userId);
    if (token) {
      return this.release(roomId, token);
    }
    return { released: false };
  }
}

module.exports = { LockManager, LOCK_TTL_MS };
