/**
 * TradeOS v4 · core/security.js
 * ─────────────────────────────────────────────────────────────
 * Security layer. Defined once. Used everywhere.
 * Every page loads this FIRST.
 * ─────────────────────────────────────────────────────────────
 */

// ── HTML escape — call before ANY innerHTML insertion ─────────
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#x27;')
    .replace(/\//g, '&#x2F;');
}

// ── URL sanitiser — blocks javascript:/data:/vbscript: ────────
function escUrl(u) {
  if (!u) return '';
  const s = String(u).trim();
  return /^(javascript|data|vbscript):/i.test(s) ? '' : s;
}

// ── Notion UUID validator ──────────────────────────────────────
function isValidNotionId(id) {
  return typeof id === 'string' && /^[a-f0-9-]{32,36}$/.test(id);
}

// ── Token store — sessionStorage default, localStorage on opt-in
const TokenStore = {
  _s: 'to_tok',
  _l: 'to_tok_p',

  get()           { return sessionStorage.getItem(this._s) || localStorage.getItem(this._l) || ''; },
  set(t, persist) {
    if (!this.ok(t)) return false;
    sessionStorage.setItem(this._s, t);
    persist ? localStorage.setItem(this._l, t) : localStorage.removeItem(this._l);
    return true;
  },
  clear()         { sessionStorage.removeItem(this._s); localStorage.removeItem(this._l); },
  ok(t)           { return typeof t === 'string' && (t.startsWith('ntn_') || t.startsWith('secret_')); },
  persisted()     { return !!localStorage.getItem(this._l); },
};

// ── API key store — session only, sent via header not URL ──────
const ApiKeyStore = {
  _s: 'to_ak',
  get()     { try { return JSON.parse(sessionStorage.getItem(this._s) || '{}'); } catch { return {}; } },
  set(k)    { sessionStorage.setItem(this._s, JSON.stringify(k)); },
  td()      { return this.get().td   || ''; },
  fred()    { return this.get().fred || ''; },
  clear()   { sessionStorage.removeItem(this._s); },
};
window.TokenStore = TokenStore;
window.esc = esc;
window.escUrl = escUrl;
