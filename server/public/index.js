document.addEventListener('DOMContentLoaded', () => {
  // --- Constants & State ---
  const API_PREFIX = '/api/admin';
  const REFRESH_INTERVAL_MS = 5000; // Auto-refresh stats every 5s
  
  let allCommands = []; // Local cache of command logs for live search filtering
  
  // --- DOM Elements ---
  const statsElements = {
    users: document.getElementById('val-users'),
    rooms: document.getElementById('val-rooms'),
    sessions: document.getElementById('val-sessions'),
    commands: document.getElementById('val-commands')
  };

  const tabs = document.querySelectorAll('.tab-btn');
  const contents = document.querySelectorAll('.tab-content');
  
  const tables = {
    users: document.getElementById('users-table-body'),
    sessions: document.getElementById('sessions-table-body'),
    commands: document.getElementById('commands-table-body')
  };

  const refreshButtons = {
    users: document.getElementById('refresh-users-btn'),
    sessions: document.getElementById('refresh-sessions-btn'),
    commands: document.getElementById('refresh-commands-btn')
  };

  const searchInput = document.getElementById('command-search-input');
  
  // --- Date & Duration Formatting Helpers ---
  function formatDate(isoString) {
    if (!isoString) return '—';
    const date = new Date(isoString);
    return date.toLocaleString();
  }

  function formatDuration(startIso, endIso) {
    const start = new Date(startIso);
    const end = endIso ? new Date(endIso) : new Date();
    const diffMs = end - start;
    
    if (diffMs < 0) return '0s';
    
    const seconds = Math.floor(diffMs / 1000) % 60;
    const minutes = Math.floor(diffMs / (1000 * 60)) % 60;
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
    
    return parts.join(' ');
  }

  // --- API Fetching Methods ---
  async function fetchStats() {
    try {
      const res = await fetch(`${API_PREFIX}/stats`);
      if (!res.ok) throw new Error('Failed to fetch stats');
      const data = await res.json();
      
      statsElements.users.textContent = data.users;
      statsElements.rooms.textContent = data.rooms;
      statsElements.sessions.textContent = data.sessions;
      statsElements.commands.textContent = data.commands;
    } catch (err) {
      console.error('Error fetching stats:', err);
    }
  }

  async function fetchUsers() {
    try {
      tables.users.innerHTML = `<tr><td colspan="5" class="loading-placeholder">Refreshing users data...</td></tr>`;
      const res = await fetch(`${API_PREFIX}/users`);
      if (!res.ok) throw new Error('Failed to fetch users');
      const users = await res.json();
      
      if (users.length === 0) {
        tables.users.innerHTML = `<tr><td colspan="5" class="loading-placeholder">No user accounts registered.</td></tr>`;
        return;
      }
      
      tables.users.innerHTML = users.map(u => `
        <tr>
          <td>${u.id}</td>
          <td><strong>${u.username}</strong></td>
          <td class="time-stamp">${formatDate(u.created_at)}</td>
          <td class="time-stamp">${formatDate(u.last_connected)}</td>
          <td>
            <span class="badge ${u.is_active ? 'active' : 'inactive'}">
              ${u.is_active ? 'Active' : 'Banned'}
            </span>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      tables.users.innerHTML = `<tr><td colspan="5" class="loading-placeholder" style="color: var(--accent-red)">Error loading users: ${err.message}</td></tr>`;
    }
  }

  async function fetchSessions() {
    try {
      tables.sessions.innerHTML = `<tr><td colspan="7" class="loading-placeholder">Refreshing sessions data...</td></tr>`;
      const res = await fetch(`${API_PREFIX}/sessions`);
      if (!res.ok) throw new Error('Failed to fetch sessions');
      const sessions = await res.json();
      
      if (sessions.length === 0) {
        tables.sessions.innerHTML = `<tr><td colspan="7" class="loading-placeholder">No sessions recorded yet.</td></tr>`;
        return;
      }
      
      tables.sessions.innerHTML = sessions.map(s => {
        const isOngoing = !s.ended_at;
        const duration = formatDuration(s.started_at, s.ended_at);
        return `
          <tr>
            <td><span class="code-text">${s.id}</span></td>
            <td><strong>${s.room_name}</strong></td>
            <td>${s.started_by_user}</td>
            <td><span class="code-text">${s.container_id || '—'}</span></td>
            <td class="time-stamp">${formatDate(s.started_at)}</td>
            <td class="time-stamp">${isOngoing ? '—' : formatDate(s.ended_at)}</td>
            <td>
              <span class="badge ${isOngoing ? 'ongoing' : 'ended'}">
                ${isOngoing ? `Ongoing (${duration})` : duration}
              </span>
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      tables.sessions.innerHTML = `<tr><td colspan="7" class="loading-placeholder" style="color: var(--accent-red)">Error loading sessions: ${err.message}</td></tr>`;
    }
  }

  async function fetchCommands() {
    try {
      tables.commands.innerHTML = `<tr><td colspan="7" class="loading-placeholder">Refreshing command logs...</td></tr>`;
      const res = await fetch(`${API_PREFIX}/commands?limit=150`);
      if (!res.ok) throw new Error('Failed to fetch commands');
      allCommands = await res.json();
      
      renderCommands(allCommands);
    } catch (err) {
      tables.commands.innerHTML = `<tr><td colspan="7" class="loading-placeholder" style="color: var(--accent-red)">Error loading commands: ${err.message}</td></tr>`;
    }
  }

  function renderCommands(commands) {
    if (commands.length === 0) {
      tables.commands.innerHTML = `<tr><td colspan="7" class="loading-placeholder">No matching command logs found.</td></tr>`;
      return;
    }
    
    tables.commands.innerHTML = commands.map(c => {
      let exitClass = 'exit-success';
      let exitDisplay = '0';
      if (c.exit_code !== null) {
        exitDisplay = c.exit_code;
        if (c.exit_code !== 0) exitClass = 'exit-error';
      } else {
        exitDisplay = '—';
        exitClass = 'exit-success';
      }
      
      return `
        <tr>
          <td>${c.id}</td>
          <td><strong>${c.room_name}</strong></td>
          <td>${c.username}</td>
          <td><span class="code-text">${escapeHtml(c.command)}</span></td>
          <td><span class="output-text" title="${escapeHtml(c.output_snippet || '')}">${escapeHtml(c.output_snippet || '—')}</span></td>
          <td><span class="exit-code ${exitClass}">${exitDisplay}</span></td>
          <td class="time-stamp">${formatDate(c.executed_at)}</td>
        </tr>
      `;
    }).join('');
  }

  // Helper to prevent HTML injection in command text or output snippets
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // --- Search Filter Logic ---
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    if (!query) {
      renderCommands(allCommands);
      return;
    }
    
    const filtered = allCommands.filter(c => 
      c.username.toLowerCase().includes(query) || 
      c.command.toLowerCase().includes(query) ||
      c.room_name.toLowerCase().includes(query)
    );
    renderCommands(filtered);
  });

  // --- Tab Navigation Setup ---
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      contents.forEach(c => c.classList.remove('active'));

      tab.classList.add('active');
      const activeTabId = tab.getAttribute('data-tab');
      document.getElementById(activeTabId).classList.add('active');
      
      // Fetch relevant content for current active tab
      if (activeTabId === 'tab-users') fetchUsers();
      else if (activeTabId === 'tab-sessions') fetchSessions();
      else if (activeTabId === 'tab-commands') fetchCommands();
    });
  });

  // --- Refresh Buttons Setup ---
  refreshButtons.users.addEventListener('click', fetchUsers);
  refreshButtons.sessions.addEventListener('click', fetchSessions);
  refreshButtons.commands.addEventListener('click', fetchCommands);

  // --- Initial Loading ---
  fetchStats();
  fetchUsers(); // Default tab
  
  // Periodic polling for stats & cards
  setInterval(fetchStats, REFRESH_INTERVAL_MS);
});
