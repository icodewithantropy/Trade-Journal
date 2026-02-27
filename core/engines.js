/**
 * TradeOS · core/engines.js — v3
 * Fixes: chart expansion, trades order, timeframes, grading, news from FRED
 */

/* ═══════════════════════════════════════
   PRICE ENGINE — EUR/GBP + NAS100/SPX500
═══════════════════════════════════════ */
const PriceEngine = {
  _timer: null,
  start() {
    if (this._timer) return;
    this.fetch();
    this._timer = setInterval(() => this.fetch(), Config.INTERVALS.PRICES_FREE);
    console.log('[PriceEngine] Started');
  },
  stop() { clearInterval(this._timer); this._timer = null; },
  async fetch() {
    try {
      const raw = await API.prices();
      const prev = State.get('prices') || {};
      const prices = {};
      ['EURUSD','GBPUSD','NAS100','SPX500'].forEach(sym => {
        // Worker may return old key names — map them
        const rawKey = sym === 'NAS100' ? (raw.NAS100 || raw.NDX || raw.DXY) :
                       sym === 'SPX500' ? (raw.SPX500 || raw.SPX || raw.XAUUSD) :
                       raw[sym];
        if (!rawKey) return;
        const price = typeof rawKey === 'object' ? parseFloat(rawKey.price) : parseFloat(rawKey);
        const changePct = typeof rawKey === 'object' ? parseFloat(rawKey.change || 0) : 0;
        if (isNaN(price)) return;
        const prevPrice = prev[sym]?.price ?? null;
        prices[sym] = {
          price, prev: prevPrice,
          change: prevPrice !== null ? +(price - prevPrice).toFixed(6) : 0,
          changePct: changePct || (prevPrice !== null ? +((price-prevPrice)/prevPrice*100).toFixed(4) : 0),
          source: raw.source, ts: Date.now(),
        };
      });
      State.set('prices', prices);
      updatePriceUI(prices, raw.source);
    } catch(e) { console.warn('[PriceEngine]', e.message); }
  }
};

function updatePriceUI(prices, source) {
  const map = [
    { elId:'ps-eur', sym:'EURUSD', dec:5 },
    { elId:'ps-gbp', sym:'GBPUSD', dec:5 },
    { elId:'ps-nas', sym:'NAS100', dec:0 },
    { elId:'ps-spx', sym:'SPX500', dec:0 },
  ];
  map.forEach(({elId, sym, dec}) => {
    const d = prices[sym]; if (!d) return;
    const el = document.getElementById(elId); if (!el) return;
    const up = d.change >= 0;
    el.querySelector('.ps-price').textContent = d.price.toFixed(dec);
    const chg = el.querySelector('.ps-chg');
    chg.textContent = (up ? '▲' : '▼') + ' ' + Math.abs(d.changePct || 0).toFixed(2) + '%';
    chg.style.color = up ? 'var(--green)' : 'var(--red)';
  });
  // Nav pills
  if (prices.EURUSD) { const e=document.getElementById('np-eur'); if(e){e.textContent=`EUR ${prices.EURUSD.price.toFixed(5)}`;e.style.color=prices.EURUSD.change>=0?'var(--green)':'var(--red)';}}
  if (prices.NAS100) { const e=document.getElementById('np-nas'); if(e){e.textContent=`NAS ${Math.round(prices.NAS100.price)}`;e.style.color=prices.NAS100.change>=0?'var(--green)':'var(--red)';}}
  if (prices.SPX500) { const e=document.getElementById('np-spx'); if(e){e.textContent=`SPX ${Math.round(prices.SPX500.price)}`;}}
  const ts = document.getElementById('strip-ts'); if(ts) ts.textContent = new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const src = document.getElementById('strip-src'); if(src){src.textContent=source==='twelvedata'?'● Live':'● Hourly';src.style.color='var(--green)';}
  const dot = document.getElementById('nav-dot'); if(dot) dot.className='nav-dot on';
}


