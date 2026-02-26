/**
 * TradeOS v4 · core/engines.js
 * ─────────────────────────────────────────────────────────────
 * All data engines. Each engine:
 *   - Fetches data via API
 *   - Writes to State
 *   - Emits state change events
 *   - Pages subscribe and re-render
 * Pages never fetch directly. Engines never render.
 * ─────────────────────────────────────────────────────────────
 */


// ════════════════════════════════════════════════════════════
// PRICE ENGINE — single interval, all pages share it
// ════════════════════════════════════════════════════════════
const PriceEngine = {
  _timer: null,
  _notifOk: false,

  start() {
    this.fetch();
    const delay = ApiKeyStore.td() ? Config.INTERVALS.PRICES_TD : Config.INTERVALS.PRICES_FREE;
    this._timer = setInterval(() => this.fetch(), delay);
    console.log(`[PriceEngine] Started · ${ApiKeyStore.td() ? '2min (TD)' : '5min (free)'}`);
  },

  stop() { clearInterval(this._timer); },

  async fetch() {
    try {
      const raw    = await API.prices();
      const prev   = State.get('prices');
      const prices = {};

      for (const sym of ['EURUSD', 'GBPUSD', 'DXY', 'XAUUSD']) {
        if (!raw[sym]) continue;
        const price = parseFloat(raw[sym]);
        if (isNaN(price)) continue;
        const prevPrice = prev[sym]?.price ?? null;
        prices[sym] = {
          price,
          prev:      prevPrice,
          change:    prevPrice !== null ? +(price - prevPrice).toFixed(6) : 0,
          changePct: prevPrice !== null ? +((price - prevPrice) / prevPrice * 100).toFixed(4) : 0,
          source:    raw.source,
          ts:        Date.now(),
        };
      }

      State.set('prices', prices);
      this._checkAlerts(prices);
      console.log(`[PriceEngine] ${raw.source} · EUR ${prices.EURUSD?.price}`);
    } catch (e) {
      console.warn('[PriceEngine] Fetch failed:', e.message);
      State._emit('priceError', e.message);
    }
  },

  setAlerts(levels) {
    State.merge('ui', { priceAlerts: levels });
  },

  _checkAlerts(prices) {
    const alerts  = State.get('ui').priceAlerts || {};
    const fired   = State.get('ui').alertsFired;

    for (const [sym, levels] of Object.entries(alerts)) {
      const d = prices[sym]; if (!d) continue;
      (levels || []).forEach(level => {
        const dist = Math.abs(d.price - level) / level * 100;
        const type = dist <= 0.15 ? 'hit' : dist <= 0.4 ? 'near' : null;
        if (!type) return;
        const key = `${sym}:${level}:${type}`;
        if (fired.has(key)) return;
        fired.add(key);
        setTimeout(() => fired.delete(key), type === 'hit' ? 1_800_000 : 900_000);
        State._emit('alert', { sym, level, type, price: d.price });
        if (type === 'hit' && this._notifOk) {
          try { new Notification(`🚨 ${sym} HIT ${level}`, { body: `Price: ${d.price}` }); } catch {}
        }
      });
    }
  },

  async requestNotifications() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') { this._notifOk = true; return; }
    if (Notification.permission !== 'denied') {
      const p = await Notification.requestPermission().catch(() => 'denied');
      this._notifOk = p === 'granted';
    }
  },
};


