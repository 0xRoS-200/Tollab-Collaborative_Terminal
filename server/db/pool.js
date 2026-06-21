/**
 * pool.js
 *
 * MySQL connection pool (mysql2/promise). We use a pool rather than
 * a single connection because the WS server will have many concurrent
 * clients potentially triggering DB writes (command logs, lock history)
 * at the same time -- a pool lets mysql2 queue/parallelize those
 * safely instead of serializing everything through one connection.
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT) || 3306,
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'collab_terminal',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // Return JS Date objects, not strings, for TIMESTAMP columns
  dateStrings: false,
});

/** Quick health check, useful at server startup. */
async function ping() {
  const conn = await pool.getConnection();
  try {
    await conn.query('SELECT 1');
    return true;
  } finally {
    conn.release();
  }
}

module.exports = { pool, ping };