/* ═══════════════════════════════════════
   MACRO ENGINE
═══════════════════════════════════════ */
const MacroEngine = {
  _timer: null,
  async start() { await this.fetch(); this._timer=setInterval(()=>this.fetch(),Config.INTERVALS.MACRO); },
  stop() { clearInterval(this._timer); this._timer=null; },

  async fetch() {
    if (!State.isStale('macro', Config.CACHE.MACRO)) return;
    try {
      const macro = {};
      // Load sequentially with retry — prevents race conditions & rate limits
      for (const series of Config.FRED_SERIES) {
        try {
          const data = await this._fetchWithRetry(series);
          macro[series] = MacroEngine._process(series, data.observations||[]);
        } catch(e) {
          console.warn(`[MacroEngine] ${series} failed:`, e.message);
          macro[series] = []; // empty array — page shows — instead of crashing
        }
      }
      State.set('macro', macro);
      // Update news calendar with fresh data
      const events = NewsEngine._buildCalendar(macro);
      State.set('news', events);
      console.log('[MacroEngine] Loaded');
    } catch(e) {
      console.warn('[MacroEngine]', e.message);
      State.set('macro', {_error: e.message});
    }
  },

  // Retry up to 3 times with exponential backoff
  async _fetchWithRetry(series, attempts=3) {
    for (let i=0; i<attempts; i++) {
      try {
        const data = await API.fred(series);
        if (data.error) throw new Error(data.error);
        return data;
      } catch(e) {
        if (i === attempts-1) throw e;
        await new Promise(r => setTimeout(r, 800 * (i+1))); // 800ms, 1600ms backoff
      }
    }
  },

  _process(series, obs) {
    const sorted = [...obs].reverse();
    if (series==='CPIAUCSL'||series==='CPILFESL') {
      return sorted.map((o,i)=>{const prev12=sorted[i-12];const val=parseFloat(o.value);const yoyPct=prev12?+((val-parseFloat(prev12.value))/parseFloat(prev12.value)*100).toFixed(2):null;return{date:o.date,value:val,yoyPct};});
    }
    if (series==='PAYEMS') {
      return sorted.map((o,i)=>{const prev=sorted[i-1];const val=parseFloat(o.value);const mom=prev?+(val-parseFloat(prev.value)).toFixed(1):null;return{date:o.date,value:val,mom};});
    }
    return sorted.map(o=>({date:o.date,value:parseFloat(o.value)}));
  }
};


