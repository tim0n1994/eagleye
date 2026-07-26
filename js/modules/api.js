import { sleep } from './utils.js';

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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  },

  fetchResearch: async (url) => {
    return await fetchJSON(`${API_BASE}/research?url=${encodeURIComponent(url)}`);
  },

  fetchItem: async (itemId) => {
    return await fetchJSON(`${API_BASE}/items/${encodeURIComponent(itemId)}`);
  },

  triggerItemResearch: async (itemId, force = false) => {
    const suffix = force ? '?force=true' : '';
    const res = await fetch(`${API_BASE}/items/${encodeURIComponent(itemId)}/research${suffix}`, { method: 'POST' });
    if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
    return await res.json();
  },

  chatItemResearch: async (itemId, message, history = []) => {
    const res = await fetch(`${API_BASE}/items/${encodeURIComponent(itemId)}/research/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history }),
    });
    if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
    return await res.json();
  },

  fetchGraph: async () => {
    return await fetchJSON(`${API_BASE}/graph`);
  },

  fetchGraph3D: async () => {
    const data = await fetchJSON(`${API_BASE}/kg3d`);
    return { nodes: data.nodes || [], edges: data.edges || [], tagItems: data.tagItems || {} };
  },

  // ─── Auth ──────────────────────────────────────────────────────────────
  me: async () => {
    const res = await fetchJSON(`${API_BASE}/auth/me`);
    return res.user || null;
  },

  register: async (email, password) => {
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },

  verify: async (email, code) => {
    const res = await fetch(`${API_BASE}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },

  login: async (email, password) => {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },

  logout: async () => {
    await fetch(`${API_BASE}/auth/logout`, { method: 'POST' });
  },

  // ─── Admin ─────────────────────────────────────────────────────────────
  adminUsers: async () => {
    return await fetchJSON(`${API_BASE}/admin/users`);
  },

  adminSetRole: async (userId, role) => {
    const res = await fetch(`${API_BASE}/admin/users/${userId}/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
