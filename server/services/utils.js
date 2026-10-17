/**
 * Eagleye — Server Utilities
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');

const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 16, timeout: 30000, proxyEnv: process.env });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 16, timeout: 30000, proxyEnv: process.env });

function generateId() {
  return crypto.randomUUID();
}

async function fetchURL(targetUrl, options = {}) {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const timeoutMs = options.timeoutMs || parseInt(process.env.FETCH_TIMEOUT_MS || '15000', 10);
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      signal: options.signal,
      agent: isHttps ? HTTPS_AGENT : HTTP_AGENT,
      headers: {
        'User-Agent': 'EagleyeBot/1.0',
        'Accept': 'application/json, application/xml, text/xml, */*',
        'Connection': 'keep-alive',
        ...options.headers,
      },
    };

    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(reqOpts, (proxyRes) => {
      const chunks = [];
      proxyRes.on('error', reject);
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
          resolve(body);
        } else {
          reject(new Error(`Upstream ${proxyRes.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

/**
 * Simple hash for deduplication
 */
function contentHash(text) {
  if (!text) return '';
  return crypto.createHash('md5').update(text).digest('hex');
}

/**
 * Escape a string for safe use in XML/Atom feeds.
 */
function escapeXML(str) {
  return String(str || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = { generateId, fetchURL, contentHash, escapeXML };