/* ═══════════════════════════════════════
   NEWS ENGINE — FRED-powered calendar
═══════════════════════════════════════ */
const NewsEngine = {
  start() {
    const macro = State.get('macro') || {};
    const events = NewsEngine._buildCalendar(macro);
    State.set('news', events);
    console.log(`[NewsEngine] ${events.length} events from FRED`);
  },
  nextHighImpact() {
    const now = new Date();
    return (State.get('news')||[]).filter(ev=>ev.impact==='high'&&new Date(ev.date)>now).sort((a,b)=>new Date(a.date)-new Date(b.date))[0]||null;
  },
  _buildCalendar(macro) {
    macro = macro || State.get('macro') || {};
    const now = new Date();
    const events = [];

    // Helper: first Friday of given month
    const firstFriday = (y,m) => { const d=new Date(y,m,1); while(d.getDay()!==5) d.setDate(d.getDate()+1); return d; };
    // Helper: ~12th of month (typical CPI release)
    const cpiDay = (y,m) => new Date(y,m,12,8,30);

    // CPI — next release (monthly)
    const cpiObs = macro.CPIAUCSL;
    if (cpiObs?.length) {
      const last = cpiObs[cpiObs.length-1];
      const lastDate = new Date(last.date);
      let releaseDate = cpiDay(lastDate.getFullYear(), lastDate.getMonth()+1);
      if (releaseDate <= now) releaseDate = cpiDay(lastDate.getFullYear(), lastDate.getMonth()+2);
      events.push({
        date: releaseDate.toISOString(), title: 'US CPI (YoY)', country: 'USD', impact: 'high',
        forecast: '—', previous: last.yoyPct!=null ? last.yoyPct.toFixed(1)+'%' : '—', actual: '', category: 'inflation',
      });
    }

    // Core CPI
    const coreCpiObs = macro.CPILFESL;
    if (coreCpiObs?.length) {
      const last = coreCpiObs[coreCpiObs.length-1];
      const lastDate = new Date(last.date);
      let releaseDate = cpiDay(lastDate.getFullYear(), lastDate.getMonth()+1);
      if (releaseDate<=now) releaseDate = cpiDay(lastDate.getFullYear(), lastDate.getMonth()+2);
      events.push({
        date: new Date(releaseDate.getTime()+60000).toISOString(), title: 'US Core CPI (YoY)', country: 'USD', impact: 'high',
        forecast: '—', previous: last.yoyPct!=null ? last.yoyPct.toFixed(1)+'%' : '—', actual: '', category: 'inflation',
      });
    }

    // NFP + Unemployment — first Friday of next month
    const nfpObs = macro.PAYEMS;
    const unObs = macro.UNRATE;
    if (nfpObs?.length) {
      const last = nfpObs[nfpObs.length-1];
      let nfpDate = firstFriday(now.getFullYear(), now.getMonth()+1);
      nfpDate.setHours(8,30,0,0);
      if (nfpDate<=now) { nfpDate = firstFriday(now.getFullYear(), now.getMonth()+2); nfpDate.setHours(8,30,0,0); }
      events.push({
        date: nfpDate.toISOString(), title: 'US Non-Farm Payrolls', country: 'USD', impact: 'high',
        forecast: '—', previous: last.mom!=null?(last.mom>=0?'+':'')+Math.round(last.mom)+'K':'—', actual: '', category: 'employment',
      });
      if (unObs?.length) {
        const ul = unObs[unObs.length-1];
        events.push({
          date: new Date(nfpDate.getTime()+120000).toISOString(), title: 'US Unemployment Rate', country: 'USD', impact: 'high',
          forecast: '—', previous: ul.value.toFixed(1)+'%', actual: '', category: 'employment',
        });
      }
    }

    // Fed Funds / FOMC
    const fedObs = macro.FEDFUNDS;
    if (fedObs?.length) {
      const last = fedObs[fedObs.length-1];
      const fomcDates = ['2026-03-18T18:00:00Z','2026-05-06T18:00:00Z','2026-06-17T18:00:00Z','2026-07-29T18:00:00Z','2026-09-16T18:00:00Z','2026-11-04T18:00:00Z','2026-12-16T18:00:00Z'];
      const nextFomc = fomcDates.find(d=>new Date(d)>now);
      if (nextFomc) {
        events.push({
          date: nextFomc, title: 'FOMC Interest Rate Decision', country: 'USD', impact: 'high',
          forecast: 'Hold', previous: last.value.toFixed(2)+'%', actual: '', category: 'central_bank',
        });
      }
    }

    // GDP — quarterly
    const gdpObs = macro.A191RL1Q225SBEA;
    if (gdpObs?.length) {
      const last = gdpObs[gdpObs.length-1];
      const gdpDate = new Date(now.getFullYear(), now.getMonth()+1, 28, 8, 30);
      events.push({
        date: gdpDate.toISOString(), title: 'US GDP Growth (Advance)', country: 'USD', impact: 'high',
        forecast: '—', previous: (last.value>=0?'+':'')+last.value.toFixed(1)+'%', actual: '', category: 'growth',
      });
    }

    // Medium impact recurring events (next occurrence)
    const mediums = [
      {dow:4, title:'US Initial Jobless Claims',  country:'USD', impact:'medium', h:8,  m:30},
      {dow:3, title:'US ISM Manufacturing PMI',   country:'USD', impact:'medium', h:10, m:0},
      {dow:2, title:'US ISM Services PMI',        country:'USD', impact:'medium', h:10, m:0},
      {dow:3, title:'JOLTS Job Openings',         country:'USD', impact:'medium', h:10, m:0},
      {dow:2, title:'ECB Economic Bulletin',      country:'EUR', impact:'medium', h:9,  m:0},
      {dow:5, title:'BoE Monetary Policy Report', country:'GBP', impact:'medium', h:12, m:0},
    ];
    mediums.forEach(ev => {
      const d = new Date();
      let ahead = ev.dow - d.getDay();
      if (ahead <= 0) ahead += 7;
      d.setDate(d.getDate()+ahead);
      d.setHours(ev.h, ev.m, 0, 0);
      events.push({ date:d.toISOString(), title:ev.title, country:ev.country, impact:ev.impact, forecast:'—', previous:'—', actual:'', category:'recurring' });
    });

    return events.sort((a,b)=>new Date(a.date)-new Date(b.date));
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
    let allResults=[], cursor;
    do {
      const body = cursor ? {start_cursor:cursor} : {};
      const data = await API.query(Config.DB.TRADES, token, body);
      allResults = allResults.concat(data.results||[]);
      cursor = data.has_more ? data.next_cursor : undefined;
      if (progressCb) progressCb(allResults.length);
    } while (cursor);

    const trades = allResults.map(this._parse).filter(t=>t.date);
    // Sort newest first
    trades.sort((a,b) => (b.date||'').localeCompare(a.date||''));
    // Auto-grade every trade based on confluences + comment
    GradingEngine.gradeAll(trades);
    const stats = this._analyze(trades);
    State.set('trades', trades);
    State.set('journalStats', stats);
    console.log(`[TradeEngine] ${trades.length} trades · WR ${stats.winRate}%`);
  },

  _parse(page) {
    const p = page.properties||{};
    // Flexible property finder - matches by type + partial name
    const find=(keys,type)=>{
      for(const k of keys){
        const match=Object.entries(p).find(([n,prop])=>prop.type===type&&n.toLowerCase().includes(k.toLowerCase()));
        if(match) return match[1];
      }
      return null;
    };
    const getText  = ks=>find(ks,'rich_text')?.rich_text?.map(r=>r.plain_text).join('')||null;
    const getSel   = ks=>find(ks,'select')?.select?.name||null;
    const getNum   = ks=>find(ks,'number')?.number??null;
    const getDate  = ks=>find(ks,'date')?.date?.start||null;
    const getTitle = ()=>Object.values(p).find(x=>x.type==='title')?.title?.[0]?.plain_text||null;
    const getFiles = ks=>{const prop=find(ks,'files');return prop?(prop.files||[]).map(f=>f.file?.url||f.external?.url||'').filter(Boolean):[];};
    const getMulti = ks=>{const prop=find(ks,'multi_select');return prop?(prop.multi_select||[]).map(x=>x.name):[];};
    return {
      id:          page.id,
      date:        getDate(['date','traded','entry','opened']),
      pair:        getSel(['pair','symbol','instrument','currency'])||getTitle(),
      direction:   getSel(['direction','side','bias','long','short']),
      outcome:     getSel(['outcome','result','status']),
      rMultiple:   getNum(['r multiple','r-multiple','rmultiple','r multi','r value','pnl r']),
      grade:       getSel(['grade','setup quality','quality','rating']),
      session:     getSel(['session','market session','time']),
      timeframe:   getSel(['timeframe','time frame','tf','entry tf']),
      comment:     getText(['comment','notes','note','journal','review','thoughts']),
      confluences: getMulti(['confluence','confluences','setup','reason','criteria','tags']),
      images:      getFiles(['chart','image','screenshot','attachment','file']),
    };
  },

  _analyze(trades) {
    const valid=trades;
    const wins=trades.filter(t=>/win/i.test(t.outcome));
    const losses=trades.filter(t=>/los/i.test(t.outcome));
    const bes=trades.filter(t=>/break|^be$/i.test(t.outcome));
    const winRate=trades.length?Math.round(wins.length/trades.length*100):0;
    const avgWin=wins.length?+(wins.reduce((s,t)=>s+(t.rMultiple||0),0)/wins.length).toFixed(2):0;
    const avgLoss=losses.length?+Math.abs(losses.reduce((s,t)=>s+(t.rMultiple||0),0)/losses.length).toFixed(2):0;
    const ev=+((winRate/100*avgWin)-((1-winRate/100)*avgLoss)).toFixed(3);

    // Equity — sorted oldest first for curve
    const sorted=[...trades].sort((a,b)=>(a.date||'').localeCompare(b.date||''));
    let running=0;
    const equity=sorted.map(t=>{running+=(t.rMultiple||0);return{date:t.date,r:+running.toFixed(2),trade:t};});
    const curR=equity.length?equity[equity.length-1].r:0;
    const peakR=equity.length?Math.max(...equity.map(e=>e.r)):0;
    const drawdown=peakR>0?Math.round((peakR-curR)/peakR*100):0;

    const monthly={};
    sorted.forEach(t=>{
      if(!t.date)return;
      const mk=t.date.slice(0,7);
      if(!monthly[mk])monthly[mk]={r:0,wins:0,total:0,label:mk};
      monthly[mk].r+=(t.rMultiple||0);
      monthly[mk].wins+=/win/i.test(t.outcome)?1:0;
      monthly[mk].total++;
    });
    const sortedMonths=Object.values(monthly).sort((a,b)=>a.label.localeCompare(b.label));
    sortedMonths.forEach(m=>{m.r=+m.r.toFixed(2);m.winRate=m.total?Math.round(m.wins/m.total*100):0;});

    const byDay={},sessions={},grades={},tfs={};
    sorted.forEach(t=>{
      if(t.date){const dk=t.date.slice(0,10);if(!byDay[dk])byDay[dk]=[];byDay[dk].push(t);}
      const s=t.session||'Unknown';if(!sessions[s])sessions[s]={wins:0,total:0};sessions[s].total++;if(/win/i.test(t.outcome))sessions[s].wins++;
      const g=t.grade||'Unknown';if(!grades[g])grades[g]={wins:0,total:0};grades[g].total++;if(/win/i.test(t.outcome))grades[g].wins++;
      const tf=t.timeframe||'—';if(!tfs[tf])tfs[tf]={wins:0,total:0};tfs[tf].total++;if(/win/i.test(t.outcome))tfs[tf].wins++;
    });

    return {valid,wins,losses,bes,winRate,avgWin,avgLoss,ev,equity,curR:+curR.toFixed(2),peakR:+peakR.toFixed(2),drawdown,sortedMonths,byDay,sessions,grades,tfs};
  }
};


