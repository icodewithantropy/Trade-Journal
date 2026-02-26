/**
 * TradeOS · core/engines.js
 * Clean Worker Architecture Version
 */

/* ═══════════════════════════════════════
   PRICE ENGINE
═══════════════════════════════════════ */
const PriceEngine = {
  _timer: null,

  start() {
    if (this._timer) return; // prevent duplicate intervals
    this.fetch();
    this._timer = setInterval(() => this.fetch(), Config.INTERVALS.PRICES_FREE);
    console.log('[PriceEngine] Started · 5min');
  },

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  },

  async fetch() {
    try {
      const raw = await API.prices();
      const prev = State.get('prices') || {};
      const prices = {};

      // Worker now returns { EURUSD: { price, open, change }, ... }
      // Support both old flat format and new object format
      ['EURUSD','GBPUSD','DXY','XAUUSD'].forEach(sym => {
        if (!raw[sym]) return;

        let price, changePct;
        if (typeof raw[sym] === 'object' && raw[sym].price != null) {
          price = parseFloat(raw[sym].price);
          changePct = parseFloat(raw[sym].change || 0);
        } else {
          price = parseFloat(raw[sym]);
          changePct = 0;
        }

        if (isNaN(price)) return;

        const prevPrice = prev[sym]?.price ?? null;

        prices[sym] = {
          price,
          prev: prevPrice,
          change: prevPrice !== null ? +(price - prevPrice).toFixed(6) : 0,
          changePct: changePct || (prevPrice !== null ? +((price - prevPrice) / prevPrice * 100).toFixed(4) : 0),
          source: raw.source,
          ts: Date.now()
        };
      });

      State.set('prices', prices);
      updatePriceUI(prices, raw.source);

    } catch (e) {
      console.warn('[PriceEngine] Failed:', e.message);
      const strip = document.getElementById('strip-src');
      if (strip) { strip.textContent = '○ Paused'; strip.style.color = 'var(--muted)'; }
    }
  }
};

/* ═══════════════════════════════════════
   PRICE UI UPDATE (shared across pages)
═══════════════════════════════════════ */
function updatePriceUI(prices, source) {
  const pairs = [
    { elId: 'ps-eur', sym: 'EURUSD', dec: 5 },
    { elId: 'ps-gbp', sym: 'GBPUSD', dec: 5 },
    { elId: 'ps-dxy', sym: 'DXY',    dec: 3 },
    { elId: 'ps-xau', sym: 'XAUUSD', dec: 2 },
  ];

  pairs.forEach(({ elId, sym, dec }) => {
    const d = prices[sym]; if (!d) return;
    const el = document.getElementById(elId); if (!el) return;
    const up = d.change >= 0;
    const clr = up ? 'var(--green)' : 'var(--red)';
    el.querySelector('.ps-price').textContent = d.price.toFixed(dec);
    const chgEl = el.querySelector('.ps-chg');
    chgEl.textContent = (up ? '▲' : '▼') + ' ' + Math.abs(d.change).toFixed(dec);
    chgEl.style.color = clr;
  });

  // Nav bar price pills
  if (prices.EURUSD) {
    const el = document.getElementById('np-eur');
    if (el) { el.textContent = `EUR ${prices.EURUSD.price.toFixed(5)}`; el.style.color = prices.EURUSD.change >= 0 ? 'var(--green)' : 'var(--red)'; }
  }
  if (prices.XAUUSD) {
    const el = document.getElementById('np-xau');
    if (el) { el.textContent = `XAU $${prices.XAUUSD.price.toFixed(0)}`; el.style.color = prices.XAUUSD.change >= 0 ? 'var(--green)' : 'var(--red)'; }
  }
  if (prices.DXY) {
    const el = document.getElementById('np-dxy');
    if (el) { el.textContent = `DXY ${prices.DXY.price.toFixed(3)}`; el.style.color = 'var(--t2)'; }
  }

  const tsEl = document.getElementById('strip-ts');
  if (tsEl) tsEl.textContent = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const srcEl = document.getElementById('strip-src');
  if (srcEl) {
    srcEl.textContent = source === 'twelvedata' ? '● Live' : '● Hourly';
    srcEl.style.color = 'var(--green)';
  }

  const dot = document.getElementById('nav-dot');
  if (dot) dot.className = 'nav-dot on';
}


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
    this._timer = null;
  },

  async fetch() {
    if (!State.isStale('macro', Config.CACHE.MACRO)) return;

    try {
      const results = await Promise.allSettled(
        Config.FRED_SERIES.map(series =>
          API.fred(series).then(d => ({ series, obs: d.observations || [] }))
        )
      );

      const macro = {};
      results.forEach(r => {
        if (r.status === 'fulfilled') {
          macro[r.value.series] = MacroEngine._process(r.value.series, r.value.obs);
        }
      });

      State.set('macro', macro);
      console.log('[MacroEngine] Loaded FRED data');

    } catch (e) {
      console.warn('[MacroEngine] Failed:', e.message);
      State.set('macro', { _error: e.message });
    }
  },

  // Compute YoY / MoM from raw observations
  _process(series, obs) {
    // obs come back newest-first from worker; reverse to oldest-first
    const sorted = [...obs].reverse();

    if (series === 'CPIAUCSL' || series === 'CPILFESL') {
      // Compute YoY %
      return sorted.map((o, i) => {
        const prev12 = sorted[i - 12];
        const val = parseFloat(o.value);
        const yoyPct = prev12 ? +((val - parseFloat(prev12.value)) / parseFloat(prev12.value) * 100).toFixed(2) : null;
        return { date: o.date, value: val, yoyPct };
      });
    }

    if (series === 'PAYEMS') {
      // Compute MoM change (thousands)
      return sorted.map((o, i) => {
        const prev = sorted[i - 1];
        const val = parseFloat(o.value);
        const mom = prev ? +((val - parseFloat(prev.value)) * 1).toFixed(1) : null;
        return { date: o.date, value: val, mom };
      });
    }

    // Default: return as-is with parsed value
    return sorted.map(o => ({ date: o.date, value: parseFloat(o.value) }));
  }
};


