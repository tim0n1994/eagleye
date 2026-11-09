// Stable topic pages share the lightweight radar reader; no graph payloads.
export async function renderTopics(params) {
  const location = window.location.href;
  const module = await import('./radar.js');
  if (window.location.href === location) return module.renderRadarTopics(params);
}
export async function renderTopicDetailPage(params) {
  const location = window.location.href;
  const module = await import('./radar.js');
  if (window.location.href === location) return module.renderRadarTopic(params);
}
