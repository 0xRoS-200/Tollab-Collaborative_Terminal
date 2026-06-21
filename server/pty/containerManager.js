/**
 * containerManager.js
 *
 * Creates/destroys the disposable Docker container that backs each
 * room's shell. We shell out to the `docker` CLI directly (via
 * execFile) rather than using the dockerode npm package, to keep
 * dependencies minimal -- the docker CLI is already required to be
 * present (it's how node-pty's `docker exec` works in ptyManager.js).
 *
 * Container naming: `collab-room-<roomId>` -- deterministic, so we
 * can always find/reuse/clean up a room's container by id alone.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'collab-terminal-sandbox';

function containerName(roomId) {
  return `collab-room-${roomId}`;
}

/**
 * Start a fresh disposable container for a room. If a container with
 * this name already exists (e.g. crashed server restarted), it's
 * removed first so we always get a clean shell.
 *
 * Resource limits are intentionally conservative -- this is a shared
 * teaching sandbox, not a build server.
 */
async function startContainer(roomId) {
  const name = containerName(roomId);

  // Clean up any stale container with the same name first
  await removeContainer(roomId).catch(() => {});

  const args = [
    'run',
    '-d',                       // detached
    '--name', name,
    '--rm',                     // auto-remove when stopped
    '--memory', '256m',
    '--cpus', '0.5',
    '--network', 'bridge',      // allow internet access to install dependencies
    '--pids-limit', '128',      // fork-bomb mitigation
    SANDBOX_IMAGE,
    'sleep', 'infinity',        // keep container alive; node-pty execs the real shell into it
  ];

  const { stdout } = await execFileAsync('docker', args);
  const containerId = stdout.trim();
  return { containerId, containerName: name };
}

async function removeContainer(roomId) {
  const name = containerName(roomId);
  await execFileAsync('docker', ['rm', '-f', name]);
}

async function containerExists(roomId) {
  const name = containerName(roomId);
  try {
    await execFileAsync('docker', ['inspect', name]);
    return true;
  } catch {
    return false;
  }
}

module.exports = { startContainer, removeContainer, containerExists, containerName };
