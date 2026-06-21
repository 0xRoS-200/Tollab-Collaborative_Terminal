/**
 * wsServer.js
 *
 * The integration layer. Wires together:
 *  - auth.js          (verify JWT on connect)
 *  - db/repository.js (rooms, sessions, command logs, lock history)
 *  - redis/lockManager.js (who controls the shared terminal right now)
 *  - pty/ptyManager.js + containerManager.js (the actual shared shell)
 *  - ws/roomRegistry.js (which sockets belong to which room)
 *
 * CONCURRENCY / LOCKING FLOW (the core DBMS-relevant logic):
 *  1. Client sends REQUEST_CONTROL.
 *  2. We call lockManager.acquire(roomId, userId).
 *  3a. If granted: store the token on this connection (server-side
 *      only -- the client never needs to see the raw token, it just
 *      needs to know "I can type now"). Record lock_history row.
 *      Broadcast CONTROL_CHANGED to everyone in the room.
 *  3b. If denied: tell this client their queue position. They'll get
 *      CONTROL_CHANGED later when promoted.
 *  4. Client sends INPUT. We check this connection's stored token
 *      against what they're allowed -- but we DON'T re-validate against
 *      Redis on every keystroke (too slow); instead we trust the
 *      connection's local "amIHolder" flag, which is only set true
 *      exactly when we received CONTROL_GRANTED, and cleared on
 *      release/expiry. Periodic heartbeats keep Redis's TTL in sync
 *      with this local flag's truth.
 *  5. On RELEASE_CONTROL or disconnect: lockManager.release(...) or
 *      handleDisconnect(...), which may atomically promote the next
 *      queued user -- we push CONTROL_GRANTED to THAT user's socket
 *      using the promotedToken returned by lockManager.
 */

const { WebSocketServer } = require('ws');
const { verifyToken } = require('../auth');
const db = require('../db');
const { LockManager } = require('../redis/lockManager');
const { PtyManager } = require('../pty/ptyManager');
const { startContainer, containerExists, containerName } = require('../pty/containerManager');
const { RoomRegistry } = require('./roomRegistry');
const { ClientMessage, ServerMessage } = require('./protocol');

const HEARTBEAT_INTERVAL_MS = 10000;

function getExecutableName(cmdStr) {
  const parts = cmdStr.trim().split(/\s+/);
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (!part) {
      i++;
      continue;
    }
    if (part.includes('=')) {
      i++;
      continue;
    }
    if (['time', 'exec', 'nohup', 'xargs'].includes(part)) {
      i++;
      continue;
    }
    if (part === 'sudo') {
      i++;
      // Skip sudo options and their arguments
      while (i < parts.length) {
        const p = parts[i];
        if (p.startsWith('-')) {
          if (['-u', '-g', '-p', '-U', '-C', '-r', '-t'].includes(p)) {
            i += 2;
          } else {
            i++;
          }
        } else {
          break; // This is the command
        }
      }
      continue;
    }
    // Found the executable
    const base = part.split('/').pop().split('\\').pop();
    return base;
  }
  return '';
}