// ════════════════════════════════════════════════════════════
// MACRO ENGINE — FRED data, cached 1h
// ════════════════════════════════════════════════════════════
const MacroEngine = {
  _timer: null,

  async start() {
    await this.fetch();
    this._timer = setInterval(() => this.fetch(), Config.INTERVALS.MACRO);
  },

  stop() { clearInterval(this._timer); },

  async fetch() {
    // Return cached if fresh
    if (!State.isStale('macro', Config.CACHE.MACRO)) {
      console.log('[MacroEngine] Cache hit');
      return;
    }

    const fredKey = ApiKeyStore.fred();
    if (!fredKey) {
      State.set('macro', { _error: 'No FRED key', _noKey: true });
      return;
    }

    console.log('[MacroEngine] Fetching FRED…');
    const results = await Promise.allSettled(
      Config.FRED_SERIES.map(s => API.fred(s).then(d => ({ series: s, obs: d.observations || [] })))
    );

    const macro = {};
    results.forEach(r => {
      if (r.status === 'fulfilled') {
        macro[r.value.series] = r.value.obs;
      }
    });

    // Compute context for AI
    macro._context = this._buildContext(macro);
    State.set('macro', macro);
    console.log('[MacroEngine] Done · series:', Object.keys(macro).filter(k => !k.startsWith('_')).join(', '));
  },

  _buildContext(macro) {
    const last = arr => arr && arr.length ? arr[arr.length - 1] : null;
    const lc   = last(macro.CPIAUCSL);
    const lcore= last(macro.CPILFESL);
    const lu   = last(macro.UNRATE);
    const ln   = last(macro.PAYEMS);
    const lg   = last(macro.A191RL1Q225SBEA);
    const lf   = last(macro.FEDFUNDS);

    return {
      fedRate:    lf    ? lf.value.toFixed(2)    + '%' : 'unknown',
      cpiYoY:     lc?.yoyPct  != null ? lc.yoyPct.toFixed(1)  + '%' : 'unknown',
      coreCpiYoY: lcore?.yoyPct != null ? lcore.yoyPct.toFixed(1) + '%' : 'unknown',
      nfpMoM:     ln?.mom != null ? Math.round(ln.mom) + 'K' : 'unknown',
      unemployment: lu  ? lu.value.toFixed(1)   + '%' : 'unknown',
      gdpQoQ:     lg    ? lg.value.toFixed(1)    + '%' : 'unknown',
      asOf:       new Date().toLocaleDateString(),
    };
  },
};


// ════════════════════════════════════════════════════════════
// NEWS ENGINE — ForexFactory, cached 30min
// ════════════════════════════════════════════════════════════
const NewsEngine = {
  _timer: null,

  async start() {
    await this.fetch();
    this._timer = setInterval(() => this.fetch(), Config.INTERVALS.NEWS);
  },

  stop() { clearInterval(this._timer); },

  async fetch() {
    if (!State.isStale('news', Config.CACHE.NEWS)) {
      console.log('[NewsEngine] Cache hit');
      return;
    }
    try {
      const data = await API.news();
      State.set('news', Array.isArray(data) ? data : []);
      console.log(`[NewsEngine] ${State.get('news').length} events loaded`);
    } catch (e) {
      console.warn('[NewsEngine] Failed:', e.message);
      State._emit('newsError', e.message);
    }
  },

  // Helper: next high-impact event from now
  nextHighImpact() {
    const now  = Date.now();
    return (State.get('news') || [])
      .filter(ev => {
        const d = new Date(ev.date);
        return !isNaN(d) && d.getTime() > now && (ev.impact || '').toLowerCase() === 'high';
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date))[0] || null;
  },
};


