import { sleep } from './utils.js';
import { getLanguage } from './i18n.js';

const API_BASE = '/api';

async function fetchJSON(url, retries = 2, delay = 1500) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      if (i < retries) {
        await sleep(delay * (i + 1));
        continue;
      }
      throw err;
    }
  }
}

async function readJSONOnce(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export const API = {
  fetchClassifiedItems: async (category = 'All') => {
    const data = await fetchJSON(`${API_BASE}/items?category=${encodeURIComponent(category)}`);
    return data.items || [];
  },

  fetchCategories: async () => {
    const data = await fetchJSON(`${API_BASE}/categories`);
    return data.categories || [];
  },

  triggerSync: async () => {
    const res = await fetch(`${API_BASE}/sync`, { method: 'POST' });
    return await readJSONOnce(res);
  },

  syncGet: async () => {
    return await fetchJSON(`${API_BASE}/sync/get`);
  },

  syncSet: async (data) => {
    return await fetch(`${API_BASE}/sync/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': getLanguage() },
      body: JSON.stringify(data)
    });
  },

  fetchItem: async (itemId) => {
    return await fetchJSON(`${API_BASE}/items/${encodeURIComponent(itemId)}`);
  },

  fetchGraph: async () => {
    return await fetchJSON(`${API_BASE}/graph`);
  },

  // ─── Auth ──────────────────────────────────────────────────────────────
  me: async () => {
    const res = await fetchJSON(`${API_BASE}/auth/me`);
    return res.user || null;
  },

  register: async (email, password, plan) => {
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': getLanguage() },
      body: JSON.stringify({ email, password, plan }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { pendingVerification:data.pending_verification === true, email:data.email, retryAfter:Number(data.retry_after || res.headers.get('Retry-After')) || 0 });
    return data;
  },

  verify: async (email, code, password) => {
    const res = await fetch(`${API_BASE}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': getLanguage() },
      body: JSON.stringify({ email, code, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },

  login: async (email, password) => {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': getLanguage() },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },

  logout: async () => {
    const res = await fetch(`${API_BASE}/auth/logout`, { method: 'POST' });
    if (!res.ok) throw new Error(`Sign out failed (HTTP ${res.status})`);
  },

  // ─── Admin ─────────────────────────────────────────────────────────────
  adminUsers: async () => {
    return await fetchJSON(`${API_BASE}/admin/users`);
  },

  adminSetRole: async (userId, role) => {
    const res = await fetch(`${API_BASE}/admin/users/${userId}/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': getLanguage() },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
    return await res.json();
  },

  adminSetStatus: async (userId, status) => {
    const res = await fetch(`${API_BASE}/admin/users/${userId}/${status}`, { method: 'POST' });
    if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
    return await res.json();
  },
};
