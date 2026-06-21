/**
 * ptyManager.js
 *
 * Manages one PTY (pseudo-terminal) process per room.
 *
 * SAFETY MODEL: we never run a shell directly on the host. Each room's
 * shell runs via `docker exec -it <container> /bin/bash` against a
 * disposable container (defined in docker-compose.yml as `sandbox`,
 * built from docker/Dockerfile.sandbox). node-pty wraps that `docker
 * exec` invocation, so from Node's perspective it's just "a PTY" --
 * but every keystroke the user sends is actually executing inside an
 * isolated container the host can't be harmed by.
 *
 * One PtyManager instance is shared by the whole server process; it
 * tracks live PTYs keyed by roomId so multiple WS connections to the
 * same room attach to the SAME underlying shell (this is what makes
 * it "shared" rather than "everyone gets their own").
 */

const pty = require('node-pty');

const SHELL_COLS = 120;
const SHELL_ROWS = 30;

class PtyManager {
  constructor() {
    /** @type {Map<string, { proc: import('node-pty').IPty, buffer: string[], listeners: Set<Function> }>} */
    this.rooms = new Map();
  }

  /**
   * Spawn a new PTY for a room, running inside the given Docker
   * container (one container per room, named e.g. `collab-room-<id>`,
   * created beforehand by the Docker orchestration layer -- see
   * docker/spawnContainer.js).
   */
  spawn(roomId, containerName) {
    if (this.rooms.has(roomId)) {
      return this.rooms.get(roomId).proc;
    }

    const proc = pty.spawn(
      'docker',
      ['exec', '-it', containerName, '/bin/bash'],
      {
        name: 'xterm-256color',
        cols: SHELL_COLS,
        rows: SHELL_ROWS,
        cwd: process.cwd(),
        env: process.env,
      }
    );

    const entry = {
      proc,
      buffer: [],       // recent output, so newly-joined clients can catch up
      listeners: new Set(),
    };

    const MAX_BUFFER_LINES = 1000;

    proc.onData((data) => {
      entry.buffer.push(data);
      if (entry.buffer.length > MAX_BUFFER_LINES) {
        entry.buffer.shift();
      }
      for (const listener of entry.listeners) {
        listener(data);
      }
    });

    proc.onExit(({ exitCode, signal }) => {
      for (const listener of entry.listeners) {
        listener(null, { exitCode, signal }); // null data signals "process ended"
      }
      this.rooms.delete(roomId);
    });

    this.rooms.set(roomId, entry);
    return proc;
  }

  /** Write user input (already lock-checked by the caller) into the PTY. */
  write(roomId, data) {
    const entry = this.rooms.get(roomId);
    if (!entry) throw new Error(`No live PTY for room ${roomId}`);
    entry.proc.write(data);
  }

  /** Resize the PTY (e.g. when the room's "active viewer" has a different terminal size). */
  resize(roomId, cols, rows) {
    const entry = this.rooms.get(roomId);
    if (!entry) return;
    entry.proc.resize(cols, rows);
  }

  /**
   * Subscribe to output for a room. Returns an unsubscribe function.
   * `callback(data, exitInfo)` -- data is null and exitInfo is set
   * when the underlying process has exited.
   */
  subscribe(roomId, callback) {
    const entry = this.rooms.get(roomId);
    if (!entry) throw new Error(`No live PTY for room ${roomId}`);
    entry.listeners.add(callback);
    return () => entry.listeners.delete(callback);
  }

  /** Get buffered recent output, for clients who just joined. */
  getBuffer(roomId) {
    const entry = this.rooms.get(roomId);
    return entry ? entry.buffer.join('') : '';
  }

  isLive(roomId) {
    return this.rooms.has(roomId);
  }

  /** Forcefully kill a room's PTY (e.g. room closed by owner, or cleanup). */
  kill(roomId) {
    const entry = this.rooms.get(roomId);
    if (!entry) return;
    entry.proc.kill();
    this.rooms.delete(roomId);
  }
}

module.exports = { PtyManager };