// ════════════════════════════════════════════════════════════
// TRADE ENGINE — parse + analyze Notion journal
// ════════════════════════════════════════════════════════════
const TradeEngine = {

  async load(onProgress) {
    if (!State.isStale('trades', Config.CACHE.TRADES)) {
      console.log('[TradeEngine] Cache hit');
      return;
    }
    const pages  = await API.queryTrades(onProgress);
    const trades = pages.map(this._parse).filter(t => t.date);
    const stats  = this._analyze(trades);
    State.set('trades',       trades);
    State.set('journalStats', stats);
    console.log(`[TradeEngine] ${trades.length} trades · WR ${stats.winRate}%`);

    // Update AI context with journal stats
    State.merge('aiContext', { journalStats: stats });
  },

  _getProp(props, query, type) {
    const k = Object.keys(props).find(k => k.toLowerCase().includes(query.toLowerCase()));
    if (!k) return type === 'multi_select' ? [] : type === 'files' ? [] : null;
    const p = props[k];
    if (type === 'select')       return p.select?.name || null;
    if (type === 'multi_select') return (p.multi_select || []).map(x => x.name);
    if (type === 'number')       return p.number ?? null;
    if (type === 'date')         return p.date?.start || null;
    if (type === 'rich_text')    return (p.rich_text || []).map(r => r.plain_text).join('');
    if (type === 'title')        return (p.title || []).map(r => r.plain_text).join('');
    if (type === 'files')        return (p.files || []).map(f => f.file?.url || f.external?.url || '').filter(Boolean);
    return null;
  },

  _parse(page) {
    const p   = page.properties;
    const g   = (q, t) => TradeEngine._getProp(p, q, t);
    const raw = g('outcome', 'select') || '';
    const outcome = /win/i.test(raw) ? 'Win' : /loss|lose/i.test(raw) ? 'Lose' : /be|break/i.test(raw) ? 'Breakeven' : raw;
    return {
      id:          page.id,
      date:        g('date', 'date'),
      pair:        g('pair', 'select') || g('pair', 'rich_text'),
      direction:   g('direction', 'select'),
      outcome,
      rMultiple:   g('multiple', 'number') ?? g('r multiple', 'number') ?? g('r-multiple', 'number'),
      session:     g('session', 'select'),
      htfContext:  g('htf', 'select'),
      entryTF:     g('entry time', 'select') || g('entry tf', 'select'),
      confluences: g('ltf', 'multi_select') || g('confluence', 'multi_select') || [],
      comment:     g('comment', 'rich_text') || g('note', 'rich_text'),
      images:      g('files', 'files') || g('chart', 'files') || [],
    };
  },

  _grade(t) {
    let s = 0;
    const c   = t.confluences || [];
    const has = q => c.some(x => x.toLowerCase().includes(q.toLowerCase()));
    if (has('CISD') || has('CSID')) s += 2;
    if (has('Displacement'))        s += 2;
    if (has('Sweep'))               s += 2;
    if (has('SMT'))                 s += 2;
    if (has('Kill Zone') || has('KZ')) s += 1;
    if (t.session === 'London KZ')  s += 2;
    else if (t.session === 'OFF session') s += 1;
    if (t.htfContext)               s += 1;
    if (c.length >= 4) s += 2; else if (c.length >= 3) s += 1;
    return s >= 11 ? 'A+' : s >= 7 ? 'B' : 'C';
  },

  _analyze(raw) {
    const valid = raw.filter(t => t.date).sort((a, b) => new Date(a.date) - new Date(b.date));
    valid.forEach(t => { t.grade = this._grade(t); });

    let running = 0;
    valid.forEach(t => { running += t.rMultiple || 0; t.cumR = Math.round(running * 100) / 100; });

    const wins   = valid.filter(t => t.outcome === 'Win');
    const losses = valid.filter(t => t.outcome === 'Lose');
    const bes    = valid.filter(t => t.outcome === 'Breakeven');

    const months   = {};
    const sessions = {};
    const tfs      = {};
    const byDay    = {};
    const grades   = { 'A+': { wins: 0, total: 0 }, B: { wins: 0, total: 0 }, C: { wins: 0, total: 0 } };

    valid.forEach(t => {
      const d  = new Date(t.date);
      const mk = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      if (!months[mk]) months[mk] = { label: d.toLocaleString('en-US',{month:'short',year:'2-digit'}), wins:0,losses:0,bes:0,r:0,order:d.getFullYear()*100+d.getMonth() };
      months[mk].wins   += t.outcome==='Win'       ? 1 : 0;
      months[mk].losses += t.outcome==='Lose'      ? 1 : 0;
      months[mk].bes    += t.outcome==='Breakeven' ? 1 : 0;
      months[mk].r      += t.rMultiple || 0;

      const s = t.session || 'Unknown';
      if (!sessions[s]) sessions[s] = { wins:0, total:0 };
      sessions[s].total++;
      if (t.outcome === 'Win') sessions[s].wins++;

      const tf = t.entryTF || 'Unknown';
      if (!tfs[tf]) tfs[tf] = { wins:0, total:0 };
      tfs[tf].total++;
      if (t.outcome === 'Win') tfs[tf].wins++;

      const dk = t.date.slice(0, 10);
      if (!byDay[dk]) byDay[dk] = [];
      byDay[dk].push(t);

      if (grades[t.grade]) {
        grades[t.grade].total++;
        if (t.outcome === 'Win') grades[t.grade].wins++;
      }
    });

    const peakR   = valid.length ? Math.max(...valid.map(t => t.cumR)) : 0;
    const curR    = valid.length ? valid[valid.length-1].cumR : 0;
    const winRate = valid.length ? Math.round(wins.length / valid.length * 100) : 0;
    const avgWin  = wins.length  ? +(wins.reduce((s,t) => s+(t.rMultiple||0),0) / wins.length).toFixed(2) : 0;
    const avgLoss = losses.length? +(losses.reduce((s,t) => s+Math.abs(t.rMultiple||0),0) / losses.length).toFixed(2) : 0;
    const ev      = (wins.length && losses.length) ? +((winRate/100*avgWin) - ((1-winRate/100)*avgLoss)).toFixed(3) : null;

    return {
      valid, wins, losses, bes,
      winRate, avgWin, avgLoss, ev,
      peakR, curR,
      drawdown: peakR > 0 ? Math.round((peakR - curR) / peakR * 100) : 0,
      sortedMonths: Object.values(months).sort((a,b) => a.order-b.order).map(m => ({...m, r: Math.round(m.r*100)/100})),
      sessions, tfs, byDay, grades,
    };
  },
};


