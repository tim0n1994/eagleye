// @vitest-environment node
/* global describe, it, expect, beforeAll, afterAll, beforeEach */
/**
 * 案 2 RED 测试 — LLM pool 配置写库路径脱敏（fix-morning-1022，分支自 main dc1fe65）
 *
 * 契约（任务书【范围】）：
 *   ① 结构化字段：任何落库路径中 api_key/authorization/LLM_API_KEY 值 → <redacted>（或等价脱敏）；
 *   ② JSON 字符串内嵌形态（被 JSON.stringify 后再落库的字符串里内嵌 key）也要脱；
 *   ③ 既有写入者逐个断言 —— 诊断定位的唯一明文写链：
 *        routes/llm-pool.js:19-24  PUT /api/settings/llm/pool（parsePastedPoolConfig masked:false）
 *        → services/llm-pool.js:282-284  savePoolConfig → setValue("llm_pool_config", next)
 *        → db/user-data.js:36-40  INSERT OR REPLACE INTO user_data + JSON.stringify（value 列）；
 *   ④ redaction 失败（异常）时宁可不落该字段也不落明文。
 *
 * 本文件除最后一个「回归锁」用例（当前应通过）外，全部为 RED：当前实现没有写库前脱敏，
 * 这些用例必须失败，失败消息即缺失契约（RED（预期失败，非环境错误）: …）。
 * 修复（写库前 redact，结构化+JSON 内嵌两形态，fail-closed）完成后应全部转 GREEN。
 *
 * 哨兵 key 全部为合成值，与生产 .env 的真实 LLM_API_KEY 无关。
 */

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const Database = require("better-sqlite3");

// —— 临时数据库（生产式真实写链）。必须在 require 任何 server 模块之前设置，
//     同 server/services/__tests__/runtime-switches-routes.test.js 的既有模式。 ——
const previousDbPath = process.env.EAGLEYE_DB_PATH;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eagleye-redact-red-"));
process.env.EAGLEYE_DB_PATH = path.join(directory, "redact-red.sqlite");

const { getDB, closeDB } = require("../../db/connection");
const { setValue } = require("../../db/user-data");
const registerPoolRoutes = require("../../routes/llm-pool");
const { createPoolService } = require("../../services/llm-pool");
const { TASKS, maskConfig } = require("../../services/llm-pool-config");

const RED_PREFIX = "RED（预期失败，非环境错误）";
const PLAIN = "sk-RED-PLAINTEXT-7f3a9c"; // 结构化字段哨兵（合成值）
const EMBED = "sk-RED-EMBEDDED-2b6e41";  // JSON 字符串内嵌哨兵（合成值）

function contract(message, detail) {
  throw new Error(`${RED_PREFIX}: ${message}${detail ? ` — ${detail}` : ""}`);
}

// 「等价脱敏」形态：<redacted>（任意大小写）/ •••• 类掩码 / ${ENV_REF} 环境引用占位。
// 空串不算：validatePoolConfig 重载时要求 api_key 非空，存空串会把池配成不可用。
function isRedactionMarker(value) {
  return typeof value === "string" && value.length > 0 && (
    /redacted/i.test(value) || /^[•*]{3,}$/.test(value) || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)
  );
}

function endpointWithKey(key, overrides = {}) {
  return { id: "lane-1", label: "Lane 1", protocol: "anthropic",
    endpoint_url: "http://127.0.0.1:45671/v1/messages", api_key: key, model: "red-model",
    enabled: true, concurrency: 1, tasks: [...TASKS], ...overrides };
}

function poolConfig(endpoints, overrides = {}) {
  return { schema_version: 1, enabled: false, global_concurrency: 2, queue_limit: 20,
    request_timeout_ms: 2000, queue_timeout_ms: 1000, max_attempts: 2, endpoints, ...overrides };
}

function rawRow(key) {
  return getDB().prepare("SELECT value FROM user_data WHERE key = ? AND user_id = ''").get(key);
}

let routes;
beforeAll(() => {
  getDB().exec([
    "CREATE TABLE user_data (",
    "  key TEXT NOT NULL,",
    "  user_id TEXT NOT NULL DEFAULT '',",
    "  value TEXT,",
    "  PRIMARY KEY (key, user_id)",
    ")",
  ].join("\n"));
  routes = {};
  registerPoolRoutes(routes);
});

beforeEach(() => {
  getDB().prepare("DELETE FROM user_data").run();
});

afterAll(() => {
  closeDB();
  if (previousDbPath === undefined) delete process.env.EAGLEYE_DB_PATH;
  else process.env.EAGLEYE_DB_PATH = previousDbPath;
  fs.rmSync(directory, { recursive: true, force: true });
});

