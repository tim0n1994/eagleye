/** Evidence-based categories for the Physical AI briefing. */
const ROBOTICS_RE = /\brobots?\b|\brobotics?\b|\bhumanoids?\b|\bembodied[ -]+(?:ai|intelligence|robotics)\b|\brobot[-_ ]?learning\b|\bvla\b|\blerobot\b|\bros2?\b|机器人|人形机|具身智能|具身人工智能|机械臂/i;
const NON_PHYSICAL_RE = /\brobot framework\b|\brobotic process automation\b|\brpa\b|\bchatbots?\b|聊天机器人|自动化办公/i;
const SCENARIO_RE = /\b(?:factor(?:y|ies)|warehouses?|fulfill?ment|logistics|manufactur(?:ing|ers?)|production lines?|hospitals?|clinics?|surgery|surgical|retail|grocery|stores?|restaurants?|farms?|agriculture|agricultural|homes?|household|construction|customer sites?|distribution cent(?:er|re)s?|facilit(?:y|ies))\b|工厂|制造|产线|生产线|仓储|仓库|物流|医院|手术|医疗|农业|农场|家庭|家用|商场|餐厅|餐饮|商业场景|客户现场/i;
const FUTURE_OR_NEGATED_RE = /\b(?:could|might|may|would|will|plans?\s+to|planned\s+to|expected\s+to|expect(?:s|ed)?\s+to|aims?\s+to|propos(?:es?|ed|al)|not\s+yet|not\s+deployed|hasn.t\s+yet|haven.t\s+yet)\b|计划|预计|拟于|拟将|尚未|未部署|未来|可能|有望/i;
const DEPLOYED_RE = /\b(?:has|have|had|is|are|was|were)\s+(?:already\s+|been\s+|being\s+)*(?:deploy(?:ed|ing)|install(?:ed|ing)|shipped)\b|\b(?:deployed|installed)\s+(?:at|in|across)\b|\b(?:is|are)\s+operat(?:ing|ional)\s+(?:in|at)\b|已(?:经)?(?:部署|投用|安装|交付|落地)|投入(?:实际|商业|生产|运营|使用)/i;
const PILOT_RE = /\b(?:piloted|piloting|pilot(?:\s+(?:program|project|deployment|trial))?\s+(?:began|started|launched|underway|is\s+underway)|(?:began|launched|started|conducted|completed)\s+(?:a\s+)?pilot|field[- ]test(?:ed|ing)|trialled|trialed)\b|已(?:开展|启动|完成).{0,12}(?:试点|试运行|试用)|(?:试点|试运行).{0,8}(?:已启动|正在|上线|落地)/i;
const PROTOTYPE_RE = /\b(?:demonstrated|evaluated|tested|validated)\b.{0,60}\b(?:real[- ]world|physical robots?|real robots?|in[- ]the[- ]wild)\b|\b(?:real[- ]world|physical robots?|real robots?)\b.{0,60}\b(?:demonstrated|evaluated|tested|validated)\b|在真实(?:环境|场景).{0,24}(?:测试|验证|演示)|(?:测试|验证|演示).{0,24}真实(?:环境|场景)/i;
const PAPER_LINK_RE = /(?:https?:\/\/)?(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\/|\barxiv\s*:\s*\d{4}\.\d{4,5}/i;
const SIMULATION_ONLY_RE = /\b(?:in|within|using|via)\s+(?:a\s+|the\s+)?(?:virtual|simulat(?:ed|ion)|digital twin)\b|\b(?:factory|warehouse|hospital)\s+simulat(?:ion|or)\b|(?:仿真|虚拟|模拟)(?:环境|场景|工厂|仓库)/i;
const PAPER_SOURCES = new Set(['physical-ai-arxiv', 'arxiv-ai', 'hugging-face', 'education-arxiv']);
const GITHUB_SOURCES = new Set(['physical-ai-open-github', 'github-trending']);
const HUGGINGFACE_SOURCES = new Set(['physical-ai-open-huggingface']);
const OPEN_LICENSES = new Set([
  'mit', 'apache-2.0', 'bsd-2-clause', 'bsd-3-clause', 'isc', 'mpl-2.0',
  'gpl-2.0', 'gpl-2.0-only', 'gpl-2.0-or-later', 'gpl-3.0', 'gpl-3.0-only', 'gpl-3.0-or-later',
  'lgpl-2.1', 'lgpl-2.1-only', 'lgpl-2.1-or-later', 'lgpl-3.0', 'lgpl-3.0-only', 'lgpl-3.0-or-later',
  'agpl-3.0', 'agpl-3.0-only', 'agpl-3.0-or-later', 'unlicense', 'cc0-1.0', 'cc-by-4.0', 'cc-by-sa-4.0',
]);

function parsePayload(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
}

function hasPhysicalRobotics(text) {
  const value = String(text || '');
  if (!ROBOTICS_RE.test(value)) return false;
  // A software test framework, chatbot, or RPA mention alone is not a robot.
  if (NON_PHYSICAL_RE.test(value) && !/\b(?:physical robots?|humanoids?|embodied (?:ai|intelligence)|robotic manipulators?)\b|具身智能|人形机器人|机械臂/i.test(value)) return false;
  return true;
}

function relevantCandidate(title, titleZh, summary) {
  return hasPhysicalRobotics(`${title || ''} ${titleZh || ''} ${String(summary || '').slice(0, 500)}`);
}

function openResource(row) {
  if (!GITHUB_SOURCES.has(row.source_slug) && !HUGGINGFACE_SOURCES.has(row.source_slug)) return null;
  const meta = parsePayload(row.source_payload);
  if (meta.private === true || meta.gated === true || meta.archived === true) return null;
  const rawLicense = typeof meta.license === 'object' ? meta.license?.spdx_id : meta.license;
  const license = String(rawLicense || '').replace(/^license:/i, '').trim();
  if (!OPEN_LICENSES.has(license.toLowerCase())) return null;
  let url;
  try { url = new URL(row.canonical_url); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  if (GITHUB_SOURCES.has(row.source_slug)) {
    if (host !== 'github.com' || parts.length !== 2 || !parts.every(p => /^[A-Za-z0-9_.-]+$/.test(p))) return null;
    if (['topics', 'orgs', 'users', 'search', 'features'].includes(parts[0].toLowerCase())) return null;
  } else {
    const isDataset = parts[0] === 'datasets';
    const resourceParts = isDataset ? parts.slice(1) : parts;
    if (host !== 'huggingface.co' || resourceParts.length !== 2 || !resourceParts.every(p => /^[A-Za-z0-9_.-]+$/.test(p))) return null;
    if (['papers', 'spaces', 'datasets', 'models'].includes(resourceParts[0].toLowerCase())) return null;
  }
  // Do not qualify a resource merely because its account name contains “robot”.
  const repoName = parts[parts.length - 1] || '';
  const tags = Array.isArray(meta.topics) ? meta.topics : Array.isArray(meta.tags) ? meta.tags : [];
  const evidence = [repoName, meta.description || '', ...tags].join(' ');
  if (!hasPhysicalRobotics(evidence.replace(/[_/.-]+/g, ' '))) return null;
  url.hash = '';
  url.search = '';
  return { url: url.href, license };
}

function applicationStage(row) {
  if (PAPER_SOURCES.has(row.source_slug) || GITHUB_SOURCES.has(row.source_slug) || HUGGINGFACE_SOURCES.has(row.source_slug)) return null;
  const title = String(row.title || '');
  const summary = String(row.original_summary || '').slice(0, 1600);
  const text = `${title}. ${summary}`;
  if (PAPER_LINK_RE.test(`${row.canonical_url || ''} ${text}`) || !hasPhysicalRobotics(text) || !SCENARIO_RE.test(text)) return null;
  const sentences = text.split(/[。！？\n]+|(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    if (FUTURE_OR_NEGATED_RE.test(sentence) || SIMULATION_ONLY_RE.test(sentence) || !hasPhysicalRobotics(sentence)) continue;
    // Require the scenario in the evidence sentence, or in the headline when
    // the sentence refers to a concrete deployment in a customer facility.
    if (!SCENARIO_RE.test(sentence) && !(SCENARIO_RE.test(title) && /\b(?:customers?|sites?|facilit(?:y|ies))\b|客户|现场/i.test(sentence))) continue;
    if (PILOT_RE.test(sentence)) return 'pilot';
    if (DEPLOYED_RE.test(sentence)) return 'deployed';
    if (PROTOTYPE_RE.test(sentence)) return 'prototype';
  }
  return null;
}

function classifyPhysicalAi(row) {
  const resource = openResource(row);
  if (resource) return { category: 'open', resource_url: resource.url, resource_license: resource.license };
  const stage = applicationStage(row);
  if (stage) return { category: 'applications', application_stage: stage };
  if (row.source_slug === 'physical-ai-arxiv') return { category: 'research' };
  if (row.source_slug === 'physical-ai-humanoid') return { category: 'humanoid' };
  return null;
}

module.exports = { classifyPhysicalAi, relevantCandidate, hasPhysicalRobotics, openResource, applicationStage, OPEN_LICENSES };
