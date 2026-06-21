/**
 * protocol.js
 *
 * Shared WS message type constants. Both server and CLI client import
 * this so message names can't drift out of sync between the two.
 *
 * Message envelope shape (always JSON-encoded over the wire):
 *   { type: string, ...payload }
 */

const ClientMessage = Object.freeze({
  JOIN_ROOM: 'join_room',          // { roomName }
  REQUEST_CONTROL: 'request_control', // {}
  RELEASE_CONTROL: 'release_control', // {}
  INPUT: 'input',                  // { data } -- raw keystrokes, only honored if lock held
  RESIZE: 'resize',                // { cols, rows }
  HEARTBEAT: 'heartbeat',          // {} -- keep-alive + lock TTL extension
});

const ServerMessage = Object.freeze({
  JOINED: 'joined',                // { roomId, sessionId, scrollback, holder, queue }
  OUTPUT: 'output',                // { data } -- raw PTY output to render
  CONTROL_GRANTED: 'control_granted',   // { token }  (token kept server-side per-connection, not sent to client in plaintext use -- see note in wsServer.js)
  CONTROL_DENIED: 'control_denied',     // { position } -- queued
  CONTROL_CHANGED: 'control_changed',   // { holderUsername | null }
  QUEUE_UPDATE: 'queue_update',    // { queue: [usernames] }
  USER_JOINED: 'user_joined',      // { username }
  USER_LEFT: 'user_left',          // { username }
  ERROR: 'error',                  // { message }
  SESSION_ENDED: 'session_ended',  // { exitCode, signal }
});

module.exports = { ClientMessage, ServerMessage };
