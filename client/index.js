#!/usr/bin/env node
/**
 * index.js (client entry point)
 *
 * Flow:
 *  1. Show login/register form (authPrompt.js) -> get JWT + room name
 *  2. Connect WebSocket (wsClient.js), join the room
 *  3. Show the main TUI (ui.js): shared output pane + status bar
 *  4. Wire input: Ctrl+R requests control, Ctrl+L releases it,
 *     plain typed lines are sent to the PTY only while holding control
 */

require('dotenv').config();
const blessed = require('blessed');

// Global patch to prevent blessed Textbox/Textarea `done is not a function` crash on Enter/submit
if (blessed.textarea && blessed.textarea.prototype) {
  Object.defineProperty(blessed.textarea.prototype, '_done', {
    get() { return this._blessedDone || (() => {}); },
    set(val) { this._blessedDone = val; },
    configurable: true,
    enumerable: true
  });
}

const fs = require('fs');
const path = require('path');
const debugLogPath = path.join(__dirname, 'debug.log');

// Clear the debug log on client startup
try {
  fs.writeFileSync(debugLogPath, `[${new Date().toISOString()}] Debug log initialized\n`);
} catch (e) {}

function logDebug(msg) {
  try {
    fs.appendFileSync(debugLogPath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (err) {}
}

const { promptAuth } = require('./lib/authPrompt');
const { WsClient } = require('./lib/wsClient');
const { createUi } = require('./lib/ui');

function normalizeUrls(apiUrl, wsUrl) {
  let normalizedApi = apiUrl ? apiUrl.trim() : '';
  let normalizedWs = wsUrl ? wsUrl.trim() : '';

  if (normalizedApi) {
    if (!/^https?:\/\//i.test(normalizedApi)) {
      if (/^wss?:\/\//i.test(normalizedApi)) {
        normalizedApi = normalizedApi.replace(/^ws/i, 'http');
      } else {
        normalizedApi = 'http://' + normalizedApi;
      }
    }
  } else {
    normalizedApi = 'http://localhost:3000';
  }

  if (normalizedWs) {
    if (!/^wss?:\/\//i.test(normalizedWs)) {
      if (/^https?:\/\//i.test(normalizedWs)) {
        normalizedWs = normalizedWs.replace(/^http/i, 'ws');
      } else {
        normalizedWs = 'ws://' + normalizedWs;
      }
    }
  } else {
    // If API URL is provided, derive WS URL from it
    if (apiUrl) {
      if (/^https:\/\//i.test(normalizedApi)) {
        normalizedWs = normalizedApi.replace(/^https/i, 'wss');
      } else {
        normalizedWs = normalizedApi.replace(/^http/i, 'ws');
      }
    } else {
      normalizedWs = 'ws://localhost:3000';
    }
  }

  return { normalizedApi, normalizedWs };
}

const { normalizedApi: API_BASE_URL, normalizedWs: WS_BASE_URL } = normalizeUrls(
  process.env.API_BASE_URL,
  process.env.WS_BASE_URL
);

async function main() {
  let auth;
  try {
    auth = await promptAuth(API_BASE_URL);
  } catch {
    console.log('Goodbye!');
    process.exit(0);
  }

  const { token, username, roomName } = auth;
  const ui = createUi();
  const ws = new WsClient(WS_BASE_URL, token);

  let idleTimer = null;
  const IDLE_TIMEOUT_MS = 20000; // 20 seconds of inactivity

  function resetIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    if (ui.isHoldingControl()) {
      idleTimer = setTimeout(() => {
        ws.releaseControl();
        ui.showMessage('Released control due to inactivity.', 'yellow');
        ui.inputBar.setValue('');
        ui.screen.focused = null;
        ui.screen.render();
      }, IDLE_TIMEOUT_MS);
    }
  }

  function stopIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  ws.on('connected', () => {
    logDebug('WebSocket connected');
    ui.showMessage('Connected. Joining room...', 'green');
    ws.joinRoom(roomName);
  });

  ws.on('joined', (msg) => {
    logDebug('Joined room: ' + roomName + ', msg: ' + JSON.stringify(msg));
    ui.setRoom(roomName, username);
    ui.showMessage(`Joined room "${roomName}".`, 'green');
    if (msg.scrollback) {
      ui.appendOutput(msg.scrollback);
    }
    if (msg.holder) ui.setHolder(msg.holder);
    if (msg.queue) ui.setQueue(msg.queue);
    if (msg.users) ui.updateUsersList(msg.users);
    ui.showMessage('Press Ctrl+R to request control of the terminal.', 'cyan');
  });

  ws.on('output', (data) => ui.appendOutput(data));

  ws.on('control_granted', () => {
    logDebug('Control granted to me');
    ui.setHoldingControl(true);
    ui.showMessage('You now have control. Start typing!', 'green');
    resetIdleTimer();
    setTimeout(() => {
      ui.inputBar.focus();
      ui.screen.render();
    }, 0);
  });

  ws.on('control_denied', (position) => {
    ui.setHoldingControl(false);
    ui.showMessage('Terminal busy. Control cannot be acquired.', 'yellow');
    stopIdleTimer();
  });

  ws.on('control_changed', (holderUsername) => {
    logDebug('Control changed to: ' + holderUsername);
    ui.setHolder(holderUsername);
    ws.holdingControl = (holderUsername === username);
    if (holderUsername && holderUsername !== username) {
      ui.showMessage(`${holderUsername} now has control.`, 'cyan');
      stopIdleTimer();
    } else if (!holderUsername) {
      ui.showMessage('Terminal is now free.', 'cyan');
      stopIdleTimer();
    }
  });

  ws.on('queue_update', (queue) => ui.setQueue(queue));

  ws.on('user_joined', (u) => {
    ui.showMessage(`${u} joined the room.`, 'blue');
    ui.addUser(u);
  });
  ws.on('user_left', (u) => {
    ui.showMessage(`${u} left the room.`, 'blue');
    ui.removeUser(u);
  });

  ws.on('session_ended', ({ exitCode, signal }) => {
    ui.showMessage(`Shell session ended (exit ${exitCode}, signal ${signal}). Exiting client...`, 'red');
    setTimeout(() => {
      ws.close();
      process.exit(0);
    }, 1000);
  });

  ws.on('server_error', (message) => ui.showMessage(`Error: ${message}`, 'red'));

  ws.on('disconnected', () => {
    ui.showMessage('Disconnected from server.', 'red');
  });

  ws.on('socket_error', (err) => {
    ui.showMessage(`Connection error: ${err.message}`, 'red');
  });

  // --- Input handling ---
  ui.inputBar.on('submit', (value) => {
    logDebug('Input submit value: "' + value + '", holdingControl: ' + ui.isHoldingControl());
    if (ui.isHoldingControl()) {
      ws.sendInput(value + '\n');
      resetIdleTimer();
    }
    ui.inputBar.clearValue();
    setTimeout(() => {
      ui.inputBar.focus();
      ui.screen.render();
    }, 0);
  });

  // Clear the input box value on cancel (e.g. Escape key)
  ui.inputBar.on('cancel', () => {
    logDebug('Input cancel/blur');
    ui.inputBar.clearValue();
    ui.screen.render();
  });

  // Intercept Ctrl+L to release control while typing in the input box
  ui.inputBar.on('keypress', (ch, key) => {
    if ((key && key.ctrl && key.name === 'l') || ch === '\f') {
      ws.releaseControl();
      ui.showMessage('You released control.', 'cyan');
      ui.inputBar.setValue('');
      ui.screen.focused = null;
      ui.screen.render();
      stopIdleTimer();
      return false; // prevent character input
    }
  });

  // Automatically focus input bar on printable keys if holding control but blurred
  ui.screen.on('keypress', (ch, key) => {
    if (ui.isHoldingControl()) {
      resetIdleTimer();
    }

    if (ui.isHoldingControl() && ui.screen.focused !== ui.inputBar) {
      if (key && (key.ctrl || key.meta)) {
        return;
      }
      const isEnter = (key && (key.name === 'enter' || key.name === 'return')) || ch === '\r' || ch === '\n';
      const isPrintable = ch && !/^[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]$/.test(ch);

      const ignoreKeys = ['escape', 'tab', 'pageup', 'pagedown', 'up', 'down', 'left', 'right'];
      if (key && ignoreKeys.includes(key.name)) {
        return;
      }

      if (isEnter || isPrintable) {
        ui.inputBar.focus();
        if (isPrintable) {
          ui.inputBar.setValue(ui.inputBar.getValue() + ch);
        }
        ui.screen.render();
      }
    } else if (!ui.isHoldingControl()) {
      if (key && (key.ctrl || key.meta)) {
        return;
      }
      const isEnter = (key && (key.name === 'enter' || key.name === 'return')) || ch === '\r' || ch === '\n';
      const isPrintable = ch && !/^[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]$/.test(ch);

      const ignoreKeys = ['escape', 'tab', 'pageup', 'pagedown', 'up', 'down', 'left', 'right'];
      if (key && ignoreKeys.includes(key.name)) {
        return;
      }

      if (isEnter || isPrintable) {
        ws.requestControl();
        ui.showMessage('Requesting control...', 'cyan');
      }
    }
  });

  ui.screen.key(['C-r'], () => {
    if (ui.isHoldingControl()) {
      ui.inputBar.focus();
      ui.screen.render();
    } else {
      ws.requestControl();
    }
  });

  ui.screen.key(['C-l'], () => {
    ws.releaseControl();
    ui.showMessage('You released control.', 'cyan');
    stopIdleTimer();
  });

  // Ctrl+C is used solely for basic Linux terminal SIGINT operations when holding control.
  // To quit the client, type the "exit" command or terminate the shell session.
  ui.screen.key(['C-c'], () => {
    if (ui.isHoldingControl()) {
      ws.sendInput('\x03');
      resetIdleTimer();
      ui.inputBar.setValue('');
      ui.screen.render();
    } else {
      ui.showMessage('Ctrl+C is only forwarded when holding control. Type "exit" to quit.', 'yellow');
    }
  });

  ui.screen.key(['C-d'], () => {
    if (ui.isHoldingControl()) {
      ws.sendInput('\x04');
      resetIdleTimer();
      ui.inputBar.setValue('');
      ui.screen.render();
    }
  });

  ws.connect();
}

main().catch((err) => {
  console.error('Fatal client error:', err);
  process.exit(1);
});
