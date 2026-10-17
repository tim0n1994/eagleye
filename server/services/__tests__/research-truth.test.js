// @vitest-environment node
const { describe, it, expect, beforeEach, afterEach, vi } = globalThis;
const Database = require('better-sqlite3');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

function load(relative, mocks) {
  const filename = path.resolve(__dirname, relative);
  const subject = new Module(filename, module);
  subject.filename = filename;
  subject.paths = module.paths;
  subject.require = id => Object.hasOwn(mocks, id) ? mocks[id] : require(Module.createRequire(filename).resolve(id));
  subject._compile(fs.readFileSync(filename, 'utf8'), filename);
  return subject.exports;
}

describe('research output truth and method contracts', () => {
  let db, provider, service, routes;
  const metadata = { endpoint_id: 'lane-3', protocol: 'anthropic', provider: 'anthropic', requested_model: 'requested', model: 'actual-returned-model', trace_id: 'trace-3' };
  const analysisText = (quote = 'A source item', interpretation = '可能值得进一步查看实现，尚需核验代码。') => JSON.stringify({
    observations: [{ evidence_id: 'title', quote, interpretation }],
    open_questions: ['需要查阅哪些代码才能确认实现方式？'],
  });

  beforeEach(() => {
    db = new Database(':memory:');
    for (const name of ['001_initial_schema.sql', '002_i18n_translations.sql', '009_alpha_radar.sql', '010_tag_hierarchy.sql', '011_tag_hierarchy_dag.sql', '012_concept_graph.sql', '032_llm_output_metadata.sql']) {
      db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations', name), 'utf8'));
    }
    db.exec("CREATE TABLE research (url TEXT PRIMARY KEY, content TEXT)");
    db.prepare('INSERT INTO sources (id,slug,label) VALUES (?,?,?)').run('test-source', 'test-source', 'Test');
    db.prepare(`INSERT INTO information_items (id,source_id,title,canonical_url,digest_date,original_summary,source_payload)
      VALUES (?,?,?,?,?,?,?)`).run('item-1', 'test-source', 'A source item', 'https://example.com/item', '20260909', 'Stored source excerpt', JSON.stringify({ readme_excerpt: 'Local README excerpt' }));
    provider = { name: 'pool', isPool: true, model: 'configured-not-actual', callWithMetadata: vi.fn(async (_prompt, opts) => ({ text: opts.json ? analysisText() : '# Report\nEvidence is limited.', metadata })) };
    service = load('../research.js', { '../db/connection': { getDB: () => db }, './llm-provider': { getProvider: () => provider } });
    routes = {};
    load('../../routes/research.js', {
      '../db/connection': { getDB: () => db }, '../services/research': service,
      '../services/skill-crawler': {}, './_shared': {
        ...load('../../routes/_shared.js', { '../services/auth': {}, '../services/rate-limit': {} }),
      },
    })(routes);
  });

  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  async function request(method, query = {}, body = {}) {
    const req = new EventEmitter();
    req.method = method; req.user = { id: 'member-1', role: 'user' };
    const response = {};
    const res = { writeHead: status => { response.status = status; }, end: data => { response.body = JSON.parse(data); } };
    const pending = routes['/api/research'](req, res, { query });
    if (method === 'POST') { req.emit('data', JSON.stringify(body)); req.emit('end'); }
    await pending;
    return response;
  }

  it('persists the actual response model and trace, not global configuration', async () => {
    const result = await service.generateItemResearch('item-1');
    const report = service.getResearchReport(result.id);
    expect(report).toMatchObject({ status: 'completed', model_name: 'actual-returned-model', model_provider: 'anthropic' });
    expect(JSON.parse(report.llm_metadata)).toMatchObject(metadata);
    expect(provider.callWithMetadata).toHaveBeenCalledWith(expect.stringContaining('Stored source excerpt'), expect.objectContaining({ task: 'research', validate: expect.any(Function) }));
  });

  it('keeps model attribution independent when concurrent research finishes out of order', async () => {
    db.prepare('INSERT INTO information_items(id,source_id,title,canonical_url,digest_date) VALUES(?,?,?,?,?)')
      .run('item-2', 'test-source', 'Second item', 'https://example.com/second', '20260909');
    let finishFirst;
    provider.callWithMetadata.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ text: analysisText('Second item'), metadata: { ...metadata, model: 'model-b', trace_id: 'trace-b' } });
    const first = service.generateItemResearch('item-1');
    const second = await service.generateItemResearch('item-2');
    finishFirst({ text: analysisText(), metadata: { ...metadata, model: 'model-a', trace_id: 'trace-a' } });
    const firstReport = service.getResearchReport((await first).id);
    const secondReport = service.getResearchReport(second.id);
    expect(firstReport.model_name).toBe('model-a');
    expect(JSON.parse(firstReport.llm_metadata).trace_id).toBe('trace-a');
    expect(secondReport.model_name).toBe('model-b');
    expect(JSON.parse(secondReport.llm_metadata).trace_id).toBe('trace-b');
  });

  it.each(['', '  \n\t '])('records empty output as failure without multiplying pool attempts (%j)', async text => {
    provider.callWithMetadata.mockResolvedValue({ text, metadata });
    const result = await service.generateItemResearch('item-1');
    expect(result.error).toBeTruthy();
    expect(service.getResearchReport(result.id)).toMatchObject({ status: 'failed', report_markdown: null });
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
  });

  it('marks transport failure terminal and does not loop over the pool', async () => {
    provider.callWithMetadata.mockRejectedValue(new Error('All endpoints unavailable'));
    const result = await service.generateItemResearch('item-1');
    expect(service.getResearchReport(result.id).status).toBe('failed');
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('cancellation prevents a late item report and any retry (pool=%s)', async isPool => {
    const controller = new AbortController();
    provider.isPool = isPool;
    let finish;
    provider.callWithMetadata.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = service.generateItemResearch('item-1', { signal: controller.signal });
    expect(provider.callWithMetadata.mock.calls[0][1].signal).toBe(controller.signal);
    controller.abort();
    finish({ text: '# Late response', metadata });
    const result = await pending;
    expect(result.error).toContain('cancelled');
    expect(service.getResearchReport(result.id)).toMatchObject({ status: 'failed', report_markdown: null });
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
  });

  it('pre-cancelled research creates no report and makes no request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(service.generateItemResearch('item-1', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider.callWithMetadata).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) n FROM research_reports').get().n).toBe(0);
  });

  it('discloses missing original text and never claims to fetch the URL', async () => {
    db.exec("UPDATE information_items SET original_summary = NULL, content_text = NULL");
    await service.generateItemResearch('item-1');
    const prompt = provider.callWithMetadata.mock.calls[0][0];
    expect(prompt).toContain('未取得原文或原始摘录');
    expect(prompt).toContain('本次没有联网读取 URL');
  });

  it('separates short source evidence from AI-derived claims and renders literal evidence', async () => {
    const original = 'Sketch M3E screens in the browser and generate vibe-coding prompts.';
    db.prepare('UPDATE information_items SET title=?,title_zh=?,original_summary=?,source_payload=? WHERE id=?')
      .run('lnkiai/m3e-canvas', 'Next.js React AI title', original, JSON.stringify({ tags: ['React'], tech_stack: ['Next.js'], readme_excerpt: '' }), 'item-1');
    db.prepare("INSERT INTO ai_summaries (id,item_id,short_summary,model_provider,model_name,prompt_version) VALUES (?,?,?,'fixture','fixture','fixture')")
      .run('ai-1', 'item-1', 'Next.js/React improves output by 80% and 10倍');
    provider.callWithMetadata.mockResolvedValue({ text: JSON.stringify({ observations: [{ evidence_id: 'source_excerpt', quote: original,
      interpretation: '可能用于把界面草图转成提示词，具体实现尚需查阅代码。' }], open_questions: ['如何验证导出提示词的实际效果？'] }), metadata });
    const result = await service.generateItemResearch('item-1');
    expect(result.error).toBeUndefined();
    const [prompt, opts] = provider.callWithMetadata.mock.calls[0];
    expect(prompt).not.toMatch(/Next\.js|React|80%|10倍/);
    expect(opts).toMatchObject({ json: true, maxTokens: 2000, task: 'research' });
    expect(result.report).toContain('## 存储的来源材料');
    expect(result.report).toContain(`> ${original}`);
    expect(result.report).toContain('URL：https://example.com/item');
    expect(result.report).toContain('## 模型分析，待核验');
    expect(result.report).toContain('仅有短描述');
    expect(result.report).not.toMatch(/Next\.js|React|80%|10倍|已证实|\[原文\]/);
  });

  it.each([
    ['invented quote', { evidence_id: 'source_excerpt', quote: 'Next.js and React', interpretation: '可能采用上述技术栈。' }],
    ['unknown source', { evidence_id: 'ai_summary', quote: 'A source item', interpretation: '可能有价值。' }],
    ['false provenance', { evidence_id: 'title', quote: 'A source item', interpretation: '可能有价值，[原文]已证实使用 React。' }],
    ['unsupported percent', { evidence_id: 'title', quote: 'A source item', interpretation: '可能达到80%的还原度。' }],
    ['unsupported multiple', { evidence_id: 'title', quote: 'A source item', interpretation: '可能提升10倍速度。' }],
    ['unsupported Chinese quantity', { evidence_id: 'title', quote: 'A source item', interpretation: '可能提升十倍速度。' }],
    ['asserted analysis', { evidence_id: 'title', quote: 'A source item', interpretation: '项目基于 Next.js 与 React 构建。' }],
  ])('rejects %s before saving a completed report', async (_name, observation) => {
    provider.callWithMetadata.mockResolvedValue({ text: JSON.stringify({ observations: [observation], open_questions: ['实现方式是什么？'] }), metadata });
    const result = await service.generateItemResearch('item-1');
    expect(result.error).toBeTruthy();
    expect(service.getResearchReport(result.id)).toMatchObject({ status: 'failed', report_markdown: null });
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
  });

  it('rejects the actual failed live Markdown report instead of preserving false source claims', async () => {
    const failedLiveExcerpt = '## 这件事到底是什么\n3. **技术栈**：[原文] 基于 TypeScript、React、Next.js 构建，属于标准的现代前端开源 Web 应用程序。\n## 反面观点与不确定性\n开发者直接“截图/手绘草图发给模型”即可获得 80% 的还原度。';
    provider.callWithMetadata.mockResolvedValue({ text: failedLiveExcerpt, metadata });
    const result = await service.generateItemResearch('item-1');
    expect(result.error).toBeTruthy();
    expect(service.getResearchReport(result.id).status).toBe('failed');
  });

  it('GET cache miss is read-only and POST resolves a URL to the stored item', async () => {
    expect((await request('GET', { url: 'https://example.com/item' })).status).toBe(404);
    expect(provider.callWithMetadata).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) n FROM research_reports').get().n).toBe(0);
    const result = await request('POST', {}, { url: 'https://example.com/item' });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ cached: false, model_name: 'actual-returned-model' });
    expect((await request('GET', { url: 'https://example.com/item' })).body.cached).toBe(true);
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
  });

  it('rejects unimported URLs and never writes an empty legacy success cache', async () => {
    expect((await request('POST', {}, { url: 'https://example.com/unknown' })).status).toBe(422);
    provider.callWithMetadata.mockRejectedValue(new Error('endpoint down'));
    expect((await request('POST', {}, { item_id: 'item-1' })).status).toBe(502);
    expect(db.prepare('SELECT COUNT(*) n FROM research').get().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM research_reports WHERE status='completed'").get().n).toBe(0);
    expect((await request('DELETE', { item_id: 'item-1' })).status).toBe(405);
  });

  it.each(['', ' \t\n\r '])('ignores empty historical completed reports (%j)', async content => {
    db.prepare("INSERT INTO research_reports (id,item_id,prompt,status,report_markdown) VALUES ('empty','item-1','','completed',?)").run(content);
    expect((await request('GET', { item_id: 'item-1' })).status).toBe(404);
    expect((await request('POST', {}, { item_id: 'item-1' })).status).toBe(200);
    expect(provider.callWithMetadata).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed request shape before any generation', async () => {
    expect((await request('POST', {}, null)).status).toBe(400);
    expect((await request('POST', {}, [])).status).toBe(400);
    expect(provider.callWithMetadata).not.toHaveBeenCalled();
  });

  it('item generation routes reject GET without calling providers', async () => {
    const itemRoutes = {};
    load('../../routes/items.js', { '../db/connection': { getDB: () => db }, '../services/research': service,
      '../services/deploy': {}, './_shared': load('../../routes/_shared.js', { '../services/auth': {}, '../services/rate-limit': {} }),
    })(itemRoutes);
    for (const route of ['/api/items/:id/research', '/api/items/:id/research/chat', '/api/items/:id/deployment-plan']) {
      let status;
      await itemRoutes[route]({ method: 'GET', user: { role: 'user' } }, { writeHead: code => { status = code; }, end: () => {} }, { query: {} }, { id: 'item-1' });
      expect(status).toBe(405);
    }
    expect(provider.callWithMetadata).not.toHaveBeenCalled();
  });

  it('returns actual metadata in research chat', async () => {
    const result = await service.answerItemResearchChat('item-1', 'What is known?');
    expect(result).toMatchObject({ model_name: metadata.model, llm_metadata: metadata });
  });

  it('persists topic report metadata with explicit evidence limits', async () => {
    const topic = db.prepare('SELECT id,slug FROM topics LIMIT 1').get();
    if (!topic) db.exec("INSERT INTO topics(id,slug,name) VALUES('topic-1','test-topic','Test topic')");
    const result = await service.generateTopicResearch(topic?.slug || 'test-topic');
    expect(service.getResearchReport(result.id).model_name).toBe(metadata.model);
    expect(provider.callWithMetadata.mock.calls[0][0]).toContain('没有读取 URL 原文');
  });

  it('deployment failure remains terminal on the real schema', async () => {
    const deploy = load('../deploy.js', { '../db/connection': { getDB: () => db }, './llm-provider': { getProvider: () => provider },
      './utils': { generateId: () => 'plan-1', fetchURL: vi.fn(() => { throw new Error('No network allowed'); }) } });
    provider.callWithMetadata.mockResolvedValue({ text: ' ', metadata });
    const result = await deploy.generateDeployPlan('item-1');
    expect(result.error).toBeTruthy();
    const row = db.prepare('SELECT * FROM deployment_plans').get();
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.risk_notes)[0]).toBeTruthy();
    expect(provider.callWithMetadata.mock.calls[0][1].task).toBe('general');
  });

  it.each(['round1', 'round2'])('graph rejects invalid JSON shape once in pool mode at %s', async failedRound => {
    const names = Array.from({ length: 30 }, (_, index) => `模型技术${index}`);
    for (const [index, name] of names.entries()) {
      db.prepare('INSERT INTO tags (id,slug,name,type) VALUES (?,?,?,?)').run(`tag-${index}`, `tag-${index}`, name, 'llm-extracted');
      db.prepare('INSERT INTO item_tags (item_id,tag_id) VALUES (?,?)').run('item-1', `tag-${index}`);
    }
    provider.call = vi.fn().mockResolvedValue('{}');
    if (failedRound === 'round2') provider.call.mockResolvedValueOnce(JSON.stringify({ sub_topics: [{ name_zh: '模型技术', tags: names }] }));
    const graph = load('../tag-hierarchy.js', {
      '../db/connection': { getDB: () => db },
      './llm-provider': { getProvider: () => provider, extractJSON: JSON.parse },
    });
    const before = db.prepare('SELECT COUNT(*) n FROM tag_hierarchy').get().n;
    await expect(graph.buildTagHierarchy()).rejects.toThrow(failedRound === 'round1' ? 'Round 1' : 'Round 2');
    expect(provider.call).toHaveBeenCalledTimes(failedRound === 'round1' ? 1 : 2);
    expect(provider.call.mock.calls.every(([, options]) => options.task === 'graph' && options.json && typeof options.validate === 'function')).toBe(true);
    expect(provider.call.mock.calls.every(([, options]) => options.validate(null) === false)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) n FROM tag_hierarchy').get().n).toBe(before);
  });

  it('RAG with no retrieved evidence returns an explicit limit without calling a model', async () => {
    const rag = load('../es-rag.js', { './llm-provider': { getProvider: () => provider },
      './elasticsearch': { ES_HOST: '', esAvailable: vi.fn(), getQueryEmbedding: vi.fn(), esRequest: vi.fn() } });
    const result = await rag.ragChat('What happened?');
    expect(result).toMatchObject({ mode: 'no-evidence', degraded: true, sources: [] });
    expect(result.answer).toContain('没有足够信息');
    expect(provider.callWithMetadata).not.toHaveBeenCalled();
  });

  it.each(['round1', 'round2'])('cancelling graph %s preserves the prior hierarchy', async round => {
    const controller = new AbortController();
    const names = Array.from({ length: 30 }, (_, index) => `模型技术${index}`);
    for (const [index, name] of names.entries()) {
      db.prepare('INSERT INTO tags (id,slug,name,type) VALUES (?,?,?,?)').run(`tag-${index}`, `tag-${index}`, name, 'llm-extracted');
      db.prepare('INSERT INTO item_tags (item_id,tag_id) VALUES (?,?)').run('item-1', `tag-${index}`);
    }
    db.prepare('INSERT INTO knowledge_domains (id,slug,name,name_zh) VALUES (?,?,?,?)').run('prior', 'prior', 'Prior', '已有图谱');
    const first = JSON.stringify({ sub_topics: [{ name_zh: '模型技术', tags: names }] });
    provider.call = vi.fn(async () => { controller.abort(); return first; });
    if (round === 'round2') provider.call.mockResolvedValueOnce(first);
    const graph = load('../tag-hierarchy.js', {
      '../db/connection': { getDB: () => db },
      './llm-provider': { getProvider: () => provider, extractJSON: JSON.parse },
    });
    await expect(graph.buildTagHierarchy({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider.call).toHaveBeenCalledTimes(round === 'round1' ? 1 : 2);
    expect(provider.call.mock.calls.every(([, opts]) => opts.signal === controller.signal)).toBe(true);
    expect(db.prepare('SELECT name_zh FROM knowledge_domains WHERE id=?').get('prior').name_zh).toBe('已有图谱');
    expect(db.prepare('SELECT COUNT(*) n FROM kg_concept_runs').get().n).toBe(0);
  });

  it('RAG does not swallow cancellation during optional follow-ups', async () => {
    const controller = new AbortController();
    provider.call = vi.fn(async () => { controller.abort(); throw new Error('cancelled'); });
    const rag = load('../es-rag.js', { './llm-provider': { getProvider: () => provider },
      './elasticsearch': { ES_HOST: 'fixture', ES_INDEX: 'fixture', esAvailable: async () => true,
        getQueryEmbedding: async () => [0.1], esRequest: async () => ({ hits: { hits: [{ _source: { title: 'Stored document' } }] } }) } });
    await expect(rag.ragChat('What happened?', { mode: 'keyword', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider.callWithMetadata.mock.calls[0][1].signal).toBe(controller.signal);
    expect(provider.call.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('RAG answer carries actual metadata and dispatches a bounded general task', async () => {
    provider.call = vi.fn().mockResolvedValue('后续问题一\n后续问题二');
    const rag = load('../es-rag.js', { './llm-provider': { getProvider: () => provider },
      './elasticsearch': { ES_HOST: 'fixture', ES_INDEX: 'fixture', esAvailable: async () => true,
        getQueryEmbedding: async () => [0.1], esRequest: async () => ({ hits: { hits: [{ _source: { title: 'Stored document', short_summary_zh: '已有摘要', url: 'https://example.com/doc' } }] } }) } });
    const result = await rag.ragChat('What happened?', { mode: 'keyword' });
    expect(result).toMatchObject({ llm_metadata: metadata, total_found: 1 });
    expect(provider.callWithMetadata).toHaveBeenCalledWith(expect.stringContaining('Stored document'), expect.objectContaining({ task: 'general', maxTokens: 3000 }));
    expect(provider.call).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ task: 'general', maxTokens: 256 }));
  });
});
