// @vitest-environment node
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const https = require('https');
const { describe, it, expect, afterEach } = globalThis;

const servers = [];
const agents = [];

async function listen(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function loadUtils(env) {
  const module = { exports: {} };
  const options = {};
  class HTTPAgent extends http.Agent {
    constructor(opts) { super(opts); options.http = opts; agents.push(this); }
  }
  class HTTPSAgent extends https.Agent {
    constructor(opts) { super(opts); options.https = opts; agents.push(this); }
  }
  const filename = path.resolve(__dirname, '../utils.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, URL, Buffer, process: { env },
    require(name) {
      if (name === 'http') return { ...http, Agent: HTTPAgent };
      if (name === 'https') return { ...https, Agent: HTTPSAgent };
      return require(name);
    },
  }, { filename });
  return { ...module.exports, options };
}

afterEach(async () => {
  for (const agent of agents.splice(0)) agent.destroy();
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  })));
});

describe('connector HTTP proxy environment', () => {
  it('routes a request through the configured proxy and preserves the full URL', async () => {
    let directRequests = 0;
    let receivedURL;
    const origin = await listen((_req, res) => { directRequests++; res.end('direct'); });
    const proxy = await listen((req, res) => { receivedURL = req.url; res.end('proxy'); });
    const env = { HTTP_PROXY: proxy, HTTPS_PROXY: proxy };
    const utils = loadUtils(env);
    expect(await utils.fetchURL(`${origin}/stories?limit=5`)).toBe('proxy');
    expect(directRequests).toBe(0);
    expect(receivedURL).toBe(`${origin}/stories?limit=5`);
    expect(utils.options.http.proxyEnv).toBe(env);
    expect(utils.options.https.proxyEnv).toBe(env);
    expect(utils.options.https.rejectUnauthorized).not.toBe(false);
  });

  it('honors NO_PROXY for local services even with a proxy configured', async () => {
    let proxyRequests = 0;
    const origin = await listen((_req, res) => res.end('direct'));
    const proxy = await listen((_req, res) => { proxyRequests++; res.end('proxy'); });
    const utils = loadUtils({ HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: '127.0.0.1,localhost' });
    expect(await utils.fetchURL(`${origin}/local`)).toBe('direct');
    expect(proxyRequests).toBe(0);
  });

  it('tunnels HTTPS through HTTPS_PROXY without disabling TLS verification', async () => {
    const proxy = await listen((_req, res) => res.writeHead(502).end());
    const targets = [];
    servers.at(-1).on('connect', (req, socket) => {
      targets.push(req.url);
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    const utils = loadUtils({ HTTPS_PROXY: proxy });
    await expect(utils.fetchURL('https://example.invalid/private')).rejects.toThrow();
    expect(targets).toEqual(['example.invalid:443']);
    expect(utils.options.https.rejectUnauthorized).not.toBe(false);
  });

  it('preserves direct requests when proxy variables are absent', async () => {
    const origin = await listen((_req, res) => res.end('direct'));
    const utils = loadUtils({});
    expect(await utils.fetchURL(origin)).toBe('direct');
  });
});