// ════════════════════════════════════════════════════════════
// AI ENGINE — structured context, never raw data
// ════════════════════════════════════════════════════════════
const AIEngine = {
  _history: [],
  _maxHistory: 6, // keep last 3 exchanges

  // Build structured context from current state
  buildContext() {
    const macro  = State.get('macro')?._context || {};
    const stats  = State.get('journalStats') || {};
    const prices = State.get('prices') || {};

    const ctx = {
      macro: {
        fedRate:      macro.fedRate      || 'unknown',
        cpiYoY:       macro.cpiYoY      || 'unknown',
        coreCpiYoY:   macro.coreCpiYoY  || 'unknown',
        nfpMoM:       macro.nfpMoM      || 'unknown',
        unemployment: macro.unemployment || 'unknown',
        gdpQoQ:       macro.gdpQoQ      || 'unknown',
        asOf:         macro.asOf        || 'unknown',
      },
      prices: {
        EURUSD: prices.EURUSD?.price?.toFixed(5) || 'unknown',
        GBPUSD: prices.GBPUSD?.price?.toFixed(5) || 'unknown',
        XAUUSD: prices.XAUUSD?.price?.toFixed(2) || 'unknown',
        DXY:    prices.DXY?.price?.toFixed(3)    || 'unknown',
      },
      journal: {
        totalTrades: stats.valid?.length || 0,
        winRate:     stats.winRate       || 0,
        avgWin:      stats.avgWin        || 0,
        avgLoss:     stats.avgLoss       || 0,
        ev:          stats.ev            || 0,
        totalR:      stats.curR          || 0,
        peakR:       stats.peakR         || 0,
        drawdown:    stats.drawdown      || 0,
      },
    };

    State.set('aiContext', ctx);
    return ctx;
  },

  systemPrompt(role = 'analyst') {
    const prompts = {
      analyst: `You are a professional forex macro analyst and trading coach. You have access to live economic data and the user's trading journal statistics. Be concise (2-3 paragraphs max), direct, and actionable. Always relate analysis to EUR/USD, GBP/USD, XAU/USD, or DXY where relevant. Do not use markdown headers.`,
      reviewer: `You are a trading performance coach reviewing a trader's weekly results. Be honest, specific, and constructive. Focus on patterns, discipline, and improvement areas. Maximum 3 paragraphs.`,
      risk: `You are a risk management specialist. Evaluate the trade setup and provide a clear risk assessment. Focus on position sizing, R:R quality, and whether this meets minimum setup criteria.`,
    };
    return prompts[role] || prompts.analyst;
  },

  async ask(question, role = 'analyst') {
    const ctx = this.buildContext();
    const contextStr = `Live data context:
Macro: Fed ${ctx.macro.fedRate} · CPI ${ctx.macro.cpiYoY} · Core ${ctx.macro.coreCpiYoY} · NFP ${ctx.macro.nfpMoM} · Unemployment ${ctx.macro.unemployment} · GDP ${ctx.macro.gdpQoQ} (as of ${ctx.macro.asOf})
Prices: EUR/USD ${ctx.prices.EURUSD} · GBP/USD ${ctx.prices.GBPUSD} · XAU/USD ${ctx.prices.XAUUSD} · DXY ${ctx.prices.DXY}
Journal: ${ctx.journal.totalTrades} trades · ${ctx.journal.winRate}% WR · +${ctx.journal.avgWin}R avg win · −${ctx.journal.avgLoss}R avg loss · EV ${ctx.journal.ev}R · Total ${ctx.journal.totalR}R`;

    this._history.push({ role: 'user', content: `${contextStr}\n\nQuestion: ${question}` });
    if (this._history.length > this._maxHistory) this._history = this._history.slice(-this._maxHistory);

    const answer = await API.ai(this._history, this.systemPrompt(role));

    this._history.push({ role: 'assistant', content: answer });
    if (this._history.length > this._maxHistory) this._history = this._history.slice(-this._maxHistory);

    return answer;
  },

  clearHistory() { this._history = []; },
};


