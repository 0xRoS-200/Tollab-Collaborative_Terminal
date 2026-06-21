# Collaborative Terminal — DBMS Project

A shared, multi-user terminal application (similar to `tmux` over a network) featuring explicit lock-based concurrency control, Redis-backed session state, MySQL-backed persistent logging, a web-based Admin Dashboard, and isolated sandbox containers.

---

## 📌 Architecture Overview

```
┌──────────────┐     WebSocket      ┌────────────────────┐
│  CLI Client   │◄──────────────────►│   Node.js Server    │
│ (blessed TUI) │   JSON messages    │  - Express (REST)   │
└──────────────┘                    │  - ws (realtime)    │
                                     │  - node-pty (shell) │
                                     └─────────┬───────────┘
                                               │
                   ┌───────────────────────────┼───────────────────────────┐
                   ▼                                                       ▼
           ┌────────────────┐                                    ┌──────────────────┐
           │     Redis        │                                    │      MySQL         │
           │ - control lock    │                                    │ - users             │
           │ - waiting queue   │                                    │ - rooms             │
           └────────────────┘                                    │ - sessions          │
                                                                    │ - command_logs      │
                                                                    │ - lock_history      │
                                                                    └──────────────────┘
```

Each **Room** maps to a single shared shell session (one real PTY process running inside an isolated Docker container built from [Dockerfile.sandbox](file:///c:/Users/offic/Desktop/Tollab-Terminal%20Collab/docker/Dockerfile.sandbox)).
* Multiple clients can connect to the same room and view the terminal output in real-time.
* Only one user may type at a time — control is a mutex lock implemented via Redis (with TTL-based auto-expiry to prevent frozen sessions) and a FIFO waiting queue.

---

## 🛠️ Tech Stack & Database Strategy

* **Node.js (Express + WebSockets)**: Core backend services and real-time events.
* **Blessed TUI**: High-fidelity terminal client layout.
* **Redis**: Holds fast, ephemeral, frequently mutated state:
  * Mutex lock ownership and waiting queues.
* **MySQL**: Holds durable, auditable history:
  * User credentials, room members, command logs (truncated to 500 characters max), and a complete lock history showing exactly who held/released the terminal lock and why (e.g., manual release, disconnect, or TTL expiry).

---

## ✨ Full Feature Set

### 1. Web Admin Dashboard
Served at `http://localhost:3000/admin`, the dashboard is a premium dark-mode, glassmorphic webpage built with pure HTML, vanilla CSS (HSL styling), and vanilla JS. It features:
* **Overview Statistics**: Real-time cards displaying total users, rooms, sessions, and commands run.
* **User Accounts**: Live list of registered users, their registration dates, last active timestamps, and active status.
* **Session History**: Room session lifetimes showing room name, creator, session duration, and active container ID.
* **Command Audit Logs**: Detailed chronological listing of all executed commands, including the executor, command string, output snippet, exit status, and execution timestamp.
* **Filter Search**: A live input box to search and filter commands by username or command text instantly.

### 2. Client-Side Input Auto-Refocusing
* Prevents the user from getting stuck when the TUI text box loses focus (e.g., when scrolling the terminal pane or clicking outside).
* Typing any printable character or pressing Enter automatically focuses the input box and appends the character.
* Intercepts `Ctrl + R` locally: if you already hold control, pressing `Ctrl + R` focuses the input bar locally instead of initiating a redundant lock request to the server.

### 3. Local Command History & Tab Autocomplete
* **Command History**: Cycle backward/forward through past successfully submitted commands using the **`Up Arrow`** and **`Down Arrow`** keys.
* **Tab Autocomplete**: Press **`Tab`** to auto-complete commands without blurring/losing focus on the text input field.
* **Dynamic Candidate Extraction**: The client parses the terminal stream characters, splits by whitespace, and registers alphanumeric words/filenames (e.g., `index.js`, `package.json`) as autocomplete candidates dynamically. This provides directory file autocompletion.

### 4. Client-Side ANSI Escape Sequence Sanitization
* Cleanly strips out terminal-specific window title sequences (OSC) and bracketed paste mode toggles (CSI) (such as `\u001b[?2004h` and `\u001b]0;...\u0007`) from raw PTY data before logging it, avoiding terminal noise.

### 5. Server-Side Lock Re-acquisition Safeguard
* Refined the Redis lock manager: if the current lock holder requests the lock again, they are immediately granted access and remain the lock holder, avoiding self-locking or being pushed back to the waiting queue.

### 6. Sandbox Network & Root Execution
* Spawned sandbox room containers use the `bridge` network driver (enabling internet connection).
* Spawns the sandbox shell as `root` in `/root` by default, allowing users to run package installer commands (e.g. `apt-get install -y curl`) inside the terminal.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Description |
| :--- | :--- |
| **`Ctrl + R`** | Request terminal control / Refocus typing bar locally |
| **`Ctrl + L`** | Release terminal control |
| **`Ctrl + C` (x2 quickly)** | Quit the TUI client |
| **`Ctrl + C` (single press)** | Send SIGINT interrupt directly to the remote shell |

---

## 🚀 Setup & Launch

### 1. Rebuild & Run the Server Stack (Docker Compose)
Navigate to the `docker` directory and launch the stack:
```bash
cd docker
docker compose up -d --build
```
This builds/spins up **MySQL (port 3307)**, **Redis (port 6379)**, and the **Application Server (port 3000)**.

### 2. Run the Client TUI
Navigate to the `client` folder, install dependencies, and run:
```bash
cd client
npm install
node index.js
```

---

## 🎮 How to Test Manual Installations
Once inside the client terminal, press `Ctrl + R` to get control and run:
```bash
apt-get update
apt-get install -y curl
curl --version
```
The sandboxed terminal will download, install, and execute the package under your shared root shell!
You can view the statistics, session counters, and the live command log audit records on the **Web Admin Dashboard** at `http://localhost:3000/admin`.