/* ═══════════════════════════════════════
   MONTE CARLO ENGINE
═══════════════════════════════════════ */
const MonteCarloEngine = {
  run({winRate,avgWin,avgLoss,trades,runs=500}) {
    const wr=winRate/100;
    const allFinals=[],allPaths=[];let ruinCount=0;
    for(let i=0;i<runs;i++){
      let eq=0;const path=[0];
      for(let t=0;t<trades;t++){eq+=Math.random()<wr?avgWin:-avgLoss;path.push(+eq.toFixed(2));}
      allFinals.push(eq);allPaths.push(path);
      if(eq<-20)ruinCount++;
    }
    allFinals.sort((a,b)=>a-b);
    const p10=allFinals[Math.floor(runs*0.10)];
    const p50=allFinals[Math.floor(runs*0.50)];
    const p90=allFinals[Math.floor(runs*0.90)];
    const ev=+((wr*avgWin)-((1-wr)*avgLoss)).toFixed(3);
    const closest=target=>allPaths.reduce((best,p)=>Math.abs(p[p.length-1]-target)<Math.abs(best[best.length-1]-target)?p:best);
    const result={p10:+p10.toFixed(2),p50:+p50.toFixed(2),p90:+p90.toFixed(2),ev,ruinPct:Math.round(ruinCount/runs*100),paths:{p10:closest(p10),p50:closest(p50),p90:closest(p90)},trades,runs};
    State.set('monteCarlo',result);
    return result;
  }
};


