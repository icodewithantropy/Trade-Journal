/**
 * TradeOS · core/engines.js — FINAL
 * Chart.js interactive charts, FRED-based news, Mistral AI fix
 */

/* ═══════════════════════════════════════
   PRICE ENGINE
═══════════════════════════════════════ */
const PriceEngine = {
  _timer: null,

  start() {
    if (this._timer) return;
    this.fetch();
    this._timer = setInterval(() => this.fetch(), Config.INTERVALS.PRICES_FREE);
    console.log('[PriceEngine] Started · 5min');
  },

  stop() { clearInterval(this._timer); this._timer = null; },

  async fetch() {
    try {
      const raw = await API.prices();
      const prev = State.get('prices') || {};
      const prices = {};

      ['EURUSD','GBPUSD','DXY','XAUUSD'].forEach(sym => {
        if (!raw[sym]) return;
        let price, changePct;
        if (typeof raw[sym] === 'object') {
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
          changePct: changePct || (prevPrice !== null ? +((price-prevPrice)/prevPrice*100).toFixed(4) : 0),
          source: raw.source,
          ts: Date.now(),
        };
      });

      State.set('prices', prices);
      updatePriceUI(prices, raw.source);
    } catch(e) {
      console.warn('[PriceEngine]', e.message);
    }
  }
};

function updatePriceUI(prices, source) {
  const map = [
    { elId:'ps-eur', sym:'EURUSD', dec:5 },
    { elId:'ps-gbp', sym:'GBPUSD', dec:5 },
    { elId:'ps-dxy', sym:'DXY',    dec:3 },
    { elId:'ps-xau', sym:'XAUUSD', dec:2 },
  ];
  map.forEach(({elId,sym,dec}) => {
    const d = prices[sym]; if (!d) return;
    const el = document.getElementById(elId); if (!el) return;
    const up = d.change >= 0;
    const clr = up ? 'var(--green)' : 'var(--red)';
    el.querySelector('.ps-price').textContent = d.price.toFixed(dec);
    const chg = el.querySelector('.ps-chg');
    chg.textContent = (up?'▲':'▼')+' '+Math.abs(d.change).toFixed(dec);
    chg.style.color = clr;
  });

  if (prices.EURUSD) { const e=document.getElementById('np-eur'); if(e){e.textContent=`EUR ${prices.EURUSD.price.toFixed(5)}`;e.style.color=prices.EURUSD.change>=0?'var(--green)':'var(--red)';} }
  if (prices.XAUUSD) { const e=document.getElementById('np-xau'); if(e){e.textContent=`XAU $${prices.XAUUSD.price.toFixed(0)}`;e.style.color=prices.XAUUSD.change>=0?'var(--green)':'var(--red)';} }
  if (prices.DXY)    { const e=document.getElementById('np-dxy'); if(e){e.textContent=`DXY ${prices.DXY.price.toFixed(3)}`;} }

  const ts=document.getElementById('strip-ts'); if(ts) ts.textContent=new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const src=document.getElementById('strip-src'); if(src){src.textContent=source==='twelvedata'?'● Live':'● Hourly';src.style.color='var(--green)';}
  const dot=document.getElementById('nav-dot'); if(dot) dot.className='nav-dot on';
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

  stop() { clearInterval(this._timer); this._timer = null; },

  async fetch() {
    if (!State.isStale('macro', Config.CACHE.MACRO)) return;
    try {
      const results = await Promise.allSettled(
        Config.FRED_SERIES.map(s => API.fred(s).then(d => ({ series: s, obs: d.observations||[] })))
      );
      const macro = {};
      results.forEach(r => {
        if (r.status === 'fulfilled') {
          macro[r.value.series] = MacroEngine._process(r.value.series, r.value.obs);
        }
      });
      State.set('macro', macro);
      console.log('[MacroEngine] Loaded FRED data');
    } catch(e) {
      console.warn('[MacroEngine]', e.message);
      State.set('macro', { _error: e.message });
    }
  },

  _process(series, obs) {
    const sorted = [...obs].reverse(); // oldest first
    if (series === 'CPIAUCSL' || series === 'CPILFESL') {
      return sorted.map((o,i) => {
        const prev12 = sorted[i-12];
        const val = parseFloat(o.value);
        const yoyPct = prev12 ? +((val-parseFloat(prev12.value))/parseFloat(prev12.value)*100).toFixed(2) : null;
        return { date: o.date, value: val, yoyPct };
      });
    }
    if (series === 'PAYEMS') {
      return sorted.map((o,i) => {
        const prev = sorted[i-1];
        const val = parseFloat(o.value);
        const mom = prev ? +(val - parseFloat(prev.value)).toFixed(1) : null;
        return { date: o.date, value: val, mom };
      });
    }
    return sorted.map(o => ({ date: o.date, value: parseFloat(o.value) }));
  }
};


