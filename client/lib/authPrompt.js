/**
 * authPrompt.js
 *
 * Simple full-screen blessed form for login/register, run before the
 * main terminal UI. Returns { token, username, roomName } on success.
 */

const blessed = require('blessed');
const { ApiClient } = require('./apiClient');

function promptAuth(apiBaseUrl) {
  return new Promise((resolve, reject) => {
    const screen = blessed.screen({ smartCSR: true, title: 'Collaborative Terminal - Login' });
    const api = new ApiClient(apiBaseUrl);

    const form = blessed.form({
      top: 'center',
      left: 'center',
      width: 50,
      height: 16,
      border: { type: 'line' },
      label: ' Collaborative Terminal ',
      style: { border: { fg: 'cyan' } },
      keys: true,
    });

    blessed.text({ parent: form, top: 1, left: 2, content: 'Username:' });
    const usernameInput = blessed.textbox({
      parent: form, top: 2, left: 2, width: 44, height: 1,
      inputOnFocus: true, style: { fg: 'white' },
    });

    blessed.text({ parent: form, top: 4, left: 2, content: 'Password:' });
    const passwordInput = blessed.textbox({
      parent: form, top: 5, left: 2, width: 44, height: 1,
      inputOnFocus: true, censor: true, style: { fg: 'white' },
    });

    blessed.text({ parent: form, top: 7, left: 2, content: 'Room name:' });
    const roomInput = blessed.textbox({
      parent: form, top: 8, left: 2, width: 44, height: 1,
      inputOnFocus: true, style: { fg: 'white' },
    });

    const statusText = blessed.text({
      parent: form, top: 10, left: 2, width: 44, height: 2, content: '',
      tags: true,
      style: { fg: 'red' },
    });

    const loginBtn = blessed.button({
      parent: form, top: 12, left: 2, width: 10, height: 1,
      content: 'Login', align: 'center',
      style: { fg: 'black', bg: 'green', focus: { bg: 'white' } },
      mouse: true,
    });

    const registerBtn = blessed.button({
      parent: form, top: 12, left: 14, width: 10, height: 1,
      content: 'Register', align: 'center',
      style: { fg: 'black', bg: 'blue', focus: { bg: 'white' } },
      mouse: true,
    });

    const resetBtn = blessed.button({
      parent: form, top: 12, left: 26, width: 10, height: 1,
      content: 'Reset', align: 'center',
      style: { fg: 'black', bg: 'magenta', focus: { bg: 'white' } },
      mouse: true,
    });

    const quitBtn = blessed.button({
      parent: form, top: 12, left: 38, width: 10, height: 1,
      content: 'Quit', align: 'center',
      style: { fg: 'black', bg: 'red', focus: { bg: 'white' } },
      mouse: true,
    });

    screen.append(form);
    usernameInput.focus();
    screen.render();

    let submitting = false;

    async function doAuth(mode) {
      if (submitting) return;
      const username = usernameInput.getValue().trim();
      const password = passwordInput.getValue();
      const roomName = roomInput.getValue().trim();

      if (!username || !password) {
        statusText.setContent('{red-fg}Username & password required{/red-fg}');
        statusText.parent.screen.render();
        return;
      }
      if (mode !== 'reset' && !roomName) {
        statusText.setContent('{red-fg}Room name required{/red-fg}');
        screen.render();
        return;
      }

      submitting = true;
      statusText.setContent(mode === 'reset' ? '{yellow-fg}Resetting...{/yellow-fg}' : '{yellow-fg}Connecting...{/yellow-fg}');
      screen.render();

      try {
        if (mode === 'reset') {
          await api.resetPassword(username, password);
          submitting = false;
          statusText.setContent('{green-fg}Password reset success! Please login.{/green-fg}');
          screen.render();
        } else {
          const result = mode === 'login'
            ? await api.login(username, password)
            : await api.register(username, password);

          screen.destroy();
          resolve({ token: result.token, username: result.user.username, roomName });
        }
      } catch (err) {
        submitting = false;
        statusText.setContent(`{red-fg}${err.message}{/red-fg}`);
        screen.render();
      }
    }

    loginBtn.on('press', () => doAuth('login'));
    registerBtn.on('press', () => doAuth('register'));
    resetBtn.on('press', () => doAuth('reset'));
    quitBtn.on('press', () => {
      screen.destroy();
      reject(new Error('User quit'));
    });

    screen.key(['escape', 'C-c'], () => {
      screen.destroy();
      reject(new Error('User quit'));
    });

    // Tab cycles through inputs
    form.key(['tab'], () => screen.focusNext());
    screen.key(['enter'], () => {
      // Convenience: pressing Enter while focused on room field submits as login
      if (screen.focused === roomInput) doAuth('login');
    });
  });
}

module.exports = { promptAuth };
