const { sendError, requireAdmin } = require('./_shared');

function requireAdminPost(req, res) {
  if (req.method !== 'POST') {
    sendError(res, 405, 'Method not allowed; use POST');
    return true;
  }
  return requireAdmin(req, res);
}

function positiveInteger(value, fallback, maximum) {
  const text = String(value ?? fallback);
  if (!/^[1-9]\d*$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

function isDigestDate(value) {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return false;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso;
}

module.exports = { requireAdminPost, positiveInteger, isDigestDate };
