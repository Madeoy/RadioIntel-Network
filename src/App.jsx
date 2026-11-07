import React, { useState, useEffect, useMemo, useRef } from 'react';
import './App.css';
import {
  HOME_MARKET, MARKETS, STATIONS, TV_STATIONS, CATEGORIES, DAYPARTS, TV_DAYPARTS, OFFER_CHANGES, PRICE_HISTORY, WEEKS, DAYS, EXPORT_COLUMNS,
  seedDetections, makeDetection, heatGrid, weekOverWeek, toTSV, toCSV,
} from './data.js';

const IS_PREVIEW = typeof window !== 'undefined' && !!window.__RI_PREVIEW__;
const LIVE_INTERVAL_MS = 4000;
const FEED_PAGE = 40;
const ALERT_GAP_MS = 45000;

const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const timeOf = (ts) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const hourLabel = (h) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
const ago = (ts, now) => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
};
const daysUntil = (offer) => (offer.exp ? (new Date(`${offer.exp}T23:59:00`) - Date.now()) / 86400000 : Infinity);

const DEFAULT_ADV = { daypart: 'All', length: 'All', adType: 'All', band: 'All', newOnly: false, promoOnly: false, expiringSoon: false, minConf: 94 };

function store(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    if (v !== null && v !== undefined) return v;
  } catch (e) { /* storage unavailable */ }
  return fallback;
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

