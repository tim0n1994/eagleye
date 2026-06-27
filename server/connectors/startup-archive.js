/**
 * Eagleye — Startup Archive Connector
 *
 * Scrapes the Startup Archive website for daily founder/CEO insights.
 * No public API available, so we parse the HTML listing page.
 */

const { BaseConnector } = require('./base');
const { fetchURL } = require('../services/utils');

class StartupArchiveConnector extends BaseConnector {
  constructor() {
    super('startup-archive');
  }

  async fetch(date) {
    try {
      const html = await fetchURL('https://www.startuparchive.org/');
      const items = [];

      // Extract items from the daily insights list
      // The page has a pattern like: "Mar 31, 2026\nMarc Andreessen on the 5 personality traits..."
      // Groups of: [date line] [name + title] separated by blank lines

      // Match date lines followed by content: "Mar 31, 2026\nMarc Andreessen on the 5..."
      // The page text extracts as: [date]\n[Person] on [topic] or [Person]: [quote]
      const entryRegex = /([A-Z][a-z]{2,}\s+\d{1,2},\s+\d{4})\n([A-Z][\w\s.]+?)(?:\s+(?:on|—|-|explains|recounts|says|:|–))\s+([^\n]+)/g;
      let match;

      while ((match = entryRegex.exec(html)) !== null) {
        const dateStr = _date;  // Use requested date for consistent daily capture
        if (date && dateStr !== date) continue;

        const person = match[2].trim();
        const insight = match[3].trim();
        const title = `${person}: ${insight}`;

        items.push({
          ...this.normalize({
            title,
            url: `https://www.startuparchive.org/`,
            description: `${person} — ${insight}`,
            publishedAt: new Date(match[1]).toISOString(),
            author: person,
            sourcePayload: {
              person,
              insight,
              date_raw: match[1],
              platform: 'startup-archive',
              type: 'founder-insight',
            },
            popularity: {},
            score: 0,
          }),
          digest_date: dateStr,
        });
      }

      return items;
    } catch (err) {
      console.error('Startup Archive fetch error:', err.message);
      return [];
    }
  }

  _normalizeDate(dateStr) {
    try {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        return d.toISOString().slice(0, 10).replace(/-/g, '');
      }
    } catch {}
    return '';
  }
}

module.exports = { StartupArchiveConnector };