// ════════════════════════════════════════════════════════════
// MONTE CARLO ENGINE
// ════════════════════════════════════════════════════════════
const MonteCarloEngine = {

  run({ winRate, avgWin, avgLoss, trades, runs = 500 }) {
    const wr   = winRate / 100;
    const results = [];
    const paths   = []; // first 60 runs for chart
    let ruinCount = 0;

    for (let r = 0; r < runs; r++) {
      let eq = 0;
      const path = [0];
      let ruined = false;

      for (let t = 0; t < trades; t++) {
        const win = Math.random() < wr;
        eq = +(eq + (win ? avgWin : -avgLoss)).toFixed(4);
        if (eq <= -(100 / (winRate || 1)) * 2) { ruined = true; break; }
        path.push(eq);
      }

      if (ruined) ruinCount++;
      results.push(eq);
      if (r < 60) paths.push(path);
    }

    results.sort((a, b) => a - b);
    const p10 = results[Math.floor(runs * 0.10)];
    const p25 = results[Math.floor(runs * 0.25)];
    const p50 = results[Math.floor(runs * 0.50)];
    const p75 = results[Math.floor(runs * 0.75)];
    const p90 = results[Math.floor(runs * 0.90)];
    const ev  = +(wr * avgWin - (1 - wr) * avgLoss).toFixed(4);

    const result = {
      ev, p10, p25, p50, p75, p90,
      ruinPct: +(ruinCount / runs * 100).toFixed(1),
      paths,
      trades,
      params: { winRate, avgWin, avgLoss, trades, runs },
    };

    State.set('monteCarlo', result);
    return result;
  },
};