function downloadCSV(rows) {
  const blob = new Blob([toCSV(rows)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `radiointel-detections-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ------------------------------------------------------------------ app

export default function App() {
  const [tab, setTab] = useState('live');
  const [events, setEvents] = useState(() => seedDetections());
  const [live, setLive] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [market, setMarket] = useState(() => store('ri.market', HOME_MARKET));
  const [category, setCategory] = useState('All');
  const [media, setMedia] = useState('Radio');
  const [query, setQuery] = useState('');
  const [adv, setAdv] = useState(DEFAULT_ADV);
  const [selected, setSelected] = useState(null);
  const [watchlist, setWatchlist] = useState(() => store('ri.watchlist.v3', ['Rainier Honda', 'Cascade Ford', 'Emerald City Subaru']));
  const [alertsOn, setAlertsOn] = useState(() => store('ri.alerts', true));
  const [toast, setToast] = useState(null);
  const watchRef = useRef(watchlist);
  const alertsRef = useRef(alertsOn);
  const lastAlert = useRef(0);
  watchRef.current = watchlist;
  alertsRef.current = alertsOn;

  useEffect(() => save('ri.watchlist.v3', watchlist), [watchlist]);
  useEffect(() => save('ri.alerts', alertsOn), [alertsOn]);
  useEffect(() => save('ri.market', market), [market]);

  // Simulated real-time ingest across ~200 stations.
  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(() => {
      const ts = Date.now();
      const batch = Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () => makeDetection(Math.random, ts));
      if (Math.random() < 0.45) batch.push(makeDetection(Math.random, ts, 'TV'));
      setNow(ts);
      setEvents((prev) => [...batch, ...prev].slice(0, 5000));
      const hit = batch.find((d) => watchRef.current.includes(d.creative.advertiser));
      if (hit && alertsRef.current && ts - lastAlert.current > ALERT_GAP_MS) {
        lastAlert.current = ts;
        setToast({ kind: 'alert', text: `${hit.creative.advertiser} just aired on ${hit.station.call}`, sub: hit.creative.offer.headline, detection: hit });
      }
    }, LIVE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [live]);

  useEffect(() => {
    if (!toast) return undefined;
    const id = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(id);
  }, [toast]);

  // Everything except the Radio/TV switch, so Trends can compare the two side by side.
  const crossMedia = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((d) => {
      const c = d.creative;
      if (market !== 'All' && d.station.market !== market) return false;
      if (category !== 'All' && c.category !== category) return false;
      if (adv.daypart !== 'All' && d.daypart !== adv.daypart) return false;
      if (adv.length !== 'All' && String(c.length) !== adv.length) return false;
      if (adv.adType !== 'All' && c.type !== adv.adType) return false;
      if (adv.band !== 'All' && d.station.band !== adv.band) return false;
      if (adv.newOnly && !d.newCreative) return false;
      if (adv.promoOnly && !c.offer.promoCode) return false;
      if (adv.expiringSoon && !(daysUntil(c.offer) <= 7)) return false;
      if (d.confidence < adv.minConf) return false;
      if (!q) return true;
      const o = c.offer;
      return [c.advertiser, d.station.call, o.headline, o.product, o.price, c.category, o.promoCode]
        .some((v) => v && String(v).toLowerCase().includes(q));
    });
  }, [events, market, category, query, adv]);
  const filtered = useMemo(
    () => (media === 'Both' ? crossMedia : crossMedia.filter((d) => d.station.media === media)),
    [crossMedia, media],
  );

  const toggleWatch = (name) =>
    setWatchlist((w) => (w.includes(name) ? w.filter((x) => x !== name) : [...w, name]));
  const notify = (text, sub) => setToast({ kind: 'info', text, sub });
  const showAdvertiser = (name) => {
    setQuery(name);
    setCategory('All');
    setTab('live');
    window.scrollTo({ top: 0 });
  };

  const filterProps = { market, setMarket, category, setCategory, query, setQuery, adv, setAdv, media, setMedia };

  return (
    <div className="ri-app">
      <Header live={live} setLive={setLive} />

      {toast && (
        <div className={`ri-toast ${toast.kind}`} role="status">
          <button type="button" className="ri-toast-body" onClick={() => { if (toast.detection) setSelected(toast.detection); setToast(null); }}>
            <strong>{toast.text}</strong>
            {toast.sub && <span>{toast.sub}</span>}
          </button>
          <button type="button" className="ri-toast-x" onClick={() => setToast(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      <main className="ri-main">
        {tab === 'live' && (
          <LiveView events={filtered} allCount={events.length} now={now} onOpen={setSelected}
            watchlist={watchlist} toggleWatch={toggleWatch} goTo={setTab} {...filterProps} />
        )}
        {tab === 'offers' && <OffersView events={filtered} onAdvertiser={showAdvertiser} {...filterProps} />}
        {tab === 'trends' && (
          <TrendsView events={filtered} crossMedia={crossMedia} allEvents={events} watchlist={watchlist} toggleWatch={toggleWatch} onAdvertiser={showAdvertiser} {...filterProps} />
        )}
        {tab === 'stations' && <StationsView events={events} now={now} onAdvertiser={showAdvertiser} />}
        {tab === 'export' && (
          <ExportView rows={filtered} market={market} category={category} query={query} media={media}
            watchlist={watchlist} toggleWatch={toggleWatch} alertsOn={alertsOn} setAlertsOn={setAlertsOn} notify={notify} />
        )}
      </main>

      <BottomNav tab={tab} setTab={setTab} />

      {selected && (
        <DetailSheet d={selected} onClose={() => setSelected(null)} watched={watchlist.includes(selected.creative.advertiser)}
          toggleWatch={toggleWatch} notify={notify} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ chrome

function Header({ live, setLive }) {
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <header className="ri-header">
      <div className="ri-brand">
        <svg className="ri-logo" viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="3" fill="currentColor" />
          <path d="M9.5 9.5a9 9 0 0 0 0 13M22.5 9.5a9 9 0 0 1 0 13M5.5 5.5a15 15 0 0 0 0 21M26.5 5.5a15 15 0 0 1 0 21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <div className="ri-brand-text">
          <h1>RadioIntel</h1>
          <span className="ri-node"><span className="wide">Node </span>Seattle-01 · {clock.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>
        </div>
      </div>
      <div className="ri-header-actions">
        <span className="ri-demo" title="Station names are real; every detection and offer is simulated">Demo<span className="wide"> data</span></span>
        <button type="button" className={`ri-live ${live ? 'on' : ''}`} onClick={() => setLive(!live)} aria-pressed={live}>
          <span className="dot" />{live ? 'Live' : 'Paused'}
        </button>
      </div>
    </header>
  );
}

const NAV = [
  ['live', 'Live', 'M3 12h3l3-8 4 16 3-8h5'],
  ['offers', 'Offers', 'M20 12l-8 8-9-9V3h8zM7.5 7.5h.01'],
  ['trends', 'Trends', 'M3 3v18h18M7 15l4-4 3 3 6-7'],
  ['stations', 'Stations', 'M5 9a10 10 0 0 1 14 0M8 12a6 6 0 0 1 8 0M12 15v6M9 21h6'],
  ['export', 'Export', 'M12 3v12M7 10l5 5 5-5M4 21h16'],
];

function BottomNav({ tab, setTab }) {
  return (
    <nav className="ri-nav" aria-label="Sections">
      {NAV.map(([id, label, path]) => (
        <button key={id} type="button" className={tab === id ? 'active' : ''} onClick={() => { setTab(id); window.scrollTo({ top: 0 }); }}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

function activeAdvCount(adv) {
  return Object.keys(DEFAULT_ADV).filter((k) => adv[k] !== DEFAULT_ADV[k]).length;
}

function MediaSwitch({ media, setMedia }) {
  return (
    <div className="ri-seg ri-media" role="radiogroup" aria-label="Media">
      {[['Radio', 'Radio'], ['TV', 'TV'], ['Both', 'Radio + TV']].map(([id, label]) => (
        <button key={id} type="button" role="radio" aria-checked={media === id} className={media === id ? 'on' : ''} onClick={() => setMedia(id)}>
          {id !== 'Both' && <i className={`sw ${id.toLowerCase()}`} aria-hidden="true" />}{label}
          {id !== 'Radio' && <span className="ri-premium">Premium</span>}
        </button>
      ))}
    </div>
  );
}

function Filters({ market, setMarket, category, setCategory, query, setQuery, adv, setAdv, media, setMedia, showSearch = true, showAdvanced = true }) {
  const [open, setOpen] = useState(false);
  const count = adv ? activeAdvCount(adv) : 0;
  const set = (k, v) => setAdv({ ...adv, [k]: v });
  const tvMissing = media === 'TV' && market !== 'All' && market !== 'Seattle';
  return (
    <div className="ri-filters-wrap">
      {setMedia && <MediaSwitch media={media} setMedia={setMedia} />}
      {tvMissing && <p className="ri-note">TV monitoring covers Seattle in this demo. Switch the market to Seattle to see TV spots.</p>}
      <div className="ri-filters">
        {showSearch && (
          <input id="ri-search" type="search" placeholder="Search advertiser, offer, vehicle, code…" value={query}
            onChange={(e) => setQuery(e.target.value)} aria-label="Search detections" />
        )}
        <div className="ri-selects">
          <select id="ri-market" value={market} onChange={(e) => setMarket(e.target.value)} aria-label="Market">
            <option value="All">All 5 markets</option>
            {MARKETS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select id="ri-category" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            <option value="All">All categories</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      {showAdvanced && adv && (
        <>
          <button type="button" className={`ri-adv-toggle ${count ? 'active' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>
            More filters{count ? ` · ${count} on` : ''} <span aria-hidden="true">{open ? '▴' : '▾'}</span>
          </button>
          {open && (
            <div className="ri-adv">
              <label>Daypart
                <select id="ri-f-daypart" value={adv.daypart} onChange={(e) => set('daypart', e.target.value)}>
                  <option value="All">Any</option>
                  <optgroup label="Radio">{DAYPARTS.map((d) => <option key={d}>{d}</option>)}</optgroup>
                  <optgroup label="TV">{TV_DAYPARTS.map((d) => <option key={d}>{d}</option>)}</optgroup>
                </select>
              </label>
              <label>Length
                <select id="ri-f-length" value={adv.length} onChange={(e) => set('length', e.target.value)}>
                  <option value="All">Any</option><option value="15">:15</option><option value="30">:30</option><option value="60">:60</option>
                </select>
              </label>
              <label>Ad type
                <select id="ri-f-type" value={adv.adType} onChange={(e) => set('adType', e.target.value)}>
                  <option value="All">Any</option><option>Produced</option><option>Live Read</option>
                </select>
              </label>
              <label>Band
                <select id="ri-f-band" value={adv.band} onChange={(e) => set('band', e.target.value)}>
                  <option value="All">AM + FM</option><option>FM</option><option>AM</option>
                </select>
              </label>
              <label className="wide">Minimum match confidence: {adv.minConf}%
                <input id="ri-f-conf" type="range" min="94" max="99" step="0.5" value={adv.minConf} onChange={(e) => set('minConf', Number(e.target.value))} />
              </label>
              <div className="ri-checks wide">
                <label><input id="ri-f-new" type="checkbox" checked={adv.newOnly} onChange={(e) => set('newOnly', e.target.checked)} /> New creatives only</label>
                <label><input id="ri-f-promo" type="checkbox" checked={adv.promoOnly} onChange={(e) => set('promoOnly', e.target.checked)} /> Has a promo code</label>
                <label><input id="ri-f-exp" type="checkbox" checked={adv.expiringSoon} onChange={(e) => set('expiringSoon', e.target.checked)} /> Offer ends within 7 days</label>
              </div>
              {count > 0 && <button type="button" className="ri-btn wide" onClick={() => setAdv(DEFAULT_ADV)}>Clear these filters</button>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ live

function Kpis({ events, market, media }) {
  const advertisers = new Set(events.map((d) => d.creative.advertiser)).size;
  const specific = events.filter((d) => d.creative.offer.offerType !== 'Brand').length;
  const spend = events.reduce((a, d) => a + d.estCost, 0);
  const tvSpend = events.reduce((a, d) => a + (d.station.media === 'TV' ? d.estCost : 0), 0);
  const st = STATIONS.filter((s) => market === 'All' || s.market === market);
  const online = st.filter((s) => s.status === 'live').length;
  const items = [
    ['Spots detected', events.length.toLocaleString('en-US')],
    ['Advertisers', advertisers],
    ['With a specific offer', events.length ? `${Math.round((specific / events.length) * 100)}%` : '–'],
    ['Est. spend', money(spend)],
    media === 'Radio'
      ? ['New creatives', new Set(events.filter((d) => d.newCreative).map((d) => d.creative.id)).size]
      : ['TV share of spend', spend ? `${Math.round((tvSpend / spend) * 100)}%` : '–'],
    ['Channels online', `${online}/${st.length}`],
  ];
  return (
    <section className="ri-kpis" aria-label="Summary for the current filters">
      {items.map(([l, v]) => (
        <div key={l} className="ri-kpi"><span className="v">{v}</span><span className="l">{l}</span></div>
      ))}
    </section>
  );
}

// "Your competitors right now": one card per watched advertiser, newest offer first.
function WatchingPanel({ events, watchlist, toggleWatch, now, onOpen, goTo }) {
  const [chart, setChart] = useState(null);
  // The client's own company, pinned on top so every competitor is compared against it.
  const [me, setMe] = useState(() => store('ri.me.v1', 'Puget Sound Toyota'));
  useEffect(() => save('ri.me.v1', me), [me]);
  if (watchlist.length === 0) {
    return (
      <div className="ri-panel ri-watch-empty">
        <p><b>You’re not watching anyone yet.</b></p>
        <p className="muted">Tap ☆ next to any advertiser on the Trends tab, or “Watch” on any ad. Their offers and alerts collect here.</p>
        <button type="button" className="ri-btn" onClick={() => goTo('trends')}>Pick competitors on Trends</button>
      </div>
    );
  }
  const build = (name) => {
    const evs = events.filter((d) => d.creative.advertiser === name);
    return {
      name, evs, latest: evs[0],
      stations: new Set(evs.map((d) => d.station.id)).size,
      spend: evs.reduce((a, d) => a + d.estCost, 0),
      change: OFFER_CHANGES.find((c) => c.advertiser === name),
      history: PRICE_HISTORY.find((p) => p.advertiser === name),
    };
  };
  const meCard = build(me);
  const cards = watchlist.filter((n) => n !== me).map(build).sort((a, b) => (b.latest?.ts || 0) - (a.latest?.ts || 0));
  const names = [...new Set([me, ...PRICE_HISTORY.map((p) => p.advertiser), ...events.map((d) => d.creative.advertiser)])].sort();
  const fmtH = (h, n) => (h.unit === ' off' ? `$${n.toLocaleString()} off` : `$${n.toLocaleString()}${h.unit}`);
  // "Them vs you" on the current deal. Only compares like with like (lease vs lease, discount vs discount).
  const compare = (w) => {
    const a = w.history; const b = meCard.history;
    if (!a || !b || a.unit !== b.unit) return null;
    const them = a.values[a.values.length - 1]; const you = b.values[b.values.length - 1];
    const gap = Math.abs(them - you);
    const off = a.unit === ' off';
    const youWin = a.lowerIsBetter ? you < them : you > them;
    const text = gap === 0 ? 'Same deal as you'
      : youWin ? (off ? `You give ${money(gap)} more off` : `You’re ${money(gap)}${a.unit} cheaper`)
      : (off ? `They give ${money(gap)} more off` : `They’re ${money(gap)}${a.unit} cheaper`);
    return { them: fmtH(a, them), you: fmtH(b, you), text, cls: gap === 0 ? '' : youWin ? 'better' : 'worse' };
  };

  return (
    <>
    <label className="ri-me-pick">
      <span>Your dealership</span>
      <select value={me} onChange={(e) => setMe(e.target.value)}>
        {names.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
    <ul className="ri-watch">
      {[meCard, ...cards].map((w) => {
        const isMe = w === meCard;
        const o = w.latest?.creative.offer;
        const fresh = w.latest && now - w.latest.ts < 15 * 60000;
        const cmp = isMe ? null : compare(w);
        const open = () => w.history && setChart({ h: w.history, mine: isMe ? null : meCard.history, own: isMe });
        return (
          <li key={isMe ? `me-${w.name}` : w.name} className={`ri-watch-card ${isMe ? 'me' : fresh ? 'hot' : ''} ${w.history ? 'tappable' : ''}`}
            onClick={open}>
            <div className="ri-watch-top">
              <span className="nm">{w.name}</span>
              {isMe ? <span className="ri-you-tag">You</span> : (
                <button type="button" className="ri-star on" onClick={(e) => { e.stopPropagation(); toggleWatch(w.name); }} aria-label={`Stop watching ${w.name}`}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" /></svg>
                </button>
              )}
            </div>
            {cmp && (
              <div className={`ri-vs ${cmp.cls}`}>
                <span><small>Them</small><b>{cmp.them}</b></span>
                <span className="v">vs</span>
                <span><small>You</small><b>{cmp.you}</b></span>
                <span className="verdict">{cmp.text}</span>
              </div>
            )}
            {w.latest ? (
              <>
                <p className="ri-watch-status">
                  <span className={`dot ${fresh ? 'on' : ''}`} />
                  Last aired {ago(w.latest.ts, now)} on {w.latest.station.call}
                </p>
                <button type="button" className="ri-watch-offer" onClick={(e) => { e.stopPropagation(); onOpen(w.latest); }}>{o.headline}</button>
                {w.change && (
                  <p className="ri-watch-change">
                    <span className="tag amber">Changed {w.change.date}</span>
                    <s>{w.change.from}</s> → <b>{w.change.to}</b>
                  </p>
                )}
                <div className="ri-watch-foot">
                  <div className="nums">
                    <span><b>{w.evs.length}</b> spots</span>
                    <span><b>{w.stations}</b> stations</span>
                    <span><b>{money(w.spend)}</b> est.</span>
                    {o.expires && <span>Ends <b>{o.expires}</b></span>}
                  </div>
                </div>
                {w.history && (() => {
                  const v = w.history.values; const first = v[0]; const last = v[v.length - 1];
                  const better = w.history.lowerIsBetter ? last < first : last > first;
                  const fmt = (n) => (w.history.unit === ' off' ? `$${n.toLocaleString()} off` : `$${n.toLocaleString()}${w.history.unit}`);
                  return (
                    <button type="button" className="ri-watch-trend" onClick={(e) => { e.stopPropagation(); open(); }} aria-label={`Open ${w.name} price chart`}>
                      <span className="lbl">
                        <span className="prod">{w.history.product} · 8 weeks</span>
                        <span className={`mv ${isMe ? 'mine' : better ? 'better' : last === first ? '' : 'worse'}`}>
                          {fmt(first)} → <b>{fmt(last)}</b>
                        </span>
                      </span>
                      <Sparkline values={v} lowerIsBetter={w.history.lowerIsBetter} w={320} h={70} own={isMe} />
                      <span className="ri-spark-hint">{isMe || !cmp ? 'Tap for full chart ›' : 'Tap to compare on chart ›'}</span>
                    </button>
                  );
                })()}
              </>
            ) : (
              <p className="muted small">{isMe ? 'You haven’t aired in the last 3 hours with these filters.' : 'No spots in the last 3 hours. If they stay off radio, that’s your open lane.'}</p>
            )}
          </li>
        );
      })}
    </ul>
    {chart && <PriceChartSheet h={chart.h} mine={chart.mine} own={chart.own} onClose={() => setChart(null)} />}
    </>
  );
}

function LiveView({ events, allCount, now, onOpen, watchlist, toggleWatch, goTo, ...filters }) {
  const [limit, setLimit] = useState(FEED_PAGE);
  const [view, setView] = useState('all');
  const shown = view === 'watching' ? events.filter((d) => watchlist.includes(d.creative.advertiser)) : events;
  return (
    <>
      <Kpis events={events} market={filters.market} media={filters.media} />
      <div className="ri-seg" role="tablist" aria-label="Feed view">
        <button type="button" role="tab" aria-selected={view === 'all'} className={view === 'all' ? 'on' : ''} onClick={() => setView('all')}>All ads</button>
        <button type="button" role="tab" aria-selected={view === 'watching'} className={view === 'watching' ? 'on' : ''} onClick={() => setView('watching')}>
          ★ Watching ({watchlist.length})
        </button>
      </div>
      {view === 'watching' && (
        <>
          <div className="ri-section-head"><h2>Your competitors right now</h2><span className="ri-count">newest first</span></div>
          <WatchingPanel events={events} watchlist={watchlist} toggleWatch={toggleWatch} now={now} onOpen={onOpen} goTo={goTo} />
        </>
      )}
      <Filters {...filters} />
      <div className="ri-section-head">
        <h2>{view === 'watching' ? 'Their latest ads' : 'Live ad feed'}</h2>
        <span className="ri-count">{shown.length.toLocaleString('en-US')} of {allCount.toLocaleString('en-US')} spots · last 3 hrs</span>
      </div>
      {shown.length === 0 && <p className="ri-empty">No spots match these filters. Clear the search or loosen a filter.</p>}
      <ul className="ri-feed">
        {shown.slice(0, limit).map((d) => <FeedCard key={d.id} d={d} now={now} onOpen={onOpen} />)}
      </ul>
      {shown.length > limit && (
        <button type="button" className="ri-more" onClick={() => setLimit(limit + FEED_PAGE)}>Show {Math.min(FEED_PAGE, shown.length - limit)} more</button>
      )}
    </>
  );
}

function FeedCard({ d, now, onOpen }) {
  const c = d.creative;
  const o = c.offer;
  const fresh = now - d.ts < 10000;
  const brand = o.offerType === 'Brand';
  const ending = daysUntil(o) <= 7;
  return (
    <li>
      <button type="button" className={`ri-card ${fresh ? 'fresh' : ''}`} onClick={() => onOpen(d)}>
        <div className="ri-card-top">
          <span className={`ri-media-tag ${d.station.media.toLowerCase()}`}>{d.station.media}</span>
          <span className="ri-time">{timeOf(d.ts)}</span>
          <span className="ri-station">{d.station.call}</span>
          <span className="ri-market">{d.program || d.station.market}</span>
          <span className="ri-len">:{c.length}</span>
        </div>
        <div className="ri-adv-name">
          <span>{c.advertiser}</span>
          <span className="ri-cat">{c.category}</span>
        </div>
        <p className={`ri-offer ${brand ? 'brand' : ''}`}>{o.headline}</p>
        {!brand && (
          <p className="ri-offer-sub">
            {[o.product, o.terms[0], o.expires ? `Ends ${o.expires}` : 'No end date stated'].filter(Boolean).join(' · ')}
          </p>
        )}
        <div className="ri-tags">
          {fresh && <span className="tag new">Just aired</span>}
          {d.newCreative && <span className="tag amber">New creative</span>}
          {ending && <span className="tag amber">Ends soon</span>}
          {c.type === 'Live Read' && <span className="tag amber">Live read</span>}
          {o.promoCode && <span className="tag">Code {o.promoCode}</span>}
          {c.notSpoken.length > 0 && <span className="tag tv">{c.notSpoken.length} fine-print terms</span>}
          <span className="tag">{d.daypart}</span>
          <span className="tag mono">{d.confidence}%</span>
          <span className="ri-cost">est. {money(d.estCost)}</span>
        </div>
      </button>
    </li>
  );
}

function highlight(text, keywords) {
  if (!keywords?.length) return text;
  const esc = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = text.split(new RegExp(`(${esc.join('|')})`, 'gi'));
  return parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : p));
}

function DetailSheet({ d, onClose, watched, toggleWatch, notify }) {
  const c = d.creative;
  const o = c.offer;
  const a = c.auto;
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const facts = [
    ['Offer type', o.offerType],
    ['Price / value', o.price || 'None stated'],
    ['Product', o.product],
    ['Promo code', o.promoCode || 'None'],
    ['Expires', o.expires || 'Not stated'],
    ['Call to action', o.cta],
    ['Phone', o.phone || '–'],
    ['Website', o.url || '–'],
  ];
  const autoFacts = a ? [
    ['Deal', a.deal],
    ['Monthly', a.monthly ? money(a.monthly) : '–'],
    ['Due at signing', a.due != null ? money(a.due) : '–'],
    ['Term', a.term ? `${a.term} mo` : '–'],
    ['APR', a.apr != null ? `${a.apr}%` : '–'],
    ['Cash off', a.cashOff ? money(a.cashOff) : '–'],
  ] : [];
  const meta = [
    ['Aired', new Date(d.ts).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' })],
    ['Station', `${d.station.call} ${d.station.network || d.station.band}`],
    ['Market', d.station.market],
    ['Daypart', d.daypart],
    ['Length', `:${c.length} ${c.type.toLowerCase()}`],
    ['Position', d.pod],
    ['Creative ID', c.id],
    ['First seen', c.firstSeen],
    ['Match confidence', `${d.confidence}%`],
    ['Est. cost', money(d.estCost)],
  ];

  const copyRow = async () => {
    const ok = await copyText(toTSV([d]));
    notify(ok ? 'Row copied' : 'Copy failed', ok ? 'Paste into Google Sheets cell A1.' : 'Your browser blocked clipboard access.');
  };

  return (
    <div className="ri-sheet-wrap" onClick={onClose}>
      <div className="ri-sheet" role="dialog" aria-modal="true" aria-label={`${c.advertiser} spot details`} onClick={(e) => e.stopPropagation()}>
        <div className="ri-sheet-grip" />
        <div className="ri-sheet-head">
          <div>
            <span className="ri-eyebrow">{c.category} · {c.scope}{c.market ? ` · ${c.market}` : ''}</span>
            <h3>{c.advertiser}</h3>
          </div>
          <button type="button" className="ri-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className={`ri-offer-block ${o.offerType === 'Brand' ? 'brand' : ''}`}>
          <span className="ri-eyebrow">Extracted offer</span>
          <p className="headline">{o.headline}</p>
          {a && (
            <dl className="ri-facts auto">
              {autoFacts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
            </dl>
          )}
          <dl className="ri-facts">
            {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
          <span className="ri-eyebrow">Terms and fine print</span>
          <ul className="ri-terms">{o.terms.map((t) => <li key={t}>{t}</li>)}</ul>
        </div>

        {c.media === 'TV' && (
          <div className="ri-tv-block">
            <span className="ri-premium">TV Premium</span>
            <span className="ri-eyebrow">On screen (read from the video)</span>
            <ul className="ri-terms">{c.onScreen.map((t) => <li key={t}>{t}</li>)}</ul>
            {c.notSpoken.length > 0 && (
              <>
                <span className="ri-eyebrow">Only in the fine print, never said out loud</span>
                <ul className="ri-terms catch">{c.notSpoken.map((t) => <li key={t}>{t}</li>)}</ul>
              </>
            )}
            <dl className="ri-facts">
              <div><dt>Program</dt><dd>{d.program}</dd></div>
              <div><dt>Network</dt><dd>{d.station.network}</dd></div>
              <div className="wide"><dt>Visuals</dt><dd>{c.visuals}</dd></div>
            </dl>
          </div>
        )}

        <span className="ri-eyebrow">{c.media === 'TV' ? 'Voiceover transcript' : 'Transcript'}</span>
        <blockquote className="ri-transcript">{highlight(c.transcript, c.keywords)}</blockquote>

        <span className="ri-eyebrow">Airing details</span>
        <dl className="ri-facts meta">
          {meta.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>

        <div className="ri-sheet-actions">
          <button type="button" className="ri-btn" onClick={() => toggleWatch(c.advertiser)}>
            {watched ? 'Stop watching' : `Watch ${c.advertiser}`}
          </button>
          <button type="button" className="ri-btn primary" onClick={copyRow}>Copy row for Sheets</button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ offers

function groupByCreative(events) {
  const by = new Map();
  for (const d of events) {
    const cur = by.get(d.creative.id) || { c: d.creative, spins: 0, stations: new Set(), spend: 0 };
    cur.spins += 1;
    cur.spend += d.estCost;
    cur.stations.add(d.station.id);
    by.set(d.creative.id, cur);
  }
  return [...by.values()];
}

function OffersView({ events, onAdvertiser, ...filters }) {
  const [view, setView] = useState('auto');
  const offers = useMemo(() => groupByCreative(events).sort((a, b) => b.spins - a.spins), [events]);
  const specific = offers.filter((x) => x.c.offer.offerType !== 'Brand');
  const brand = offers.filter((x) => x.c.offer.offerType === 'Brand');
  const changes = OFFER_CHANGES.filter((ch) => filters.market === 'All' || ch.market === filters.market);

  return (
    <>
      <Filters {...filters} showSearch={false} />
      <div className="ri-seg" role="tablist" aria-label="Offer views">
        {[['auto', 'Auto deal board'], ['all', 'All offers'], ['changes', 'Changes']].map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} className={view === id ? 'on' : ''} onClick={() => setView(id)}>{label}</button>
        ))}
      </div>

      {view === 'auto' && <AutoBoard offers={offers} market={filters.market} onAdvertiser={onAdvertiser} />}

      {view === 'all' && (
        <>
          <div className="ri-section-head"><h2>Offers on air</h2><span className="ri-count">{specific.length} specific · {brand.length} brand-only</span></div>
          <ul className="ri-offer-grid">{specific.map((x) => <OfferCard key={x.c.id} x={x} onAdvertiser={onAdvertiser} />)}</ul>
          {brand.length > 0 && (
            <>
              <div className="ri-section-head"><h2>Brand-only spots</h2><span className="ri-count">no price or deal stated</span></div>
              <ul className="ri-offer-grid">{brand.map((x) => <OfferCard key={x.c.id} x={x} onAdvertiser={onAdvertiser} />)}</ul>
            </>
          )}
        </>
      )}

      {view === 'changes' && (
        <>
          <div className="ri-section-head"><h2>Offer changes this week</h2><span className="ri-count">{changes.length} changes</span></div>
          {changes.length === 0 && <p className="ri-empty">No offer changes in this market this week.</p>}
          <ul className="ri-changes">
            {changes.map((ch) => (
              <li key={ch.advertiser + ch.date}>
                <span className="date">{ch.date}</span>
                <div>
                  <strong>{ch.advertiser}</strong> <span className="muted">{ch.product} · {ch.market}</span>
                  <div className="ri-diff"><s>{ch.from}</s><span aria-hidden="true">→</span><b>{ch.to}</b></div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function AutoBoard({ offers, market, onAdvertiser }) {
  const [body, setBody] = useState('All');
  const [sort, setSort] = useState('true');
  const auto = offers.filter((x) => x.c.auto && (body === 'All' || x.c.auto.body === body));
  const leases = auto.filter((x) => x.c.auto.monthly).map((x) => ({ ...x, trueMonthly: x.c.auto.monthly + (x.c.auto.due || 0) / x.c.auto.term }));
  const sorters = {
    true: (a, b) => a.trueMonthly - b.trueMonthly,
    monthly: (a, b) => a.c.auto.monthly - b.c.auto.monthly,
    spins: (a, b) => b.spins - a.spins,
  };
  leases.sort(sorters[sort]);
  const other = auto.filter((x) => !x.c.auto.monthly);

  return (
    <>
      <div className="ri-section-head">
        <h2>Lease deals on air{market !== 'All' ? ` in ${market}` : ''}</h2>
        <span className="ri-count">{leases.length} deals</span>
      </div>
      <div className="ri-board-controls">
        <div className="ri-chips">
          {['All', 'Sedan', 'SUV', 'Truck', 'EV'].map((b) => (
            <button key={b} type="button" className={`ri-chip ${body === b ? 'on' : ''}`} onClick={() => setBody(b)} aria-pressed={body === b}>{b}</button>
          ))}
        </div>
        <select id="ri-board-sort" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort deals">
          <option value="true">Sort: true monthly cost</option>
          <option value="monthly">Sort: advertised monthly</option>
          <option value="spins">Sort: most spins</option>
        </select>
      </div>
      <p className="muted small">True monthly cost adds the money due at signing, spread over the term. It is the fair way to compare a "$0 down" deal with a "$299/mo" deal.</p>
      {leases.length === 0 && <p className="ri-empty">No lease deals match. Try another market or body style.</p>}
      <ol className="ri-board">
        {leases.map((x, i) => {
          const a = x.c.auto;
          return (
            <li key={x.c.id}>
              <span className="rank">{i + 1}</span>
              <div className="body">
                <div className="top">
                  <span className="veh">{a.vehicle}</span>
                  <span className="true">{money(x.trueMonthly)}<small>/mo true</small></span>
                </div>
                <div className="nums">
                  <span><b>{money(a.monthly)}</b>/mo</span>
                  <span><b>{money(a.due)}</b> due</span>
                  <span><b>{a.term}</b> mo</span>
                  <span className="body-type">{a.body}</span>
                </div>
                <div className="sub">
                  <button type="button" className="ri-link" onClick={() => onAdvertiser(x.c.advertiser)}>{x.c.advertiser}</button>
                  <span>{x.c.market}</span>
                  <span>{x.spins} spins · {x.stations.size} stations</span>
                  <span>Ends {x.c.offer.expires}</span>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {other.length > 0 && (
        <>
          <div className="ri-section-head"><h2>Cash-off and financing deals</h2></div>
          <ul className="ri-offer-grid">{other.map((x) => <OfferCard key={x.c.id} x={x} onAdvertiser={onAdvertiser} />)}</ul>
        </>
      )}
    </>
  );
}

function OfferCard({ x, onAdvertiser }) {
  const o = x.c.offer;
  return (
    <li className="ri-offer-card">
      <div className="ri-adv-name">
        <button type="button" className="ri-link" onClick={() => onAdvertiser(x.c.advertiser)}>{x.c.advertiser}</button>
        <span className="ri-cat">{x.c.category}</span>
      </div>
      {o.price && <span className="ri-price">{o.price}</span>}
      <p className="ri-offer">{o.headline}</p>
      <ul className="ri-terms compact">{o.terms.slice(0, 3).map((t) => <li key={t}>{t}</li>)}</ul>
      <div className="ri-offer-foot">
        <span>{o.expires ? `Ends ${o.expires}` : 'No end date'}</span>
        <span>{x.spins} spins · {x.stations.size} stn · {money(x.spend)}</span>
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ trends

function Sparkline({ values, lowerIsBetter, w = 132, h = 40, own = false }) {
  const pad = 4;
  const min = Math.min(...values); const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [pad + (i * (w - pad * 2)) / (values.length - 1), pad + (h - pad * 2) * (1 - (v - min) / span)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${d} L${pts[pts.length - 1][0]},${h} L${pts[0][0]},${h} Z`;
  const last = pts[pts.length - 1];
  const better = lowerIsBetter ? values[values.length - 1] < values[0] : values[values.length - 1] > values[0];
  return (
    <svg className={`ri-spark ${own ? 'mine' : better ? 'better' : ''}`} viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      <path d={area} className="area" />
      <path d={d} className="line" />
      <circle cx={last[0]} cy={last[1]} r="3" className="dot" />
    </svg>
  );
}

function Donut({ radio, tv }) {
  const total = radio + tv || 1;
  const r = 42; const C = 2 * Math.PI * r; const gap = 2;
  const segs = [['radio', radio], ['tv', tv]].filter(([, v]) => v > 0);
  let offset = 0;
  return (
    <svg className="ri-donut" viewBox="0 0 110 110" width="120" height="120" role="img" aria-label={`Radio ${Math.round((radio / total) * 100)}%, TV ${Math.round((tv / total) * 100)}%`}>
      <circle cx="55" cy="55" r={r} className="track" />
      {segs.map(([k, v]) => {
        const len = Math.max(0, (v / total) * C - (segs.length > 1 ? gap : 0));
        const el = <circle key={k} cx="55" cy="55" r={r} className={`seg ${k}`} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} transform="rotate(-90 55 55)" />;
        offset += (v / total) * C;
        return el;
      })}
      <text x="55" y="52" textAnchor="middle" className="big">{money(total)}</text>
      <text x="55" y="67" textAnchor="middle" className="small">est. spend</text>
    </svg>
  );
}

function SplitBars({ rows, onPick, picked, limit = 10, showTvOnly = false }) {
  const max = Math.max(...rows.map((r) => r.radio + r.tv), 1);
  return (
    <ol className="ri-bars">
      {rows.slice(0, limit).map((r) => {
        const total = r.radio + r.tv;
        return (
          <li key={r.name}>
            <button type="button" className={`ri-bar-row ${picked === r.name ? 'sel' : ''}`} onClick={() => onPick && onPick(r.name)}
              aria-label={`${r.name}: ${money(total)} total, ${money(r.radio)} radio, ${money(r.tv)} TV`}>
              <span className="lbl"><span className="nm">{r.name}</span><span className="val">{money(total)}</span></span>
              <span className="track">
                {!showTvOnly && r.radio > 0 && <span className="seg radio" style={{ width: `${(r.radio / max) * 100}%` }} />}
                {r.tv > 0 && <span className="seg tv" style={{ width: `${(r.tv / max) * 100}%` }} />}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function MediaLegend() {
  return (
    <div className="ri-media-legend" aria-hidden="true">
      <span><i className="sw radio" />Radio</span><span><i className="sw tv" />TV</span>
    </div>
  );
}

function splitBy(events, key) {
  const m = new Map();
  for (const d of events) {
    const k = key(d);
    const cur = m.get(k) || { name: k, radio: 0, tv: 0 };
    if (d.station.media === 'TV') cur.tv += d.estCost; else cur.radio += d.estCost;
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.radio + b.tv - (a.radio + a.tv));
}

function RadioVsTv({ crossMedia, market }) {
  const [picked, setPicked] = useState(null);
  const scoped = market === 'All' || market === 'Seattle' ? crossMedia.filter((d) => d.station.market === 'Seattle') : null;
  if (!scoped) {
    return <p className="ri-note">Radio vs TV compares Seattle, where TV is monitored in this demo. Set the market to Seattle or All.</p>;
  }
  const radio = scoped.reduce((a, d) => a + (d.station.media === 'Radio' ? d.estCost : 0), 0);
  const tv = scoped.reduce((a, d) => a + (d.station.media === 'TV' ? d.estCost : 0), 0);
  const byAdv = splitBy(scoped, (d) => d.creative.advertiser);
  const byCat = splitBy(scoped, (d) => d.creative.category);
  const byTvStation = splitBy(scoped.filter((d) => d.station.media === 'TV'), (d) => `${d.station.call} ${d.station.network}`);
  const pick = byAdv.find((r) => r.name === picked);
  const bothCount = byAdv.filter((r) => r.radio > 0 && r.tv > 0).length;
  const radioOnly = byAdv.filter((r) => r.tv === 0).length;
  const tvOnly = byAdv.filter((r) => r.radio === 0).length;
  const total = radio + tv || 1;

  return (
    <>
      <div className="ri-section-head"><h2>Radio vs TV in Seattle <span className="ri-premium">TV Premium</span></h2><span className="ri-count">last 3 hrs, est. spend</span></div>
      <div className="ri-panel ri-mix">
        <Donut radio={radio} tv={tv} />
        <dl className="ri-mix-facts">
          <div><dt><i className="sw radio" />Radio</dt><dd>{money(radio)} <span className="muted">{Math.round((radio / total) * 100)}%</span></dd></div>
          <div><dt><i className="sw tv" />TV</dt><dd>{money(tv)} <span className="muted">{Math.round((tv / total) * 100)}%</span></dd></div>
          <div><dt>On both</dt><dd>{bothCount} advertisers</dd></div>
          <div><dt>Radio only / TV only</dt><dd>{radioOnly} / {tvOnly}</dd></div>
        </dl>
      </div>

      <div className="ri-section-head"><h2>Who's spending the most</h2><span className="ri-count">top 10 by est. spend</span></div>
      <div className="ri-panel">
        <MediaLegend />
        <p className="ri-callout">
          {pick
            ? <><b>{pick.name}</b>: {money(pick.radio)} radio · {money(pick.tv)} TV · {Math.round((pick.tv / (pick.radio + pick.tv)) * 100)}% on TV</>
            : 'Tap a bar to split it into radio and TV.'}
        </p>
        <SplitBars rows={byAdv} onPick={setPicked} picked={picked} />
      </div>

      <div className="ri-section-head"><h2>Spend by category</h2></div>
      <div className="ri-panel">
        <MediaLegend />
        <SplitBars rows={byCat} limit={10} />
      </div>

      <div className="ri-section-head"><h2>TV spend by station</h2><span className="ri-count">{TV_STATIONS.length} Seattle TV stations</span></div>
      <div className="ri-panel">
        <SplitBars rows={byTvStation} limit={8} showTvOnly />
      </div>
    </>
  );
}

// Stock-style price chart for one tracked offer: tap any week for its exact price.
function PriceChartSheet({ h, mine, own, onClose }) {
  const vals = h.values;
  const n = vals.length;
  // Optional "you" line: the client's own deal, drawn dashed on the same scale (same unit only).
  const you = mine && mine.unit === h.unit && mine.advertiser !== h.advertiser && mine.values.length === n ? mine.values : null;
  const [sel, setSel] = useState(n - 1);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const W = 360; const H = 220; const L = 54; const R = 14; const T = 14; const B = 30;
  const all = you ? [...vals, ...you] : vals;
  const min = Math.min(...all); const max = Math.max(...all);
  const pad = (max - min || max * 0.1) * 0.2;
  const lo = Math.max(0, min - pad); const hi = max + pad;
  const x = (i) => L + (i * (W - L - R)) / (n - 1);
  const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const raw = (hi - lo) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(n - 1)},${H - B} L${x(0)},${H - B} Z`;
  const youLine = you && you.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const fmt = (v) => `${money(v)}${h.unit}`;

  const first = vals[0]; const last = vals[n - 1];
  const delta = last - first;
  const better = h.lowerIsBetter ? delta < 0 : delta > 0;
  // Colors from the client's side: competitor getting richer = red (threat), weaker = green, own deal = neutral.
  const tone = own ? 'mine' : better ? 'better' : 'worse';
  const pct = first ? (delta / first) * 100 : 0;
  const weekDelta = sel > 0 ? vals[sel] - vals[sel - 1] : 0;
  let biggest = { i: 0, d: 0 };
  vals.forEach((v, i) => { if (i && Math.abs(v - vals[i - 1]) > Math.abs(biggest.d)) biggest = { i, d: v - vals[i - 1] }; });
  const changes = vals.filter((v, i) => i && v !== vals[i - 1]).length;

  return (
    <div className="ri-sheet-wrap" onClick={onClose}>
      <div className="ri-sheet" role="dialog" aria-modal="true" aria-label={`${h.advertiser} price history`} onClick={(e) => e.stopPropagation()}>
        <div className="ri-sheet-grip" />
        <div className="ri-sheet-head">
          <div>
            <span className="ri-eyebrow">{h.product} · {h.market} · 8 weeks</span>
            <h3>{h.advertiser}</h3>
          </div>
          <button type="button" className="ri-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="ri-quote">
          <span className="now">{fmt(last)}</span>
          <span className={`chg ${tone}`}>
            {delta < 0 ? '▼' : delta > 0 ? '▲' : '■'} {money(Math.abs(delta))} ({pct > 0 ? '+' : ''}{pct.toFixed(1)}%) since {WEEKS[0]}
          </span>
          <span className="muted small">{own ? (delta === 0 ? 'Your deal hasn’t changed in 8 weeks.' : 'Your own deal over 8 weeks.')
            : better ? 'Red: a richer deal for shoppers. This competitor is getting aggressive and can cost you sales.' : delta === 0 ? 'No change in 8 weeks.' : 'Green: a weaker deal than 8 weeks ago. Good for you.'}</span>
        </div>

        <p className="ri-callout ri-chart-read">
          Week of <b>{WEEKS[sel]}</b>: <b>{fmt(vals[sel])}</b>
          {sel > 0 && <span className="muted"> · {weekDelta === 0 ? 'no change' : `${weekDelta < 0 ? '▼' : '▲'} ${money(Math.abs(weekDelta))} vs week before`}</span>}
          {you && <><br /><span className="muted">You ({mine.advertiser}): </span><b>{fmt(you[sel])}</b></>}
        </p>
        {you && (
          <div className="ri-chart-legend">
            <span><i className={`sw ${tone}`} />{h.advertiser}</span>
            <span><i className="sw you" />You · {mine.product}</span>
          </div>
        )}

        <div className="ri-chart">
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${h.advertiser} ${h.product}: ${fmt(first)} on ${WEEKS[0]} to ${fmt(last)} on ${WEEKS[n - 1]}`}>
            <defs>
              <linearGradient id="ri-area" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" className={`stop-a ${tone}`} />
                <stop offset="100%" className="stop-b" />
              </linearGradient>
            </defs>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="grid" />
                <text x={L - 8} y={y(t) + 4} textAnchor="end" className="axis">{money(t)}</text>
              </g>
            ))}
            {WEEKS.map((wk, i) => ((i % 2 === 0 && i < n - 2) || i === n - 1) && (
              <text key={wk} x={x(i)} y={H - 10} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="axis">{wk}</text>
            ))}
            <path d={area} fill="url(#ri-area)" />
            <line x1={x(sel)} x2={x(sel)} y1={T} y2={H - B} className="cross" />
            {you && <path d={youLine} className="pline you" />}
            {you && <circle cx={x(sel)} cy={y(you[sel])} r="5" className="pt you" />}
            <path d={line} className={`pline ${tone}`} />
            {vals.map((v, i) => {
              const moved = i > 0 && v !== vals[i - 1];
              return <circle key={i} cx={x(i)} cy={y(v)} r={i === sel ? 7 : moved ? 5 : 3.5} className={`pt ${tone} ${i === sel ? 'sel' : ''} ${moved ? 'moved' : ''}`} />;
            })}
            {vals.map((_, i) => (
              <rect key={`hit${i}`} x={x(i) - (W - L - R) / (n - 1) / 2} y={T} width={(W - L - R) / (n - 1)} height={H - T - B}
                className="hit" onClick={() => setSel(i)} onMouseEnter={() => setSel(i)} />
            ))}
          </svg>
        </div>

        <dl className="ri-facts">
          <div><dt>8 weeks ago</dt><dd>{fmt(first)}</dd></div>
          <div><dt>Now</dt><dd>{fmt(last)}</dd></div>
          <div><dt>Price changes</dt><dd>{changes} in 8 weeks</dd></div>
          <div><dt>Biggest move</dt><dd>{biggest.d ? `${biggest.d < 0 ? '▼' : '▲'} ${money(Math.abs(biggest.d))}, week of ${WEEKS[biggest.i]}` : 'None'}</dd></div>
        </dl>

        <span className="ri-eyebrow">Week by week</span>
        <div className="ri-table-wrap">
          <table className="ri-table ri-weeks">
            <thead><tr><th>Week of</th><th className="num">{you ? 'Them' : 'Price'}</th>{you && <th className="num">You</th>}<th className="num">Change</th></tr></thead>
            <tbody>
              {vals.map((v, i) => {
                const d = i ? v - vals[i - 1] : 0;
                return (
                  <tr key={i} className={i === sel ? 'home' : ''} onClick={() => setSel(i)}>
                    <td>{WEEKS[i]}</td>
                    <td className="num">{fmt(v)}</td>
                    {you && <td className="num">{fmt(you[i])}</td>}
                    <td className="num">{i === 0 ? '–' : d === 0 ? 'no change' : `${d < 0 ? '▼' : '▲'} ${money(Math.abs(d))}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function TrendsView({ events, crossMedia, allEvents, watchlist, toggleWatch, onAdvertiser, ...filters }) {
  const [chart, setChart] = useState(null);
  const { market, category, media } = filters;
  const [cell, setCell] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const grid = useMemo(() => heatGrid(market, category, media), [market, category, media]);
  const flat = grid.flat();
  const max = Math.max(...flat);
  let peak = { d: 0, h: 0, v: 0 };
  grid.forEach((row, d) => row.forEach((v, h) => { if (v > peak.v) peak = { d, h, v }; }));
  const level = (v) => Math.min(4, Math.floor((v / (max || 1)) * 5));

  const sov = useMemo(() => {
    const by = new Map();
    for (const d of events) {
      const k = d.creative.advertiser;
      const cur = by.get(k) || { name: k, cat: d.creative.category, spins: 0, spend: 0, stations: new Set(), offer: d.creative.offer.headline };
      cur.spins += 1; cur.spend += d.estCost; cur.stations.add(d.station.id);
      by.set(k, cur);
    }
    return [...by.values()].sort((a, b) => b.spend - a.spend);
  }, [events]);
  const total = sov.reduce((a, r) => a + r.spend, 0) || 1;
  const maxSpend = sov[0]?.spend || 1;

  const wow = weekOverWeek(sov.map((r) => r.name)).map((r) => ({ ...r, pct: (r.now - r.last) / r.last }));
  const rising = [...wow].sort((a, b) => b.pct - a.pct).slice(0, 5);
  const falling = [...wow].sort((a, b) => a.pct - b.pct).slice(0, 3).filter((r) => r.pct < 0);

  const prices = PRICE_HISTORY.filter((p) => market === 'All' || p.market === market);

  const share = useMemo(() => {
    const counts = {};
    const totals = {};
    for (const d of allEvents) {
      const m = d.station.market; const c = d.creative.category;
      counts[`${m}|${c}`] = (counts[`${m}|${c}`] || 0) + 1;
      totals[m] = (totals[m] || 0) + 1;
    }
    return { counts, totals };
  }, [allEvents]);
  const shareMax = Math.max(...MARKETS.flatMap((m) => CATEGORIES.map((c) => (share.counts[`${m}|${c}`] || 0) / (share.totals[m] || 1))));

  return (
    <>
      <Filters {...filters} showSearch={false} showAdvanced={false} />

      <RadioVsTv crossMedia={crossMedia} market={market} />

      <div className="ri-section-head">
        <h2>When ads run{media !== 'Both' ? ` on ${media}` : ''}</h2>
        <span className="ri-count">spots per hour · last 7 days</span>
      </div>
      <div className="ri-panel">
        <p className="ri-callout">
          {cell
            ? <><b>{DAYS[cell.d]} {hourLabel(cell.h)}</b>: {grid[cell.d][cell.h].toLocaleString('en-US')} spots</>
            : <>Busiest hour: <b>{DAYS[peak.d]} {hourLabel(peak.h)}</b>, {peak.v.toLocaleString('en-US')} spots. Tap any cell.</>}
        </p>
        <div className="ri-heat-scroll">
          <div className="ri-heat" role="grid" aria-label="Ad volume by day and hour">
            <span />
            {Array.from({ length: 24 }, (_, h) => <span key={h} className="hh">{h % 6 === 0 ? hourLabel(h).replace(' ', '') : ''}</span>)}
            {grid.map((row, d) => (
              <React.Fragment key={d}>
                <span className="dd">{DAYS[d]}</span>
                {row.map((v, h) => (
                  <button key={h} type="button" className={`c l${level(v)} ${cell && cell.d === d && cell.h === h ? 'sel' : ''}`}
                    onClick={() => setCell({ d, h })} aria-label={`${DAYS[d]} ${hourLabel(h)}: ${v} spots`} />
                ))}
              </React.Fragment>
            ))}
          </div>
        </div>
        <div className="ri-legend"><span>Fewer</span>{[0, 1, 2, 3, 4].map((l) => <i key={l} className={`c l${l}`} />)}<span>More</span></div>
      </div>

      <div className="ri-section-head"><h2>Price moves</h2><span className="ri-count">8 weeks, {WEEKS[0]} to {WEEKS[WEEKS.length - 1]}</span></div>
      {prices.length === 0 && <p className="ri-empty">No tracked price history in this market yet.</p>}
      <ul className="ri-prices">
        {prices.map((p) => {
          const first = p.values[0]; const last = p.values[p.values.length - 1];
          const fmt = (v) => `${money(v)}${p.unit}`;
          return (
            <li key={p.advertiser + p.product}>
              <div className="body">
                <button type="button" className="ri-link" onClick={() => onAdvertiser(p.advertiser)}>{p.advertiser}</button>
                <span className="muted small">{p.product} · {p.market}</span>
                <span className="move"><s>{fmt(first)}</s> → <b>{fmt(last)}</b></span>
              </div>
              <button type="button" className="ri-spark-btn" onClick={() => setChart(p)} aria-label={`Open ${p.advertiser} price chart`}>
                <Sparkline values={p.values} lowerIsBetter={p.lowerIsBetter} />
                <span className="ri-spark-hint">Tap for chart</span>
              </button>
            </li>
          );
        })}
      </ul>
      {chart && <PriceChartSheet h={chart} onClose={() => setChart(null)} />}

      <div className="ri-section-head"><h2>Rising and falling</h2><span className="ri-count">spots this week vs last</span></div>
      <ul className="ri-wow">
        {rising.map((r) => (
          <li key={r.name}><button type="button" className="ri-link" onClick={() => onAdvertiser(r.name)}>{r.name}</button><span className="up">▲ {Math.round(r.pct * 100)}%</span><span className="muted">{r.last} → {r.now}</span></li>
        ))}
        {falling.map((r) => (
          <li key={r.name}><button type="button" className="ri-link" onClick={() => onAdvertiser(r.name)}>{r.name}</button><span className="down">▼ {Math.round(-r.pct * 100)}%</span><span className="muted">{r.last} → {r.now}</span></li>
        ))}
      </ul>

      <div className="ri-section-head"><h2>Category share by market</h2><span className="ri-count">% of each market's spots</span></div>
      <div className="ri-table-wrap">
        <table className="ri-table ri-share">
          <thead><tr><th>Category</th>{MARKETS.map((m) => <th key={m} className="num">{m}</th>)}</tr></thead>
          <tbody>
            {CATEGORIES.map((c) => (
              <tr key={c}>
                <td>{c}</td>
                {MARKETS.map((m) => {
                  const v = (share.counts[`${m}|${c}`] || 0) / (share.totals[m] || 1);
                  return <td key={m} className="num" style={{ background: `rgba(0, 229, 153, ${(0.04 + (v / (shareMax || 1)) * 0.4).toFixed(3)})` }}>{(v * 100).toFixed(0)}%</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="ri-section-head">
        <h2>Share of voice by spend</h2>
        <span className="ri-count">{sov.length} advertisers · {money(total)}</span>
      </div>
      <ol className="ri-sov">
        {(showAll ? sov : sov.slice(0, 10)).map((r, i) => (
          <li key={r.name}>
            <span className="rank">{i + 1}</span>
            <div className="body">
              <div className="top">
                <button type="button" className="ri-link" onClick={() => onAdvertiser(r.name)}>{r.name}</button>
                <span className="pct">{((r.spend / total) * 100).toFixed(1)}%</span>
              </div>
              <div className="bar"><span style={{ width: `${(r.spend / maxSpend) * 100}%` }} /></div>
              <div className="sub"><span>{r.cat}</span><span>{r.spins} spins</span><span>{r.stations.size} stations</span><span>{money(r.spend)}</span></div>
              <p className="offer">{r.offer}</p>
            </div>
            <button type="button" className={`ri-star ${watchlist.includes(r.name) ? 'on' : ''}`} onClick={() => toggleWatch(r.name)}
              aria-pressed={watchlist.includes(r.name)} aria-label={`Watch ${r.name}`}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" /></svg>
            </button>
          </li>
        ))}
      </ol>
      {sov.length > 10 && (
        <button type="button" className="ri-more" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show top 10' : `Show all ${sov.length}`}</button>
      )}
    </>
  );
}

// ------------------------------------------------------------------ stations

// Head to head: the home station against any rival in the same market and media.
function HeadToHead({ events, home, hours, onAdvertiser }) {
  const [rivalId, setRivalId] = useState(null);
  const stats = useMemo(() => {
    const m = new Map();
    for (const d of events) {
      if (d.station.market !== home.market || d.station.media !== home.media) continue;
      const cur = m.get(d.station.id) || { spots: 0, secs: 0, spend: 0, advs: new Set() };
      cur.spots += 1; cur.secs += d.creative.length; cur.spend += d.estCost; cur.advs.add(d.creative.advertiser);
      m.set(d.station.id, cur);
    }
    return m;
  }, [events, home]);
  const empty = { spots: 0, secs: 0, spend: 0, advs: new Set() };
  const peers = STATIONS.filter((s) => s.market === home.market && s.media === home.media);
  const ranked = [...peers].sort((a, b) => (stats.get(b.id) || empty).spend - (stats.get(a.id) || empty).spend);
  const rivals = ranked.filter((s) => s.id !== home.id);
  const rival = rivals.find((s) => s.id === rivalId) || rivals[0];
  if (!rival) return null;
  const me = stats.get(home.id) || empty;
  const them = stats.get(rival.id) || empty;
  const rank = ranked.findIndex((s) => s.id === home.id) + 1;

  const metrics = [
    ['Est. ad revenue', me.spend, them.spend, money],
    ['Spots per hour', me.spots / hours, them.spots / hours, (v) => v.toFixed(1)],
    ['Ad minutes per hour', me.secs / 60 / hours, them.secs / 60 / hours, (v) => v.toFixed(1)],
    ['Advertisers', me.advs.size, them.advs.size, (v) => String(v)],
    ['Avg. est. $ per spot', me.spots ? me.spend / me.spots : 0, them.spots ? them.spend / them.spots : 0, money],
  ];
  const wins = metrics.filter(([, a, b]) => a > b).length;
  const onlyThem = [...them.advs].filter((a) => !me.advs.has(a));
  const onlyMe = [...me.advs].filter((a) => !them.advs.has(a));
  const both = [...me.advs].filter((a) => them.advs.has(a));

  return (
    <>
      <div className="ri-section-head"><h2>Head to head</h2><span className="ri-count">last {hours.toFixed(1)} hrs</span></div>
      <div className="ri-panel ri-h2h">
        <div className="ri-h2h-pick">
          <span className="me">{home.call}</span>
          <span className="vs">vs</span>
          <select id="ri-rival" value={rival.id} onChange={(e) => setRivalId(e.target.value)} aria-label="Compare with">
            {rivals.map((s) => <option key={s.id} value={s.id}>{s.call} {s.network || s.band}</option>)}
          </select>
        </div>
        <p className="ri-callout">
          {home.call} ranks <b>#{rank} of {peers.length}</b> {home.market} {home.media === 'TV' ? 'TV' : 'radio'} stations by est. ad revenue, and leads {rival.call} on <b>{wins} of {metrics.length}</b>.
        </p>
        <div className="ri-media-legend" aria-hidden="true"><span><i className="sw me" />{home.call}</span><span><i className="sw them" />{rival.call}</span></div>
        <ul className="ri-h2h-rows">
          {metrics.map(([label, a, b, f]) => {
            const max = Math.max(a, b) || 1;
            return (
              <li key={label}>
                <span className="lbl">{label}</span>
                <div className="pair">
                  <span className="track"><span className="bar me" style={{ width: `${(a / max) * 100}%` }} /></span>
                  <span className={`val ${a >= b ? 'lead' : ''}`}>{f(a)}</span>
                  <span className="track"><span className="bar them" style={{ width: `${(b / max) * 100}%` }} /></span>
                  <span className={`val ${b > a ? 'lead' : ''}`}>{f(b)}</span>
                </div>
              </li>
            );
          })}
        </ul>
        <dl className="ri-facts">
          <div><dt>On both</dt><dd>{both.length} advertisers</dd></div>
          <div><dt>Only on {home.call}</dt><dd>{onlyMe.length}</dd></div>
          <div className="wide"><dt>Only on {rival.call}: pitch them</dt><dd>{onlyThem.length ? onlyThem.slice(0, 6).map((a, i) => (
            <React.Fragment key={a}>{i ? ', ' : ''}<button type="button" className="ri-link" onClick={() => onAdvertiser(a)}>{a}</button></React.Fragment>
          )) : 'None'}</dd></div>
        </dl>
      </div>
    </>
  );
}

function StationsView({ events, now, onAdvertiser }) {
  const [home, setHome] = useState(() => store('ri.home', 'KISW'));
  useEffect(() => save('ri.home', home), [home]);
  const homeStation = STATIONS.find((s) => s.id === home) || STATIONS[0];
  const hours = useMemo(() => Math.max(1, (now - events[events.length - 1].ts) / 3600000), [events, now]);

  const perStation = useMemo(() => {
    const m = new Map();
    for (const d of events) {
      const cur = m.get(d.station.id) || { spots: 0, secs: 0, spend: 0, last: 0 };
      cur.spots += 1; cur.secs += d.creative.length; cur.spend += d.estCost; cur.last = Math.max(cur.last, d.ts);
      m.set(d.station.id, cur);
    }
    return m;
  }, [events]);

  const marketRows = MARKETS.map((mk) => {
    const st = STATIONS.filter((s) => s.market === mk);
    const agg = st.reduce((a, s) => {
      const p = perStation.get(s.id);
      if (p) { a.spots += p.spots; a.spend += p.spend; }
      return a;
    }, { spots: 0, spend: 0 });
    return {
      mk, stations: st.length, fm: st.filter((s) => s.band === 'FM').length, am: st.filter((s) => s.band === 'AM').length,
      tv: st.filter((s) => s.media === 'TV').length, online: st.filter((s) => s.status === 'live').length, ...agg,
    };
  });

  const leads = useMemo(() => {
    const onHome = new Set(events.filter((d) => d.station.id === home).map((d) => d.creative.advertiser));
    const by = new Map();
    for (const d of events) {
      if (d.station.market !== homeStation.market || d.station.id === home || d.station.media !== homeStation.media) continue;
      const k = d.creative.advertiser;
      if (onHome.has(k)) continue;
      const cur = by.get(k) || { name: k, cat: d.creative.category, spins: 0, spend: 0, stations: new Set(), offer: d.creative.offer.headline, phone: d.creative.offer.phone };
      cur.spins += 1; cur.spend += d.estCost; cur.stations.add(d.station.id);
      by.set(k, cur);
    }
    return [...by.values()].sort((a, b) => b.spend - a.spend);
  }, [events, home, homeStation]);
  const leadTotal = leads.reduce((a, l) => a + l.spend, 0);

  // TV-only advertisers: spending on TV in this market but on no radio station at all. Pitch them radio.
  const tvOnly = useMemo(() => {
    if (homeStation.media !== 'Radio') return [];
    const onRadio = new Set(events.filter((d) => d.station.market === homeStation.market && d.station.media === 'Radio').map((d) => d.creative.advertiser));
    const by = new Map();
    for (const d of events) {
      if (d.station.market !== homeStation.market || d.station.media !== 'TV' || onRadio.has(d.creative.advertiser)) continue;
      const k = d.creative.advertiser;
      const cur = by.get(k) || { name: k, cat: d.creative.category, spins: 0, spend: 0, stations: new Set(), offer: d.creative.offer.headline, phone: d.creative.offer.phone };
      cur.spins += 1; cur.spend += d.estCost; cur.stations.add(d.station.id);
      by.set(k, cur);
    }
    return [...by.values()].sort((a, b) => b.spend - a.spend);
  }, [events, homeStation]);
  const tvOnlyTotal = tvOnly.reduce((a, l) => a + l.spend, 0);

  const marketStations = STATIONS.filter((s) => s.market === homeStation.market)
    .map((s) => ({ s, p: perStation.get(s.id) || { spots: 0, secs: 0, spend: 0, last: 0 } }))
    .sort((a, b) => b.p.spend - a.p.spend);

  return (
    <>
      <div className="ri-home">
        <label htmlFor="ri-home">Your station</label>
        <select id="ri-home" value={home} onChange={(e) => setHome(e.target.value)}>
          <optgroup label="Seattle TV">
            {TV_STATIONS.map((s) => <option key={s.id} value={s.id}>{s.call} {s.network}</option>)}
          </optgroup>
          {MARKETS.map((mk) => (
            <optgroup key={mk} label={`${mk} radio`}>
              {STATIONS.filter((s) => s.market === mk && s.media === 'Radio').map((s) => <option key={s.id} value={s.id}>{s.call} {s.band}</option>)}
            </optgroup>
          ))}
        </select>
      </div>

      <HeadToHead key={home} events={events} home={homeStation} hours={hours} onAdvertiser={onAdvertiser} />

      <div className="ri-section-head">
        <h2>Sales leads for {homeStation.call}</h2>
        <span className="ri-count">on competitors, not on you</span>
      </div>
      <p className="ri-lead-total">
        <b>{money(leadTotal)}</b> in estimated {homeStation.market} {homeStation.media === 'TV' ? 'TV' : 'radio'} spend over the last {hours.toFixed(1)} hrs went to competing stations from {leads.length} advertisers who are not buying {homeStation.call}.
      </p>
      <ul className="ri-leads">
        {leads.slice(0, 12).map((l) => (
          <li key={l.name}>
            <div className="top">
              <button type="button" className="ri-link" onClick={() => onAdvertiser(l.name)}>{l.name}</button>
              <b>{money(l.spend)}</b>
            </div>
            <p className="offer">{l.offer}</p>
            <div className="sub">
              <span>{l.cat}</span><span>{l.spins} spins on {l.stations.size} stations</span>
              {l.phone && <span className="mono">{l.phone}</span>}
            </div>
          </li>
        ))}
      </ul>

      {tvOnly.length > 0 && (
        <>
          <div className="ri-section-head">
            <h2>On TV, not on radio <span className="ri-premium">TV Premium</span></h2>
            <span className="ri-count">pitch them radio</span>
          </div>
          <p className="ri-lead-total">
            <b className="tv">{money(tvOnlyTotal)}</b> in estimated {homeStation.market} TV spend over the last {hours.toFixed(1)} hrs came from {tvOnly.length} advertisers who buy no radio at all. Every one is a new radio prospect.
          </p>
          <ul className="ri-leads tv">
            {tvOnly.map((l) => (
              <li key={l.name}>
                <div className="top">
                  <button type="button" className="ri-link" onClick={() => onAdvertiser(l.name)}>{l.name}</button>
                  <b>{money(l.spend)}</b>
                </div>
                <p className="offer">{l.offer}</p>
                <div className="sub">
                  <span>{l.cat}</span><span>{l.spins} TV spots on {l.stations.size} stations</span>
                  {l.phone && <span className="mono">{l.phone}</span>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="ri-section-head"><h2>Coverage</h2><span className="ri-count">{STATIONS.length} commercial stations monitored</span></div>
      <div className="ri-table-wrap">
        <table className="ri-table">
          <thead><tr><th>Market</th><th className="num">Stations</th><th className="num">FM / AM / TV</th><th className="num">Online</th><th className="num">Spots</th><th className="num">Est. $</th></tr></thead>
          <tbody>
            {marketRows.map((r) => (
              <tr key={r.mk} className={r.mk === homeStation.market ? 'home' : ''}>
                <td><b>{r.mk}</b></td>
                <td className="num">{r.stations}</td>
                <td className="num">{r.fm} / {r.am} / {r.tv || '–'}</td>
                <td className="num">{r.online}</td>
                <td className="num">{r.spots.toLocaleString('en-US')}</td>
                <td className="num">{money(r.spend)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="ri-section-head"><h2>{homeStation.market} stream monitor</h2><span className="ri-count">{marketStations.length} streams</span></div>
      <div className="ri-table-wrap">
        <table className="ri-table">
          <thead><tr><th>Station</th><th>Status</th><th className="num">Spots/hr</th><th className="num">Ad min/hr</th><th className="num">Est. $</th><th>Last spot</th></tr></thead>
          <tbody>
            {marketStations.map(({ s, p }) => (
              <tr key={s.id} className={s.id === home ? 'home' : ''}>
                <td><b>{s.call}</b> <span className="muted">{s.network || s.band}</span></td>
                <td><span className={`ri-status ${s.status}`} title={s.note || ''}>{s.status === 'live' ? 'Live' : 'Degraded'}</span></td>
                <td className="num">{(p.spots / hours).toFixed(1)}</td>
                <td className="num">{(p.secs / 60 / hours).toFixed(1)}</td>
                <td className="num">{money(p.spend)}</td>
                <td className="muted">{p.last ? ago(p.last, now) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {STATIONS.filter((s) => s.note).map((s) => (
        <p key={s.id} className="ri-note"><span className="ri-status degraded">Degraded</span> {s.call} ({s.market}): {s.note}. Spots may be missed until it recovers.</p>
      ))}
      <p className="muted small">Radio call signs and frequencies come from public market lists (full-power commercial band). Seattle TV is the 8 main broadcast stations. Spot counts, spend and stream status are simulated for this demo.</p>
    </>
  );
}

// ------------------------------------------------------------------ export

function ExportView({ rows, market, category, query, media, watchlist, toggleWatch, alertsOn, setAlertsOn, notify }) {
  const scope = [media === 'Both' ? 'Radio + TV' : media, market === 'All' ? 'All markets' : market, category === 'All' ? 'all categories' : category, query && `"${query}"`].filter(Boolean).join(', ');
  const feedUrl = `https://api.radiointel.network/v1/feed.csv?market=${market === 'All' ? 'all' : encodeURIComponent(market.toLowerCase())}&key=YOUR_CLIENT_KEY`;
  const formula = `=IMPORTDATA("${feedUrl}")`;

  const copyRows = async () => {
    const ok = await copyText(toTSV(rows));
    notify(ok ? `Copied ${rows.length.toLocaleString('en-US')} rows` : 'Copy failed', ok ? 'Open Google Sheets, tap cell A1, and paste.' : 'Your browser blocked clipboard access.');
  };
  const copyFormula = async () => {
    const ok = await copyText(formula);
    notify(ok ? 'Formula copied' : 'Copy failed', ok ? 'Paste it into cell A1 of a new Google Sheet.' : 'Select the formula and copy it manually.');
  };

  return (
    <>
      <div className="ri-section-head"><h2>Send to Google Sheets</h2></div>
      <div className="ri-panel">
        <p>Exports the spots that match your current filters: <b>{scope}</b>. That is <b>{rows.length.toLocaleString('en-US')} rows</b> with {EXPORT_COLUMNS.length} columns each, including lease payment, money due, term and APR as numbers.</p>
        <div className="ri-sheet-actions">
          <button type="button" className="ri-btn primary" onClick={copyRows}>Copy rows for Sheets</button>
          {!IS_PREVIEW && <button type="button" className="ri-btn" onClick={() => downloadCSV(rows)}>Download CSV</button>}
        </div>
        {IS_PREVIEW && <p className="muted small">CSV download works in the installed app. In this preview, copy the rows and paste them into Sheets.</p>}
      </div>

      <div className="ri-section-head"><h2>Watchlist alerts</h2><span className="ri-count">{watchlist.length} watched</span></div>
      <div className="ri-panel">
        <label className="ri-switch">
          <input id="ri-alerts" type="checkbox" checked={alertsOn} onChange={(e) => setAlertsOn(e.target.checked)} />
          <span>Show an alert when a watched advertiser airs (at most one every 45 seconds)</span>
        </label>
        <div className="ri-chips">
          {watchlist.length === 0 && <span className="muted">Nobody watched yet. Star advertisers on the Trends tab.</span>}
          {watchlist.map((w) => (
            <button key={w} type="button" className="ri-chip" onClick={() => toggleWatch(w)} aria-label={`Remove ${w}`}>{w} <span aria-hidden="true">×</span></button>
          ))}
        </div>
      </div>

      <div className="ri-section-head"><h2>Live feed for client sheets</h2><span className="tag amber">Needs API</span></div>
      <div className="ri-panel">
        <p>Each client gets a private feed URL. This formula in a Google Sheet pulls new detections on its own.</p>
        <code className="ri-code">{formula}</code>
        <button type="button" className="ri-btn" onClick={copyFormula}>Copy formula</button>
        <p className="muted small">Google refreshes IMPORTDATA about once an hour. For minute-by-minute rows, the backend writes into the client's sheet through the Sheets API.</p>
      </div>

      <div className="ri-section-head"><h2>Columns in every export</h2></div>
      <div className="ri-chips">
        {EXPORT_COLUMNS.map(([name]) => <span key={name} className="ri-chip static">{name}</span>)}
      </div>

      <div className="ri-section-head"><h2>How a spot becomes a row</h2></div>
      <ol className="ri-pipeline">
        <li><b>Capture</b><span>Record every commercial station around the clock, by stream and over the air.</span></li>
        <li><b>Detect</b><span>Find ad breaks and fingerprint each spot so repeats match instantly.</span></li>
        <li><b>Transcribe</b><span>Speech-to-text on each new creative, including the fast-read fine print.</span></li>
        <li><b>Extract the offer</b><span>AI fills in price, vehicle, payment, money down, term, APR, promo code, expiry, phone and URL.</span></li>
        <li><b>Deliver</b><span>The spot lands in the live feed, the alerts and the client's Google Sheet.</span></li>
      </ol>
    </>
  );
}
