/**
 * TradeOS v4 · core/api.js
 * ─────────────────────────────────────────────────────────────
 * Single API gateway. Every network request goes through here.
 * Pages never call fetch() directly. Ever.
 * Keys always via header. Never in URL.
 * ─────────────────────────────────────────────────────────────
 */

const API = (() => {

  // ── Base worker fetch — all calls route through here ──────
  async function _fetch(action, params = {}, body = null, timeoutMs = 14000) {
    const url = new URL(Config.WORKER);
    url.searchParams.set('action', action);

    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }

    // Keys go in header — NEVER in URL
    const keys = ApiKeyStore.get();
    const headers = { 'Content-Type': 'application/json' };
    if (keys.td || keys.fred) {
      headers['X-Api-Keys'] = JSON.stringify({ td: keys.td || '', fred: keys.fred || '' });
    }

    const opts = {
      method:  body ? 'POST' : 'GET',
      headers,
      signal:  AbortSignal.timeout(timeoutMs),
    };
    if (body) opts.body = JSON.stringify(body);

    const res  = await fetch(url.toString(), opts);
    const data = await res.json();

    if (!res.ok || data.error) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  // ── Notion-authenticated fetch ─────────────────────────────
  async function _notionFetch(action, params = {}, body = null) {
    const token = TokenStore.get();
    if (!TokenStore.ok(token)) throw new Error('NO_TOKEN');
    return _fetch(action, { ...params, token }, body);
  }

  // ── Paginated Notion query — fetches all pages ─────────────
  async function _queryAll(db, onProgress) {
    let all = [], cursor = null, page = 0;
    do {
      const params = { db };
      if (cursor) params.cursor = cursor;
      const data = await _notionFetch('query', params);
      all    = all.concat(data.results || []);
      cursor = data.next_cursor || null;
      page++;
      if (onProgress) onProgress(all.length);
    } while (cursor && page < 30);
    return all;
  }

  return {
    // ── Prices ──────────────────────────────────────────────
    async prices() {
      const hasTD = !!ApiKeyStore.td();
      return _fetch('prices', { source: hasTD ? 'twelvedata' : 'exchangerate' });
    },

    // ── FRED ─────────────────────────────────────────────────
    async fred(series) {
      return _fetch('fred', { series });
    },

    // ── News ─────────────────────────────────────────────────
    async news() {
      return _fetch('news');
    },

    // ── Notion: query trades ──────────────────────────────────
    async queryTrades(onProgress) {
      return _queryAll(Config.DB.TRADES, onProgress);
    },

    // ── Notion: query playbook ────────────────────────────────
    async queryPlaybook(onProgress) {
      return _queryAll(Config.DB.PLAYBOOK, onProgress);
    },

    // ── Notion: create page ───────────────────────────────────
    async createPage(db, properties) {
      return _notionFetch('create', { db }, { properties });
    },

    // ── Notion: update page ───────────────────────────────────
    async updatePage(pageId, properties) {
      if (!isValidNotionId(pageId)) throw new Error('Invalid page ID format');
      return _notionFetch('update', { pageId }, { properties });
    },

    // ── Notion: delete (archive) page ────────────────────────
    async deletePage(pageId) {
      if (!isValidNotionId(pageId)) throw new Error('Invalid page ID format');
      return _notionFetch('delete', { pageId });
    },

    // ── AI: send structured context ───────────────────────────
    async ai(messages, systemPrompt, maxTokens = 800) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-20250514',
          max_tokens: maxTokens,
          system:     systemPrompt,
          messages,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || 'AI error');
      return data.content?.[0]?.text || '';
    },
  };
})();
