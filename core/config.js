/**
 * TradeOS v4 · core/config.js
 * ─────────────────────────────────────────────────────────────
 * All constants in one place. Change here → changes everywhere.
 * ─────────────────────────────────────────────────────────────
 */

const Config = {

  // ── Worker URL — your Cloudflare Worker ──────────────────
  WORKER: 'https://notion-proxy.churan756.workers.dev/',

  // ── Notion DB IDs (not secrets — safe in source) ─────────
  DB: {
    TRADES:   '1f8c2f0e01588051ac78f92b4aaf19f9',
    PLAYBOOK: '30fc2f0e0158808a9ce1cb7ff70ce3aa',
  },

  // ── Pages manifest ────────────────────────────────────────
  PAGES: [
    { id: 'analytics', label: 'Analytics', file: 'index.html'     },
    { id: 'macro',     label: 'Macro',     file: 'macro.html'     },
    { id: 'playbook',  label: 'Playbook',  file: 'playbook.html'  },
    { id: 'news',      label: 'News',      file: 'news.html'      },
    { id: 'simulator', label: 'Simulator', file: 'simulator.html' },
  ],

  // ── Refresh intervals (ms) ────────────────────────────────
  INTERVALS: {
    PRICES_TD:   120_000,   // Twelve Data — 2 min
    PRICES_FREE: 300_000,   // exchangerate-api — 5 min
    MACRO:     3_600_000,   // FRED — 1 hour
    NEWS:      1_800_000,   // ForexFactory — 30 min
  },

  // ── Cache TTLs (ms) ───────────────────────────────────────
  CACHE: {
    MACRO:    3_600_000,   // 1 hour
    NEWS:     1_800_000,   // 30 min
    TRADES:     300_000,   // 5 min
  },

  // ── Price symbols in strip ────────────────────────────────
  SYMBOLS: {
    EURUSD: { sym:'EUR/USD', label:'EUR/USD', dec:5 },
    GBPUSD: { sym:'GBP/USD', label:'GBP/USD', dec:5 },
    NAS100: { sym:'NDX',     label:'NAS100',  dec:0 },
    SPX500: { sym:'SPX',     label:'SPX500',  dec:0 },
  },

  // ── FRED series to fetch ──────────────────────────────────
  FRED_SERIES: ['CPIAUCSL', 'CPILFESL', 'PAYEMS', 'UNRATE', 'A191RL1Q225SBEA', 'FEDFUNDS'],

  VERSION: 'v4.0.0',
};
window.Config = Config;

// ── Global export ──────────────────────────────────────────
window.Config = Config;
