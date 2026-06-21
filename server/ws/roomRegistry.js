/**
 * roomRegistry.js
 *
 * Tracks which live WebSocket connections belong to which room, and
 * each connection's current lock token (if they hold control).
 *
 * This is intentionally separate from PtyManager (which owns the
 * actual shell process) and from LockManager (which owns lock state
 * in Redis) -- this registry's only job is "which sockets do I need
 * to broadcast to for room X", kept in-process since WS connections
 * themselves are inherently tied to this one server instance.
 */

class RoomRegistry {
  constructor() {
    /** @type {Map<string, Set<import('ws').WebSocket>>} */
    this.roomConnections = new Map();
    /** @type {WeakMap<import('ws').WebSocket, { roomId: string, userId: number, username: string, lockToken: string|null, lockHistoryId: number|null }>} */
    this.connMeta = new WeakMap();
  }

  addConnection(roomId, ws, { userId, username }) {
    if (!this.roomConnections.has(roomId)) {
      this.roomConnections.set(roomId, new Set());
    }
    this.roomConnections.get(roomId).add(ws);
    this.connMeta.set(ws, { roomId, userId, username, lockToken: null, lockHistoryId: null });
  }

  removeConnection(ws) {
    const meta = this.connMeta.get(ws);
    if (!meta) return null;

    const set = this.roomConnections.get(meta.roomId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        this.roomConnections.delete(meta.roomId);
      }
    }
    this.connMeta.delete(ws);
    return meta;
  }

  getMeta(ws) {
    return this.connMeta.get(ws) || null;
  }

  setLockToken(ws, token, lockHistoryId = null) {
    const meta = this.connMeta.get(ws);
    if (meta) {
      meta.lockToken = token;
      meta.lockHistoryId = lockHistoryId;
    }
  }

  getConnections(roomId) {
    return this.roomConnections.get(roomId) || new Set();
  }

  roomIsEmpty(roomId) {
    const set = this.roomConnections.get(roomId);
    return !set || set.size === 0;
  }

  /** Find the live connection (if any) for a given userId within a room. */
  findConnectionByUserId(roomId, userId) {
    const set = this.roomConnections.get(roomId);
    if (!set) return null;
    for (const ws of set) {
      const meta = this.connMeta.get(ws);
      if (meta && meta.userId === userId) return ws;
    }
    return null;
  }

  broadcast(roomId, messageObj, { exclude } = {}) {
    const payload = JSON.stringify(messageObj);
    for (const ws of this.getConnections(roomId)) {
      if (ws === exclude) continue;
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  }
}

module.exports = { RoomRegistry };
