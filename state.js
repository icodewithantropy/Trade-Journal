/**
 * TradeOS v4 · core/state.js
 * ─────────────────────────────────────────────────────────────
 * Single source of truth. No page ever writes to this directly.
 * Only engines call State.set(). Pages call State.get() to render.
 * ─────────────────────────────────────────────────────────────
 */

const State = (() => {
  const _data = {
    prices:       {},      // { EURUSD: { price, prev, change, changePct, ts } }
    macro:        {},      // { CPIAUCSL: [...obs], FEDFUNDS: [...obs], ... }
    news:         [],      // [ { date, title, country, impact, forecast, previous, actual } ]
    trades:       [],      // parsed trade objects from Notion
    journalStats: {},      // computed from trades: winRate, avgR, etc.
    playbook:     {},      // { weekKey: { plan:{}, review:{}, images:[] } }
    monteCarlo:   {},      // last simulation result
    aiContext:    {},      // structured context sent to AI
    lastUpdated:  {},      // { prices: timestamp, macro: timestamp, ... }
    ui: {
      currentPage: '',
      priceAlerts: {},
      alertsFired: new Set(),
    },
  };

  const _listeners = {};

  return {
    // ── Read ──────────────────────────────────────────────
    get(key) {
      return key ? _data[key] : { ..._data };
    },

    // ── Write — only engines call this ───────────────────
    set(key, value) {
      _data[key] = value;
      _data.lastUpdated[key] = Date.now();
      this._emit(key, value);
    },

    // ── Merge — for partial updates ───────────────────────
    merge(key, value) {
      _data[key] = { ..._data[key], ...value };
      _data.lastUpdated[key] = Date.now();
      this._emit(key, _data[key]);
    },

    // ── Staleness check ───────────────────────────────────
    isStale(key, maxAgeMs) {
      const ts = _data.lastUpdated[key];
      return !ts || (Date.now() - ts) > maxAgeMs;
    },

    // ── Event system — pages subscribe, engines emit ──────
    on(key, fn) {
      if (!_listeners[key]) _listeners[key] = [];
      _listeners[key].push(fn);
    },

    off(key, fn) {
      if (!_listeners[key]) return;
      _listeners[key] = _listeners[key].filter(f => f !== fn);
    },

    _emit(key, value) {
      (_listeners[key] || []).forEach(fn => { try { fn(value); } catch(e) { console.warn('[State] Listener error:', e); } });
      (_listeners['*'] || []).forEach(fn => { try { fn(key, value); } catch(e) {} });
    },
  };
})();

window.State = State;

// ── Global export ──────────────────────────────────────────
window.State = State;