async function callPoolRoute(method, body) {
  const raw = body === undefined ? null : JSON.stringify(body);
  const req = Readable.from(raw === null ? [] : [raw]);
  Object.assign(req, { method, url: "/api/settings/llm/pool", user: { id: "admin-test", role: "admin" } });
  let statusCode = 0;
  let rawResponse = "";
  const res = { writeHead(code) { statusCode = code; }, end(chunk) { rawResponse = chunk; } };
  await routes["/api/settings/llm/pool"](req, res);
  await new Promise(resolve => setImmediate(resolve));
  return { status: statusCode, body: rawResponse ? JSON.parse(rawResponse) : null };
}

describe("案2 RED · 写入者① services/llm-pool.js savePoolConfig → setValue（service 层写链）", () => {
  it("T1 结构化字段：交给 setValue 落库的 endpoints[].api_key 不得是明文，必须是可识别脱敏形态", () => {
    const store = new Map();
    const pool = createPoolService({
      getValue: key => store.get(key),
      setValue: (key, value) => store.set(key, value),
      now: () => 1700000000000,
    });
    const saved = pool.savePoolConfig(poolConfig([endpointWithKey(PLAIN)]));
    const persisted = store.get("llm_pool_config");
    if (!persisted) contract("savePoolConfig 必须把配置交给 setValue 落库（当前未捕获到写入，请先排查测试环境）");
    const raw = JSON.stringify(persisted);
    if (raw.includes(PLAIN)) {
      contract("savePoolConfig 落库值含明文 api_key：setValue 收到的 llm_pool_config 必须在写库前把 endpoints[].api_key 替换为 <redacted>（或等价脱敏：•••• 掩码 / ${ENV_REF} 引用），任何路径不得落明文", `captured=${raw}`);
    }
    const keys = (persisted.endpoints || []).map(endpoint => endpoint.api_key);
    if (!keys.every(isRedactionMarker)) {
      contract("落库的 endpoints[].api_key 必须保留为可识别的脱敏形态（<redacted> / •••• / ${ENV_REF}），不能是明文也不能是空串（空串会让 validatePoolConfig 重载失败）", `api_keys=${JSON.stringify(keys)}`);
    }
    // 补充（当前已通过）：保存返回值保持掩码
    expect(saved.endpoints[0].api_key).toBe("••••");
  });

  it("T4 掩码视图/原样回存不得复活明文（validatePoolConfig:66 对 masked 入参沿用旧 key 的路径）", () => {
    const store = new Map();
    const pool = createPoolService({
      getValue: key => store.get(key),
      setValue: (key, value) => store.set(key, value),
    });
    pool.savePoolConfig(poolConfig([endpointWithKey(PLAIN)]));
    // 回存形态 A：UI 拿到 GET 默认的掩码配置后原样 PUT 回来
    pool.savePoolConfig(maskConfig(store.get("llm_pool_config")));
    // 回存形态 B：把库里读到的配置原样回存
    pool.savePoolConfig(JSON.parse(JSON.stringify(store.get("llm_pool_config"))));
    const raw = JSON.stringify(store.get("llm_pool_config"));
    if (raw.includes(PLAIN)) {
      contract("掩码/原样回存路径把明文 api_key 重新写回：validatePoolConfig 对 masked 入参沿用旧 key 时旧 key 也必须是脱敏形态；redact 后的存储值重存必须幂等，任何回存路径不得复活明文", `captured=${raw}`);
    }
  });
});

