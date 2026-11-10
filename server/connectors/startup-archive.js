/** Publisher-provided Beehiiv RSS. Evergreen archive, not breaking news. */
const { RSSConnector } = require('./rss');
const { compactDigestDate, todayDigestDate } = require('../services/date-contract');

class StartupArchiveConnector extends RSSConnector {
  constructor() { super('startup-archive'); }

  async fetch(date, opts = {}) {
    // The publisher's current feed contains historical essays. Keep their real
    // dates and distinct article URLs; repeated polls use ETag and URL dedup.
    // Do not discard evergreen material via the generic 36-hour news window.
    const items = await super.fetch(null, opts);
    const digestDate = compactDigestDate(date) || compactDigestDate(todayDigestDate());
    return items.map(item => ({ ...item, digest_date: digestDate,
      source_payload: JSON.stringify({ ...JSON.parse(item.source_payload), content_kind: 'founder_archive' }) }));
  }
}
module.exports = { StartupArchiveConnector };
