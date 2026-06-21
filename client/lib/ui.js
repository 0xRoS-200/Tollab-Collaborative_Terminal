/**
 * ui.js
 *
 * blessed TUI with three regions:
 *   - top status bar: room name, who holds control, queue
 *   - main pane: raw PTY output (the "shared terminal")
 *   - bottom input line: where YOU type, only active when you hold
 *     control; otherwise shows a "press Enter to request control" hint
 *
 * Key bindings:
 *   Ctrl+R  -> request control
 *   Ctrl+L  -> release control (deliberately NOT plain Ctrl+C, since
 *              that needs to pass through to the shell for the user's
 *              actual SIGINT use case)
 *   Ctrl+C (twice quickly) -> quit the client
 */

const blessed = require('blessed');

function createUi() {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'Collaborative Terminal',
  });

  const statusBar = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: 'cyan' } },
    content: '{bold}Connecting...{/bold}',
  });

  const outputPane = blessed.log({
    top: 3,
    left: 0,
    width: '80%',
    height: '100%-6',
    border: { type: 'line' },
    label: ' Shared Terminal ',
    style: { border: { fg: 'green' } },
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    scrollbar: { ch: ' ', inverse: true },
    tags: true,
  });

  const usersPane = blessed.box({
    top: 3,
    right: 0,
    width: '20%',
    height: '100%-6',
    border: { type: 'line' },
    label: ' Active Users ',
    style: { border: { fg: 'blue' } },
    tags: true,
  });

  const inputBar = blessed.textbox({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    border: { type: 'line' },
    style: { border: { fg: 'yellow' } },
    inputOnFocus: true,
    keys: true,
  });

  // Autocomplete candidates (common commands)
  const candidates = ['ls', 'cd', 'cat', 'nano', 'apt-get', 'apt', 'whoami', 'pwd', 'clear', 'mkdir', 'rm', 'touch', 'cp', 'mv', 'git', 'curl', 'sleep', 'update', 'upgrade', 'install'];
  const commandHistory = [];
  let historyIndex = 0;
  let currentDraft = '';

  // Listen to submit to record history
  inputBar.on('submit', (value) => {
    if (value.trim()) {
      if (commandHistory.length === 0 || commandHistory[commandHistory.length - 1] !== value) {
        commandHistory.push(value);
      }
      if (value.length <= 30 && !candidates.includes(value)) {
        candidates.push(value);
      }
    }
    historyIndex = commandHistory.length;
    currentDraft = '';
  });

  // Intercept Enter key, Up/Down arrows for history, and Tab for autocomplete
  inputBar.on('keypress', (ch, key) => {
    const fs = require('fs');
    const path = require('path');
    const logPath = path.join(__dirname, '..', 'debug.log');
    const keyName = key ? key.name : 'undefined';
    try {
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] keypress: ch=${JSON.stringify(ch)}, key=${keyName}\n`);
    } catch (e) {}

    const isEnter = (key && (key.name === 'enter' || key.name === 'return')) || ch === '\r' || ch === '\n';
    if (isEnter) {
      inputBar.submit();
      return false;
    }

    if (key && key.name === 'up') {
      if (historyIndex > 0) {
        if (historyIndex === commandHistory.length) {
          currentDraft = inputBar.getValue();
        }
        historyIndex--;
        inputBar.setValue(commandHistory[historyIndex]);
        screen.render();
      }
      return false;
    }

    if (key && key.name === 'down') {
      if (historyIndex < commandHistory.length) {
        historyIndex++;
        if (historyIndex === commandHistory.length) {
          inputBar.setValue(currentDraft);
        } else {
          inputBar.setValue(commandHistory[historyIndex]);
        }
        screen.render();
      }
      return false;
    }

    if (key && key.name === 'tab') {
      const value = inputBar.getValue();
      const words = value.split(' ');
      const lastWord = words[words.length - 1];
      if (lastWord.length > 0) {
        const matches = candidates.filter(c => c.startsWith(lastWord));
        if (matches.length === 1) {
          words[words.length - 1] = matches[0];
          inputBar.setValue(words.join(' '));
          screen.render();
        } else if (matches.length > 1) {
          // Find longest common prefix
          let prefix = lastWord;
          let possible = true;
          while (possible) {
            const nextChar = matches[0][prefix.length];
            if (!nextChar) break;
            const matchesAll = matches.every(m => m.startsWith(prefix + nextChar));
            if (matchesAll) {
              prefix += nextChar;
            } else {
              possible = false;
            }
          }
          words[words.length - 1] = prefix;
          inputBar.setValue(words.join(' '));
          screen.render();
        }
      }
      return false;
    }
  });

  screen.append(statusBar);
  screen.append(outputPane);
  screen.append(usersPane);
  screen.append(inputBar);

  let holdingControl = false;
  let currentHolder = null;
  let currentQueue = [];
  let roomName = '';
  let myUsername = '';
  let activeUsersList = [];

  function renderUsers() {
    const listLines = activeUsersList.map(u => {
      let suffix = '';
      let prefix = '• ';
      if (u === myUsername) suffix += ' (You)';
      if (u === currentHolder) {
        prefix = '⚡ ';
        return `{green-fg}${prefix}${u}${suffix}{/green-fg}`;
      }
      return `${prefix}${u}${suffix}`;
    });

    usersPane.setContent(
      `{bold}Total: ${activeUsersList.length}{/bold}\n\n` + listLines.join('\n')
    );
    screen.render();
  }

  function updateUsersList(users) {
    activeUsersList = users;
    renderUsers();
  }

  function addUser(username) {
    if (!activeUsersList.includes(username)) {
      activeUsersList.push(username);
    }
    renderUsers();
  }

  function removeUser(username) {
    activeUsersList = activeUsersList.filter(u => u !== username);
    renderUsers();
  }

  function renderStatus() {
    const controlText = currentHolder
      ? `{bold}{green-fg}${currentHolder}{/green-fg}{/bold} has control`
      : '{bold}{grey-fg}No one has control{/grey-fg}{/bold}';

    const queueText = currentQueue.length > 0
      ? `  |  Queue: ${currentQueue.join(', ')}`
      : '';

    const youText = holdingControl
      ? '  |  {bold}{yellow-fg}YOU ARE TYPING{/yellow-fg}{/bold}'
      : '  |  Ctrl+R to request control';

    statusBar.setContent(
      `Room: {bold}${roomName}{/bold}  |  ${controlText}${queueText}${youText}`
    );
    screen.render();
  }

  function setRoom(name, username) {
    roomName = name;
    myUsername = username;
    renderStatus();
  }

  function setHolder(username) {
    currentHolder = username;
    holdingControl = username === myUsername;
    inputBar.style.border.fg = holdingControl ? 'green' : 'yellow';
    renderStatus();
    renderUsers();
  }

  function setQueue(queue) {
    currentQueue = queue;
    renderStatus();
  }

  function setHoldingControl(val) {
    holdingControl = val;
    inputBar.style.border.fg = holdingControl ? 'green' : 'yellow';
    renderStatus();
  }

  function appendOutput(data) {
    if (typeof data === 'string') {
      // Strip bracketed paste mode sequences (\u001b[?2004h and \u001b[?2004l)
      data = data.replace(/\u001b\[\?2004[hl]/g, '');
      // Strip window title OSC sequences (\u001b]0;...\u0007 or \u001b]0;...\u001b\\)
      data = data.replace(/\u001b\][0-2];[^\x07\x1b]*(?:\x07|\u001b\\)/g, '');

      // Dynamically extract words/filenames from terminal output to populate autocomplete candidates
      const words = data.split(/[\s\r\n\t,;]+/);
      for (const word of words) {
        const cleanWord = word.replace(/[^a-zA-Z0-9_\-\.]/g, '');
        if (cleanWord.length >= 2 && cleanWord.length <= 30 && /^[a-zA-Z_\-\.][a-zA-Z0-9_\-\.]*$/.test(cleanWord)) {
          if (!candidates.includes(cleanWord)) {
            candidates.push(cleanWord);
          }
        }
      }
    }
    // blessed's log widget handles ANSI escape codes reasonably well
    // for basic color/cursor sequences; raw PTY output is fed in
    // directly.
    outputPane.add(data.replace(/\r?\n$/, ''));
    screen.render();
  }

  function showMessage(text, color = 'red') {
    outputPane.add(`{${color}-fg}[system] ${text}{/${color}-fg}`);
    screen.render();
  }

  return {
    screen,
    statusBar,
    outputPane,
    inputBar,
    setRoom,
    setHolder,
    setQueue,
    setHoldingControl,
    appendOutput,
    showMessage,
    isHoldingControl: () => holdingControl,
    renderStatus,
    updateUsersList,
    addUser,
    removeUser,
  };
}

module.exports = { createUi };
