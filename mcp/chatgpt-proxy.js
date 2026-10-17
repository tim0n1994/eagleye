#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = Number(process.argv[2] || process.env.EAGLEYE_MCP_PROXY_PORT || 3021);
const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = Number(process.env.EAGLEYE_MCP_PROXY_TARGET_PORT || 3020);
const CONFIG_DIR = path.resolve(__dirname, '..', 'config');
const TOKEN_PATH = path.join(CONFIG_DIR, 'mcp-token');
const SECRET_PATH = path.join(CONFIG_DIR, 'mcp-tunnel-secret');

function readTrimmed(filePath) {
  return fs.readFileSync(filePath, 'utf8').trim();
}

function ensureSecret() {
  try {
    const existing = readTrimmed(SECRET_PATH);
    if (existing) return existing;
  } catch {}
  const generated = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(SECRET_PATH, generated + '\n', { mode: 0o600 });
  console.log(`[mcp-proxy] generated tunnel secret at ${SECRET_PATH}`);
  return generated;
}

const TOKEN = readTrimmed(TOKEN_PATH);
const SECRET = ensureSecret();
const expectedSecretDigest = crypto.createHash('sha256').update(SECRET).digest();

function secretMatches(candidate) {
  const provided = crypto.createHash('sha256').update(String(candidate || '')).digest();
  return crypto.timingSafeEqual(provided, expectedSecretDigest);
}

function proxy(req, res) {
  const segments = (req.url || '/').split('/').filter(Boolean);
  if (segments.length !== 2 || !secretMatches(segments[0])) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  const upstream = http.request({
    host: TARGET_HOST,
    port: TARGET_PORT,
    path: `/${segments[1]}`,
    method: req.method,
    headers: { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}`, authorization: `Bearer ${TOKEN}` },
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'MCP upstream unavailable' }));
  });
  req.pipe(upstream);
}

http.createServer(proxy).listen(PORT, '127.0.0.1', () => {
  console.log(`[mcp-proxy] listening on http://127.0.0.1:${PORT}/<secret>/{mcp,health} -> ${TARGET_HOST}:${TARGET_PORT}`);
});