/* ═══════════════════════════════════════
   AI ENGINE
═══════════════════════════════════════ */
const AIEngine = {
  async ask(question, role='analyst') {
    const macro=State.get('macro')||{};
    const stats=State.get('journalStats')||{};
    const prices=State.get('prices')||{};
    const ms={};
    if(macro.CPIAUCSL?.length){const l=macro.CPIAUCSL[macro.CPIAUCSL.length-1];ms.cpi_yoy=l.yoyPct!=null?l.yoyPct.toFixed(2)+'%':'N/A';}
    if(macro.CPILFESL?.length){const l=macro.CPILFESL[macro.CPILFESL.length-1];ms.core_cpi=l.yoyPct!=null?l.yoyPct.toFixed(2)+'%':'N/A';}
    if(macro.UNRATE?.length){ms.unemployment=macro.UNRATE[macro.UNRATE.length-1].value.toFixed(1)+'%';}
    if(macro.FEDFUNDS?.length){ms.fed_funds=macro.FEDFUNDS[macro.FEDFUNDS.length-1].value.toFixed(2)+'%';}
    if(macro.PAYEMS?.length){const l=macro.PAYEMS[macro.PAYEMS.length-1];ms.nfp=l.mom!=null?(l.mom>=0?'+':'')+Math.round(l.mom)+'K':'N/A';}
    if(macro.A191RL1Q225SBEA?.length){const l=macro.A191RL1Q225SBEA[macro.A191RL1Q225SBEA.length-1];ms.gdp_qoq=(l.value>=0?'+':'')+l.value.toFixed(1)+'%';}
    const ps={};
    ['EURUSD','GBPUSD','XAUUSD','DXY'].forEach(sym=>{if(prices[sym])ps[sym]=prices[sym].price;});
    const js=stats.winRate!=null?{win_rate:stats.winRate+'%',avg_win:stats.avgWin+'R',avg_loss:stats.avgLoss+'R',ev:stats.ev+'R',total_r:stats.curR}:{};
    const prompt=`Role: ${role==='reviewer'?'Weekly performance reviewer for a FX trader':'Institutional FX macro analyst'}\nMacro: ${JSON.stringify(ms)}\nPrices: ${JSON.stringify(ps)}\n${Object.keys(js).length?'Journal: '+JSON.stringify(js)+'\n':''}\nQuestion: ${question}`;
    const res = await API.ai(prompt);
    if (res.error && !res.reply) throw new Error(res.error);
    return res.reply || 'No response received';
  }
};