/* ═══════════════════════════════════════
   NEWS ENGINE — uses FRED events calendar
   No more ForexFactory scraping
═══════════════════════════════════════ */
const NewsEngine = {
  start() {
    // Build economic calendar from known upcoming release dates + FRED data
    const events = NewsEngine._buildCalendar();
    State.set('news', events);
    console.log(`[NewsEngine] ${events.length} FRED calendar events`);
  },

  nextHighImpact() {
    const events = State.get('news') || [];
    const now = new Date();
    return events
      .filter(ev => ev.impact === 'high' && new Date(ev.date) > now)
      .sort((a,b) => new Date(a.date) - new Date(b.date))[0] || null;
  },

  // Build a rolling 2-week calendar of major economic events
  // Dates are approximate — update monthly
  _buildCalendar() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth(); // 0-indexed

    // Get next occurrences of recurring events
    const events = [];

    // Helper: find next occurrence of day-of-week in current/next week
    const nextWeekday = (targetDow, hour=8, minuteOffset=0) => {
      const d = new Date();
      let daysAhead = targetDow - d.getDay();
      if (daysAhead <= 0) daysAhead += 7;
      d.setDate(d.getDate() + daysAhead);
      d.setHours(hour, minuteOffset, 0, 0);
      return d.toISOString();
    };

    const macro = State.get('macro') || {};

    // CPI — releases around 8:30am ET on the second/third Tuesday of month
    const cpiObs = macro.CPIAUCSL;
    if (cpiObs?.length) {
      const last = cpiObs[cpiObs.length-1];
      const nextRelease = new Date(last.date);
      nextRelease.setMonth(nextRelease.getMonth() + 1);
      nextRelease.setDate(12); // approximate
      nextRelease.setHours(8,30,0,0);
      events.push({
        date: nextRelease.toISOString(),
        title: 'US CPI (Consumer Price Index)',
        country: 'USD',
        impact: 'high',
        forecast: '—',
        previous: last.yoyPct != null ? last.yoyPct.toFixed(1)+'%' : '—',
        actual: '',
        category: 'inflation',
      });
    }

    // NFP — first Friday of month
    const nfpObs = macro.PAYEMS;
    if (nfpObs?.length) {
      const last = nfpObs[nfpObs.length-1];
      // Find first Friday of next month
      const nextMonth = new Date(now.getFullYear(), now.getMonth()+1, 1);
      while (nextMonth.getDay() !== 5) nextMonth.setDate(nextMonth.getDate()+1);
      nextMonth.setHours(8,30,0,0);
      events.push({
        date: nextMonth.toISOString(),
        title: 'US Non-Farm Payrolls (NFP)',
        country: 'USD',
        impact: 'high',
        forecast: '—',
        previous: last.mom != null ? (last.mom>=0?'+':'')+Math.round(last.mom)+'K' : '—',
        actual: '',
        category: 'employment',
      });
    }

    // FOMC — approximately every 6-7 weeks
    const fedObs = macro.FEDFUNDS;
    if (fedObs?.length) {
      const last = fedObs[fedObs.length-1];
      // Rough FOMC schedule — next meeting
      const fomcDates2025 = [
        '2026-03-18T18:00:00',
        '2026-05-06T18:00:00',
        '2026-06-17T18:00:00',
        '2026-07-29T18:00:00',
        '2026-09-16T18:00:00',
        '2026-11-04T18:00:00',
        '2026-12-16T18:00:00',
      ];
      const nextFomc = fomcDates2025.find(d => new Date(d) > now);
      if (nextFomc) {
        events.push({
          date: nextFomc,
          title: 'FOMC Rate Decision',
          country: 'USD',
          impact: 'high',
          forecast: 'Hold',
          previous: last.value.toFixed(2)+'%',
          actual: '',
          category: 'central_bank',
        });
      }
    }

    // Unemployment Rate — same day as NFP usually
    const unObs = macro.UNRATE;
    if (unObs?.length) {
      const last = unObs[unObs.length-1];
      const nextMonth = new Date(now.getFullYear(), now.getMonth()+1, 1);
      while (nextMonth.getDay() !== 5) nextMonth.setDate(nextMonth.getDate()+1);
      nextMonth.setHours(8,30,0,0);
      events.push({
        date: nextMonth.toISOString(),
        title: 'US Unemployment Rate',
        country: 'USD',
        impact: 'high',
        forecast: '—',
        previous: last.value.toFixed(1)+'%',
        actual: '',
        category: 'employment',
      });
    }

    // GDP — quarterly, roughly end of month
    const gdpObs = macro.A191RL1Q225SBEA;
    if (gdpObs?.length) {
      const last = gdpObs[gdpObs.length-1];
      events.push({
        date: new Date(now.getFullYear(), now.getMonth()+1, 28, 8, 30).toISOString(),
        title: 'US GDP (Advance Estimate)',
        country: 'USD',
        impact: 'high',
        forecast: '—',
        previous: (last.value>=0?'+':'')+last.value.toFixed(1)+'%',
        actual: '',
        category: 'growth',
      });
    }

    // Add some medium-impact recurring events
    const mediumEvents = [
      { dow: 3, title: 'US ISM Manufacturing PMI',   country: 'USD', impact: 'medium', hour: 10 },
      { dow: 4, title: 'US Initial Jobless Claims',   country: 'USD', impact: 'medium', hour: 8, min: 30 },
      { dow: 3, title: 'US JOLTS Job Openings',       country: 'USD', impact: 'medium', hour: 10 },
      { dow: 2, title: 'ECB Economic Bulletin',       country: 'EUR', impact: 'medium', hour: 9 },
    ];

    mediumEvents.forEach(ev => {
      const d = new Date();
      let daysAhead = ev.dow - d.getDay();
      if (daysAhead <= 0) daysAhead += 7;
      d.setDate(d.getDate() + daysAhead);
      d.setHours(ev.hour || 8, ev.min || 0, 0, 0);
      events.push({
        date: d.toISOString(),
        title: ev.title,
        country: ev.country,
        impact: ev.impact,
        forecast: '—', previous: '—', actual: '',
      });
    });

    return events.sort((a,b) => new Date(a.date) - new Date(b.date));
  }
};


