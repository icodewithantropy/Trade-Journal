/**
 * TradeOS · core/engines.js
 * Clean Worker Architecture Version
 * No frontend API keys
 * All data via API layer
 */


/* ═══════════════════════════════════════
   PRICE ENGINE
═══════════════════════════════════════ */
const PriceEngine = {
  _timer: null,

  start() {
    this.fetch();
    this._timer = setInterval(() => this.fetch(), Config.INTERVALS.PRICES_FREE);
    console.log('[PriceEngine] Started · 5min');
  },

  stop() {
    clearInterval(this._timer);
  },

  async fetch() {
    try {
      const raw = await API.prices();
      const prev = State.get('prices') || {};
      const prices = {};

      ['EURUSD','GBPUSD','DXY','XAUUSD'].forEach(sym => {
        if (!raw[sym]) return;

        const price = parseFloat(raw[sym]);
        if (isNaN(price)) return;

        const prevPrice = prev[sym]?.price ?? null;

        prices[sym] = {
          price,
          prev: prevPrice,
          change: prevPrice !== null ? +(price - prevPrice).toFixed(6) : 0,
          changePct: prevPrice !== null
            ? +((price - prevPrice) / prevPrice * 100).toFixed(4)
            : 0,
          source: raw.source,
          ts: Date.now()
        };
      });

      State.set('prices', prices);

    } catch (e) {
      console.warn('[PriceEngine] Failed:', e.message);
    }
  }
};


/* ═══════════════════════════════════════
   MACRO ENGINE (FRED)
═══════════════════════════════════════ */
const MacroEngine = {
  _timer: null,

  async start() {
    await this.fetch();
    this._timer = setInterval(() => this.fetch(), Config.INTERVALS.MACRO);
  },

  stop() {
    clearInterval(this._timer);
  },

  async fetch() {

    if (!State.isStale('macro', Config.CACHE.MACRO)) {
      return;
    }

    try {

      const results = await Promise.allSettled(
        Config.FRED_SERIES.map(series =>
          API.fred(series).then(d => ({
            series,
            obs: d.observations || []
          }))
        )
      );

      const macro = {};

      results.forEach(r => {
        if (r.status === 'fulfilled') {
          macro[r.value.series] = r.value.obs;
        }
      });

      State.set('macro', macro);

    } catch (e) {
      console.warn('[MacroEngine] Failed:', e.message);
      State.set('macro', { _error: e.message });
    }
  }
};


/* ═══════════════════════════════════════
   TRADE ENGINE (Notion Journal)
═══════════════════════════════════════ */
const TradeEngine = {

  async load() {

    if (!State.isStale('trades', Config.CACHE.TRADES)) {
      return;
    }

    try {

      const token = TokenStore.get();
      if (!token) {
        console.warn('[TradeEngine] No Notion token');
        return;
      }

      const dbId = "1f8c2f0e01588051ac78f92b4aaf19f9";

      const data = await API.query(dbId, token);

      const pages = data.results || [];

      const trades = pages.map(this._parse).filter(t => t.date);

      const stats = this._analyze(trades);

      State.set('trades', trades);
      State.set('journalStats', stats);

      console.log(`[TradeEngine] ${trades.length} trades · WR ${stats.winRate}%`);

    } catch (e) {
      console.warn('[TradeEngine] Failed:', e.message);
    }
  },

  _parse(page) {
    const p = page.properties || {};

    const get = (key, type) => {
      const prop = Object.values(p).find(x => x.type === type && x[type]);
      if (!prop) return null;

      if (type === 'select') return prop.select?.name || null;
      if (type === 'number') return prop.number ?? null;
      if (type === 'date') return prop.date?.start || null;
      if (type === 'title') return prop.title?.[0]?.plain_text || null;
      if (type === 'rich_text') return prop.rich_text?.map(r => r.plain_text).join('') || null;

      return null;
    };

    return {
      id: page.id,
      date: get('date','date'),
      pair: get('pair','select'),
      outcome: get('outcome','select'),
      rMultiple: get('multiple','number')
    };
  },

  _analyze(trades) {

    const wins = trades.filter(t => /win/i.test(t.outcome));
    const losses = trades.filter(t => /loss/i.test(t.outcome));

    const winRate = trades.length
      ? Math.round((wins.length / trades.length) * 100)
      : 0;

    const avgWin = wins.length
      ? wins.reduce((s,t)=>s+(t.rMultiple||0),0)/wins.length
      : 0;

    const avgLoss = losses.length
      ? Math.abs(losses.reduce((s,t)=>s+(t.rMultiple||0),0)/losses.length)
      : 0;

    const ev = +( (winRate/100*avgWin) - ((1-winRate/100)*avgLoss) ).toFixed(3);

    return {
      valid: trades,
      winRate,
      avgWin: +avgWin.toFixed(2),
      avgLoss: +avgLoss.toFixed(2),
      ev
    };
  }
};


/* ═══════════════════════════════════════
   AI ENGINE
═══════════════════════════════════════ */
const AIEngine = {

  async ask(question, role = 'analyst') {

    const macro  = State.get('macro') || {};
    const stats  = State.get('journalStats') || {};
    const prices = State.get('prices') || {};

    const context = {
      macro,
      journal: stats,
      prices
    };

    const prompt =
      "You are a professional trading analyst.\n\n" +
      "Context:\n" +
      JSON.stringify(context, null, 2) +
      "\n\nQuestion:\n" +
      question;

    return await API.ai(prompt);
  }
};
// Minimal NavEngine
const NavEngine = {
  init(pageId) {
    State.merge('ui', { currentPage: pageId });
    document.body.style.opacity = "1";
  }
};

window.NavEngine = NavEngine;

// Export engines globally
window.PriceEngine = PriceEngine;
window.MacroEngine = MacroEngine;
window.TradeEngine = TradeEngine;
window.AIEngine = AIEngine;
