/**
 * Eagleye — Page Components (barrel)
 *
 * Render functions live in ./pages/*.js, one module per page domain. This file
 * only re-exports them, so the import surface app-main.js and kg3d.js rely on
 * is unchanged.
 *
 * Shared helpers (loaders, item cards, source nav, title selection) live in
 * ./pages/shared.js — import from there directly in new code rather than
 * pulling the whole barrel.
 */

// shared.js also exports internal helpers for the other page modules; the
// barrel deliberately re-exports only what pages.js exposed before the split.
export {
  showLoader,
  showError,
  renderSourceNav,
  hydrateSourceNavPills,
  renderItemCard,
  renderItemRow,
  renderItemMiniCard,
  markItemSeen,
} from './pages/shared.js';
export * from './pages/home.js';
export * from './pages/digest.js';
export * from './pages/sources.js';
export * from './pages/research.js';
export * from './pages/topics.js';
export * from './pages/signals.js';
export * from './pages/papers.js';
export * from './pages/catalog.js';
export * from './pages/intelligence.js';
export * from './pages/settings.js';
export * from './pages/tags.js';
export * from './pages/lists.js';
export * from './pages/trajectory.js';
export * from './pages/personal.js';
export * from './pages/archive.js';
export * from './pages/search.js';
export * from './pages/misc.js';
