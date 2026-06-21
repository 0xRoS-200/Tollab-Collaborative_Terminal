/**
 * httpRoutes.js
 *
 * REST endpoints for account creation and login. WebSocket connections
 * authenticate via the JWT issued here (passed as ?token=... on the
 * WS URL -- see ws/wsServer.js).
 */

const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword, issueToken } = require('../auth');

const router = express.Router();

router.post('/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || typeof username !== 'string' || username.length < 3 || username.length > 32) {
    return res.status(400).json({ error: 'username must be 3-32 characters' });
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }

  try {
    const existing = await db.findUserByUsername(username);
    if (existing) {
      return res.status(409).json({ error: 'username already taken' });
    }

    const passwordHash = await hashPassword(password);
    const userId = await db.createUser(username, passwordHash);
    const token = issueToken({ id: userId, username });

    res.status(201).json({ token, user: { id: userId, username } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'internal server error' });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    const user = await db.findUserByUsername(username);
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    await db.touchLastConnected(user.id);
    const token = issueToken({ id: user.id, username: user.username });

    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'internal server error' });
  }
});

router.post('/reset-password', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and new password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }

  try {
    const user = await db.findUserByUsername(username);
    if (!user) {
      return res.status(404).json({ error: 'user not found' });
    }

    const passwordHash = await hashPassword(password);
    const success = await db.updateUserPasswordByUsername(username, passwordHash);

    if (success) {
      res.json({ success: true, message: 'Password reset successfully' });
    } else {
      res.status(500).json({ error: 'failed to update password' });
    }
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'internal server error' });
  }
});

router.get('/health', async (_req, res) => {
  try {
    await db.ping();
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'db unreachable' });
  }
});

// Admin REST APIs
router.get('/admin/stats', async (req, res) => {
  try {
    const stats = await db.getAdminStats();
    res.json(stats);
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'failed to fetch admin stats' });
  }
});

router.get('/admin/users', async (req, res) => {
  try {
    const users = await db.getAdminUsers();
    res.json(users);
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).json({ error: 'failed to fetch admin users' });
  }
});

router.get('/admin/sessions', async (req, res) => {
  try {
    const sessions = await db.getAdminSessions();
    res.json(sessions);
  } catch (err) {
    console.error('Admin sessions error:', err);
    res.status(500).json({ error: 'failed to fetch admin sessions' });
  }
});

router.get('/admin/commands', async (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const commands = await db.getAdminCommands(limit);
    res.json(commands);
  } catch (err) {
    console.error('Admin commands error:', err);
    res.status(500).json({ error: 'failed to fetch admin commands' });
  }
});

module.exports = router;
