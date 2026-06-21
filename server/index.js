/**
 * index.js
 *
 * Server entry point. Boots:
 *  - Express app (REST: /register, /login, /health)
 *  - HTTP server (shared by Express + WS upgrade)
 *  - ioredis client (for the lock manager)
 *  - WebSocket server (the real-time terminal protocol)
 *
 * Run with: node index.js   (or `npm start`)
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const Redis = require('ioredis');
const path = require('path');

const httpRoutes = require('./http/httpRoutes');
const { createWsServer } = require('./ws/wsServer');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT) || 6379;

async function main() {
  // Fail fast if MySQL isn't reachable -- better than mysterious
  // errors later on the first WS join.
  try {
    await db.ping();
    console.log('[startup] MySQL connection OK');
  } catch (err) {
    console.error('[startup] FATAL: could not connect to MySQL:', err.message);
    process.exit(1);
  }

  const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
  redis.on('error', (err) => console.error('[redis] connection error:', err.message));
  redis.on('connect', () => console.log('[startup] Redis connection OK'));

  const app = express();
  app.use(express.json());
  app.use('/api', httpRoutes);
  app.use('/admin', express.static(path.join(__dirname, 'public')));

  const httpServer = http.createServer(app);

  createWsServer(httpServer, redis);

  httpServer.listen(PORT, () => {
    console.log(`[startup] Collaborative terminal server listening on :${PORT}`);
    console.log(`[startup] REST API:     http://localhost:${PORT}/api`);
    console.log(`[startup] WebSocket:    ws://localhost:${PORT}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[shutdown] closing server...');
    httpServer.close();
    await redis.quit();
    await db.pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[startup] FATAL:', err);
  process.exit(1);
});