/* ═══════════════════════════════════════
   CHARTS — Chart.js with FIXED sizing
   Key fix: wrap canvas in fixed-height div
═══════════════════════════════════════ */
const Charts = {
  _instances: {},

  _destroy(id) {
    if (this._instances[id]) { try{this._instances[id].destroy();}catch(e){} delete this._instances[id]; }
  },

  // Replace SVG with properly wrapped canvas — THIS fixes the expansion bug
  _getCanvas(svgId, height) {
    let el = document.getElementById(svgId);
    if (!el) return null;

    if (el.tagName === 'svg' || el.tagName === 'SVG' || el.tagName === 'CANVAS') {
      // Create wrapper div with FIXED height — critical to prevent expansion
      const wrapper = document.createElement('div');
      wrapper.style.cssText = `position:relative;width:100%;height:${height}px;min-height:${height}px;max-height:${height}px;overflow:hidden;`;
      const cnv = document.createElement('canvas');
      cnv.id = svgId;
      wrapper.appendChild(cnv);
      el.parentNode.replaceChild(wrapper, el);
      return cnv;
    }
    // Already a canvas inside wrapper
    return el.tagName === 'CANVAS' ? el : el.querySelector('canvas');
  },

  equity(svgId, stats, range='all') {
    if (!stats?.equity?.length) return;
    let data=stats.equity;
    if(range==='3m') data=data.slice(-66);
    if(range==='1m') data=data.slice(-22);
    const vals=data.map(d=>d.r);
    const lastVal=vals[vals.length-1]||0;
    const color=lastVal>=0?'#00d47a':'#ff2d55';

    const canvas = this._getCanvas(svgId, 160);
    if (!canvas) return;
    this._destroy(svgId);

    if (typeof Chart==='undefined') { this._svgFallback(canvas.parentNode||canvas, vals, color); return; }

    const ctx=canvas.getContext('2d');
    const grad=ctx.createLinearGradient(0,0,0,160);
    grad.addColorStop(0,color+'44'); grad.addColorStop(1,color+'00');

    this._instances[svgId]=new Chart(ctx,{
      type:'line',
      data:{labels:data.map(d=>d.date?.slice(0,10)||''),datasets:[{data:vals,borderColor:color,backgroundColor:grad,borderWidth:2,fill:true,tension:0.3,pointRadius:0,pointHoverRadius:5,pointHoverBackgroundColor:color}]},
      options:{
        responsive:true,maintainAspectRatio:false,
        interaction:{mode:'index',intersect:false},
        plugins:{
          legend:{display:false},
          tooltip:{backgroundColor:'#0f1923',borderColor:'#1e2d3d',borderWidth:1,titleColor:'#9aaabb',bodyColor:'#e2ecf5',padding:10,
            callbacks:{label:c=>`  ${c.parsed.y>=0?'+':''}${c.parsed.y.toFixed(2)}R`,title:c=>c[0].label}}
        },
        scales:{
          x:{display:false},
          y:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#374a60',font:{size:10},callback:v=>(v>=0?'+':'')+v.toFixed(1)+'R'}}
        }
      }
    });
  },

  sparkline(svgId, data, color, valueKey='value') {
    if (!data?.length) return;
    const vals=data.map(d=>d[valueKey]??d.value??0).filter(v=>v!=null&&!isNaN(v));
    if (!vals.length) return;

    const canvas=this._getCanvas(svgId,60);
    if (!canvas) return;
    this._destroy(svgId);
    if (typeof Chart==='undefined') return;

    const ctx=canvas.getContext('2d');
    this._instances[svgId]=new Chart(ctx,{
      type:'line',
      data:{labels:data.map(d=>d.date?.slice(0,7)||''),datasets:[{data:vals,borderColor:color,borderWidth:1.5,fill:false,tension:0.4,pointRadius:0,pointHoverRadius:3,pointHoverBackgroundColor:color}]},
      options:{
        responsive:true,maintainAspectRatio:false,
        interaction:{mode:'index',intersect:false},
        plugins:{legend:{display:false},tooltip:{backgroundColor:'#0f1923',titleColor:'#9aaabb',bodyColor:color,callbacks:{label:c=>`${c.parsed.y.toFixed(2)}`}}},
        scales:{x:{display:false},y:{display:false}}
      }
    });
  },

  barChart(svgId, data) {
    if (!data?.length) return;
    const canvas=this._getCanvas(svgId,96);
    if (!canvas) return;
    this._destroy(svgId);
    if (typeof Chart==='undefined') return;

    const colors=data.map(d=>(d.value||0)>=0?'#00d47a':'#ff2d55');
    const ctx=canvas.getContext('2d');
    this._instances[svgId]=new Chart(ctx,{
      type:'bar',
      data:{labels:data.map(d=>d.label?.slice(2)||''),datasets:[{data:data.map(d=>d.value),backgroundColor:colors,borderRadius:2,borderSkipped:false}]},
      options:{
        responsive:true,maintainAspectRatio:false,
        interaction:{mode:'index',intersect:false},
        plugins:{legend:{display:false},tooltip:{backgroundColor:'#0f1923',titleColor:'#9aaabb',bodyColor:'#e2ecf5',callbacks:{label:c=>(c.parsed.y>=0?'+':'')+c.parsed.y.toFixed(2)+'R'}}},
        scales:{x:{ticks:{color:'#374a60',font:{size:8},maxRotation:0},grid:{display:false}},y:{ticks:{color:'#374a60',font:{size:9},callback:v=>(v>=0?'+':'')+v.toFixed(1)},grid:{color:'rgba(255,255,255,0.04)'}}}
      }
    });
  },

  donut(svgId, segments) {
    const total=segments.reduce((s,x)=>s+x.value,0);
    if (!total) return;
    const canvas=this._getCanvas(svgId,90);
    if (!canvas) return;
    this._destroy(svgId);
    if (typeof Chart==='undefined') return;

    const ctx=canvas.getContext('2d');
    this._instances[svgId]=new Chart(ctx,{
      type:'doughnut',
      data:{labels:segments.map(s=>s.label),datasets:[{data:segments.map(s=>s.value),backgroundColor:segments.map(s=>s.color),borderWidth:0,hoverOffset:4}]},
      options:{
        responsive:true,maintainAspectRatio:false,cutout:'65%',
        plugins:{
          legend:{position:'right',labels:{color:'#9aaabb',font:{size:10},boxWidth:10,padding:8}},
          tooltip:{backgroundColor:'#0f1923',callbacks:{label:c=>`${c.label}: ${c.raw} (${Math.round(c.raw/total*100)}%)`}}
        }
      }
    });
  },

  monteCarlo(svgId, mc) {
    if (!mc?.paths) return;
    const {p10,p50,p90}=mc.paths;
    const n=p50.length;
    const canvas=this._getCanvas(svgId,180);
    if (!canvas) return;
    this._destroy(svgId);
    if (typeof Chart==='undefined') return;

    const labels=Array.from({length:n},(_,i)=>i===0?'0':''+i);
    const ctx=canvas.getContext('2d');
    this._instances[svgId]=new Chart(ctx,{
      type:'line',
      data:{labels,datasets:[
        {label:'P90',data:p90,borderColor:'#3d8eff',borderWidth:1.5,borderDash:[4,3],fill:false,tension:0.3,pointRadius:0},
        {label:'P50 Median',data:p50,borderColor:'#00d47a',borderWidth:2,fill:false,tension:0.3,pointRadius:0,pointHoverRadius:3},
        {label:'P10',data:p10,borderColor:'#ff2d55',borderWidth:1.5,borderDash:[4,3],fill:false,tension:0.3,pointRadius:0},
      ]},
      options:{
        responsive:true,maintainAspectRatio:false,
        interaction:{mode:'index',intersect:false},
        plugins:{legend:{position:'top',labels:{color:'#9aaabb',font:{size:10},boxWidth:12}},tooltip:{backgroundColor:'#0f1923',callbacks:{label:c=>`${c.dataset.label}: ${c.parsed.y>=0?'+':''}${c.parsed.y.toFixed(2)}R`}}},
        scales:{x:{display:false},y:{ticks:{color:'#374a60',font:{size:10},callback:v=>(v>=0?'+':'')+v.toFixed(1)+'R'},grid:{color:'rgba(255,255,255,0.04)'}}}
      }
    });
  },

  _svgFallback(container, vals, color) {
    const W=800,H=160,P=10;
    const min=Math.min(...vals,0),max=Math.max(...vals,0.1),range=max-min||1;
    const px=i=>P+(i/(vals.length-1))*(W-P*2);
    const py=v=>H-P-((v-min)/range)*(H-P*2);
    const pts=vals.map((v,i)=>`${px(i)},${py(v)}`).join(' ');
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox',`0 0 ${W} ${H}`);svg.style.width='100%';svg.style.height=H+'px';
    svg.innerHTML=`<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>`;
    container.innerHTML='';container.appendChild(svg);
  }
};


