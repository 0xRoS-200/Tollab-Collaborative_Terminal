/**
 * apiClient.js
 *
 * Thin wrapper around the server's REST endpoints, used before the
 * WebSocket connection is established (you need a JWT before you can
 * open the WS connection at all -- see wsClient.js).
 */

const http = require('http');
const https = require('https');

function request(baseUrl, path, method, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const payload = body ? JSON.stringify(body) : null;
    const req = lib.request(
      url,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = { error: 'Invalid response from server' };
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(parsed.error || `Request failed with status ${res.statusCode}`));
          }
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }

  register(username, password) {
    return request(this.baseUrl, '/api/register', 'POST', { username, password });
  }

  login(username, password) {
    return request(this.baseUrl, '/api/login', 'POST', { username, password });
  }

  resetPassword(username, password) {
    return request(this.baseUrl, '/api/reset-password', 'POST', { username, password });
  }
}

module.exports = { ApiClient };
