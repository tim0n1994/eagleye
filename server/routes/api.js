/**
 * Eagleye — API route aggregator
 *
 * Every /api/* handler lives in a domain module beside this file; each exports
 * register(routes) and owns its own requires. This file only composes them, so
 * adding a domain means adding a module and one line here.
 *
 * server.js imports sendJSON/sendError from here as well, since it answers a
 * few non-/api paths (feeds, sitemap, static) with the same envelope.
 */

const { sendJSON, sendError } = require('./_shared');

const registerApiKeysRoutes = require('./apikeys');
const registerAuthRoutes = require('./auth');
const registerSignalsRoutes = require('./signals');
const registerElasticsearchRoutes = require('./elasticsearch');
const registerDigestRoutes = require('./digest');
const registerDiscoveryRoutes = require('./discovery');
const registerGraphRoutes = require('./graph');
const registerItemsRoutes = require('./items');
const registerJobsRoutes = require('./jobs');
const registerResearchRoutes = require('./research');
const registerSettingsRoutes = require('./settings');
const registerSourcesRoutes = require('./sources');
const registerSystemRoutes = require('./system');
const registerTaxonomyRoutes = require('./taxonomy');

/**
 * Register all API routes on the provided router.
 * The router is just a map from pathname -> handler function.
 */
function registerRoutes(routes) {
  registerApiKeysRoutes(routes);
  registerAuthRoutes(routes);
  registerSignalsRoutes(routes);
  registerElasticsearchRoutes(routes);
  registerDigestRoutes(routes);
  registerDiscoveryRoutes(routes);
  registerGraphRoutes(routes);
  registerItemsRoutes(routes);
  registerJobsRoutes(routes);
  registerResearchRoutes(routes);
  registerSettingsRoutes(routes);
  registerSourcesRoutes(routes);
  registerSystemRoutes(routes);
  registerTaxonomyRoutes(routes);
}

module.exports = { sendJSON, sendError, registerRoutes };
