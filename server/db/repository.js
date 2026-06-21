/**
 * repository.js
 *
 * All MySQL access for the app goes through here. Keeping queries
 * centralized makes it easy to (a) see every query the app issues in
 * one place for the project report, and (b) swap implementation
 * details (e.g. add caching) without touching call sites elsewhere.
 */

const { pool } = require('./pool');

const OUTPUT_SNIPPET_MAX = 500;

function truncateOutput(output) {
  if (!output) return null;
  return output.length > OUTPUT_SNIPPET_MAX
    ? output.slice(0, OUTPUT_SNIPPET_MAX)
    : output;
}

// ---------------------------------------------------------------
// Users
// ---------------------------------------------------------------

async function createUser(username, passwordHash) {
  const [result] = await pool.query(
    `INSERT INTO users (username, password_hash) VALUES (?, ?)`,
    [username, passwordHash]
  );
  return result.insertId;
}

async function findUserByUsername(username) {
  const [rows] = await pool.query(
    `SELECT * FROM users WHERE username = ? LIMIT 1`,
    [username]
  );
  return rows[0] || null;
}

async function findUserById(userId) {
  const [rows] = await pool.query(
    `SELECT id, username, created_at, last_connected, is_active
     FROM users WHERE id = ? LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function touchLastConnected(userId) {
  await pool.query(
    `UPDATE users SET last_connected = CURRENT_TIMESTAMP WHERE id = ?`,
    [userId]
  );
}

async function updateUserPasswordByUsername(username, newPasswordHash) {
  const [result] = await pool.query(
    `UPDATE users SET password_hash = ? WHERE username = ?`,
    [newPasswordHash, username]
  );
  return result.affectedRows > 0;
}

// ---------------------------------------------------------------
// Rooms & membership
// ---------------------------------------------------------------

async function createRoom(roomName, createdByUserId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.query(
      `INSERT INTO rooms (room_name, created_by) VALUES (?, ?)`,
      [roomName, createdByUserId]
    );
    const roomId = result.insertId;

    // Creator is automatically the owning member
    await conn.query(
      `INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, 'owner')`,
      [roomId, createdByUserId]
    );

    await conn.commit();
    return roomId;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function findRoomByName(roomName) {
  const [rows] = await pool.query(
    `SELECT * FROM rooms WHERE room_name = ? AND is_archived = FALSE LIMIT 1`,
    [roomName]
  );
  return rows[0] || null;
}

async function addRoomMember(roomId, userId, role = 'member') {
  // INSERT IGNORE: rejoining an already-member room is a no-op, not an error
  await pool.query(
    `INSERT IGNORE INTO room_members (room_id, user_id, role) VALUES (?, ?, ?)`,
    [roomId, userId, role]
  );
}

async function isRoomMember(roomId, userId) {
  const [rows] = await pool.query(
    `SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ? LIMIT 1`,
    [roomId, userId]
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------
// Sessions (one row per PTY process lifetime)
// ---------------------------------------------------------------

/** Find a currently-live session for a room (ended_at IS NULL), if any. */
async function findLiveSession(roomId) {
  const [rows] = await pool.query(
    `SELECT * FROM sessions WHERE room_id = ? AND ended_at IS NULL LIMIT 1`,
    [roomId]
  );
  return rows[0] || null;
}

async function startSession(roomId, startedByUserId, containerId = null) {
  const [result] = await pool.query(
    `INSERT INTO sessions (room_id, started_by, container_id) VALUES (?, ?, ?)`,
    [roomId, startedByUserId, containerId]
  );
  return result.insertId;
}

async function endSession(sessionId) {
  await pool.query(
    `UPDATE sessions SET ended_at = CURRENT_TIMESTAMP
     WHERE id = ? AND ended_at IS NULL`,
    [sessionId]
  );
}

// ---------------------------------------------------------------
// Command logs
// ---------------------------------------------------------------

async function logCommand(sessionId, userId, command, output = null, exitCode = null) {
  const [result] = await pool.query(
    `INSERT INTO command_logs (session_id, user_id, command, output_snippet, exit_code)
     VALUES (?, ?, ?, ?, ?)`,
    [sessionId, userId, command, truncateOutput(output), exitCode]
  );
  return result.insertId;
}

/** Update exit_code/output after a command finishes (PTY output is async). */
async function completeCommandLog(logId, output, exitCode) {
  await pool.query(
    `UPDATE command_logs SET output_snippet = ?, exit_code = ? WHERE id = ?`,
    [truncateOutput(output), exitCode, logId]
  );
}

async function getRecentCommands(sessionId, limit = 50) {
  const [rows] = await pool.query(
    `SELECT cl.*, u.username
     FROM command_logs cl
     JOIN users u ON u.id = cl.user_id
     WHERE cl.session_id = ?
     ORDER BY cl.executed_at DESC
     LIMIT ?`,
    [sessionId, limit]
  );
  return rows;
}

// ---------------------------------------------------------------
// Lock history (durable audit trail; Redis remains the live source
// of truth for "who holds it right now")
// ---------------------------------------------------------------

async function recordLockAcquired(sessionId, userId) {
  const [result] = await pool.query(
    `INSERT INTO lock_history (session_id, user_id) VALUES (?, ?)`,
    [sessionId, userId]
  );
  return result.insertId;
}

async function recordLockReleased(lockHistoryId, reason = 'manual') {
  await pool.query(
    `UPDATE lock_history
     SET released_at = CURRENT_TIMESTAMP, release_reason = ?
     WHERE id = ? AND released_at IS NULL`,
    [reason, lockHistoryId]
  );
}

// ---------------------------------------------------------------
// Admin Dashboard
// ---------------------------------------------------------------

async function getAdminStats() {
  const [[{ count: users }]] = await pool.query('SELECT COUNT(*) as count FROM users');
  const [[{ count: rooms }]] = await pool.query('SELECT COUNT(*) as count FROM rooms');
  const [[{ count: sessions }]] = await pool.query('SELECT COUNT(*) as count FROM sessions');
  const [[{ count: commands }]] = await pool.query('SELECT COUNT(*) as count FROM command_logs');
  return { users, rooms, sessions, commands };
}

async function getAdminUsers() {
  const [rows] = await pool.query(
    `SELECT id, username, created_at, last_connected, is_active FROM users ORDER BY created_at DESC`
  );
  return rows;
}

async function getAdminSessions() {
  const [rows] = await pool.query(
    `SELECT s.id, r.room_name, u.username as started_by_user, s.container_id, s.started_at, s.ended_at
     FROM sessions s
     JOIN rooms r ON r.id = s.room_id
     JOIN users u ON u.id = s.started_by
     ORDER BY s.started_at DESC`
  );
  return rows;
}

async function getAdminCommands(limit = 100) {
  const [rows] = await pool.query(
    `SELECT cl.id, r.room_name, u.username, cl.command, cl.output_snippet, cl.exit_code, cl.executed_at
     FROM command_logs cl
     JOIN sessions s ON s.id = cl.session_id
     JOIN rooms r ON r.id = s.room_id
     JOIN users u ON u.id = cl.user_id
     ORDER BY cl.executed_at DESC
     LIMIT ?`,
    [limit]
  );
  return rows;
}

module.exports = {
  // users
  createUser,
  findUserByUsername,
  findUserById,
  touchLastConnected,
  updateUserPasswordByUsername,
  // rooms
  createRoom,
  findRoomByName,
  addRoomMember,
  isRoomMember,
  // sessions
  findLiveSession,
  startSession,
  endSession,
  // command logs
  logCommand,
  completeCommandLog,
  getRecentCommands,
  // lock history
  recordLockAcquired,
  recordLockReleased,
  // admin
  getAdminStats,
  getAdminUsers,
  getAdminSessions,
  getAdminCommands,
};
