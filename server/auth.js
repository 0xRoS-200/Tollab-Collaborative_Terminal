/**
 * auth.js
 *
 * Password hashing via Node's built-in crypto.scrypt (no native
 * compilation needed, unlike bcrypt -- important for reliable Docker
 * builds across machines). Session auth via JWT.
 *
 * scrypt is a memory-hard KDF (similar security goals to bcrypt),
 * tunable via N/r/p cost params. We store salt + hash together as
 * "salt:hash" (both hex) in the single password_hash column.
 */

const { randomBytes, scrypt: scryptCb, timingSafeEqual } = require('crypto');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');

const scrypt = promisify(scryptCb);

const KEY_LEN = 64;
const SALT_LEN = 16;

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production';
const JWT_EXPIRES_IN = '7d';

/** Hash a plaintext password -> "salt:hash" string for storage. */
async function hashPassword(plain) {
  const salt = randomBytes(SALT_LEN).toString('hex');
  const derivedKey = await scrypt(plain, salt, KEY_LEN);
  return `${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Verify a plaintext password against a stored "salt:hash" string.
 * Uses timingSafeEqual to avoid leaking match-length via timing.
 */
async function verifyPassword(plain, stored) {
  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) return false;

  const derivedKey = await scrypt(plain, salt, KEY_LEN);
  const storedBuf = Buffer.from(hashHex, 'hex');

  if (storedBuf.length !== derivedKey.length) return false;
  return timingSafeEqual(storedBuf, derivedKey);
}

/** Issue a JWT for an authenticated user. */
function issueToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/** Verify a JWT, returns decoded payload or throws. */
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = { hashPassword, verifyPassword, issueToken, verifyToken };