/* ═══════════════════════════════════════
   NEWS ENGINE (removed ForexFactory scraping)
   Now uses a static/manual approach
═══════════════════════════════════════ */
const NewsEngine = {
  _timer: null,

  start() {
    // No more ForexFactory scraping — set empty and log
    console.log('[NewsEngine] News via Notion or manual — ForexFactory removed');
    State.set('news', []);
  },

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  },

  nextHighImpact() {
    const events = State.get('news') || [];
    const now = new Date();
    return events
      .filter(ev => (ev.impact || '').toLowerCase() === 'high' && new Date(ev.date) > now)
      .sort((a, b) => new Date(a.date) - new Date(b.date))[0] || null;
  }
};


/* ═══════════════════════════════════════
   TRADE ENGINE (Notion Journal)
═══════════════════════════════════════ */
const TradeEngine = {

  async load(progressCb) {
    if (!State.isStale('trades', Config.CACHE.TRADES)) return;

    const token = TokenStore.get();
    if (!token) throw new Error('NO_TOKEN');

    try {
      let allResults = [];
      let cursor = undefined;

      // Paginate through all Notion results
      do {
        const body = cursor ? { start_cursor: cursor } : {};
        const data = await API.query(Config.DB.TRADES, token, body);
        allResults = allResults.concat(data.results || []);
        cursor = data.has_more ? data.next_cursor : undefined;
        if (progressCb) progressCb(allResults.length);
      } while (cursor);

      // Sort newest first
      allResults.sort((a, b) => {
        const da = a.properties?.Date?.date?.start || a.created_time || '';
        const db = b.properties?.Date?.date?.start || b.created_time || '';
        return db.localeCompare(da);
      });

      const trades = allResults.map(this._parse).filter(t => t.date);
      const stats  = this._analyze(trades);

      State.set('trades', trades);
      State.set('journalStats', stats);

      console.log(`[TradeEngine] ${trades.length} trades · WR ${stats.winRate}%`);

    } catch (e) {
      console.warn('[TradeEngine] Failed:', e.message);
      throw e;
    }
  },

  _parse(page) {
    const p = page.properties || {};

    // Helper: find property by matching type and common name patterns
    const find = (keys, type) => {
      for (const k of keys) {
        const match = Object.entries(p).find(([name, prop]) =>
          prop.type === type && name.toLowerCase().includes(k.toLowerCase())
        );
        if (match) return match[1];
      }
      return null;
    };

    const getText  = (keys)        => find(keys, 'rich_text')?.rich_text?.map(r => r.plain_text).join('') || null;
    const getSelect= (keys)        => find(keys, 'select')?.select?.name || null;
    const getNum   = (keys)        => find(keys, 'number')?.number ?? null;
    const getDate  = (keys)        => find(keys, 'date')?.date?.start || null;
    const getTitle = ()            => Object.values(p).find(x => x.type === 'title')?.title?.[0]?.plain_text || null;
    const getFiles = (keys)        => {
      const prop = find(keys, 'files');
      if (!prop) return [];
      return (prop.files || []).map(f => f.file?.url || f.external?.url || '').filter(Boolean);
    };
    const getMulti = (keys)        => {
      const prop = find(keys, 'multi_select');
      return prop ? (prop.multi_select || []).map(x => x.name) : [];
    };

    return {
      id:          page.id,
      date:        getDate(['date','traded','entry']),
      pair:        getSelect(['pair','symbol','instrument']) || getTitle(),
      direction:   getSelect(['direction','side','type','long','short']),
      outcome:     getSelect(['outcome','result','win','loss']),
      rMultiple:   getNum(['r multiple','r-multiple','rmultiple','r multi','r']),
      grade:       getSelect(['grade','setup','quality']),
      session:     getSelect(['session','time','market']),
      comment:     getText(['comment','notes','note','journal','thought']),
      confluences: getMulti(['confluence','setup','reason','criteria']),
      images:      getFiles(['chart','image','screenshot','file']),
    };
  },

  _analyze(trades) {
    const valid   = trades;
    const wins    = trades.filter(t => /win/i.test(t.outcome));
    const losses  = trades.filter(t => /los/i.test(t.outcome));
    const bes     = trades.filter(t => /break|be/i.test(t.outcome));

    const winRate = trades.length ? Math.round((wins.length / trades.length) * 100) : 0;

    const avgWin  = wins.length
      ? +(wins.reduce((s, t) => s + (t.rMultiple || 0), 0) / wins.length).toFixed(2) : 0;

    const avgLoss = losses.length
      ? +Math.abs(losses.reduce((s, t) => s + (t.rMultiple || 0), 0) / losses.length).toFixed(2) : 0;

    const ev = +((winRate / 100 * avgWin) - ((1 - winRate / 100) * avgLoss)).toFixed(3);

    // Cumulative equity curve
    const sorted  = [...trades].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    let running = 0;
    const equity  = sorted.map(t => { running += (t.rMultiple || 0); return { date: t.date, r: +running.toFixed(2), trade: t }; });
    const curR    = equity.length ? equity[equity.length - 1].r : 0;
    const peakR   = equity.length ? Math.max(...equity.map(e => e.r)) : 0;
    const drawdown= peakR > 0 ? Math.round((peakR - curR) / peakR * 100) : 0;

    // Monthly buckets
    const monthly = {};
    sorted.forEach(t => {
      if (!t.date) return;
      const mk = t.date.slice(0, 7);
      if (!monthly[mk]) monthly[mk] = { r: 0, wins: 0, total: 0, label: mk };
      monthly[mk].r     += (t.rMultiple || 0);
      monthly[mk].wins  += /win/i.test(t.outcome) ? 1 : 0;
      monthly[mk].total++;
    });
    const sortedMonths = Object.values(monthly).sort((a, b) => a.label.localeCompare(b.label));
    sortedMonths.forEach(m => { m.r = +m.r.toFixed(2); m.winRate = m.total ? Math.round(m.wins / m.total * 100) : 0; });

    // By day
    const byDay = {};
    sorted.forEach(t => {
      if (!t.date) return;
      const dk = t.date.slice(0, 10);
      if (!byDay[dk]) byDay[dk] = [];
      byDay[dk].push(t);
    });

    // Sessions
    const sessions = {};
    sorted.forEach(t => {
      const s = t.session || 'Unknown';
      if (!sessions[s]) sessions[s] = { wins: 0, total: 0 };
      sessions[s].total++;
      if (/win/i.test(t.outcome)) sessions[s].wins++;
    });

    // Grades
    const grades = {};
    sorted.forEach(t => {
      const g = t.grade || 'Unknown';
      if (!grades[g]) grades[g] = { wins: 0, total: 0 };
      grades[g].total++;
      if (/win/i.test(t.outcome)) grades[g].wins++;
    });

    // Timeframes
    const tfs = {};
    sorted.forEach(t => {
      const tf = t.timeframe || 'Unknown';
      if (!tfs[tf]) tfs[tf] = { wins: 0, total: 0 };
      tfs[tf].total++;
      if (/win/i.test(t.outcome)) tfs[tf].wins++;
    });

    return {
      valid, wins, losses, bes,
      winRate, avgWin, avgLoss, ev,
      equity, curR: +curR.toFixed(2), peakR: +peakR.toFixed(2), drawdown,
      sortedMonths, byDay, sessions, grades, tfs,
    };
  }
};