function createWsServer(httpServer, redisClient) {
  const wss = new WebSocketServer({ server: httpServer });
  const lockManager = new LockManager(redisClient);
  const ptyManager = new PtyManager();
  const registry = new RoomRegistry();

  // roomId -> sessionId (MySQL), kept here since it's needed by
  // multiple handlers and is cheap to cache per live room.
  const activeSessions = new Map();

  function send(ws, type, payload = {}) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type, ...payload }));
    }
  }

  async function handleJoin(ws, msg) {
    const meta = registry.getMeta(ws);
    const { roomName } = msg;

    if (!roomName || typeof roomName !== 'string') {
      return send(ws, ServerMessage.ERROR, { message: 'roomName is required' });
    }

    let room = await db.findRoomByName(roomName);
    if (!room) {
      const roomId = await db.createRoom(roomName, meta.userId);
      room = { id: roomId, room_name: roomName };
    } else {
      await db.addRoomMember(room.id, meta.userId);
    }

    const roomId = String(room.id);

    // Ensure a live session + container + PTY exist for this room.
    let sessionRow = await db.findLiveSession(room.id);
    if (!sessionRow) {
      const exists = await containerExists(room.id).catch(() => false);
      let cName;
      if (!exists) {
        const { containerName: cn } = await startContainer(room.id);
        cName = cn;
      } else {
        cName = containerName(room.id);
      }
      const sessionId = await db.startSession(room.id, meta.userId, cName);
      sessionRow = { id: sessionId };
      ptyManager.spawn(roomId, cName);
    } else if (!ptyManager.isLive(roomId)) {
      // DB thinks session is live but our process restarted -- respawn PTY
      // attached to the same (still-running, --rm only removes on stop) container.
      ptyManager.spawn(roomId, containerName(room.id));
    }

    activeSessions.set(roomId, sessionRow.id);
    registry.addConnection(roomId, ws, { userId: meta.userId, username: meta.username });

    // Subscribe this socket to PTY output for this room
    const unsubscribe = ptyManager.subscribe(roomId, (data, exitInfo) => {
      if (data !== null) {
        send(ws, ServerMessage.OUTPUT, { data });
      } else {
        send(ws, ServerMessage.SESSION_ENDED, exitInfo);
      }
    });
    ws._unsubscribePty = unsubscribe;
    ws._roomId = roomId;

    const holder = await lockManager.getHolder(roomId);
    const queue = await lockManager.getQueue(roomId);

    // Get list of all currently connected usernames in this room
    const activeUsers = [...registry.getConnections(roomId)]
      .map((s) => registry.getMeta(s)?.username)
      .filter(Boolean);

    send(ws, ServerMessage.JOINED, {
      roomId,
      sessionId: sessionRow.id,
      scrollback: ptyManager.getBuffer(roomId),
      holder,
      queue,
      users: activeUsers,
    });

    registry.broadcast(roomId, { type: ServerMessage.USER_JOINED, username: meta.username }, { exclude: ws });
  }

  async function handleRequestControl(ws) {
    const meta = registry.getMeta(ws);
    if (!meta) return;
    const { roomId, userId, username } = meta;

    const result = await lockManager.acquire(roomId, userId, { skipQueue: true });
    const sessionId = activeSessions.get(roomId);

    if (result.granted) {
      registry.setLockToken(ws, result.token);
      const lockHistoryId = await db.recordLockAcquired(sessionId, userId);
      registry.setLockToken(ws, result.token, lockHistoryId);

      send(ws, ServerMessage.CONTROL_GRANTED, {});
      registry.broadcast(roomId, { type: ServerMessage.CONTROL_CHANGED, holderUsername: username });
    } else {
      send(ws, ServerMessage.CONTROL_DENIED, {});
    }
  }

  async function releaseAndPromote(ws, reason = 'manual') {
    const meta = registry.getMeta(ws);
    if (!meta || !meta.lockToken) return;
    const { roomId, lockToken, lockHistoryId } = meta;

    const result = await lockManager.release(roomId, lockToken);

    if (lockHistoryId) {
      await db.recordLockReleased(lockHistoryId, reason).catch(() => {});
    }
    registry.setLockToken(ws, null, null);

    if (result.released && result.promoted) {
      // result.promoted is a userId as stored in Redis (string). Our
      // registry stores userId as whatever type came out of the JWT
      // (Number, from jsonwebtoken's `sub` claim as set in auth.js).
      // Compare as strings to avoid type mismatches.
      const targetWs = [...registry.getConnections(roomId)].find(
        (s) => String(registry.getMeta(s)?.userId) === String(result.promoted)
      );
      if (targetWs) {
        registry.setLockToken(targetWs, result.promotedToken);
        const promotedMeta = registry.getMeta(targetWs);
        const sessionId = activeSessions.get(roomId);
        const lockHistoryId2 = await db.recordLockAcquired(sessionId, promotedMeta.userId);
        registry.setLockToken(targetWs, result.promotedToken, lockHistoryId2);

        send(targetWs, ServerMessage.CONTROL_GRANTED, {});
        registry.broadcast(roomId, {
          type: ServerMessage.CONTROL_CHANGED,
          holderUsername: promotedMeta.username,
        });
      }
    } else {
      registry.broadcast(roomId, { type: ServerMessage.CONTROL_CHANGED, holderUsername: null });
    }

    const queue = await lockManager.getQueue(roomId);
    registry.broadcast(roomId, { type: ServerMessage.QUEUE_UPDATE, queue });
  }

  async function handleInput(ws, msg) {
    const meta = registry.getMeta(ws);
    if (!meta || !meta.lockToken) {
      return send(ws, ServerMessage.ERROR, { message: 'You do not hold control of this terminal' });
    }
    const { roomId, userId } = meta;
    const sessionId = activeSessions.get(roomId);

    // Log only "complete" commands (heuristic: input ending in newline)
    // to avoid spamming a DB row per keystroke.
    if (typeof msg.data === 'string' && msg.data.includes('\n')) {
      const command = msg.data.replace(/\n+$/, '');
      if (command.trim().length > 0) {
        const exe = getExecutableName(command);
        const BLOCKED_COMMANDS = ['nano', 'vi', 'vim', 'emacs', 'top', 'htop', 'less', 'more', 'man', 'ssh', 'ftp', 'sftp', 'telnet', 'gdb'];
        if (BLOCKED_COMMANDS.includes(exe)) {
          return send(ws, ServerMessage.ERROR, {
            message: `Interactive command "${exe}" is not supported in this line-buffered terminal session.`
          });
        }

        db.logCommand(sessionId, userId, command).catch((err) => {
          console.error('Failed to log command:', err);
        });
      }
    }

    ptyManager.write(roomId, msg.data);
  }

  async function handleResize(ws, msg) {
    const meta = registry.getMeta(ws);
    if (!meta) return;
    ptyManager.resize(meta.roomId, msg.cols, msg.rows);
  }

  async function handleHeartbeat(ws) {
    const meta = registry.getMeta(ws);
    if (!meta || !meta.lockToken) return;
    const ok = await lockManager.heartbeat(meta.roomId, meta.lockToken);
    if (!ok) {
      // Our token expired/was stolen server-side somehow -- clear local state
      registry.setLockToken(ws, null, null);
      send(ws, ServerMessage.CONTROL_CHANGED, { holderUsername: null });
    }
  }

  async function handleDisconnect(ws) {
    const meta = registry.removeConnection(ws);
    if (ws._unsubscribePty) ws._unsubscribePty();
    if (!meta) return;

    const { roomId, userId, username, lockToken } = meta;

    if (lockToken) {
      await releaseAndPromote(ws, 'disconnect');
    } else {
      await lockManager.leaveQueue(roomId, userId);
    }

    registry.broadcast(roomId, { type: ServerMessage.USER_LEFT, username });

    if (registry.roomIsEmpty(roomId)) {
      // Last user left -- end the MySQL session record. We deliberately
      // do NOT kill the PTY/container immediately (a brief network blip
      // shouldn't nuke the shell); a separate reaper/cron can clean up
      // containers idle beyond some threshold. For this project scope,
      // ending the session row is the meaningful "ephemeral session,
      // persistent room" boundary.
      const sessionId = activeSessions.get(roomId);
      if (sessionId) {
        await db.endSession(sessionId);
        activeSessions.delete(roomId);
      }
    }
  }

  wss.on('connection', async (ws, req) => {
    // --- Auth handshake: expect ?token=<jwt> on the WS URL ---
    let user;
    try {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      const decoded = verifyToken(token);
      user = { userId: decoded.sub, username: decoded.username };
    } catch (err) {
      send(ws, ServerMessage.ERROR, { message: 'Authentication failed' });
      ws.close();
      return;
    }

    await db.touchLastConnected(user.userId);

    // Stash pre-join identity on a temp WeakMap entry via roomRegistry's
    // connMeta isn't populated until JOIN_ROOM (we don't know the room
    // yet) -- so we attach identity directly to the ws object meanwhile.
    ws._pendingUser = user;

    const heartbeatTimer = setInterval(() => {
      handleHeartbeat(ws).catch((err) => console.error('Heartbeat error:', err));
    }, HEARTBEAT_INTERVAL_MS);

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, ServerMessage.ERROR, { message: 'Invalid JSON' });
      }

      try {
        switch (msg.type) {
          case ClientMessage.JOIN_ROOM: {
            // Bridge pending identity into registry on first join
            const pending = ws._pendingUser;
            registry.connMeta.set(ws, {
              roomId: null,
              userId: pending.userId,
              username: pending.username,
              lockToken: null,
              lockHistoryId: null,
            });
            await handleJoin(ws, msg);
            break;
          }
          case ClientMessage.REQUEST_CONTROL:
            await handleRequestControl(ws);
            break;
          case ClientMessage.RELEASE_CONTROL:
            await releaseAndPromote(ws, 'manual');
            break;
          case ClientMessage.INPUT:
            await handleInput(ws, msg);
            break;
          case ClientMessage.RESIZE:
            await handleResize(ws, msg);
            break;
          case ClientMessage.HEARTBEAT:
            await handleHeartbeat(ws);
            break;
          default:
            send(ws, ServerMessage.ERROR, { message: `Unknown message type: ${msg.type}` });
        }
      } catch (err) {
        console.error('Error handling message:', err);
        send(ws, ServerMessage.ERROR, { message: 'Internal server error' });
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeatTimer);
      handleDisconnect(ws).catch((err) => console.error('Disconnect cleanup error:', err));
    });
  });

  return wss;
}

module.exports = { createWsServer };
