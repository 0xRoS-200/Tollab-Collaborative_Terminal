/**
 * wsClient.js
 *
 * Thin EventEmitter wrapper around the raw WebSocket connection.
 * The TUI (ui.js) subscribes to these events instead of touching
 * the WebSocket directly, keeping rendering logic separate from
 * protocol logic.
 */

const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { ClientMessage, ServerMessage } = require('./protocol');

const HEARTBEAT_INTERVAL_MS = 10000;

class WsClient extends EventEmitter {
  constructor(wsBaseUrl, token) {
    super();
    this.wsBaseUrl = wsBaseUrl;
    this.token = token;
    this.ws = null;
    this.heartbeatTimer = null;
    this.holdingControl = false;
  }

  connect() {
    try {
      const url = `${this.wsBaseUrl}?token=${encodeURIComponent(this.token)}`;
      this.ws = new WebSocket(url);

      this.ws.on('open', () => this.emit('connected'));

      this.ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        this._handleServerMessage(msg);
      });

      this.ws.on('close', () => {
        this._stopHeartbeat();
        this.emit('disconnected');
      });

      this.ws.on('error', (err) => this.emit('socket_error', err));
    } catch (err) {
      process.nextTick(() => {
        this.emit('socket_error', err);
      });
    }
  }

  _handleServerMessage(msg) {
    switch (msg.type) {
      case ServerMessage.JOINED:
        this.emit('joined', msg);
        this._startHeartbeat();
        break;
      case ServerMessage.OUTPUT:
        this.emit('output', msg.data);
        break;
      case ServerMessage.CONTROL_GRANTED:
        this.holdingControl = true;
        this.emit('control_granted');
        break;
      case ServerMessage.CONTROL_DENIED:
        this.holdingControl = false;
        this.emit('control_denied', msg.position);
        break;
      case ServerMessage.CONTROL_CHANGED:
        if (msg.holderUsername === null) this.holdingControl = false;
        this.emit('control_changed', msg.holderUsername);
        break;
      case ServerMessage.QUEUE_UPDATE:
        this.emit('queue_update', msg.queue);
        break;
      case ServerMessage.USER_JOINED:
        this.emit('user_joined', msg.username);
        break;
      case ServerMessage.USER_LEFT:
        this.emit('user_left', msg.username);
        break;
      case ServerMessage.SESSION_ENDED:
        this.emit('session_ended', msg);
        break;
      case ServerMessage.ERROR:
        this.emit('server_error', msg.message);
        break;
      default:
        // Unknown message type -- ignore rather than crash the TUI
        break;
    }
  }

  joinRoom(roomName) {
    this._send({ type: ClientMessage.JOIN_ROOM, roomName });
  }

  requestControl() {
    this._send({ type: ClientMessage.REQUEST_CONTROL });
  }

  releaseControl() {
    this._send({ type: ClientMessage.RELEASE_CONTROL });
  }

  sendInput(data) {
    if (!this.holdingControl) return; // client-side guard; server enforces too
    this._send({ type: ClientMessage.INPUT, data });
  }

  resize(cols, rows) {
    this._send({ type: ClientMessage.RESIZE, cols, rows });
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this._send({ type: ClientMessage.HEARTBEAT });
    }, HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  close() {
    this._stopHeartbeat();
    if (this.ws) this.ws.close();
  }
}

module.exports = { WsClient };