/* ═══════════════════════════════════════
   MONTE CARLO ENGINE
═══════════════════════════════════════ */
const MonteCarloEngine = {

  run({ winRate, avgWin, avgLoss, trades, runs = 500 }) {
    const wr = winRate / 100;
    const RUIN_THRESHOLD = -20; // R below this = ruin
    const allFinals = [];
    let ruinCount = 0;

    const paths = { p10: null, p50: null, p90: null };
    const allPaths = [];

    for (let i = 0; i < runs; i++) {
      let equity = 0;
      const path = [0];

      for (let t = 0; t < trades; t++) {
        equity += Math.random() < wr ? avgWin : -avgLoss;
        path.push(+equity.toFixed(2));
      }

      allFinals.push(equity);
      allPaths.push(path);
      if (equity < RUIN_THRESHOLD) ruinCount++;
    }

    allFinals.sort((a, b) => a - b);
    const p10 = allFinals[Math.floor(runs * 0.10)];
    const p50 = allFinals[Math.floor(runs * 0.50)];
    const p90 = allFinals[Math.floor(runs * 0.90)];
    const ev  = +((wr * avgWin) - ((1 - wr) * avgLoss)).toFixed(3);

    // Pick 3 representative paths for display
    const pathP10 = allPaths.find(p => Math.abs(p[p.length-1] - p10) < 0.5) || allPaths[Math.floor(runs * 0.10)];
    const pathP50 = allPaths.find(p => Math.abs(p[p.length-1] - p50) < 0.5) || allPaths[Math.floor(runs * 0.50)];
    const pathP90 = allPaths.find(p => Math.abs(p[p.length-1] - p90) < 0.5) || allPaths[Math.floor(runs * 0.90)];

    const result = {
      p10: +p10.toFixed(2),
      p50: +p50.toFixed(2),
      p90: +p90.toFixed(2),
      ev,
      ruinPct: Math.round(ruinCount / runs * 100),
      paths: { p10: pathP10, p50: pathP50, p90: pathP90 },
      trades,
      runs,
    };

    State.set('monteCarlo', result);
    return result;
  }
};


