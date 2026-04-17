/**
 * TradeOS · core/api.js · v11
 * FIX: X-Notion-Token was blocked by CORS preflight.
 *      Token is now sent via Authorization header (standard, always allowed).
 *      Worker v11 reads it from Authorization or falls back to env.NOTION_KEY.
 */

const WORKER_URL = 'https://notion-proxy.churan756.workers.dev';

async function _fetch(action, options = {}) {
  const url = new URL(WORKER_URL);
  url.searchParams.set('action', action);

  if (options.params) {
    Object.entries(options.params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  // Use standard Authorization header — always allowed in CORS, no preflight block
  const headers = { 'Content-Type': 'application/json' };
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;

  const res = await fetch(url.toString(), {
    method:  options.method || 'GET',
    headers,
    body:    options.body ? JSON.stringify(options.body) : undefined,
    signal:  AbortSignal.timeout(15000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const API = {

  async prices() {
    return _fetch('prices');
  },

  async fred(seriesId) {
    // engines.js sends raw FRED IDs like 'CPIAUCSL' — worker-v11 handles both formats
    return _fetch('fred', { params: { series: seriesId } });
  },

  async ai(prompt, system) {
    return _fetch('ai', { method: 'POST', body: { prompt, system } });
  },

  async aiMacro(question) {
    return _fetch('ai-macro', { method: 'POST', body: { question } });
  },

  async tweets() {
    return _fetch('tweets');
  },

  async query(dbId, token, body = {}) {
    return _fetch('query', {
      method: 'POST',
      params: { db: dbId },
      token,
      body,
    });
  },

  async queryPlaybook() {
    const token = typeof TokenStore !== 'undefined' ? TokenStore.get() : '';
    if (!token) throw new Error('No token');
    return _fetch('query', {
      method: 'POST',
      params: { db: typeof Config !== 'undefined' ? Config.DB.PLAYBOOK : '' },
      token,
      body: { sorts: [{ property: 'Date', direction: 'descending' }] },
    }).then(d => d.results || []);
  },

  async createPage(dbId, properties) {
    const token = typeof TokenStore !== 'undefined' ? TokenStore.get() : '';
    return _fetch('create', { method: 'POST', token, body: { parent: { database_id: dbId }, properties } });
  },

  async updatePage(pageId, properties) {
    const token = typeof TokenStore !== 'undefined' ? TokenStore.get() : '';
    return _fetch('update', { method: 'PATCH', params: { id: pageId }, token, body: { properties } });
  },

  async deletePage(pageId) {
    const token = typeof TokenStore !== 'undefined' ? TokenStore.get() : '';
    return _fetch('delete', { method: 'PATCH', params: { id: pageId }, token });
  },
};

window.API = API;