/* ═══════════════════════════════════════
   TRADE ENGINE
═══════════════════════════════════════ */
const TradeEngine = {
  async load(progressCb) {
    if (!State.isStale('trades', Config.CACHE.TRADES)) return;
    const token = TokenStore.get();
    if (!token) throw new Error('NO_TOKEN');

    let allResults = [], cursor;
    do {
      const body = cursor ? { start_cursor: cursor } : {};
      const data = await API.query(Config.DB.TRADES, token, body);
      allResults = allResults.concat(data.results || []);
      cursor = data.has_more ? data.next_cursor : undefined;
      if (progressCb) progressCb(allResults.length);
    } while (cursor);

    // Sort newest first
    allResults.sort((a,b) => {
      const da = a.properties?.Date?.date?.start || a.created_time || '';
      const db_ = b.properties?.Date?.date?.start || b.created_time || '';
      return db_.localeCompare(da);
    });

    const trades = allResults.map(this._parse).filter(t => t.date);
    const stats  = this._analyze(trades);
    State.set('trades', trades);
    State.set('journalStats', stats);
    console.log(`[TradeEngine] ${trades.length} trades · WR ${stats.winRate}%`);
  },

  _parse(page) {
    const p = page.properties || {};
    const find = (keys, type) => {
      for (const k of keys) {
        const match = Object.entries(p).find(([n,prop]) => prop.type===type && n.toLowerCase().includes(k.toLowerCase()));
        if (match) return match[1];
      }
      return null;
    };
    const getText  = ks => find(ks,'rich_text')?.rich_text?.map(r=>r.plain_text).join('')||null;
    const getSel   = ks => find(ks,'select')?.select?.name||null;
    const getNum   = ks => find(ks,'number')?.number??null;
    const getDate  = ks => find(ks,'date')?.date?.start||null;
    const getTitle = () => Object.values(p).find(x=>x.type==='title')?.title?.[0]?.plain_text||null;
    const getFiles = ks => { const prop=find(ks,'files'); return prop?(prop.files||[]).map(f=>f.file?.url||f.external?.url||'').filter(Boolean):[]; };
    const getMulti = ks => { const prop=find(ks,'multi_select'); return prop?(prop.multi_select||[]).map(x=>x.name):[]; };
    return {
      id:          page.id,
      date:        getDate(['date','traded','entry']),
      pair:        getSel(['pair','symbol','instrument'])||getTitle(),
      direction:   getSel(['direction','side','type','long','short']),
      outcome:     getSel(['outcome','result','win','loss']),
      rMultiple:   getNum(['r multiple','r-multiple','rmultiple','r multi','^r$']),
      grade:       getSel(['grade','setup','quality']),
      session:     getSel(['session','time','market']),
      timeframe:   getSel(['timeframe','tf','time frame']),
      comment:     getText(['comment','notes','note','journal','thought']),
      confluences: getMulti(['confluence','setup','reason','criteria']),
      images:      getFiles(['chart','image','screenshot','file']),
    };
  },

  _analyze(trades) {
    const valid   = trades;
    const wins    = trades.filter(t=>/win/i.test(t.outcome));
    const losses  = trades.filter(t=>/los/i.test(t.outcome));
    const bes     = trades.filter(t=>/break|be/i.test(t.outcome));
    const winRate = trades.length ? Math.round(wins.length/trades.length*100) : 0;
    const avgWin  = wins.length ? +(wins.reduce((s,t)=>s+(t.rMultiple||0),0)/wins.length).toFixed(2) : 0;
    const avgLoss = losses.length ? +Math.abs(losses.reduce((s,t)=>s+(t.rMultiple||0),0)/losses.length).toFixed(2) : 0;
    const ev = +((winRate/100*avgWin)-((1-winRate/100)*avgLoss)).toFixed(3);

    const sorted = [...trades].sort((a,b)=>(a.date||'').localeCompare(b.date||''));
    let running = 0;
    const equity = sorted.map(t => { running+=(t.rMultiple||0); return {date:t.date,r:+running.toFixed(2),trade:t}; });
    const curR   = equity.length ? equity[equity.length-1].r : 0;
    const peakR  = equity.length ? Math.max(...equity.map(e=>e.r)) : 0;
    const drawdown = peakR>0 ? Math.round((peakR-curR)/peakR*100) : 0;

    const monthly = {};
    sorted.forEach(t => {
      if (!t.date) return;
      const mk = t.date.slice(0,7);
      if (!monthly[mk]) monthly[mk]={r:0,wins:0,total:0,label:mk};
      monthly[mk].r    += (t.rMultiple||0);
      monthly[mk].wins += /win/i.test(t.outcome)?1:0;
      monthly[mk].total++;
    });
    const sortedMonths = Object.values(monthly).sort((a,b)=>a.label.localeCompare(b.label));
    sortedMonths.forEach(m=>{m.r=+m.r.toFixed(2);m.winRate=m.total?Math.round(m.wins/m.total*100):0;});

    const byDay={}, sessions={}, grades={}, tfs={};
    sorted.forEach(t => {
      if (t.date) { const dk=t.date.slice(0,10); if(!byDay[dk])byDay[dk]=[]; byDay[dk].push(t); }
      const s=t.session||'Unknown'; if(!sessions[s])sessions[s]={wins:0,total:0}; sessions[s].total++; if(/win/i.test(t.outcome))sessions[s].wins++;
      const g=t.grade||'Unknown';   if(!grades[g])grades[g]={wins:0,total:0};   grades[g].total++;   if(/win/i.test(t.outcome))grades[g].wins++;
      const tf=t.timeframe||'—';    if(!tfs[tf])tfs[tf]={wins:0,total:0};       tfs[tf].total++;     if(/win/i.test(t.outcome))tfs[tf].wins++;
    });

    return { valid, wins, losses, bes, winRate, avgWin, avgLoss, ev, equity, curR:+curR.toFixed(2), peakR:+peakR.toFixed(2), drawdown, sortedMonths, byDay, sessions, grades, tfs };
  }
};