describe("案2 RED · 写入者② db/user-data.js setValue（唯一落库点，user_data.value 列）", () => {
  it("T2a 结构化字段形态：setValue 落库的 value JSON 中 api_key 字段值必须脱敏", () => {
    setValue("llm_pool_config", poolConfig([endpointWithKey(PLAIN)]));
    const raw = rawRow("llm_pool_config")?.value ?? "";
    if (raw.includes(PLAIN)) {
      contract("setValue 落库的 user_data.value 中 endpoints[].api_key 仍为明文：写库前必须替换为 <redacted>（或等价脱敏）", `value=${raw}`);
    }
    const stored = JSON.parse(raw);
    if (!(stored.endpoints || []).every(endpoint => isRedactionMarker(endpoint.api_key))) {
      contract("setValue 落库的 endpoints[].api_key 必须是可识别脱敏形态", `api_keys=${JSON.stringify((stored.endpoints || []).map(e => e.api_key))}`);
    }
  });

  it("T2b JSON 字符串内嵌形态：value 中被 JSON.stringify 后再落库的字符串（如 headers）内嵌 authorization/api_key/LLM_API_KEY 明文时同样必须脱敏", () => {
    const embedded = JSON.stringify({ authorization: `Bearer ${EMBED}`, api_key: EMBED, LLM_API_KEY: EMBED });
    // 结构化形态的脱敏由 T2a 单独断言；这里 endpoint.api_key 用占位值，只考内嵌形态。
    setValue("llm_pool_config", poolConfig([Object.assign(endpointWithKey("placeholder-not-a-secret"), { headers: embedded })]));
    const raw = rawRow("llm_pool_config")?.value ?? "";
    if (raw.includes(EMBED)) {
      contract("JSON 字符串内嵌形态未脱敏：value 里嵌套的 JSON 字符串（headers 字段）内的 authorization/api_key/LLM_API_KEY 值必须同样替换为 <redacted>（或等价脱敏）后整体落库，明文不得以任何嵌套形态出现在 user_data.value", `value=${raw}`);
    }
  });

  it("T5 redaction 异常必须 fail-closed：抛错字段宁可丢弃，也不得让整笔写入回退成明文落库", () => {
    const value = poolConfig([endpointWithKey(PLAIN)]);
    Object.defineProperty(value, "debug_meta", { enumerable: true, get() { throw new Error("redaction-hostile-field"); } });
    let writeError = null;
    try { setValue("llm_pool_config", value); } catch (error) { writeError = error; }
    const row = rawRow("llm_pool_config");
    if (row && row.value.includes(PLAIN)) {
      contract("redaction 异常路径落了明文：脱敏处理抛错时绝不能回退为原值落盘（宁可不落该字段也不落明文）", `value=${row.value}`);
    }
    if (writeError || !row) {
      contract("缺少 fail-closed 写库脱敏：某字段处理抛错时必须只丢弃该字段（这里模拟 debug_meta 抛错），其余已脱敏配置仍应完成落库，而不是整行写入失败或明文落库", writeError ? `setValue 抛错: ${writeError.message}` : "user_data 行缺失");
    }
  });
});

describe("案2 RED · 写入者③ routes/llm-pool.js PUT /api/settings/llm/pool（HTTP 入口写链）", () => {
  it("T3 PUT pasted 明文 key 的配置 → user_data.value 列不得含明文，endpoints[].api_key 必须是脱敏形态", async () => {
    const pasted = [
      "Provider: Red Lane 1",
      "Protocol: Anthropic Messages",
      "Messages URL: http://127.0.0.1:45671/v1/messages",
      `API Key: ${PLAIN}`,
      "Model: red-model",
    ].join("\n");
    const put = await callPoolRoute("PUT", { pasted, enabled: true });
    if (put.status !== 200) {
      contract(`PUT /api/settings/llm/pool 应接受该合法 pasted 配置（status=${put.status}；若此处失败属环境/夹具问题，请先排查再重跑）`, JSON.stringify(put.body));
    }
    const raw = rawRow("llm_pool_config")?.value ?? "";
    if (raw.includes(PLAIN)) {
      contract("PUT 落库明文：routes/llm-pool.js parsePastedPoolConfig(masked:false) → savePoolConfig → setValue 的完整写链必须写库前脱敏，user_data.value 不得含明文 api_key", `value=${raw}`);
    }
    const stored = JSON.parse(raw);
    if (!(stored.endpoints || []).every(endpoint => isRedactionMarker(endpoint.api_key))) {
      contract("PUT 落库的 endpoints[].api_key 必须是可识别脱敏形态", `api_keys=${JSON.stringify((stored.endpoints || []).map(e => e.api_key))}`);
    }
    // 补充（当前已通过，回归锁）：GET 返回掩码配置，不回显明文
    const got = await callPoolRoute("GET");
    expect(got.status).toBe(200);
    expect(JSON.stringify(got.body.config)).not.toContain(PLAIN);
  });
});

describe("案2 回归锁 · llm_request_events 不落 key（诊断已证该表仅遥测列，当前应通过）", () => {
  it("T6 一次成功请求写入的 llm_request_events 所有列均不含明文 api_key", async () => {
    const db = new Database(":memory:");
    try {
      db.exec(fs.readFileSync(path.resolve(__dirname, "../../migrations/031_llm_request_events.sql"), "utf8"));
      db.exec(fs.readFileSync(path.resolve(__dirname, "../../migrations/038_llm_error_class.sql"), "utf8"));
      const store = new Map();
      const server = http.createServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ model: "red-model", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      try {
        const pool = createPoolService({ getDB: () => db, getValue: key => store.get(key), setValue: (key, value) => store.set(key, value) });
        pool.savePoolConfig(poolConfig([
          endpointWithKey(PLAIN, { endpoint_url: `http://127.0.0.1:${server.address().port}/v1/messages` }),
        ], { enabled: true }));
        const text = await pool.getPoolProvider("general").call("ping");
        expect(text).toBe("ok");
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      const rows = db.prepare("SELECT * FROM llm_request_events").all();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        for (const cell of Object.values(row)) {
          expect(String(cell)).not.toContain(PLAIN);
        }
      }
    } finally {
      db.close();
    }
  });
});
