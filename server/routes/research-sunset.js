/**
 * Eagleye — Research module sunset stubs
 *
 * 2026-10-21 方案C下线：research 模块正式淘汰（主体路由/服务已随 58650a7 删除）。
 * 原端点保留本 stub 统一回 410 Gone —— 刻意永久移除的标准语义，区别于 404 的
 * "不存在/瞬时"；数据表 research_reports 保留至 R5 retention 统一处理，本文件
 * 不查库、不写入。回滚 = git revert。
 */

const { sendJSON } = require('./_shared');

// Method-agnostic 410 for every retired research endpoint (old list/read/
// generate/chat/trigger paths alike).
function gone(req, res) {
  sendJSON(res, 410, {
    error: 'Gone: the research module was retired on 2026-10-21 (CTO option C); these endpoints are permanently removed.',
  });
}

function registerResearchSunsetRoutes(routes) {
  // Exact-match keys (server.js routeMap dispatch).
  routes['/api/research'] = gone;
  routes['/api/reports'] = gone;
  // Param-route keys (server.js paramRoutes dispatch; patterns must stay
  // ahead of the /api/topics/(.+) and /api/items/(.+) catch-alls).
  routes['/api/research/:id'] = gone;
  routes['/api/items/:id/research'] = gone;
  routes['/api/items/:id/research/chat'] = gone;
  routes['/api/topics/:slug/research'] = gone;
}

module.exports = registerResearchSunsetRoutes;