/* ═══════════════════════════════════════
   MONTE CARLO ENGINE
═══════════════════════════════════════ */
const MonteCarloEngine = {
  run({ winRate, avgWin, avgLoss, trades, runs=500 }) {
    const wr = winRate/100;
    const allFinals=[], allPaths=[]; let ruinCount=0;
    for (let i=0; i<runs; i++) {
      let eq=0; const path=[0];
      for (let t=0; t<trades; t++) { eq+=Math.random()<wr?avgWin:-avgLoss; path.push(+eq.toFixed(2)); }
      allFinals.push(eq); allPaths.push(path);
      if (eq < -20) ruinCount++;
    }
    allFinals.sort((a,b)=>a-b);
    const p10=allFinals[Math.floor(runs*0.10)];
    const p50=allFinals[Math.floor(runs*0.50)];
    const p90=allFinals[Math.floor(runs*0.90)];
    const ev=+((wr*avgWin)-((1-wr)*avgLoss)).toFixed(3);
    const closest=(target)=>allPaths.reduce((best,p)=>Math.abs(p[p.length-1]-target)<Math.abs(best[best.length-1]-target)?p:best);
    const result={ p10:+p10.toFixed(2), p50:+p50.toFixed(2), p90:+p90.toFixed(2), ev, ruinPct:Math.round(ruinCount/runs*100), paths:{p10:closest(p10),p50:closest(p50),p90:closest(p90)}, trades, runs };
    State.set('monteCarlo', result);
    return result;
  }
};


