# Collaborative Terminal — Comprehensive Setup Guide

This guide provides step-by-step instructions to host the collaborative terminal server, run the client, and connect multiple computers on the same network for real-time multiplayer collaboration.

---

## 📌 Architecture Overview

The application functions like a network-aware `tmux` with strict lock-based concurrency control:
* **Server**: Node.js + Express (REST APIs) + WebSockets (real-time communication).
* **Database (MySQL)**: Persistent logging of user credentials, rooms, sessions, command history, and lock audits.
* **Cache (Redis)**: Low-latency mutex locks, queue bookkeeping, and ephemeral active states.
* **Sandbox**: Isolated Docker container per active room to run a safe Linux PTY process.

---

## 🛠️ Prerequisites

Ensure the following tools are installed on your host machine:

| Tool | Version (Recommended) | Purpose |
| :--- | :--- | :--- |
| **Docker & Docker Desktop** | latest | Container virtualization (MySQL, Redis, Room Sandbox) |
| **Node.js** | v18.x or v20.x (LTS) | Execution environment for server and CLI clients |
| **Git** | latest | Version control and repository cloning |

---

## 🚀 1. Hosting the Server (Host Machine)

Choose one of the two options below to run the server. **Option A (Docker Compose) is highly recommended.**

### Option A — Docker Compose (Recommended)

This method spins up MySQL, Redis, the sandbox image, and the application server automatically in isolated containers.

1. Navigate to the `docker` directory:
   ```bash
   cd docker
   ```
2. Build the images and start the container stack:
   ```bash
   docker compose up --build
   ```

> [!WARNING]
> **Port Conflicts (bind: Only one usage of each socket address is normally permitted)**:
> If you get this error on port `3306`, it means you already have a local MySQL/MariaDB server running on your host machine. 
> To resolve this, change the host port mapping in your `docker-compose.yml` to another port (e.g., `3307:3306`), which has already been configured in your project.

---

### Option B — Local Development (Native Server)

Use this option if you want to run the Node.js server code directly on your host machine instead of inside a Docker container. 

> [!NOTE]
> You still need Docker installed and running because the server shells out to the Docker CLI to create sandbox containers.

1. **Build the Sandbox Image**:
   Build the runner container image so that it is locally available for spawning rooms:
   ```bash
   docker build -t collab-terminal-sandbox -f docker/Dockerfile.sandbox docker/
   ```
2. **Start MySQL & Redis Services**:
   Ensure you have a local instance of Redis running on port `6379` and MySQL running on port `3306`.
3. **Initialize the Database Schema**:
   Import the schema to set up tables and application users:
   ```bash
   mysql -u root -p < server/db/schema.sql
   ```
4. **Configure Environment Variables**:
   Create a `.env` file in the `server` directory:
   ```bash
   cd server
   cp .env.example .env
   ```
   *Edit `.env` to match your local database credentials, port number, and a random `JWT_SECRET`.*
5. **Install Server Dependencies & Start**:
   ```bash
   npm install
   node index.js
   ```

---

## 💻 2. Client Setup

The CLI client runs natively in the terminal using the `blessed` TUI library.

1. Open a new terminal window and navigate to the `client` folder:
   ```bash
   cd client
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Initialize the client environment variables file:
   * **PowerShell**:
     ```powershell
     Copy-Item .env.example .env
     ```
   * **Command Prompt (cmd)**:
     ```cmd
     copy .env.example .env
     ```
   * **Bash (macOS/Linux/Git Bash)**:
     ```bash
     cp .env.example .env
     ```

---

## 🌐 3. Running Across Different Computers (LAN & Radmin VPN / WAN)

If the server is running on **Computer A** (Host/Server) and you want users on **Computer B, C, etc.** (Clients) to join, you can connect them either over the same Wi-Fi network (LAN) or over the Internet using a virtual LAN tool like **Radmin VPN**.

### Option A — Over the Internet (Using Radmin VPN)

This is the easiest way to connect PCs over different networks (across the internet) without port-forwarding:

1. **Setup Radmin VPN**:
   - Download and install **Radmin VPN** (free) on both the Server Host (**Computer A**) and all Client PCs (**Computer B, C**, etc.).
   - On **Computer A**, open Radmin VPN and click **Create Network**. Set a Network Name and Password.
   - On all Client PCs, open Radmin VPN, click **Join Network**, and enter that name and password.

2. **Get Host IP**:
   - Copy the IP address of **Computer A** shown in the Radmin VPN window (e.g., `26.154.22.88`).

3. **Configure Clients**:
   - On the Client PCs, copy the `client/` folder.
   - Edit the client's `.env` file on those machines, replacing `localhost` with Computer A's Radmin VPN IP address:
     ```env
     API_BASE_URL=http://26.154.22.88:3000
     WS_BASE_URL=ws://26.154.22.88:3000
     ```

4. **Launch Client**:
   - Run `node index.js` on the client machines. They will connect directly to the host server!

---

### Option B — Over the Same Local Network (LAN)

If all computers are on the same Wi-Fi or router network:

1. **Find Server IP**:
   - On **Computer A** (Server), open command prompt/terminal and run `ipconfig`.
   - Look for the **IPv4 Address** (e.g., `192.168.1.15`).

2. **Configure Clients**:
   - Copy the `client/` folder to the client PCs.
   - Edit the client's `.env` file on those machines, replacing `localhost` with the local IP address:
     ```env
     API_BASE_URL=http://192.168.1.15:3000
     WS_BASE_URL=ws://192.168.1.15:3000
     ```

3. **Launch Client**:
   - Run `node index.js` on the client machines.

---

> [!IMPORTANT]
> **Windows Firewall Settings (Crucial for Host PC)**:
> In both Option A and Option B, the Host PC (**Computer A**) must allow incoming connections on port `3000`. If clients fail to connect, follow these steps on Computer A:
> 1. Open Windows Search, type **Windows Defender Firewall with Advanced Security**, and open it.
> 2. Click **Inbound Rules** in the left sidebar, then click **New Rule...** on the right.
> 3. Select **Port** and click Next.
> 4. Choose **TCP**, type `3000` in **Specific local ports**, and click Next.
> 5. Select **Allow the connection** and click Next.
> 6. Keep all profiles (Domain, Private, Public) checked and click Next.
> 7. Name the rule (e.g. `Collab Terminal Port 3000`) and click **Finish**.

### Step 4: Run the client on Computer B
```bash
node index.js
```

---

## 🎮 4. How to Use the App (Operating Instructions)

1. **Authentication**: 
   When you run `node index.js`, select **Register** to create a new user account, then **Login** with those credentials.
2. **Join / Create a Room**:
   * Type in a room name to join or create one (e.g. `OS_Lab_Group`).
   * If a room doesn't exist, you will be prompted to create it.
3. **Requesting Control (Mutex Lock)**:
   * By default, you join as a **Spectator** and can see whatever is happening in the terminal.
   * Press **`c`** to request control of the terminal lock.
   * If the lock is free, you will be promoted to **Holder** instantly, and your input will now send keys to the terminal.
   * If another user holds the lock, you will be put into a FIFO waiting queue. You will see your position in the status bar at the bottom.
4. **Releasing Control**:
   * Press **`c`** again to release control.
   * The next user in the queue will be automatically promoted and given a fresh lease to start typing.
5. **Autopromote & TTL**:
   * If the current holder remains inactive or gets disconnected, the lock will auto-expire, and the next person in line will be promoted.
6. **Command Logging**:
   * Every command executed is logged to the MySQL `command_logs` table (with truncated outputs and exit codes) for durably audited persistence.
