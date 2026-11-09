// Legacy route names remain valid; the old dashboards are retired.
export async function renderIntelligence(params) {
  const location = window.location.href;
  const module = await import('./radar.js');
  if (window.location.href === location) return module.renderRadarTrends(params);
}
export async function renderIndustryMetrics(params) {
  const location = window.location.href;
  const module = await import('./radar.js');
  if (window.location.href === location) return module.renderRadarSystem(params);
}
