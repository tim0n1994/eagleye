#!/usr/bin/env node
/**
 * Eagleye — Read-only MCP Server
 *
 * Standalone process exposing Eagleye business data to MCP clients (ChatGPT,
 * Claude, Inspector) over Streamable HTTP on 127.0.0.1. The business database
 * is opened read-only; credentials-bearing tables are unreachable; every call
 * is audited; the admin switch (user_data key mcp_server_config) can disable
 * serving at runtime without restarting this process.
 *
 * Usage: node mcp/server.js [port]   (default 3020)
 *        node mcp/server.js --stdio  (local client transport)
 * Auth:  Authorization: Bearer <token from EAGLEYE_MCP_TOKEN or config/mcp-token>
 */

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { parsePort, getDBPath } = require('../server/config');
const { audit, closeAudit } = require('./audit');
const queries = require('./queries');
const { registerTools } = require('./tools');

const MCP_PORT = parsePort(process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : process.env.EAGLEYE_MCP_PORT, 3020);
const TOKEN_PATH = process.env.EAGLEYE_MCP_TOKEN_PATH?.trim()
  || path.resolve(__dirname, '..', 'config', 'mcp-token');
const SWITCH_POLL_MS = 5000;
const MAX_CONCURRENCY = 2;
const MAX_QUEUE = 10;
const QUEUE_WAIT_MS = 10000;
const MAX_BODY_BYTES = 1024 * 1024;

function resolveToken() {
  if (process.env.EAGLEYE_MCP_TOKEN?.trim()) return process.env.EAGLEYE_MCP_TOKEN.trim();
  try {
    const fromFile = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (fromFile) return fromFile;
  } catch { /* generate below */ }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, generated + '\n', { mode: 0o600 });
  console.log(`[mcp] generated bearer token at ${TOKEN_PATH}`);
  return generated;
}

const TOKEN = resolveToken();
const tokenHash = crypto.createHash('sha256').update(TOKEN).digest();

function authorized(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return false;
  const provided = crypto.createHash('sha256').update(match[1].trim()).digest();
  return crypto.timingSafeEqual(provided, tokenHash);
}

// --- Runtime admin switch: poll the (read-only) business DB ---
const enabledRef = { value: queries.isMcpEnabled() };
function pollSwitch() {
  try {
    enabledRef.value = queries.isMcpEnabled();
  } catch (err) {
    console.error('[mcp] switch poll failed:', err.message);
  }
}
setInterval(pollSwitch, SWITCH_POLL_MS).unref();

// --- Concurrency gate ---
let active = 0;
const queue = [];
function acquireSlot() {
  if (active < MAX_CONCURRENCY) {
    active += 1;
    return Promise.resolve();
  }
  if (queue.length >= MAX_QUEUE) return Promise.reject(new Error('Server busy'));
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject };
    queue.push(entry);
    setTimeout(() => {
      const idx = queue.indexOf(entry);
      if (idx !== -1) {
        queue.splice(idx, 1);
        reject(new Error('Server busy'));
      }
    }, QUEUE_WAIT_MS).unref();
  }).then(() => { active += 1; });
}
function releaseSlot() {
  active -= 1;
  const next = queue.shift();
  if (next) next.resolve();
}

function buildServer() {
  const server = new McpServer({ name: 'eagleye-readonly', version: '1.0.0' });
  registerTools(server, enabledRef);
  return server;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendText(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

class AuditedHttpTransport extends StreamableHTTPServerTransport {
  constructor(options, observeResponse) {
    super(options);
    this.observeResponse = observeResponse;
  }

  async send(message, options) {
    this.observeResponse(message);
    return super.send(message, options);
  }
}

async function handleMcpPost(req, res) {
  const started = Date.now();
  let toolName = 'initialize/unknown';
  let argsJson = '';
  let status = 'ok';
  let errorText = '';
  const requestId = crypto.randomUUID();
  res.setHeader('X-Eagleye-Request-Id', requestId);
  try {
    const raw = await readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(raw || '{}');
    } catch {
      sendText(res, 400, { error: 'Invalid JSON body' });
      status = 'bad_request';
      audit({ requestId, tool: 'unparseable', status, durationMs: Date.now() - started });
      return;
    }
    if (parsed && parsed.params && parsed.params.name) {
      toolName = String(parsed.params.name).slice(0, 100);
      argsJson = JSON.stringify(parsed.params.arguments || {});
    }
    if (!authorized(req)) {
      sendText(res, 401, { error: 'Unauthorized' });
      status = 'unauthorized';
      audit({ requestId, tool: toolName, argsJson, status, durationMs: Date.now() - started, error: 'unauthorized' });
      return;
    }
    if (Array.isArray(parsed)) {
      status = 'bad_request';
      sendText(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests are not supported; send one request per HTTP call.' } });
      audit({ requestId, tool: 'batch_rejected', argsJson: JSON.stringify(parsed), status, durationMs: Date.now() - started });
      return;
    }
    await acquireSlot();
    try {
      // Stateless mode: one transport per request, JSON responses only.
      const transport = new AuditedHttpTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      }, (message) => {
        if (message.id !== parsed?.id) return;
        if (message.error) {
          status = 'protocol_error';
          errorText = String(message.error.code);
        } else if (message.result?.isError === true) {
          status = 'tool_error';
          errorText = 'tool_result_is_error';
        }
      });
      const server = buildServer();
      await server.connect(transport);
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await transport.handleRequest(req, res, parsed);
      if (status === 'ok' && res.statusCode >= 400) status = 'protocol_error';
    } finally {
      releaseSlot();
    }
  } catch (err) {
    errorText = err.message || 'error';
    if (!res.headersSent) {
      sendText(res, err.message === 'Server busy' ? 429 : 500, { error: errorText });
    }
    status = err.message === 'Server busy' ? 'busy' : 'error';
  } finally {
    if (status !== 'unauthorized' && status !== 'bad_request') {
      audit({ requestId, tool: toolName, argsJson, status, durationMs: Date.now() - started, error: errorText });
    }
  }
}

function main() {
  if (process.argv.includes('--stdio')) {
    const server = buildServer();
    server.connect(new StdioServerTransport()).then(() => {
      console.error(`[mcp] eagleye-readonly stdio ready; db=${getDBPath()}; enabled=${enabledRef.value}`);
    });
    return;
  }
  const httpServer = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/health') {
      return sendText(res, 200, { ok: true, service: 'eagleye-readonly-mcp' });
    }
    if (urlPath !== '/mcp') return sendText(res, 404, { error: 'Not found' });
    if (req.method === 'POST') return handleMcpPost(req, res);
    // Stateless server keeps no SSE streams or sessions to terminate.
    return sendText(res, 405, { error: 'Method not allowed' });
  });
  httpServer.listen(MCP_PORT, '127.0.0.1', () => {
    console.log(`[mcp] eagleye-readonly listening on http://127.0.0.1:${MCP_PORT}/mcp (enabled=${enabledRef.value})`);
    console.log('[mcp] business DB opened READ-ONLY:', getDBPath());
  });
  const shutdown = () => {
    httpServer.close(() => {
      queries.closeRoDB();
      closeAudit();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
