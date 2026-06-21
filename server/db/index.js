/**
 * index.js (db module entry point)
 * Re-exports pool + repository so the rest of the app can do:
 *   const db = require('./db');
 *   db.createUser(...), db.findRoomByName(...), etc.
 */
const { pool, ping } = require('./pool');
const repository = require('./repository');

module.exports = {
  pool,
  ping,
  ...repository,
};
