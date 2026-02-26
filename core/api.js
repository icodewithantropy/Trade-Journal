/**
 * TradeOS · core/api.js
 * Clean Worker-Only API Layer
 */

const WORKER_URL = 'https://notion-proxy.churan756.workers.dev';

// ─────────────────────────────────────────────
// Internal Fetch Helper
// ─────────────────────────────────────────────
async function _fetch(action, options = {}) {
  const url = new URL(WORKER_URL);
  url.searchParams.set('action', action);

  if (options.params) {
    Object.entries(options.params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const res = await fetch(url.toString(), {
    method:  options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body:    options.body ? JSON.stringify(options.body) : undefined,
    signal:  AbortSignal.timeout(15000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ─────────────────────────────────────────────
// Public API Object
// ─────────────────────────────────────────────
const API = {

  async prices() {
    return _fetch('prices');
  },

  async fred(seriesId) {
    return _fetch('fred', { params: { series: seriesId } });
  },

  async ai(prompt, system) {
    return _fetch('ai', { method: 'POST', body: { prompt, system } });
  },

  async query(dbId, token, body = {}) {
    return _fetch('query', {
      method: 'POST',
      params: { db: dbId },
      headers: { 'X-Notion-Token': token },
      body,
    });
  },

  async queryPlaybook() {
    const token = typeof TokenStore !== 'undefined' ? TokenStore.get() : '';
    if (!token) throw new Error('No token');
    return _fetch('query', {
      method: 'POST',
      params: { db: typeof Config !== 'undefined' ? Config.DB.PLAYBOOK : '' },
      headers: { 'X-Notion-Token': token },
      body: { sorts: [{ property: 'Date', direction: 'descending' }] },
    }).then(d => d.results || []);
  },

  async createPage(dbId, properties) {
    const token = typeof TokenStore !== 'undefined' ? TokenStore.get() : '';
    return _fetch('create', {
      method: 'POST',
      headers: { 'X-Notion-Token': token },
      body: { parent: { database_id: dbId }, properties },
    });
  },

  async updatePage(pageId, properties) {
    const token = typeof TokenStore !== 'undefined' ? TokenStore.get() : '';
    return _fetch('update', {
      method: 'PATCH',
      params: { id: pageId },
      headers: { 'X-Notion-Token': token },
      body: { properties },
    });
  },

  async deletePage(pageId) {
    const token = typeof TokenStore !== 'undefined' ? TokenStore.get() : '';
    return _fetch('delete', {
      method: 'PATCH',
      params: { id: pageId },
      headers: { 'X-Notion-Token': token },
    });
  },
};

// Global export
window.API = API;