// ════════════════════════════════════════════════════════════
// NAV ENGINE — page transitions, nav render
// ════════════════════════════════════════════════════════════
const NavEngine = {

  init(currentPageId) {
    State.merge('ui', { currentPage: currentPageId });

    const el = document.getElementById('nav-links');
    if (!el) return;

    el.innerHTML = Config.PAGES.map(p => {
      const active = p.id === currentPageId ? ' active' : '';
      const click  = p.id !== currentPageId
        ? `onclick="NavEngine.go('${esc(p.file)}')"` : '';
      return `<div class="nav-link${active}" ${click}>${esc(p.label)}</div>`;
    }).join('');

    // Subscribe to price updates → update nav price displays
    State.on('prices', prices => NavEngine._updateNavPrices(prices));

    // Subscribe to alert events
    State.on('alert', alert => NavEngine._showAlert(alert));

    // Fade page in
    document.body.style.opacity = '1';
  },

  go(file) {
    document.body.style.transition = 'opacity 130ms ease';
    document.body.style.opacity    = '0';
    setTimeout(() => { window.location.href = file; }, 140);
  },

  _updateNavPrices(prices) {
    const items = [
      { id: 'np-eur', sym: 'EURUSD', dec: 5, prefix: 'EUR ' },
      { id: 'np-xau', sym: 'XAUUSD', dec: 0, prefix: 'XAU $' },
      { id: 'np-dxy', sym: 'DXY',    dec: 3, prefix: 'DXY '  },
    ];
    items.forEach(({ id, sym, dec, prefix }) => {
      const el = document.getElementById(id); if (!el) return;
      const d  = prices[sym];                 if (!d) return;
      el.textContent = prefix + d.price.toFixed(dec);
      el.style.color = d.change >= 0 ? 'var(--green)' : 'var(--red)';
    });

    // Price strip
    [
      { id: 'ps-eur', sym: 'EURUSD', dec: 5 },
      { id: 'ps-gbp', sym: 'GBPUSD', dec: 5 },
      { id: 'ps-dxy', sym: 'DXY',    dec: 3 },
      { id: 'ps-xau', sym: 'XAUUSD', dec: 2 },
    ].forEach(({ id, sym, dec }) => {
      const el = document.getElementById(id); if (!el) return;
      const d  = prices[sym];                 if (!d) return;
      const up = d.change >= 0;
      const clr = up ? 'var(--green)' : 'var(--red)';
      const price = el.querySelector('.ps-price');
      const chg   = el.querySelector('.ps-chg');
      if (price) price.textContent = d.price.toFixed(dec);
      if (chg)   { chg.textContent = (up ? '▲ ' : '▼ ') + Math.abs(d.change).toFixed(dec); chg.style.color = clr; }
    });

    const ts  = document.getElementById('strip-ts');
    const src = document.getElementById('strip-src');
    const fst = Object.values(prices)[0];
    if (ts)  ts.textContent  = new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    if (src) { src.textContent = fst?.source === 'twelvedata' ? '● Live' : '● Hourly'; src.style.color = 'var(--green)'; }

    // Nav dot
    const dot = document.getElementById('nav-dot');
    if (dot) dot.className = 'nav-dot on';
  },

  _showAlert({ sym, level, type, price }) {
    const bar = document.getElementById('alert-bar'); if (!bar) return;
    const id  = `al-${sym}-${level}-${type}`.replace(/[:.]/g, '_');
    if (document.getElementById(id)) return;
    const div = document.createElement('div');
    div.id    = id;
    div.className = `alert-item alert-${type}`;
    div.innerHTML =
      `${type === 'hit' ? '🚨' : '⚠'} <strong>${esc(sym)}</strong> ` +
      `${type === 'hit' ? 'HIT' : 'approaching'} <strong>${esc(String(level))}</strong>` +
      ` · ${esc(String(price))}` +
      `<button onclick="this.parentElement.remove()" class="alert-close">✕</button>`;
    bar.appendChild(div);
  },
};