/* ═══════════════════════════════════════
   AUTO GRADING ENGINE
   Reads confluences + comment → assigns A+/B/C automatically.
   Also supports Mistral AI deep-grade per trade (aiGrade method).
═══════════════════════════════════════ */
const GradingEngine = {

  STRONG: [
    'displacement','fvg','fair value gap','order block','ob',
    'sweep','liquidity','bos','break of structure','choch','change of character',
    'cisd','imbalance','inducement','pdh','pdl','previous day','htf',
    'higher time frame','weekly','daily','institutional','smt','divergence',
    'breaker','mitigation','rejection','engulf','reversal','confluence',
  ],

  QUALITY_COMMENT: [
    'perfect','clean','textbook','waited','patient','confirmed',
    'aligned','planned','as expected','clear','high probability',
    'thesis','structured','no hesitation','strong','valid',
  ],

  WEAK_COMMENT: [
    'fomo','rushed','forced','revenge','gut','feeling','random','lucky',
    'shouldnt','should not','mistake','impulsive','emotional','early',
    'late entry','chased','doubt','not sure','unclear','gambling',
    'bored','scared','hesitat','overtraded','broke rules',
  ],

  grade(trade) {
    const notionGrade = (trade.grade||'').trim();
    if (notionGrade && ['A+','A','B','C','D','F'].includes(notionGrade)) return notionGrade;

    const confluences = (trade.confluences||[]).map(c=>c.toLowerCase());
    const comment = (trade.comment||'').toLowerCase();
    const allText = [...confluences, comment].join(' ');

    const strongCount  = this.STRONG.filter(kw => allText.includes(kw)).length;
    const qualityCount = this.QUALITY_COMMENT.filter(kw => comment.includes(kw)).length;
    const weakCount    = this.WEAK_COMMENT.filter(kw => comment.includes(kw)).length;
    const totalConfs   = confluences.length;

    if (weakCount >= 2) return 'C';
    if (strongCount >= 3 || (strongCount >= 2 && qualityCount >= 1)) return 'A+';
    if (strongCount >= 2 || (totalConfs >= 3 && qualityCount >= 1)) return 'A+';
    if (strongCount >= 1 && totalConfs >= 2) return 'B';
    if (totalConfs >= 2 && weakCount === 0) return 'B';
    if (totalConfs >= 1 || qualityCount >= 1) return 'C';
    return 'C';
  },

  gradeAll(trades) {
    trades.forEach(t => { t.grade = this.grade(t); });
    return trades;
  },

  explain(trade) {
    const confluences = trade.confluences||[];
    const comment = (trade.comment||'').toLowerCase();
    const allText = [...confluences.map(c=>c.toLowerCase()), comment].join(' ');
    const matched  = this.STRONG.filter(kw => allText.includes(kw));
    const weak     = this.WEAK_COMMENT.filter(kw => comment.includes(kw));
    const quality  = this.QUALITY_COMMENT.filter(kw => comment.includes(kw));
    const lines = [];
    if (matched.length)  lines.push(`Confluences: ${matched.slice(0,4).join(', ')}`);
    if (quality.length)  lines.push(`Quality: ${quality.join(', ')}`);
    if (weak.length)     lines.push(`⚠ Weak signals: ${weak.join(', ')}`);
    if (!confluences.length && !trade.comment) lines.push('No confluences or comment tagged');
    return `Grade ${trade.grade} — ${lines.join(' · ')||'auto-graded from setup'}`;
  },

  // Mistral AI deep-grade a single trade
  async aiGrade(trade) {
    const prompt =
      `You are a professional ICT/SMC FX trading coach grading a trade.

` +
      `Pair: ${trade.pair||'?'} | Direction: ${trade.direction||'?'} | Outcome: ${trade.outcome||'?'} | R: ${trade.rMultiple!=null?trade.rMultiple+'R':'?'}
` +
      `Session: ${trade.session||'?'} | Timeframe: ${trade.timeframe||'?'}
` +
      `Confluences: ${(trade.confluences||[]).join(', ')||'none listed'}
` +
      `Comment: ${trade.comment||'no comment'}

` +
      `Grade A+, B, or C:
` +
      `A+ = 3+ strong ICT confluences (FVG, OB, sweep, displacement, HTF bias), patient execution, clear written thesis
` +
      `B  = 2 confluences, decent structure, room for improvement
` +
      `C  = 1 or no confluences, FOMO/revenge/impulsive signals, or poorly documented

` +
      `Reply ONLY in this exact format:
GRADE: [A+/B/C]
REASON: [one sentence]
IMPROVE: [one actionable tip]`;
    try {
      const res = await API.ai(prompt);
      const text = res.reply||'';
      const gm = text.match(/GRADE:\s*(A\+|B|C)/i);
      const rm = text.match(/REASON:\s*(.+)/i);
      const im = text.match(/IMPROVE:\s*(.+)/i);
      return { grade: gm?gm[1].toUpperCase():trade.grade, reason: rm?rm[1].trim():'', improve: im?im[1].trim():'', raw:text };
    } catch(e) {
      return { grade: trade.grade, reason: 'AI unavailable: '+e.message, improve: '' };
    }
  }
};

window.GradingEngine = GradingEngine;

const NavEngine = {
  init(pageId) {
    State.merge('ui',{currentPage:pageId});
    const linksEl=document.getElementById('nav-links');
    if(linksEl&&typeof Config!=='undefined'){
      linksEl.innerHTML=Config.PAGES.map(p=>{
        const active=p.id===pageId?' active':'';
        const click=p.id!==pageId?`onclick="window._navGo('${p.file}')"`:'' ;
        return `<div class="nav-link${active}" ${click}>${p.label}</div>`;
      }).join('');
    }
    document.body.style.opacity='1';
    window._navGo=(file)=>{
      document.body.style.transition='opacity 130ms ease';
      document.body.style.opacity='0';
      setTimeout(()=>{window.location.href=file;},140);
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
