-- =============================================================
-- schema.sql
-- Collaborative Terminal — MySQL persistent storage
--
-- Design notes (for your project report):
--
-- - "rooms" are PERSISTENT: a room is created once and can be
--   rejoined across multiple connect/disconnect cycles. The actual
--   PTY process dies when the last user leaves (it's just a Linux
--   process inside a container), but the room's IDENTITY and its
--   full command history survive in MySQL. Rejoining spawns a fresh
--   PTY but keeps the same room_id / history / membership record.
--
-- - "sessions" represents one continuous *lifetime* of a room's PTY
--   process (from spawn to termination). A single room can have many
--   sessions over its life (every rejoin-after-empty = new session).
--   This is what lets you write a query like "how many times was
--   room X revived" or "what was the longest-running session".
--
-- - command_logs stores command text + truncated output (≤500 chars)
--   + exit_code. This keeps storage bounded while still giving a
--   real audit trail and forensic value (you can show a grader
--   "user X ran `rm -rf /` at this timestamp, exit code 1").
--
-- - lock_history is an append-only audit log of every acquire/release
--   of the control lock — directly demonstrates the mutual-exclusion
--   concept from your DBMS/OS coursework with real timestamped data.
-- =============================================================

CREATE DATABASE IF NOT EXISTS collab_terminal
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE collab_terminal;

-- Dedicated app user (don't connect as root from the Node app).
-- Password is intentionally simple here for local dev; override via
-- Docker/env secrets in any real deployment.
CREATE USER IF NOT EXISTS 'collabapp'@'%' IDENTIFIED BY 'collabpass';
GRANT ALL PRIVILEGES ON collab_terminal.* TO 'collabapp'@'%';
FLUSH PRIVILEGES;

-- -------------------------------------------------------------
-- users
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username        VARCHAR(32)  NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,           -- bcrypt hash
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_connected  TIMESTAMP    NULL,                -- updated on every WS connect
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,

  CONSTRAINT uq_users_username UNIQUE (username)
) ENGINE=InnoDB;

-- -------------------------------------------------------------
-- rooms  (persistent — identity + membership survive PTY restarts)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rooms (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_name       VARCHAR(64)  NOT NULL,
  created_by      INT UNSIGNED NOT NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_archived     BOOLEAN      NOT NULL DEFAULT FALSE,  -- soft delete

  CONSTRAINT uq_rooms_name UNIQUE (room_name),
  CONSTRAINT fk_rooms_created_by FOREIGN KEY (created_by)
    REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- -------------------------------------------------------------
-- room_members  (who is allowed to rejoin a persistent room)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_members (
  room_id         INT UNSIGNED NOT NULL,
  user_id         INT UNSIGNED NOT NULL,
  joined_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  role            ENUM('owner', 'member') NOT NULL DEFAULT 'member',

  PRIMARY KEY (room_id, user_id),
  CONSTRAINT fk_members_room FOREIGN KEY (room_id)
    REFERENCES rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_members_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- -------------------------------------------------------------
-- sessions  (one row per PTY process lifetime within a room)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id         INT UNSIGNED NOT NULL,
  started_by      INT UNSIGNED NOT NULL,             -- who triggered the (re)spawn
  container_id    VARCHAR(64)  NULL,                 -- docker container id, for ops/debug
  started_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at        TIMESTAMP    NULL,                 -- NULL while session is live

  CONSTRAINT fk_sessions_room FOREIGN KEY (room_id)
    REFERENCES rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_sessions_started_by FOREIGN KEY (started_by)
    REFERENCES users(id) ON DELETE RESTRICT,

  INDEX idx_sessions_room (room_id),
  INDEX idx_sessions_live (room_id, ended_at)         -- fast "is there a live session?" lookup
) ENGINE=InnoDB;

-- -------------------------------------------------------------
-- command_logs  (command + truncated output, append-only audit trail)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS command_logs (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  session_id      INT UNSIGNED NOT NULL,
  user_id         INT UNSIGNED NOT NULL,
  command         TEXT         NOT NULL,
  output_snippet  VARCHAR(500) NULL,                 -- truncated stdout/stderr
  exit_code       SMALLINT     NULL,                 -- NULL until command completes
  executed_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_logs_session FOREIGN KEY (session_id)
    REFERENCES sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_logs_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE RESTRICT,

  INDEX idx_logs_session (session_id, executed_at),
  INDEX idx_logs_user (user_id, executed_at)
) ENGINE=InnoDB;

-- -------------------------------------------------------------
-- lock_history  (audit trail of the Redis control-lock lifecycle)
-- Redis is the LIVE source of truth for "who holds the lock right
-- now" — this table is the durable record of every acquire/release
-- for after-the-fact analysis (e.g. "how long did each user hold
-- control", "how many lock contentions happened").
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lock_history (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  session_id      INT UNSIGNED NOT NULL,
  user_id         INT UNSIGNED NOT NULL,
  acquired_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at     TIMESTAMP    NULL,                 -- NULL while still held
  release_reason  ENUM('manual', 'ttl_expired', 'disconnect') NULL,

  CONSTRAINT fk_lockhist_session FOREIGN KEY (session_id)
    REFERENCES sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_lockhist_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE RESTRICT,

  INDEX idx_lockhist_session (session_id, acquired_at)
) ENGINE=InnoDB;