// ════════════════════════════════════════════════════════════
// CHARTS ENGINE — reusable SVG charting
// ════════════════════════════════════════════════════════════
const Charts = {

  equity(svgId, stats, range = 'all') {
    const svg = document.getElementById(svgId); if (!svg) return;
    let data = stats.valid || [];
    const now = new Date();
    if (range === '3m') { const c = new Date(now); c.setMonth(c.getMonth()-3); data = data.filter(t => new Date(t.date) >= c); }
    if (range === '1m') { const c = new Date(now); c.setMonth(c.getMonth()-1); data = data.filter(t => new Date(t.date) >= c); }
    if (!data.length) { svg.innerHTML = ''; return; }

    let run = 0;
    const pts = data.map(t => { run += t.rMultiple||0; return { ...t, dr: Math.round(run*100)/100 }; });

    const W=800,H=200,pL=40,pR=14,pT=18,pB=28;
    const w=W-pL-pR, h=H-pT-pB;
    const vals = pts.map(p => p.dr);
    const minV = Math.min(...vals, 0)-1, maxV = Math.max(...vals)+1;
    const n    = pts.length;
    const px   = i => pL + (i/(n-1||1))*w;
    const py   = v => pT + h - ((v-minV)/(maxV-minV||1))*h;
    const zY   = py(0);

    const line = pts.map((p,i) => `${i===0?'M':'L'}${px(i).toFixed(1)},${py(p.dr).toFixed(1)}`).join(' ');
    const area = `${line} L${px(n-1).toFixed(1)},${zY.toFixed(1)} L${px(0).toFixed(1)},${zY.toFixed(1)} Z`;

    const monthsSeen = new Set();
    let monthLabels  = '';
    pts.forEach((p, i) => {
      const m = p.date?.slice(0,7);
      if (m && !monthsSeen.has(m)) {
        monthsSeen.add(m);
        const d = new Date(p.date);
        monthLabels += `<text x="${px(i).toFixed(1)}" y="${H-4}" fill="var(--muted)" font-size="7" font-family="JetBrains Mono" text-anchor="middle">${esc(d.toLocaleString('en-US',{month:'short'}))}</text>`;
      }
    });

    svg.innerHTML = `
      <defs><linearGradient id="eg-${svgId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--green)" stop-opacity=".22"/>
        <stop offset="100%" stop-color="var(--green)" stop-opacity=".02"/>
      </linearGradient></defs>
      <line x1="${pL}" x2="${W-pR}" y1="${zY}" y2="${zY}" stroke="rgba(255,255,255,.07)" stroke-width="1" stroke-dasharray="4 4"/>
      <path d="${area}" fill="url(#eg-${svgId})"/>
      <path d="${line}" fill="none" stroke="var(--green)" stroke-width="1.5" stroke-linejoin="round"/>
      <text x="${pL-4}" y="${pT+4}" fill="var(--muted)" font-size="8" font-family="JetBrains Mono" text-anchor="end">${maxV.toFixed(1)}R</text>
      <text x="${pL-4}" y="${zY+3}" fill="var(--muted)" font-size="8" font-family="JetBrains Mono" text-anchor="end">0</text>
      ${monthLabels}`;
  },

  sparkline(svgId, data, color, field = 'yoyPct') {
    const svg = document.getElementById(svgId); if (!svg || !data.length) return;
    const W=300, H=60, pL=2, pR=2, pT=4, pB=4;
    const vals = data.map(d => d[field] ?? d.value ?? 0);
    const min  = Math.min(...vals), max = Math.max(...vals);
    const rng  = max - min || 0.001;
    const n    = vals.length;
    const px   = i => pL + (i/(n-1||1))*(W-pL-pR);
    const py   = v => pT + (H-pT-pB) - ((v-min)/rng)*(H-pT-pB);
    const path = data.map((d,i) => `${i===0?'M':'L'}${px(i).toFixed(1)},${py(vals[i]).toFixed(1)}`).join(' ');
    const area = `${path} L${px(n-1)},${H-pB} L${pL},${H-pB} Z`;
    svg.innerHTML = `
      <defs><linearGradient id="sg-${svgId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity=".28"/>
        <stop offset="100%" stop-color="${color}" stop-opacity=".02"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#sg-${svgId})"/>
      <path d="${path}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>`;
  },

  barChart(svgId, data, colorFn) {
    const svg = document.getElementById(svgId); if (!svg || !data.length) return;
    const W=380, H=120, pL=6, pR=6, pT=10, pB=18;
    const w=W-pL-pR, h=H-pT-pB;
    const vals = data.map(d => d.value ?? d.r ?? 0);
    const maxA = Math.max(...vals.map(Math.abs), 0.1);
    const bw   = w/data.length - 2;
    const zY   = pT + h/2;
    let out = `<line x1="${pL}" x2="${W-pR}" y1="${zY}" y2="${zY}" stroke="rgba(255,255,255,.07)" stroke-width="1"/>`;
    data.forEach((d, i) => {
      const val = d.value ?? d.r ?? 0;
      const x   = pL + i*(w/data.length) + 1;
      const bh  = Math.max((Math.abs(val)/maxA)*(h/2), 2);
      const by  = val >= 0 ? zY - bh : zY;
      const clr = colorFn ? colorFn(d, val) : (val >= 0 ? 'var(--green)' : 'var(--red)');
      out += `<rect x="${x}" y="${by}" width="${bw}" height="${bh}" fill="${clr}" opacity=".85" rx="1"/>`;
      if (d.label) out += `<text x="${x+bw/2}" y="${H-3}" fill="var(--muted)" font-size="6" font-family="JetBrains Mono" text-anchor="middle">${esc(String(d.label))}</text>`;
    });
    svg.innerHTML = out;
  },

  donut(svgId, segments) {
    const svg    = document.getElementById(svgId); if (!svg) return;
    const total  = segments.reduce((s, x) => s + x.value, 0); if (!total) return;
    const cx=100, cy=60, r=48, iR=32;
    let angle    = -Math.PI/2;
    let arcs     = '';
    let legend   = '';
    segments.forEach((seg, i) => {
      const frac  = seg.value / total;
      const end   = angle + frac * 2 * Math.PI - 0.01;
      const large = frac > 0.5 ? 1 : 0;
      const x1=cx+r*Math.cos(angle), y1=cy+r*Math.sin(angle);
      const x2=cx+r*Math.cos(end),   y2=cy+r*Math.sin(end);
      const xi1=cx+iR*Math.cos(end), yi1=cy+iR*Math.sin(end);
      const xi2=cx+iR*Math.cos(angle),yi2=cy+iR*Math.sin(angle);
      if (seg.value > 0) arcs += `<path d="M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} L${xi1},${yi1} A${iR},${iR} 0 ${large} 0 ${xi2},${yi2} Z" fill="${seg.color}" opacity=".85"/>`;
      legend += `<text x="164" y="${14+i*18}" fill="${seg.color}" font-size="9" font-family="JetBrains Mono">${esc(seg.label)}: ${seg.value} (${Math.round(seg.value/total*100)}%)</text>`;
      angle = end + 0.01;
    });
    svg.innerHTML = arcs +
      `<text x="${cx}" y="${cy+4}" fill="var(--text)" font-size="13" font-family="Syne" text-anchor="middle" font-weight="800">${total}</text>
       <text x="${cx}" y="${cy+16}" fill="var(--muted)" font-size="7" font-family="JetBrains Mono" text-anchor="middle">TRADES</text>` +
      legend;
  },

  monteCarlo(svgId, result) {
    const svg = document.getElementById(svgId); if (!svg || !result) return;
    const { paths, p10, p50, p90, trades } = result;
    const W=600, H=180, pL=40, pR=10, pT=10, pB=22;
    const w=W-pL-pR, h=H-pT-pB;
    const allVals = paths.flat().concat([p10, p90]);
    const minV = Math.min(...allVals)-1, maxV = Math.max(...allVals)+1;
    const px   = i => pL + (i/trades)*w;
    const py   = v => pT + h - ((v-minV)/(maxV-minV||1))*h;
    const zY   = py(0);

    let out = `<line x1="${pL}" x2="${W-pR}" y1="${zY}" y2="${zY}" stroke="rgba(255,255,255,.08)" stroke-width="1" stroke-dasharray="4 3"/>`;
    paths.forEach(path => {
      const pts = path.map((v,i) => `${i===0?'M':'L'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
      out += `<path d="${pts}" fill="none" stroke="rgba(155,107,255,.12)" stroke-width=".8"/>`;
    });
    [{ v:p90,c:'var(--green)',l:'P90'},{v:p50,c:'#ccc',l:'P50'},{v:p10,c:'var(--red)',l:'P10'}].forEach(({v,c,l})=>{
      out += `<line x1="${pL}" x2="${W-pR}" y1="${py(v)}" y2="${py(v)}" stroke="${c}" stroke-width="1" stroke-dasharray="6 4" opacity=".6"/>`;
      out += `<text x="${pL-4}" y="${py(v)+4}" fill="${c}" font-size="8" font-family="JetBrains Mono" text-anchor="end">${(v>=0?'+':'')+v.toFixed(0)}R</text>`;
    });
    [0,Math.round(trades/4),Math.round(trades/2),Math.round(3*trades/4),trades].forEach(t=>{
      out += `<text x="${px(t)}" y="${H-4}" fill="var(--muted)" font-size="8" font-family="JetBrains Mono" text-anchor="middle">${t}</text>`;
    });
    svg.innerHTML = out;
  },
};