/* ═══════════════════════════════════════
   AI ENGINE — Mistral via Worker
═══════════════════════════════════════ */
const AIEngine = {
  async ask(question, role='analyst') {
    const macro  = State.get('macro')        || {};
    const stats  = State.get('journalStats') || {};
    const prices = State.get('prices')       || {};

    const ms={};
    if(macro.CPIAUCSL?.length){const l=macro.CPIAUCSL[macro.CPIAUCSL.length-1];ms.cpi_yoy=l.yoyPct!=null?l.yoyPct.toFixed(2)+'%':'N/A';}
    if(macro.CPILFESL?.length){const l=macro.CPILFESL[macro.CPILFESL.length-1];ms.core_cpi=l.yoyPct!=null?l.yoyPct.toFixed(2)+'%':'N/A';}
    if(macro.UNRATE?.length)  {ms.unemployment=macro.UNRATE[macro.UNRATE.length-1].value.toFixed(1)+'%';}
    if(macro.FEDFUNDS?.length){ms.fed_funds=macro.FEDFUNDS[macro.FEDFUNDS.length-1].value.toFixed(2)+'%';}
    if(macro.PAYEMS?.length)  {const l=macro.PAYEMS[macro.PAYEMS.length-1];ms.nfp=l.mom!=null?(l.mom>=0?'+':'')+Math.round(l.mom)+'K':'N/A';}
    if(macro.A191RL1Q225SBEA?.length){const l=macro.A191RL1Q225SBEA[macro.A191RL1Q225SBEA.length-1];ms.gdp_qoq=(l.value>=0?'+':'')+l.value.toFixed(1)+'%';}

    const ps={};
    ['EURUSD','GBPUSD','XAUUSD','DXY'].forEach(sym=>{if(prices[sym])ps[sym]=prices[sym].price;});

    const js = stats.winRate!=null ? { win_rate:stats.winRate+'%', avg_win:stats.avgWin+'R', avg_loss:stats.avgLoss+'R', ev:stats.ev+'R', total_r:stats.curR } : {};

    const prompt =
      `Role: ${role==='reviewer'?'Weekly performance reviewer for a FX trader':'Institutional FX macro analyst'}\n\n`+
      `Macro Data: ${JSON.stringify(ms)}\n`+
      `Live Prices: ${JSON.stringify(ps)}\n`+
      (Object.keys(js).length?`Journal: ${JSON.stringify(js)}\n`:'')+
      `\nQuestion: ${question}`;

    const res = await API.ai(prompt);
    if (res.error) throw new Error(res.error);
    return res.reply || 'No response';
  }
};


