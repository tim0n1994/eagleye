const path = require('node:path');
const reach = require('./agent-reach');

async function redditSubreddit(subreddit, { sort = 'hot', limit = 20, signal } = {}) {
  signal?.throwIfAborted();
  const result = await reach.runReach('rdt', [path.resolve(__dirname, '../../scripts/reddit-collector.py'), subreddit, '--sort', sort, '--limit', String(limit)], { jsonMode: 'cli-json', signal });
  if (!result.ok) throw new Error(`Reddit: ${result.code || 'COLLECTION_FAILED'}`);
  if (!Array.isArray(result.data) || result.data.some(post => !post || !post.id || !post.url)) throw new Error('Reddit: SCHEMA_ERROR');
  return result;
}

async function xiaohongshuSearch(keyword, { limit = 20, signal } = {}) {
  signal?.throwIfAborted();
  const loginResponse = await fetch(new URL('/api/v1/login/status', process.env.EAGLEYE_XHS_MCP_URL), { method: 'GET', signal });
  if (!loginResponse.ok) throw new Error(`XiaoHongShu: ${[401, 403].includes(loginResponse.status) ? 'AUTH_REQUIRED' : `HTTP_${loginResponse.status}`}`);
  const login = await loginResponse.json();
  if (login?.data?.is_logged_in === false) throw new Error('XiaoHongShu: AUTH_REQUIRED');
  if (login?.success !== true || login.error || login.errors || login.data?.error || login.data?.errors || login.data?.is_logged_in !== true) throw new Error('XiaoHongShu: LOGIN_STATUS_ERROR');
  signal?.throwIfAborted();
  const response = await fetch(new URL('/api/v1/feeds/search', process.env.EAGLEYE_XHS_MCP_URL), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyword }), signal,
  });
  if (!response.ok) throw new Error(`XiaoHongShu: ${[401, 403].includes(response.status) ? 'AUTH_REQUIRED' : `HTTP_${response.status}`}`);
  const body = await response.json();
  if (body?.success !== true || body.error || body.errors || body.data?.error || body.data?.errors || body.data?.is_logged_in === false) throw new Error('XiaoHongShu: AUTH_OR_BACKEND_ERROR');
  const feeds = body.data?.feeds;
  if (!Array.isArray(feeds)) throw new Error('XiaoHongShu: SCHEMA_ERROR');
  const data = feeds.map(feed => {
    const card = feed?.noteCard;
    if (!feed?.id || !feed.xsecToken || !card || typeof card.displayTitle !== 'string' || !card.user?.userId || typeof card.user.nickname !== 'string' || card.interactInfo?.likedCount === undefined || card.interactInfo.likedCount === null) throw new Error('XiaoHongShu: SCHEMA_ERROR');
    return {
      id: feed.id, title: card.displayTitle, author: card.user.nickname,
      author_url: `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(card.user.userId)}`,
      likes: card.interactInfo.likedCount,
      url: `https://www.xiaohongshu.com/explore/${encodeURIComponent(feed.id)}?xsec_token=${encodeURIComponent(feed.xsecToken)}&xsec_source=pc_search`,
    };
  });
  return { ok: true, data: data.slice(0, limit) };
}

module.exports = { redditSubreddit, xiaohongshuSearch };
