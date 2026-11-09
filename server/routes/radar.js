'use strict';
const { readRadar } = require('../services/radar');
const { getAll } = require('../services/watchlist');
const { sendJSON,sendError } = require('./_shared');
function register(routes) {
  routes['/api/radar'] = async (req,res,parsed) => {
    if (req.method !== 'GET') return sendError(res,405,'GET required');
    const q = parsed.query || {};
    if (Object.values(q).some(value => typeof value !== 'string')) return sendError(res,400,'Invalid radar filters');
    const date = q.date || new Intl.DateTimeFormat('en-CA',{ timeZone: 'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date());
    const days = Number(q.days || 7), offset = Number(q.offset || 0);
    const view = q.view || 'discover';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T12:00:00Z`)) || new Date(`${date}T12:00:00Z`).toISOString().slice(0,10) !== date ||
      ![1,7,30].includes(days) || !Number.isInteger(offset) || offset < 0 || offset > 6000 ||
      !['discover','topics','topic','trends','following','system'].includes(view) || (view === 'topic' && !q.topic) ||
      (q.topic && (typeof q.topic !== 'string' || q.topic.length > 160)) ||
      (q.entity && (typeof q.entity !== 'string' || q.entity.length > 160))) return sendError(res,400,'Invalid radar filters');
    if (view === 'following' && !req.user) return sendError(res,401,'Authentication required');
    res.setHeader('Cache-Control','private, no-store');
    try {
      const data = await readRadar({ date,days,offset,view,topic:q.topic || '',entity:q.entity || '',
        kind:q.kind === 'topic' ? 'topic' : 'entity',sort:q.sort === 'sources' ? 'sources' : 'recent',
        ...(view === 'following' ? {subs:getAll(req.user.id).subs} : {}) });
      sendJSON(res,200,{ status:'ok',...data });
    } catch (error) {
      console.error('[radar]',error.message);
      sendError(res,error.status || 503,'Radar data temporarily unavailable. Please retry.');
    }
  };
}
module.exports = register;