/* ═══════════════════════════════════════
   CHARTS — Chart.js interactive charts
   Falls back to SVG sparklines if Chart.js unavailable
═══════════════════════════════════════ */
const Charts = {
  _instances: {},

  _destroy(id) {
    if (this._instances[id]) {
      try { this._instances[id].destroy(); } catch(e) {}
      delete this._instances[id];
    }
  },

  // ── Equity curve (interactive Chart.js line) ──────────────
  equity(svgId, stats, range='all') {
    const canvas = document.getElementById(svgId);
    if (!canvas || !stats?.equity?.length) return;

    let data = stats.equity;
    if (range==='3m') data=data.slice(-66);
    if (range==='1m') data=data.slice(-22);

    const labels = data.map(d => d.date?.slice(0,10)||'');
    const vals   = data.map(d => d.r);
    const lastVal= vals[vals.length-1]||0;
    const color  = lastVal>=0 ? '#00d47a' : '#ff2d55';

    // If element is SVG, replace with canvas for Chart.js
    if (canvas.tagName === 'svg' || canvas.tagName === 'SVG') {
      const cnv = document.createElement('canvas');
      cnv.id = svgId; cnv.style.width='100%'; cnv.style.height='160px';
      canvas.parentNode.replaceChild(cnv, canvas);
      return this.equity(svgId, stats, range);
    }

    this._destroy(svgId);

    if (typeof Chart === 'undefined') {
      // SVG fallback
      this._svgLine(svgId, vals, color, 800, 200);
      return;
    }

    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0,0,0,160);
    grad.addColorStop(0, color+'55'); grad.addColorStop(1, color+'00');

    this._instances[svgId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: vals, borderColor: color, backgroundColor: grad,
          borderWidth: 2, fill: true, tension: 0.3,
          pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: color,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1a2535', borderColor: '#2a3a50', borderWidth: 1,
            titleColor: '#9aaabb', bodyColor: '#e2ecf5',
            callbacks: {
              label: ctx => `${ctx.parsed.y>=0?'+':''}${ctx.parsed.y.toFixed(2)}R`,
              title: ctx => ctx[0].label,
            }
          }
        },
        scales: {
          x: { display: false },
          y: {
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: '#374a60', font: { size: 10 }, callback: v=>(v>=0?'+':'')+v.toFixed(1)+'R' },
          }
        }
      }
    });
  },

  // ── Sparkline (Chart.js mini line) ────────────────────────
  sparkline(svgId, data, color, valueKey='value') {
    const canvas = document.getElementById(svgId);
    if (!canvas || !data?.length) return;

    const vals = data.map(d=>d[valueKey]??d.value??0).filter(v=>v!=null&&!isNaN(v));
    if (!vals.length) return;

    if (canvas.tagName === 'svg' || canvas.tagName === 'SVG') {
      const cnv = document.createElement('canvas');
      cnv.id=svgId; cnv.style.width='100%'; cnv.style.height='60px';
      canvas.parentNode.replaceChild(cnv, canvas);
      return this.sparkline(svgId, data, color, valueKey);
    }

    this._destroy(svgId);
    if (typeof Chart === 'undefined') { this._svgLine(svgId, vals, color, 300, 60); return; }

    const ctx = canvas.getContext('2d');
    this._instances[svgId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.map(d=>d.date?.slice(0,7)||''),
        datasets: [{ data: vals, borderColor: color, borderWidth: 1.5, fill: false, tension: 0.4, pointRadius: 0, pointHoverRadius: 3 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1a2535', titleColor: '#9aaabb', bodyColor: color,
            callbacks: { label: c=>`${c.parsed.y.toFixed(2)}` }
          }
        },
        scales: { x:{ display:false }, y:{ display:false } }
      }
    });
  },

  // ── Bar chart (monthly R) ──────────────────────────────────
  barChart(svgId, data, colorFn) {
    const canvas = document.getElementById(svgId);
    if (!canvas || !data?.length) return;

    if (canvas.tagName === 'svg' || canvas.tagName === 'SVG') {
      const cnv = document.createElement('canvas');
      cnv.id=svgId; cnv.style.width='100%'; cnv.style.height='96px';
      canvas.parentNode.replaceChild(cnv, canvas);
      return this.barChart(svgId, data, colorFn);
    }

    this._destroy(svgId);
    if (typeof Chart === 'undefined') { this._svgBars(svgId, data); return; }

    const colors = data.map(d => (d.value||0)>=0 ? '#00d47a' : '#ff2d55');
    const ctx = canvas.getContext('2d');
    this._instances[svgId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map(d=>d.label||''),
        datasets: [{ data: data.map(d=>d.value), backgroundColor: colors, borderRadius: 2, borderSkipped: false }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1a2535', titleColor: '#9aaabb', bodyColor: '#e2ecf5',
            callbacks: { label: c=>(c.parsed.y>=0?'+':'')+c.parsed.y.toFixed(2)+'R' }
          }
        },
        scales: {
          x: { ticks: { color:'#374a60', font:{size:9} }, grid:{ display:false } },
          y: { ticks: { color:'#374a60', font:{size:9}, callback: v=>(v>=0?'+':'')+v.toFixed(1) }, grid:{ color:'rgba(255,255,255,0.04)' } }
        }
      }
    });
  },

  // ── Donut chart (Win/Loss/BE) ──────────────────────────────
  donut(svgId, segments) {
    const canvas = document.getElementById(svgId);
    if (!canvas) return;
    const total = segments.reduce((s,x)=>s+x.value,0);
    if (!total) return;

    if (canvas.tagName === 'svg' || canvas.tagName === 'SVG') {
      const cnv = document.createElement('canvas');
      cnv.id=svgId; cnv.style.width='100%'; cnv.style.height='90px';
      canvas.parentNode.replaceChild(cnv, canvas);
      return this.donut(svgId, segments);
    }

    this._destroy(svgId);
    if (typeof Chart === 'undefined') return;

    const ctx = canvas.getContext('2d');
    this._instances[svgId] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: segments.map(s=>s.label),
        datasets: [{ data: segments.map(s=>s.value), backgroundColor: segments.map(s=>s.color), borderWidth: 0, hoverOffset: 4 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '65%',
        plugins: {
          legend: { position:'right', labels:{ color:'#9aaabb', font:{size:10}, boxWidth:10, padding:8 } },
          tooltip: {
            backgroundColor: '#1a2535',
            callbacks: { label: c=>`${c.label}: ${c.raw} (${Math.round(c.raw/total*100)}%)` }
          }
        }
      }
    });
  },

  // ── Monte Carlo chart ──────────────────────────────────────
  monteCarlo(svgId, mc) {
    const canvas = document.getElementById(svgId);
    if (!canvas || !mc?.paths) return;

    if (canvas.tagName === 'svg' || canvas.tagName === 'SVG') {
      const cnv = document.createElement('canvas');
      cnv.id=svgId; cnv.style.width='100%'; cnv.style.height='180px';
      canvas.parentNode.replaceChild(cnv, canvas);
      return this.monteCarlo(svgId, mc);
    }

    this._destroy(svgId);
    if (typeof Chart === 'undefined') return;

    const {p10,p50,p90} = mc.paths;
    const n = p50.length;
    const labels = Array.from({length:n},(_,i)=>i===0?'Start':'T'+i);

    const ctx = canvas.getContext('2d');
    this._instances[svgId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label:'P90 (Best 10%)',  data:p90, borderColor:'#3d8eff', borderWidth:1.5, borderDash:[4,3], fill:false, tension:0.3, pointRadius:0 },
          { label:'P50 (Median)',    data:p50, borderColor:'#00d47a', borderWidth:2,   fill:false,        tension:0.3, pointRadius:0, pointHoverRadius:3 },
          { label:'P10 (Worst 10%)', data:p10, borderColor:'#ff2d55', borderWidth:1.5, borderDash:[4,3], fill:false, tension:0.3, pointRadius:0 },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode:'index', intersect:false },
        plugins: {
          legend: { position:'top', labels:{ color:'#9aaabb', font:{size:10}, boxWidth:12 } },
          tooltip: {
            backgroundColor:'#1a2535',
            callbacks: { label: c=>`${c.dataset.label}: ${c.parsed.y>=0?'+':''}${c.parsed.y.toFixed(2)}R` }
          }
        },
        scales: {
          x: { display:false },
          y: { ticks:{color:'#374a60',font:{size:10},callback:v=>(v>=0?'+':'')+v.toFixed(1)+'R'}, grid:{color:'rgba(255,255,255,0.04)'} }
        }
      }
    });
  },

  // ── SVG fallbacks (if Chart.js fails to load) ─────────────
  _svgLine(id, vals, color, W=800, H=200) {
    const el=document.getElementById(id); if(!el||el.tagName!=='svg') return;
    const min=Math.min(...vals,0), max=Math.max(...vals,0.1), range=max-min||1;
    const px=i=>10+(i/(vals.length-1))*(W-20), py=v=>H-10-((v-min)/range)*(H-20);
    const pts=vals.map((v,i)=>`${px(i)},${py(v)}`).join(' ');
    el.innerHTML=`<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
  },

  _svgBars(id, data) {
    const el=document.getElementById(id); if(!el||el.tagName!=='svg') return;
    const W=380,H=120,PAD=8,bw=Math.max(1,(W-PAD*2)/data.length-2);
    const vals=data.map(d=>d.value),maxAbs=Math.max(...vals.map(Math.abs),0.1),zero=H/2;
    let out='';
    data.forEach((d,i)=>{
      const x=PAD+i*((W-PAD*2)/data.length),h=Math.abs(d.value)/maxAbs*(H/2-10),y=d.value>=0?zero-h:zero;
      out+=`<rect x="${x}" y="${y}" width="${bw}" height="${Math.max(h,1)}" fill="${d.value>=0?'#00d47a':'#ff2d55'}" opacity=".85"/>`;
    });
    el.innerHTML=out+`<line x1="${PAD}" y1="${zero}" x2="${W-PAD}" y2="${zero}" stroke="rgba(255,255,255,.06)" stroke-width="1"/>`;
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
        const active = p.id===pageId?' active':'';
        const click  = p.id!==pageId?`onclick="window._navGo('${p.file}')"`:'' ;
        return `<div class="nav-link${active}" ${click}>${p.label}</div>`;
      }).join('');
    }
    document.body.style.opacity = '1';
    window._navGo = (file) => {
      document.body.style.transition='opacity 130ms ease';
      document.body.style.opacity='0';
      setTimeout(()=>{ window.location.href=file; },140);
    };
  }
};


/* ═══════════════════════════════════════
   GLOBAL EXPORTS
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
