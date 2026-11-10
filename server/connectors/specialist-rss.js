const { RSSConnector } = require('./rss');
const catalog = require('../services/specialist-sources');
const AI_TOPIC = /\b(?:ai|llms?|gpt|chatgpt|artificial intelligence|generative|intelligent tutor|machine learning)\b|人工智能|大模型|智能辅导/i;

// Reuse conditional requests, time windows, retries and ingestion deduplication.
class SpecialistRSSConnector extends RSSConnector {
  constructor(slug) { super(slug); this.transport = catalog[slug]?.transport; }
  normalize(raw) {
    const source = catalog[this.slug];
    return super.normalize({ ...raw,
      title: `${source.context} — ${raw.title}`,
      sourcePayload: { ...raw.sourcePayload, original_title: raw.title,
        source_kind: source.kind, publisher_url: source.homepage },
    });
  }
  async fetch(date, opts = {}) {
    const items = await super.fetch(date, opts);
    return items.filter(item => this.slug !== 'education-openedx-community'
      || AI_TOPIC.test(`${JSON.parse(item.source_payload).original_title} ${item.original_summary}`));
  }
}
module.exports = { SpecialistRSSConnector };
