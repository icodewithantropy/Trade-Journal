/**
 * TradeOS v4 · core/api.js
 * ─────────────────────────────────────────────────────────────
 * Single API gateway. Every network request goes through here.
 * Notion token → X-Notion-Token header. NEVER in URL.
 * API keys (TD, FRED) → X-Api-Keys header. NEVER in URL.
 * ─────────────────────────────────────────────────────────────
 */

const API = (() => {

  // ── Base worker fetch — public actions (prices, fred, news) ─
  async function _fetch(action, params = {}, body = null, timeoutMs = 14000) {
    const url = new URL(Config.WORKER);
    url.searchParams.set('action', action);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
    const keys = ApiKeyStore.get();
    const headers = { 'Content-Type': 'application/json' };
    if (keys.td || keys.fred) {
      headers['X-Api-Keys'] = JSON.stringify({ td: keys.td || '', fred: keys.fred || '' });
    }
    const opts = { method: body ? 'POST' : 'GET', headers, signal: AbortSignal.timeout(timeoutMs) };
    if (body) opts.body = JSON.stringify(body);
    const res  = await fetch(url.toString(), opts);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ── Notion fetch — token in X-Notion-Token header ONLY ────
  // Token is NEVER added to URL params. This was the leak. Fixed.
  async function _notionFetch(action, params = {}, body = null) {
    const token = TokenStore.get();
    if (!TokenStore.ok(token)) throw new Error('NO_TOKEN');

    const url = new URL(Config.WORKER);
    url.searchParams.set('action', action);
    for (const [k, v] of Object.entries(params)) {
      if (k === 'token') continue; // block accidental token leak
      url.searchParams.set(k, String(v));
    }

    const keys = ApiKeyStore.get();
    const headers = {
      'Content-Type':   'application/json',
      'X-Notion-Token': token,   // header only — never in URL
    };
    if (keys.td || keys.fred) {
      headers['X-Api-Keys'] = JSON.stringify({ td: keys.td || '', fred: keys.fred || '' });
    }

    const opts = { method: body ? 'POST' : 'GET', headers, signal: AbortSignal.timeout(14000) };
    if (body) opts.body = JSON.stringify(body);
    const res  = await fetch(url.toString(), opts);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ── Paginated Notion query ─────────────────────────────────
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
    async prices() {
      return _fetch('prices', { source: ApiKeyStore.td() ? 'twelvedata' : 'exchangerate' });
    },
    async fred(series) {
      return _fetch('fred', { series });
    },
    async news() {
      return _fetch('news');
    },
    async queryTrades(onProgress)  { return _queryAll(Config.DB.TRADES, onProgress); },
    async queryPlaybook(onProgress){ return _queryAll(Config.DB.PLAYBOOK, onProgress); },
    async createPage(db, properties) {
      return _notionFetch('create', { db }, { properties });
    },
    async updatePage(pageId, properties) {
      if (!isValidNotionId(pageId)) throw new Error('Invalid page ID format');
      return _notionFetch('update', { pageId }, { properties });
    },
    async deletePage(pageId) {
      if (!isValidNotionId(pageId)) throw new Error('Invalid page ID format');
      return _notionFetch('delete', { pageId });
    },
    async ai(messages, systemPrompt, maxTokens = 800) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, system: systemPrompt, messages }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || 'AI error');
      return data.content?.[0]?.text || '';
    },
  };
})();