/* ═══════════════════════════════════════
   CHARTS UTILITY
═══════════════════════════════════════ */
const Charts = {

  equity(svgId, stats, range = 'all') {
    const svg = document.getElementById(svgId);
    if (!svg || !stats?.equity?.length) return;

    let data = stats.equity;
    if (range === '3m') data = data.slice(-66); // ~3 months of trading days
    if (range === '1m') data = data.slice(-22);

    const W = 800, H = 200, PAD = 30;
    const vals = data.map(d => d.r);
    const minV = Math.min(...vals, 0);
    const maxV = Math.max(...vals, 0.1);
    const range_ = maxV - minV || 1;

    const px = i => PAD + (i / (data.length - 1)) * (W - PAD * 2);
    const py = v => H - PAD - ((v - minV) / range_) * (H - PAD * 2);

    const pts = data.map((d, i) => `${px(i)},${py(d.r)}`).join(' ');
    const fill = `${data.map((d, i) => `${px(i)},${py(d.r)}`).join(' ')} ${px(data.length-1)},${py(0)} ${px(0)},${py(0)}`;

    svg.innerHTML = `
      <defs>
        <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${vals[vals.length-1]>=0?'#00d47a':'#ff2d55'}" stop-opacity=".35"/>
          <stop offset="100%" stop-color="${vals[vals.length-1]>=0?'#00d47a':'#ff2d55'}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <line x1="${PAD}" y1="${py(0)}" x2="${W-PAD}" y2="${py(0)}" stroke="rgba(255,255,255,.06)" stroke-width="1"/>
      <polygon points="${fill}" fill="url(#eqGrad)"/>
      <polyline points="${pts}" fill="none" stroke="${vals[vals.length-1]>=0?'#00d47a':'#ff2d55'}" stroke-width="2"/>
      <circle cx="${px(data.length-1)}" cy="${py(vals[vals.length-1])}" r="3" fill="${vals[vals.length-1]>=0?'#00d47a':'#ff2d55'}"/>
    `;
  },

  sparkline(svgId, data, color, valueKey = 'value') {
    const svg = document.getElementById(svgId);
    if (!svg || !data?.length) return;

    const W = 300, H = 60;
    const vals = data.map(d => d[valueKey] ?? d.value ?? 0).filter(v => v != null && !isNaN(v));
    if (!vals.length) return;

    const minV = Math.min(...vals);
    const maxV = Math.max(...vals);
    const range = maxV - minV || 1;

    const px = i => (i / (vals.length - 1)) * W;
    const py = v => H - 4 - ((v - minV) / range) * (H - 8);

    const pts = vals.map((v, i) => `${px(i)},${py(v)}`).join(' ');
    svg.innerHTML = `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>`;
  },

  barChart(svgId, data, colorFn) {
    const svg = document.getElementById(svgId);
    if (!svg || !data?.length) return;

    const W = 380, H = 120, PAD = 8;
    const vals = data.map(d => d.value);
    const maxAbs = Math.max(...vals.map(Math.abs), 0.1);
    const bw = Math.max(1, (W - PAD * 2) / data.length - 2);
    const zero = H / 2;

    let out = '';
    data.forEach((d, i) => {
      const x   = PAD + i * ((W - PAD * 2) / data.length);
      const h   = Math.abs(d.value) / maxAbs * (H / 2 - 10);
      const y   = d.value >= 0 ? zero - h : zero;
      const clr = colorFn ? colorFn(d, d.value) : (d.value >= 0 ? 'var(--green)' : 'var(--red)');
      out += `<rect x="${x}" y="${y}" width="${bw}" height="${Math.max(h, 1)}" fill="${clr}" opacity=".85"/>`;
    });

    out += `<line x1="${PAD}" y1="${zero}" x2="${W-PAD}" y2="${zero}" stroke="rgba(255,255,255,.06)" stroke-width="1"/>`;
    svg.innerHTML = out;
  },

  donut(svgId, segments) {
    const svg = document.getElementById(svgId);
    if (!svg) return;

    const total = segments.reduce((s, x) => s + x.value, 0);
    if (!total) { svg.innerHTML = '<text x="130" y="65" fill="#374a60" text-anchor="middle" font-size="10">No data</text>'; return; }

    const cx = 65, cy = 60, r = 48, inner = 30;
    let angle = -Math.PI / 2;
    let paths = '';

    segments.forEach(seg => {
      if (!seg.value) return;
      const slice = (seg.value / total) * 2 * Math.PI;
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      angle += slice;
      const x2 = cx + r * Math.cos(angle);
      const y2 = cy + r * Math.sin(angle);
      const xi1 = cx + inner * Math.cos(angle - slice);
      const yi1 = cy + inner * Math.sin(angle - slice);
      const xi2 = cx + inner * Math.cos(angle);
      const yi2 = cy + inner * Math.sin(angle);
      const large = slice > Math.PI ? 1 : 0;
      paths += `<path d="M${xi1},${yi1} L${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} L${xi2},${yi2} A${inner},${inner} 0 ${large},0 ${xi1},${yi1}" fill="${seg.color}" opacity=".9"/>`;
    });

    // Legend
    let legend = '';
    segments.forEach((seg, i) => {
      const pct = Math.round(seg.value / total * 100);
      legend += `<g transform="translate(145,${20 + i * 28})">
        <rect width="8" height="8" fill="${seg.color}" rx="2"/>
        <text x="13" y="8" fill="#9aaabb" font-size="9">${seg.label} ${seg.value} (${pct}%)</text>
      </g>`;
    });

    svg.innerHTML = paths + legend;
  },

  monteCarlo(svgId, mc) {
    const svg = document.getElementById(svgId);
    if (!svg || !mc?.paths) return;

    const W = 600, H = 180, PAD = 30;
    const { p10: pathP10, p50: pathP50, p90: pathP90 } = mc.paths;
    const allVals = [...pathP10, ...pathP50, ...pathP90];
    const minV = Math.min(...allVals, 0);
    const maxV = Math.max(...allVals, 0.1);
    const range = maxV - minV || 1;
    const n = pathP50.length;

    const px = i => PAD + (i / (n - 1)) * (W - PAD * 2);
    const py = v => H - PAD - ((v - minV) / range) * (H - PAD * 2);

    const line = (path, color, width = 1.5, dash = '') =>
      `<polyline points="${path.map((v, i) => `${px(i)},${py(v)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="${width}" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;

    svg.innerHTML = `
      <line x1="${PAD}" y1="${py(0)}" x2="${W-PAD}" y2="${py(0)}" stroke="rgba(255,255,255,.08)" stroke-width="1" stroke-dasharray="4,4"/>
      ${line(pathP10, '#ff2d55', 1.5, '4,3')}
      ${line(pathP50, '#00d47a', 2)}
      ${line(pathP90, '#3d8eff', 1.5, '4,3')}
      <text x="${W-PAD+4}" y="${py(mc.p10)+4}" fill="#ff2d55" font-size="9">P10</text>
      <text x="${W-PAD+4}" y="${py(mc.p50)+4}" fill="#00d47a" font-size="9">P50</text>
      <text x="${W-PAD+4}" y="${py(mc.p90)+4}" fill="#3d8eff" font-size="9">P90</text>
    `;
  }
};


/* ═══════════════════════════════════════
   AI ENGINE
═══════════════════════════════════════ */
const AIEngine = {

  async ask(question, role = 'analyst') {
    const macro  = State.get('macro')        || {};
    const stats  = State.get('journalStats') || {};
    const prices = State.get('prices')       || {};

    // Build clean context — don't dump raw FRED arrays, just latest values
    const macroSummary = {};
    if (macro.CPIAUCSL?.length) {
      const last = macro.CPIAUCSL[macro.CPIAUCSL.length - 1];
      macroSummary.cpi_yoy = last.yoyPct != null ? last.yoyPct.toFixed(2) + '%' : 'N/A';
    }
    if (macro.UNRATE?.length) {
      macroSummary.unemployment = macro.UNRATE[macro.UNRATE.length - 1].value.toFixed(1) + '%';
    }
    if (macro.FEDFUNDS?.length) {
      macroSummary.fed_funds = macro.FEDFUNDS[macro.FEDFUNDS.length - 1].value.toFixed(2) + '%';
    }
    if (macro.PAYEMS?.length) {
      const last = macro.PAYEMS[macro.PAYEMS.length - 1];
      macroSummary.nfp_mom = last.mom != null ? (last.mom >= 0 ? '+' : '') + Math.round(last.mom) + 'K' : 'N/A';
    }

    const pricesSummary = {};
    ['EURUSD','GBPUSD','XAUUSD','DXY'].forEach(sym => {
      if (prices[sym]) pricesSummary[sym] = prices[sym].price;
    });

    const journalSummary = stats.winRate != null ? {
      win_rate: stats.winRate + '%',
      avg_win:  stats.avgWin + 'R',
      avg_loss: stats.avgLoss + 'R',
      ev_per_trade: stats.ev + 'R',
      total_r: stats.curR,
    } : {};

    const prompt =
      `Role: ${role === 'reviewer' ? 'Weekly performance reviewer' : 'Institutional macro analyst'}\n\n` +
      `Current Macro Data:\n${JSON.stringify(macroSummary, null, 2)}\n\n` +
      `Live Prices:\n${JSON.stringify(pricesSummary, null, 2)}\n\n` +
      (Object.keys(journalSummary).length ? `Journal Stats:\n${JSON.stringify(journalSummary, null, 2)}\n\n` : '') +
      `Question: ${question}`;

    const res = await API.ai(prompt);
    return res.reply || res.response || JSON.stringify(res);
  }
};


/* ═══════════════════════════════════════
   NAV ENGINE
═══════════════════════════════════════ */
const NavEngine = {
  init(pageId) {
    State.merge('ui', { currentPage: pageId });

    const linksEl = document.getElementById('nav-links');
    if (linksEl && typeof Config !== 'undefined') {
      linksEl.innerHTML = Config.PAGES.map(p => {
        const active = p.id === pageId ? ' active' : '';
        const onclick = p.id !== pageId ? `onclick="window._navGo('${p.file}')"` : '';
        return `<div class="nav-link${active}" ${onclick}>${p.label}</div>`;
      }).join('');
    }

    // Smooth page transition
    document.body.style.opacity = '1';

    window._navGo = (file) => {
      document.body.style.transition = 'opacity 130ms ease';
      document.body.style.opacity = '0';
      setTimeout(() => { window.location.href = file; }, 140);
    };
  }
};


/* ═══════════════════════════════════════
   GLOBAL EXPORTS
   Must be at the very bottom, after all
   engine definitions above.
═══════════════════════════════════════ */
window.PriceEngine      = PriceEngine;
window.MacroEngine      = MacroEngine;
window.NewsEngine       = NewsEngine;
window.TradeEngine      = TradeEngine;
window.MonteCarloEngine = MonteCarloEngine;
window.AIEngine         = AIEngine;
window.NavEngine        = NavEngine;
window.Charts           = Charts;
window.updatePriceUI    = updatePriceUI;
