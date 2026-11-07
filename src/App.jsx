import React, { useState, useEffect, useMemo, useRef } from 'react';
import './App.css';
import {
  HOME_MARKET, MARKETS, STATIONS, TV_STATIONS, CATEGORIES, DAYPARTS, TV_DAYPARTS, OFFER_CHANGES, PRICE_HISTORY, WEEKS, DAYS, EXPORT_COLUMNS,
  CREATIVES, MARKET_MOVES, CITIES_BY_MARKET, cityOf,
  seedDetections, makeDetection, heatGrid, weekOverWeek, toTSV, toCSV,
} from './data.js';
import { WEB_CAPTURED, WEB_SITES, WEB_OFFERS } from './webdeals.js';
import { ROSTER } from './roster.js';

const IS_PREVIEW = typeof window !== 'undefined' && !!window.__RI_PREVIEW__;
const LIVE_INTERVAL_MS = 4000;
const FEED_PAGE = 40;
const ALERT_GAP_MS = 45000;
const WINDOW_MS = 3 * 3600 * 1000;
// Every spend number names its period. The demo only holds a rolling 3-hour window.
const PERIOD = `last ${WINDOW_MS / 3600000} hrs`;

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

// ------------------------------------------------------------------ deal analysis
// We only judge what the ads prove: whose deal is better for a shopper, and who is
// buying more or less airtime. We never guess a dealer's profit.

// True monthly cost: the payment plus the money due at signing, spread over the term.
const trueMonthly = (a) => (a && a.monthly ? a.monthly + (a.due || 0) / (a.term || 36) : null);

// An advertiser's current car deal (radio version first).
function dealOf(name) {
  const list = CREATIVES.filter((c) => c.advertiser === name && c.auto);
  return list.find((c) => c.media === 'Radio') || list[0] || null;
}

// Them vs you on the current deal. Same market and same kind of deal only, otherwise null.
// status: 'them' = their deal beats yours, 'you' = yours is better, 'even' = within a few dollars.
function compareDeals(themName, meName) {
  if (!meName || themName === meName) return null;
  const t = dealOf(themName); const y = dealOf(meName);
  if (!t || !y || t.market !== y.market) return null;
  const ta = t.auto; const ya = y.auto;
  const tTrue = trueMonthly(ta); const yTrue = trueMonthly(ya);
  if (tTrue && yTrue) {
    const gap = Math.round(yTrue - tTrue); // above 0 = they're cheaper
    const status = Math.abs(gap) < 5 ? 'even' : gap > 0 ? 'them' : 'you';
    const side = (a, tr) => ({ veh: a.vehicle, big: `${money(a.monthly)}/mo`, sub: `${money(a.due)} due · ${a.term} mo`, tru: `${money(tr)}/mo true cost` });
    return {
      status, gap: Math.abs(gap), sameBody: ta.body === ya.body, them: side(ta, tTrue), you: side(ya, yTrue),
      short: status === 'them' ? `Beats you by ${money(gap)}/mo` : status === 'you' ? `You’re ${money(-gap)}/mo cheaper` : 'About even with you',
    };
  }
  if (ta.cashOff && ya.cashOff) {
    const gap = ta.cashOff - ya.cashOff; // above 0 = they give more off
    const status = Math.abs(gap) < 250 ? 'even' : gap > 0 ? 'them' : 'you';
    const side = (a) => ({ veh: a.vehicle, big: `${money(a.cashOff)} off`, sub: a.apr != null ? `or ${a.apr}% APR` : a.deal, tru: '' });
    return {
      status, gap: Math.abs(gap), sameBody: ta.body === ya.body, them: side(ta), you: side(ya),
      short: status === 'them' ? `Beats you by ${money(gap)} off` : status === 'you' ? `You give ${money(-gap)} more off` : 'About even with you',
    };
  }
  return null;
}

// Every car deal on air in your market that beats yours right now.
function dealsBeatingMe(meName) {
  const mine = dealOf(meName);
  if (!mine) return [];
  const names = [...new Set(CREATIVES.filter((c) => c.auto && c.market === mine.market).map((c) => c.advertiser))];
  return names.map((n) => ({ name: n, cmp: compareDeals(n, meName) }))
    .filter((x) => x.cmp && x.cmp.status === 'them')
    .sort((a, b) => b.cmp.gap - a.cmp.gap);
}

const MAKES = ['toyota', 'honda', 'ford', 'subaru', 'chevrolet', 'chevy', 'nissan', 'hyundai', 'kia', 'mazda', 'jeep', 'ram', 'gmc', 'bmw', 'lexus',
  'volkswagen', 'vw', 'audi', 'mercedes', 'tesla', 'dodge', 'chrysler', 'buick', 'cadillac', 'acura', 'infiniti', 'volvo', 'mitsubishi'];

// Closest competitors for a business: same brand first, then same vehicle class, then the rest of its category, same market.
function rivalsFor(name, limit = 4) {
  const mine = dealOf(name) || CREATIVES.find((c) => c.advertiser === name);
  if (!mine) return [];
  const make = MAKES.find((m) => name.toLowerCase().split(/\W+/).includes(m));
  const body = mine.auto?.body;
  const pool = [...new Set(CREATIVES.filter((c) => c.category === mine.category && c.advertiser !== name
    && (!mine.market || !c.market || c.market === mine.market)).map((c) => c.advertiser))];
  const rank = (n) => (make && n.toLowerCase().split(/\W+/).includes(make) ? 0 : body && dealOf(n)?.auto?.body === body ? 1 : 2);
  return pool.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, limit);
}

// Momentum: are they buying more or less airtime than last week, and is their deal getting richer?
function momentumOf(name) {
  const w = weekOverWeek([name])[0];
  const pct = (w.now - w.last) / (w.last || 1);
  const dir = pct >= 0.15 ? 'up' : pct <= -0.15 ? 'down' : 'flat';
  const label = { up: 'Ramping up', down: 'Pulling back', flat: 'Steady' }[dir];
  const h = PRICE_HISTORY.find((p) => p.advertiser === name);
  let deal = null;
  if (h) {
    const d = h.values[h.values.length - 1] - h.values[0];
    deal = d === 0 ? 'same' : (h.lowerIsBetter ? d < 0 : d > 0) ? 'richer' : 'weaker';
  }
  let read;
  if (deal === 'richer' && dir === 'up') read = 'Making a push: a richer deal and more airtime.';
  else if (deal === 'richer' && dir === 'down') read = 'Richer deal but less airtime. They may be clearing stock.';
  else if (deal === 'richer') read = 'Richer deal on steady airtime.';
  else if (dir === 'up') read = 'Buying more airtime this week.';
  else if (dir === 'down') read = 'Quieter this week. Room to grab attention.';
  else read = 'Steady airtime, no big change.';
  return { pct, dir, label, last: w.last, now: w.now, read };
}

function MomentumChip({ m }) {
  return (
    <span className={`ri-mo ${m.dir}`} title={`${m.last} spots last week, ${m.now} this week`}>
      {m.dir === 'up' ? '▲' : m.dir === 'down' ? '▼' : '■'} {m.label} {m.dir !== 'flat' && <small>{m.pct > 0 ? '+' : ''}{Math.round(m.pct * 100)}% spots</small>}
    </span>
  );
}

// Where and when someone is buying: top stations and dayparts by share of their spots.
function mixOf(evs) {
  const count = (key) => {
    const m = new Map();
    for (const d of evs) m.set(key(d), (m.get(key(d)) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ k, pct: Math.round((v / (evs.length || 1)) * 100) }));
  };
  return { stations: count((d) => d.station.id).slice(0, 3), dayparts: count((d) => d.daypart).slice(0, 2) };
}

function VsBadge({ cmp }) {
  if (!cmp) return null;
  return <span className={`ri-vs-badge ${cmp.status}`}>{cmp.status === 'them' ? '⚠ ' : cmp.status === 'you' ? '✓ ' : ''}{cmp.short}</span>;
}

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
  const [city, setCity] = useState('All');
  const [media, setMedia] = useState('Radio');
  const [query, setQuery] = useState('');
  const [adv, setAdv] = useState(DEFAULT_ADV);
  const [selected, setSelected] = useState(null);
  const [watchlist, setWatchlist] = useState(() => store('ri.watchlist.v3', ['Rainier Honda', 'Cascade Ford', 'Emerald City Subaru']));
  const [alertsOn, setAlertsOn] = useState(() => store('ri.alerts', true));
  const [beatAlerts, setBeatAlerts] = useState(() => store('ri.beatAlerts', true));
  // The client's own company. Every "vs you" comparison in the app is against it.
  const [me, setMe] = useState(() => store('ri.me.v1', 'Puget Sound Toyota'));
  const [toast, setToast] = useState(null);
  const watchRef = useRef(watchlist);
  const alertsRef = useRef(alertsOn);
  const beatRef = useRef(beatAlerts);
  const meRef = useRef(me);
  const lastAlert = useRef(0);
  watchRef.current = watchlist;
  alertsRef.current = alertsOn;
  beatRef.current = beatAlerts;
  meRef.current = me;

  useEffect(() => save('ri.watchlist.v3', watchlist), [watchlist]);
  useEffect(() => save('ri.alerts', alertsOn), [alertsOn]);
  useEffect(() => save('ri.beatAlerts', beatAlerts), [beatAlerts]);
  useEffect(() => save('ri.me.v1', me), [me]);
  useEffect(() => save('ri.market', market), [market]);
  // A city belongs to one metro, so changing the market clears it.
  useEffect(() => { if (city !== 'All' && market !== 'All' && !(CITIES_BY_MARKET[market] || []).includes(city)) setCity('All'); }, [market, city]);

  // Simulated real-time ingest across ~200 stations.
  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(() => {
      const ts = Date.now();
      // Same pace as the 3-hour history: about one radio spot every 25 seconds.
      const batch = Math.random() < 0.16 ? [makeDetection(Math.random, ts)] : [];
      if (Math.random() < 0.025) batch.push(makeDetection(Math.random, ts, 'TV'));
      setNow(ts);
      // True rolling window: spots older than 3 hours drop off.
      setEvents((prev) => [...batch, ...prev].filter((d) => d.ts > ts - WINDOW_MS).slice(0, 9000));
      if (ts - lastAlert.current > ALERT_GAP_MS) {
        // A deal that beats yours outranks a plain "they aired" alert.
        const beat = beatRef.current && batch.map((d) => ({ d, cmp: compareDeals(d.creative.advertiser, meRef.current) })).find((x) => x.cmp?.status === 'them');
        const hit = alertsRef.current && batch.find((d) => watchRef.current.includes(d.creative.advertiser));
        if (beat) {
          lastAlert.current = ts;
          setToast({ kind: 'threat', text: `${beat.d.creative.advertiser} just aired a deal that beats yours`, sub: `${beat.cmp.short} · ${beat.d.station.call}`, detection: beat.d });
        } else if (hit) {
          lastAlert.current = ts;
          setToast({ kind: 'alert', text: `${hit.creative.advertiser} just aired on ${hit.station.call}`, sub: hit.creative.offer.headline, detection: hit });
        }
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
      if (city !== 'All' && c.city !== city) return false;
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
      return [c.advertiser, c.city, d.station.market, d.station.call, o.headline, o.product, o.price, c.category, o.promoCode]
        .some((v) => v && String(v).toLowerCase().includes(q));
    });
  }, [events, market, category, city, query, adv]);
  const filtered = useMemo(
    () => (media === 'Both' ? crossMedia : crossMedia.filter((d) => d.station.media === media)),
    [crossMedia, media],
  );

  const toggleWatch = (name) =>
    setWatchlist((w) => (w.includes(name) ? w.filter((x) => x !== name) : [...w, name]));
  // Set "you" once at the top and the whole app follows: market, competitors, website deals.
  const chooseMe = (name) => {
    setMe(name);
    const c = dealOf(name) || CREATIVES.find((x) => x.advertiser === name);
    if (c) {
      if (c.market) setMarket(c.market);
      setCategory('All'); setCity('All'); setQuery('');
      setWatchlist(rivalsFor(name));
    }
    if (WEB_SITES.some((s) => s.dealer === name)) save('ri.webme', name);
  };
  const notify = (text, sub) => setToast({ kind: 'info', text, sub });
  const showAdvertiser = (name) => {
    setQuery(name);
    setCategory('All');
    setTab('live');
    window.scrollTo({ top: 0 });
  };

  const filterProps = { market, setMarket, category, setCategory, city, setCity, query, setQuery, adv, setAdv, media, setMedia };

  return (
    <div className="ri-app">
      <Header live={live} setLive={setLive} me={me} chooseMe={chooseMe} watchCount={watchlist.filter((n) => n !== me).length} />

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
            watchlist={watchlist} toggleWatch={toggleWatch} goTo={setTab} me={me} setMe={setMe} {...filterProps} />
        )}
        {tab === 'offers' && <OffersView events={filtered} onAdvertiser={showAdvertiser} me={me} {...filterProps} />}
        {tab === 'trends' && (
          <TrendsView events={filtered} crossMedia={crossMedia} allEvents={events} watchlist={watchlist} toggleWatch={toggleWatch} onAdvertiser={showAdvertiser} me={me} {...filterProps} />
        )}
        {tab === 'web' && <WebDealsView />}
        {tab === 'mix' && <MixView crossMedia={crossMedia} market={market} category={category} me={me} setMe={setMe} onAdvertiser={showAdvertiser} />}
        {tab === 'stations' && <StationsView events={events} now={now} onAdvertiser={showAdvertiser} onOpen={setSelected} />}
        {tab === 'export' && (
          <ExportView rows={filtered} market={market} city={city} category={category} query={query} media={media}
            watchlist={watchlist} toggleWatch={toggleWatch} alertsOn={alertsOn} setAlertsOn={setAlertsOn}
            beatAlerts={beatAlerts} setBeatAlerts={setBeatAlerts} me={me} notify={notify} />
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

// "Insights on": pick any business we know (tap ▾ for the full list) or start typing to filter. A website address works too.
// Three kinds: on air (demo ads), real website deals, and real businesses we watch that haven't been heard yet.
const DIRECTORY = (() => {
  const seen = new Set();
  const out = [];
  const add = (name, group, meta) => { if (!seen.has(name)) { seen.add(name); out.push({ name, group, meta }); } };
  for (const c of CREATIVES) add(c.advertiser, 'air', [c.category, c.city || c.market].filter(Boolean).join(' · '));
  for (const s of WEB_SITES) add(s.dealer, 'web', ['Auto Dealer', s.city].filter(Boolean).join(' · '));
  for (const r of ROSTER) add(r.name, 'watch', [r.category, r.area].filter(Boolean).join(' · '));
  return out.sort((a, b) => a.name.localeCompare(b.name));
})();
const GROUPS = [['air', 'On air now · demo ads'], ['web', 'Website deals · real'], ['watch', 'Watching · no ads heard yet']];

function MeBar({ me, chooseMe, watchCount }) {
  const [text, setText] = useState(me);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const box = useRef(null);
  useEffect(() => setText(me), [me]);
  useEffect(() => {
    if (!open) return undefined;
    const off = (e) => { if (box.current && !box.current.contains(e.target)) { setOpen(false); setText(me); } };
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, [open, me]);

  const q = text.trim().toLowerCase();
  const dom = q.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  const siteHit = dom.includes('.') ? WEB_SITES.find((x) => x.domain.startsWith(dom)) : null;
  const showAll = !q || text === me;
  const list = showAll ? DIRECTORY : DIRECTORY.filter((d) =>
    `${d.name} ${d.meta}`.toLowerCase().includes(q) || (siteHit && d.name === siteHit.dealer));
  const ordered = GROUPS.flatMap(([g]) => list.filter((d) => d.group === g));

  const pick = (name) => {
    setOpen(false);
    setText(name);
    if (name && name !== me) chooseMe(name);
    document.activeElement?.blur();
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, ordered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Escape') { setOpen(false); setText(me); }
  };
  const submit = (e) => {
    e.preventDefault();
    if (showAll) { setOpen(false); document.activeElement?.blur(); return; }
    pick(ordered[hi]?.name || ordered[0]?.name || text.trim());
  };

  const c = dealOf(me) || CREATIVES.find((x) => x.advertiser === me);
  const site = WEB_SITES.find((s) => s.dealer === me);
  const status = c
    ? `${c.category} · ${c.market || 'all markets'} · comparing with ${watchCount} competitor${watchCount === 1 ? '' : 's'}`
    : site ? 'Not heard on air yet · real website deals on the Websites tab'
      : 'Watching · no ads heard yet. Data starts the moment they air.';
  let i = -1;
  return (
    <form className="ri-mebar" onSubmit={submit} role="search" ref={box}>
      <label htmlFor="ri-me-input">Insights on</label>
      <div className="ri-combo">
        <input id="ri-me-input" type="text" value={text} autoComplete="off" enterKeyHint="go"
          placeholder="Type any business or website" role="combobox" aria-expanded={open} aria-controls="ri-me-list"
          onChange={(e) => { setText(e.target.value); setOpen(true); setHi(0); }}
          onFocus={(e) => { e.target.select(); setOpen(true); setHi(0); }} onKeyDown={onKey} />
        <button type="button" className="ri-combo-btn" aria-label="Show every business"
          onClick={() => { setText(me); setOpen(!open); setHi(0); }}>
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        {open && (
          <ul className="ri-combo-list" id="ri-me-list" role="listbox">
            {ordered.length === 0 && (
              <li className="ri-combo-empty">Not in our database yet. Press Go to start watching “{text.trim()}”.</li>
            )}
            {GROUPS.map(([g, label]) => {
              const rows = ordered.filter((d) => d.group === g);
              if (!rows.length) return null;
              return (
                <React.Fragment key={g}>
                  <li className="ri-combo-group" role="presentation">{label} <span>{rows.length}</span></li>
                  {rows.map((d) => {
                    i += 1;
                    const n = i;
                    return (
                      <li key={d.name} role="option" aria-selected={n === hi}
                        className={`ri-combo-opt ${n === hi ? 'hi' : ''} ${d.name === me ? 'cur' : ''}`}
                        onPointerDown={(e) => e.preventDefault()} onClick={() => pick(d.name)} onPointerEnter={() => setHi(n)}>
                        <span className="nm">{d.name}</span><span className="meta">{d.meta}</span>
                      </li>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </ul>
        )}
      </div>
      <span className="ri-mebar-status">{status}</span>
    </form>
  );
}

function Header({ live, setLive, me, chooseMe, watchCount }) {
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
      <MeBar me={me} chooseMe={chooseMe} watchCount={watchCount} />
    </header>
  );
}

const NAV = [
  ['live', 'Live', 'M3 12h3l3-8 4 16 3-8h5'],
  ['offers', 'Offers', 'M20 12l-8 8-9-9V3h8zM7.5 7.5h.01'],
  ['web', 'Websites', 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18'],
  ['trends', 'Trends', 'M3 3v18h18M7 15l4-4 3 3 6-7'],
  ['mix', 'Media', 'M4 5h16v11H4zM8 20h8M12 16v4'],
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

function Filters({ market, setMarket, category, setCategory, city, setCity, query, setQuery, adv, setAdv, media, setMedia, showSearch = true, showAdvanced = true }) {
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
          <input id="ri-search" type="search" placeholder="Search advertiser, city, offer, vehicle, code…" value={query}
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
          {setCity && (
            <select id="ri-city" className="city" value={city} onChange={(e) => setCity(e.target.value)} aria-label="City">
              <option value="All">{market === 'All' ? 'All cities' : `All ${market} metro`}</option>
              {market !== 'All'
                ? (CITIES_BY_MARKET[market] || []).map((ct) => <option key={ct} value={ct}>{ct}</option>)
                : MARKETS.filter((m) => CITIES_BY_MARKET[m]).map((m) => (
                  <optgroup key={m} label={`${m} metro`}>
                    {CITIES_BY_MARKET[m].map((ct) => <option key={ct} value={ct}>{ct}</option>)}
                  </optgroup>
                ))}
            </select>
          )}
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

function Kpis({ events: all, market, media, category, now }) {
  const [hrs, setHrs] = useState(3);
  const events = hrs === 3 ? all : all.filter((d) => d.ts > now - hrs * 3600 * 1000);
  const scope = [market === 'All' ? 'All markets' : market, media === 'Both' ? 'Radio + TV' : media, category !== 'All' && category].filter(Boolean).join(' · ');
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
    <>
      <div className="ri-kpi-head">
        <span>{hrs === 1 ? 'Last hour' : 'Last 3 hours'} · {scope}</span>
        <div className="ri-seg mini" role="radiogroup" aria-label="Time window">
          {[[1, '1 hr'], [3, '3 hrs']].map(([h, l]) => (
            <button key={h} type="button" role="radio" aria-checked={hrs === h} className={hrs === h ? 'on' : ''} onClick={() => setHrs(h)}>{l}</button>
          ))}
        </div>
      </div>
      <section className="ri-kpis" aria-label={`Summary, ${hrs === 1 ? 'last hour' : 'last 3 hours'}`}>
        {items.map(([l, v]) => (
          <div key={l} className="ri-kpi"><span className="v">{v}</span><span className="l">{l}</span></div>
        ))}
      </section>
    </>
  );
}

// "Your competitors right now": one card per watched advertiser, newest offer first.
// Top-of-panel verdict: does any deal on air in your market beat yours right now?
function BeatBanner({ me, watchlist, toggleWatch }) {
  const mine = dealOf(me);
  if (!mine) {
    return <p className="ri-note">Deal-vs-deal checks cover car dealers for now. Airtime, share of voice and momentum work for every category.</p>;
  }
  const beats = dealsBeatingMe(me);
  if (beats.length === 0) {
    return <div className="ri-beat ok"><b>✓ No car deal on air in {mine.market} beats yours right now.</b></div>;
  }
  return (
    <div className="ri-beat threat">
      <b>⚠ {beats.length} deal{beats.length > 1 ? 's' : ''} on air beat{beats.length > 1 ? '' : 's'} yours</b>
      <ul>
        {beats.map(({ name, cmp }) => (
          <li key={name}>
            <span className="nm">{name}</span>
            <span className="muted">{cmp.them.veh} · {cmp.them.big}{cmp.them.tru ? ` · ${cmp.them.tru}` : ''}</span>
            <span className="gap">{cmp.short}</span>
            {!watchlist.includes(name) && <button type="button" className="ri-chip" onClick={() => toggleWatch(name)}>☆ Watch</button>}
          </li>
        ))}
      </ul>
      <p className="muted small">Compared on true monthly cost: the payment plus money due at signing, spread over the term. Vehicles differ, so judge the fit.</p>
    </div>
  );
}

function WatchingPanel({ events, watchlist, toggleWatch, now, onOpen, goTo, me, setMe }) {
  const [chart, setChart] = useState(null);
  // "You" is set in the bar at the top. Rivals to add: same category, same market as you.
  const meCreative = dealOf(me) || CREATIVES.find((c) => c.advertiser === me);
  const rivals = meCreative
    ? [...new Set(CREATIVES.filter((c) => c.category === meCreative.category && c.advertiser !== me
        && (!meCreative.market || !c.market || c.market === meCreative.market)).map((c) => c.advertiser))]
        .filter((n) => !watchlist.includes(n)).sort()
    : [];
  const pickers = (
    <>
      {rivals.length > 0 && (
        <label className="ri-add-rival">
          <span>Compare with</span>
          <select value="" onChange={(e) => e.target.value && toggleWatch(e.target.value)}>
            <option value="">+ Add {/^[aeiou]/i.test(meCreative.category) ? 'an' : 'a'} {meCreative.category.toLowerCase()} competitor…</option>
            {rivals.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}
    </>
  );
  if (watchlist.length === 0) {
    return (
      <>
        {pickers}
        <div className="ri-panel ri-watch-empty">
          <p><b>You’re not comparing against anyone yet.</b></p>
          <p className="muted">Use “Compare with” above, tap ☆ on the Trends tab, or tap “Watch” on any ad.</p>
          <button type="button" className="ri-btn" onClick={() => goTo('trends')}>Pick competitors on Trends</button>
        </div>
      </>
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

  // Your share of voice: your share of all spots in your category and market (current filters, last 3 hrs).
  const myDeal = meCreative;
  const sov = (() => {
    if (!myDeal) return null;
    const pool = events.filter((d) => d.creative.category === myDeal.category && d.station.market === (myDeal.market || d.station.market));
    if (!pool.length) return null;
    const by = new Map();
    for (const d of pool) by.set(d.creative.advertiser, (by.get(d.creative.advertiser) || 0) + 1);
    const ranked = [...by.entries()].sort((a, b) => b[1] - a[1]);
    const idx = ranked.findIndex(([n]) => n === me);
    return { pct: Math.round(((by.get(me) || 0) / pool.length) * 100), rank: idx + 1, of: ranked.length, leader: ranked[0][0], cat: myDeal.category.toLowerCase() };
  })();

  return (
    <>
    {pickers}
    <BeatBanner me={me} watchlist={watchlist} toggleWatch={toggleWatch} />
    <ul className="ri-watch">
      {[meCard, ...cards].map((w) => {
        const isMe = w === meCard;
        const o = w.latest?.creative.offer;
        const fresh = w.latest && now - w.latest.ts < 15 * 60000;
        const cmp = isMe ? null : compareDeals(w.name, me);
        const mo = momentumOf(w.name);
        const mix = mixOf(w.evs);
        const open = () => w.history && setChart({ h: w.history, mine: isMe ? null : meCard.history, own: isMe });
        return (
          <li key={isMe ? `me-${w.name}` : w.name} className={`ri-watch-card ${isMe ? 'me' : cmp?.status === 'them' ? 'threat' : cmp?.status === 'you' ? 'win' : fresh ? 'hot' : ''} ${w.history ? 'tappable' : ''}`}
            onClick={open}>
            <div className="ri-watch-top">
              <span className="nm">{w.name}{cityOf(w.name) && <span className="ri-city"> · {cityOf(w.name)}</span>}</span>
              {isMe ? <span className="ri-you-tag">You</span> : (
                <button type="button" className="ri-star on" onClick={(e) => { e.stopPropagation(); toggleWatch(w.name); }} aria-label={`Stop watching ${w.name}`}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" /></svg>
                </button>
              )}
            </div>
            {cmp && (
              <div className={`ri-vs ${cmp.status}`}>
                <span><small>Them</small><b>{cmp.them.big}</b><em>{cmp.them.sub}</em>{cmp.them.tru && <em>{cmp.them.tru}</em>}</span>
                <span className="v">vs</span>
                <span><small>You</small><b>{cmp.you.big}</b><em>{cmp.you.sub}</em>{cmp.you.tru && <em>{cmp.you.tru}</em>}</span>
                <span className="verdict">{cmp.status === 'them' ? '⚠ ' : cmp.status === 'you' ? '✓ ' : ''}{cmp.short}{cmp.them.tru ? ' (true cost)' : ''}</span>
                {!cmp.sameBody && <span className="note">Different vehicle: {cmp.them.veh} vs your {cmp.you.veh}</span>}
              </div>
            )}
            {isMe && sov && (
              <p className="ri-sov-me">
                Your share of {sov.cat} airtime: <b>{sov.pct}%</b> · {sov.rank ? <>#{sov.rank} of {sov.of}</> : <>not on air</>}
                {sov.rank !== 1 && <span className="muted"> · leader: {sov.leader}</span>}
              </p>
            )}
            {!isMe && (
              <p className="ri-watch-airtime">
                Airtime, last 3 hrs: them <b>{w.evs.length}</b> spots · <b>{money(w.spend)}</b> est. vs you <b>{meCard.evs.length}</b> · <b>{money(meCard.spend)}</b>
              </p>
            )}
            <div className="ri-mo-row">
              <MomentumChip m={mo} />
              <span className="read">{mo.read}</span>
            </div>
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
                <dl className="ri-mix-mini">
                  <div><dt>Top stations</dt><dd>{mix.stations.map((s) => `${s.k} ${s.pct}%`).join(' · ')}</dd></div>
                  <div><dt>When (3 hrs)</dt><dd>{mix.dayparts.map((s) => `${s.k} ${s.pct}%`).join(' · ')}</dd></div>
                </dl>
                {w.history && (() => {
                  const v = w.history.values; const first = v[0]; const last = v[v.length - 1];
                  const fmt = (n) => (w.history.unit === ' off' ? `$${n.toLocaleString()} off` : `$${n.toLocaleString()}${w.history.unit}`);
                  return (
                    <button type="button" className="ri-watch-trend" onClick={(e) => { e.stopPropagation(); open(); }} aria-label={`Open ${w.name} price chart`}>
                      <span className="lbl">
                        <span className="prod">{w.history.product} · 8 weeks</span>
                        <span className="mv">
                          {fmt(first)} → <b>{fmt(last)}</b>
                        </span>
                      </span>
                      <Sparkline values={v} w={320} h={70} />
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

function LiveView({ events, allCount, now, onOpen, watchlist, toggleWatch, goTo, me, setMe, ...filters }) {
  const [limit, setLimit] = useState(FEED_PAGE);
  const [view, setView] = useState('all');
  const shown = view === 'watching' ? events.filter((d) => watchlist.includes(d.creative.advertiser)) : events;
  return (
    <>
      <Kpis events={events} market={filters.market} media={filters.media} category={filters.category} now={now} />
      <div className="ri-seg" role="tablist" aria-label="Feed view">
        <button type="button" role="tab" aria-selected={view === 'all'} className={view === 'all' ? 'on' : ''} onClick={() => setView('all')}>All ads</button>
        <button type="button" role="tab" aria-selected={view === 'watching'} className={view === 'watching' ? 'on' : ''} onClick={() => setView('watching')}>
          ★ Watching ({watchlist.length})
        </button>
      </div>
      {view === 'watching' && (
        <>
          <div className="ri-section-head"><h2>Your competitors right now</h2><span className="ri-count">newest first</span></div>
          <WatchingPanel events={events} watchlist={watchlist} toggleWatch={toggleWatch} now={now} onOpen={onOpen} goTo={goTo} me={me} setMe={setMe} />
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
          <span>{c.advertiser}{c.city && <span className="ri-city"> · {c.city}</span>}</span>
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

// Read the captured ad text aloud with the phone's computer voice. Never plays original audio (data policy: facts only).
function HearIt({ text }) {
  const [playing, setPlaying] = useState(false);
  const ok = typeof window !== 'undefined' && 'speechSynthesis' in window;
  useEffect(() => () => { if (ok) window.speechSynthesis.cancel(); }, [ok]);
  if (!ok) return null;
  const toggle = () => {
    const s = window.speechSynthesis;
    if (playing) { s.cancel(); setPlaying(false); return; }
    const u = new SpeechSynthesisUtterance(text.replace(/^\(.*?\)\s*/, ''));
    u.rate = 1.05;
    u.onend = () => setPlaying(false);
    u.onerror = () => setPlaying(false);
    s.cancel(); s.speak(u); setPlaying(true);
  };
  return (
    <div className="ri-hear">
      <button type="button" className="ri-btn" onClick={toggle}>{playing ? '■ Stop' : '▶ Listen to ad capture'}</button>
      <span className="muted small">A computer voice reads the words we captured from this ad. We don't store or replay the original audio.</span>
    </div>
  );
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
    ['True monthly', a.monthly ? `${money(trueMonthly(a))}/mo` : '–'],
    ['Term', a.term ? `${a.term} mo` : '–'],
    ['APR', a.apr != null ? `${a.apr}%` : '–'],
    ['Cash off', a.cashOff ? money(a.cashOff) : '–'],
  ] : [];
  const meta = [
    ['Aired', new Date(d.ts).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' })],
    ['Station', `${d.station.call} ${d.station.network || d.station.band}`],
    ['Market', d.station.market],
    ['Advertiser city', c.city || 'National'],
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
            <span className="ri-eyebrow">{c.category} · {c.scope}{c.city ? ` · ${c.city}` : ''}{c.market ? ` · ${c.market} metro` : ''}</span>
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
        <HearIt text={c.transcript} />

        <span className="ri-eyebrow">Airing details</span>
        <dl className="ri-facts meta">
          {meta.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>

        <div className="ri-sheet-actions">
          <button type="button" className={`ri-btn watch ${watched ? 'on' : ''}`} onClick={() => toggleWatch(c.advertiser)} aria-pressed={watched}>
            {watched ? '★ Watching · tap to stop' : `☆ Watch ${c.advertiser}`}
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

function OffersView({ events, onAdvertiser, me, ...filters }) {
  const [view, setView] = useState('auto');
  const offers = useMemo(() => groupByCreative(events).sort((a, b) => b.spins - a.spins), [events]);
  const specific = offers.filter((x) => x.c.offer.offerType !== 'Brand');
  const brand = offers.filter((x) => x.c.offer.offerType === 'Brand');
  const inCity = (name) => filters.city === 'All' || cityOf(name) === filters.city;
  const changes = OFFER_CHANGES.filter((ch) => (filters.market === 'All' || ch.market === filters.market) && inCity(ch.advertiser));
  const moves = MARKET_MOVES.filter((m) => (filters.market === 'All' || m.market === filters.market) && (filters.category === 'All' || m.category === filters.category) && inCity(m.advertiser));
  const fresh = moves.filter((m) => m.kind === 'new');
  const dark = moves.filter((m) => m.kind === 'dark');

  return (
    <>
      <Filters {...filters} showSearch={false} />
      <div className="ri-seg" role="tablist" aria-label="Offer views">
        {[['auto', 'Auto deal board'], ['all', 'All offers'], ['changes', 'Changes']].map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} className={view === id ? 'on' : ''} onClick={() => setView(id)}>{label}</button>
        ))}
      </div>

      {view === 'auto' && <AutoBoard offers={offers} market={filters.city !== 'All' ? filters.city : filters.market} onAdvertiser={onAdvertiser} me={me} />}

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
                  <strong>{ch.advertiser}</strong> <span className="muted">{ch.product} · {cityOf(ch.advertiser) ? `${cityOf(ch.advertiser)}, ` : ''}{ch.market}</span>
                  <div className="ri-diff"><s>{ch.from}</s><span aria-hidden="true">→</span><b>{ch.to}</b></div>
                </div>
              </li>
            ))}
          </ul>

          <div className="ri-section-head"><h2>New on air</h2><span className="ri-count">started advertising</span></div>
          {fresh.length === 0 && <p className="ri-empty">No new advertisers here this week.</p>}
          <ul className="ri-changes">
            {fresh.map((m) => (
              <li key={m.advertiser}>
                <span className="date">{m.date}</span>
                <div>
                  <strong>{m.advertiser}</strong> <span className="tag new">New</span> <span className="muted">{m.category} · {cityOf(m.advertiser) ? `${cityOf(m.advertiser)}, ` : ''}{m.market}</span>
                  <div className="muted small">{m.note}</div>
                </div>
              </li>
            ))}
          </ul>

          <div className="ri-section-head"><h2>Gone dark</h2><span className="ri-count">no spots for 7+ days · open lanes</span></div>
          {dark.length === 0 && <p className="ri-empty">Nobody here has gone quiet this week.</p>}
          <ul className="ri-changes">
            {dark.map((m) => (
              <li key={m.advertiser}>
                <span className="date">{m.date}</span>
                <div>
                  <strong>{m.advertiser}</strong> <span className="tag">Last aired</span> <span className="muted">{m.category} · {cityOf(m.advertiser) ? `${cityOf(m.advertiser)}, ` : ''}{m.market}</span>
                  <div className="muted small">{m.note}</div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function AutoBoard({ offers, market, onAdvertiser, me }) {
  const [body, setBody] = useState('All');
  const [sort, setSort] = useState('true');
  const auto = offers.filter((x) => x.c.auto && (body === 'All' || x.c.auto.body === body));
  const leases = auto.filter((x) => x.c.auto.monthly).map((x) => ({ ...x, trueMonthly: x.c.auto.monthly + (x.c.auto.due || 0) / x.c.auto.term }));
  const sorters = {
    true: (a, b) => a.trueMonthly - b.trueMonthly,
    monthly: (a, b) => a.c.auto.monthly - b.c.auto.monthly,
    spins: (a, b) => b.spins - a.spins,
    city: (a, b) => (a.c.city || '').localeCompare(b.c.city || '') || a.trueMonthly - b.trueMonthly,
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
          <option value="city">Sort: city A–Z</option>
        </select>
      </div>
      <p className="ri-note">Every dealer with a lease ad on air, ranked. <span className="ri-vs-badge them">⚠ red</span> = their deal beats <b>{me}</b>’s, <span className="ri-vs-badge you">✓ green</span> = {me}’s is better. Change “Insights on” at the top to look at another business.</p>
      <p className="muted small">True monthly cost adds the money due at signing, spread over the term. It is the fair way to compare a "$0 down" deal with a "$299/mo" deal.</p>
      {leases.length === 0 && <p className="ri-empty">No lease deals match. Try another market or body style.</p>}
      <ol className="ri-board">
        {leases.map((x, i) => {
          const a = x.c.auto;
          const mine = x.c.advertiser === me;
          const cmp = mine ? null : compareDeals(x.c.advertiser, me);
          return (
            <li key={x.c.id} className={mine ? 'me' : cmp ? `vs-${cmp.status}` : ''}>
              <span className="rank">{i + 1}</span>
              <div className="body">
                <div className="top">
                  <span className="veh">{a.vehicle}</span>
                  <span className="true">{money(x.trueMonthly)}<small>/mo true</small></span>
                </div>
                {(mine || cmp) && <div className="vsline">{mine ? <span className="ri-you-tag">You</span> : <VsBadge cmp={cmp} />}</div>}
                <div className="nums">
                  <span><b>{money(a.monthly)}</b>/mo</span>
                  <span><b>{money(a.due)}</b> due</span>
                  <span><b>{a.term}</b> mo</span>
                  <span className="body-type">{a.body}</span>
                </div>
                <div className="sub">
                  <button type="button" className="ri-link" onClick={() => onAdvertiser(x.c.advertiser)}>{x.c.advertiser}</button>
                  <span>{x.c.city ? `${x.c.city}, ${x.c.market} metro` : x.c.market}</span>
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

const trendDir = (values) => {
  const d = values[values.length - 1] - values[0];
  return d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
};

function Sparkline({ values, w = 132, h = 40 }) {
  const pad = 4;
  const min = Math.min(...values); const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [pad + (i * (w - pad * 2)) / (values.length - 1), pad + (h - pad * 2) * (1 - (v - min) / span)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${d} L${pts[pts.length - 1][0]},${h} L${pts[0][0]},${h} Z`;
  const last = pts[pts.length - 1];
  // Neutral on purpose: a price line shows direction only. Red/green is saved for "vs you".
  return (
    <svg className={`ri-spark ${trendDir(values)}`} viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
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

// Advertisers who put nearly all their spend in one medium: a pitch for the other one.
function mediaGaps(scoped) {
  const m = new Map();
  for (const d of scoped) {
    const k = d.creative.advertiser;
    const cur = m.get(k) || { name: k, creative: d.creative, radio: 0, tv: 0, radioSpots: 0, tvSpots: 0, radioSt: new Set(), tvSt: new Set() };
    if (d.station.media === 'TV') { cur.tv += d.estCost; cur.tvSpots += 1; cur.tvSt.add(d.station.call); }
    else { cur.radio += d.estCost; cur.radioSpots += 1; cur.radioSt.add(d.station.call); }
    if (d.creative.offer.phone && !cur.creative.offer.phone) cur.creative = d.creative;
    m.set(k, cur);
  }
  const rows = [...m.values()].map((r) => ({ ...r, total: r.radio + r.tv, tvShare: r.tv / ((r.radio + r.tv) || 1) }))
    .sort((a, b) => b.total - a.total);
  return {
    needRadio: rows.filter((r) => r.tvShare >= 0.85).slice(0, 6),
    needTv: rows.filter((r) => r.tvShare <= 0.15).slice(0, 6),
  };
}

function GapList({ rows, pitch, onPick }) {
  if (!rows.length) return <p className="ri-empty">Nobody in this view is that lopsided right now.</p>;
  return (
    <ul className={`ri-leads ri-gaps ${pitch === 'radio' ? 'tv' : ''}`}>
      {rows.map((r) => {
        const strongPct = Math.round((pitch === 'radio' ? r.tvShare : 1 - r.tvShare) * 100);
        return (
          <li key={r.name}>
            <button type="button" className="ri-gap-btn" onClick={() => onPick({ ...r, pitch })}>
              <span className="top"><span className="name">{r.name}</span><b>{money(r.total)}</b></span>
              <span className="ri-gap-bar" aria-hidden="true"><i className="seg radio" style={{ width: `${(1 - r.tvShare) * 100}%` }} /><i className="seg tv" style={{ width: `${r.tvShare * 100}%` }} /></span>
              <span className="sub">
                <span>{r.creative.category}</span>
                <span>{strongPct}% {pitch === 'radio' ? 'TV' : 'radio'}</span>
                <span>{pitch === 'radio' ? (r.radioSpots ? `${r.radioSpots} radio spots` : 'no radio') : (r.tvSpots ? `${r.tvSpots} TV spots` : 'no TV')}</span>
                <span className="ri-gap-cta">Tap for the pitch →</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function OpportunitySheet({ o, onClose }) {
  const [msg, setMsg] = useState('');
  const c = o.creative;
  const pitch = o.pitch; // the medium they are under-using
  const strong = pitch === 'radio' ? 'TV' : 'radio';
  const strongPct = Math.round((pitch === 'radio' ? o.tvShare : 1 - o.tvShare) * 100);
  const weakSpots = pitch === 'radio' ? o.radioSpots : o.tvSpots;
  const strongSt = [...(pitch === 'radio' ? o.tvSt : o.radioSt)];
  const local = c.scope === 'Local';
  const phone = c.offer.phone;
  const site = c.offer.url;
  const realSite = site && !/\.example$/.test(site);
  const linkedIn = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${c.advertiser} marketing`)}`;
  const email = [
    `Subject: ${c.advertiser} on Seattle ${pitch}`,
    '',
    'Hi,',
    '',
    `We track every radio and TV ad in Seattle. Over the ${PERIOD}, about ${strongPct}% of ${c.advertiser}'s estimated Seattle ad spend went to ${strong} (${strongSt.slice(0, 3).join(', ')}${strongSt.length > 3 ? ' and others' : ''}), ${weakSpots ? `with only ${weakSpots} ${pitch} spot${weakSpots === 1 ? '' : 's'}` : `and none on ${pitch}`}.`,
    `Your current offer, "${c.offer.headline}", is a good fit for ${pitch}${pitch === 'radio' ? ' drive-time listeners' : ' viewers'} who aren't hearing it yet.`,
    '',
    'Could we take 15 minutes this week to show you what that would look like?',
    '',
    'Thanks,',
  ].join('\n');
  const copy = async (text, what) => setMsg((await copyText(text)) ? `${what} copied.` : 'Your browser blocked copying. Select the text and copy it.');

  return (
    <div className="ri-sheet-wrap" onClick={onClose}>
      <div className="ri-sheet" role="dialog" aria-modal="true" aria-label={`${c.advertiser} ${pitch} opportunity`} onClick={(e) => e.stopPropagation()}>
        <div className="ri-sheet-grip" />
        <div className="ri-sheet-head">
          <div>
            <span className="ri-eyebrow">{pitch === 'radio' ? 'Radio' : 'TV'} opportunity · {c.category} · {c.scope} <span className="ri-premium">Station Premium</span></span>
            <h3>{c.advertiser}</h3>
          </div>
          <button type="button" className="ri-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <p className="ri-callout">
          <b>{strongPct}%</b> of their est. Seattle spend is on {strong}: <b>{money(pitch === 'radio' ? o.tv : o.radio)}</b> {strong} vs <b>{money(pitch === 'radio' ? o.radio : o.tv)}</b> {pitch}, {PERIOD}.
        </p>
        <span className="ri-gap-bar big" aria-hidden="true"><i className="seg radio" style={{ width: `${(1 - o.tvShare) * 100}%` }} /><i className="seg tv" style={{ width: `${o.tvShare * 100}%` }} /></span>

        <dl className="ri-facts">
          <div><dt>Their offer</dt><dd>{c.offer.headline}</dd></div>
          <div><dt>On {strong} now</dt><dd>{strongSt.join(', ') || '—'}</dd></div>
          <div><dt>{pitch === 'radio' ? 'Radio' : 'TV'} spots</dt><dd>{weakSpots || 'None'}</dd></div>
          <div><dt>Est. spend, {PERIOD}</dt><dd>{money(o.total)}</dd></div>
        </dl>

        <span className="ri-eyebrow">Contact from their own ads</span>
        <dl className="ri-facts meta">
          <div><dt>Phone</dt><dd className="mono">{phone || 'Not given in their ads'}</dd></div>
          <div><dt>Website</dt><dd>{realSite ? <a href={`https://${site}`} target="_blank" rel="noreferrer">{site}</a> : (site || 'Not given')}</dd></div>
        </dl>

        <span className="ri-eyebrow">Who decides</span>
        <p className="muted small">
          {local
            ? 'Local business. Usually the owner, general manager or marketing manager buys the ads. Call the number from their ad and ask for whoever handles advertising.'
            : 'National brand. Seattle media is usually bought by their ad agency, not a local store. Ask your national sales rep, or look up their agency of record.'}
          {' '}In the live product, the buyer's name, title and email will come from a contact-data provider. This demo only shows what's in the ads.
        </p>

        <div className="ri-sheet-actions">
          {phone && <button type="button" className="ri-btn" onClick={() => copy(phone, 'Phone number')}>Copy phone</button>}
          <a className="ri-btn" href={linkedIn} target="_blank" rel="noreferrer">Find their marketing lead</a>
          <button type="button" className="ri-btn primary" onClick={() => copy(email, 'Pitch email')}>Copy pitch email</button>
        </div>
        {msg && <p className="muted small" role="status">{msg}</p>}
      </div>
    </div>
  );
}

function RadioVsTv({ crossMedia, market }) {
  const [picked, setPicked] = useState(null);
  const [opp, setOpp] = useState(null);
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
  const gaps = mediaGaps(scoped);

  return (
    <>
      <p className="ri-note">All spend on this page is <b>estimated</b> over the <b>{PERIOD}</b>, the demo's live window. Once recording runs, you choose Today, 7 days or 30 days.</p>
      <div className="ri-section-head"><h2>Radio vs TV in Seattle <span className="ri-premium">TV Premium</span></h2><span className="ri-count">est. spend, {PERIOD}</span></div>
      <div className="ri-panel ri-mix">
        <Donut radio={radio} tv={tv} />
        <dl className="ri-mix-facts">
          <div><dt><i className="sw radio" />Radio</dt><dd>{money(radio)} <span className="muted">{Math.round((radio / total) * 100)}%</span></dd></div>
          <div><dt><i className="sw tv" />TV</dt><dd>{money(tv)} <span className="muted">{Math.round((tv / total) * 100)}%</span></dd></div>
          <div><dt>On both</dt><dd>{bothCount} advertisers</dd></div>
          <div><dt>Radio only / TV only</dt><dd>{radioOnly} / {tvOnly}</dd></div>
        </dl>
      </div>

      <div className="ri-section-head"><h2>Who's spending the most</h2><span className="ri-count">top 10 by est. spend, {PERIOD}</span></div>
      <div className="ri-panel">
        <MediaLegend />
        <p className="ri-callout">
          {pick
            ? <><b>{pick.name}</b>: {money(pick.radio)} radio · {money(pick.tv)} TV · {Math.round((pick.tv / (pick.radio + pick.tv)) * 100)}% on TV ({PERIOD})</>
            : 'Tap a bar to split it into radio and TV.'}
        </p>
        <SplitBars rows={byAdv} onPick={setPicked} picked={picked} />
      </div>

      <div className="ri-section-head"><h2>Mostly TV: pitch them radio <span className="ri-premium">Station Premium</span></h2><span className="ri-count">85%+ of spend on TV, {PERIOD}</span></div>
      <GapList rows={gaps.needRadio} pitch="radio" onPick={setOpp} />

      <div className="ri-section-head"><h2>Mostly radio: pitch them TV <span className="ri-premium">Station Premium</span></h2><span className="ri-count">85%+ of spend on radio, {PERIOD}</span></div>
      <GapList rows={gaps.needTv} pitch="tv" onPick={setOpp} />
      {opp && <OpportunitySheet o={opp} onClose={() => setOpp(null)} />}

      <div className="ri-section-head"><h2>Spend by category</h2><span className="ri-count">est., {PERIOD}</span></div>
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

// ------------------------------------------------------------------ website deals (real, read from dealer sites)
// Every new-vehicle special a dealer posts on its own website, read the way a shopper sees it.
// Sites that block automated visits are listed as blocked and left alone.
const wTrue = (o) => (o.monthly ? o.monthly + (o.due || 0) / (o.term || 36) : null);
const wOff = (o) => (o.discount || 0) + (o.rebate || 0);
const wKey = (o) => `${o.model}|${o.trim}`;
const wName = (k) => k.replace('|', ' ').trim();
const wWhen = new Date(WEB_CAPTURED).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function findSite(q) {
  const s = q.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!s) return null;
  const words = s.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  return WEB_SITES.find((x) => x.domain === s)
    || WEB_SITES.find((x) => x.dealer.toLowerCase() === s)
    || WEB_SITES.find((x) => words.every((w) => `${x.dealer} ${x.domain}`.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').includes(w)));
}

// Best offer per dealer for one vehicle: lowest true monthly cost (leases) or most off sticker (prices).
function bestPerDealer(list, type) {
  const m = new Map();
  // Lease sites often also print the sticker and the discount, so they count in the price view too.
  const fits = (x) => (type === 'lease' ? x.type === 'lease' : x.type === 'price' || (x.tsrp && x.price));
  for (const o of list.filter(fits)) {
    const cur = m.get(o.dealer);
    const better = !cur || (type === 'lease' ? wTrue(o) < wTrue(cur) : wOff(o) > wOff(cur));
    if (better) m.set(o.dealer, o);
  }
  return [...m.values()].sort((a, b) => (type === 'lease' ? wTrue(a) - wTrue(b) : wOff(b) - wOff(a)));
}

function vsMine(o, mine, type) {
  if (!mine || o.dealer === mine.dealer) return null;
  if (type === 'lease') {
    const gap = Math.round(wTrue(mine) - wTrue(o));
    if (Math.abs(gap) < 5) return { status: 'even', short: 'About even with you' };
    return gap > 0 ? { status: 'them', short: `Beats you by ${money(gap)}/mo` } : { status: 'you', short: `You're ${money(-gap)}/mo cheaper` };
  }
  const gap = wOff(o) - wOff(mine);
  if (Math.abs(gap) < 250) return { status: 'even', short: 'About even with you' };
  return gap > 0 ? { status: 'them', short: `${money(gap)} more off than you` } : { status: 'you', short: `You take ${money(-gap)} more off` };
}

function WebDealsView() {
  const [q, setQ] = useState(() => store('ri.webme', "Michael's Toyota of Bellevue"));
  const site = findSite(q);
  useEffect(() => { if (site) save('ri.webme', site.dealer); }, [site]);
  const me = site ? site.dealer : null;
  const mine = WEB_OFFERS.filter((o) => o.dealer === me);
  const rivals = WEB_OFFERS.filter((o) => o.dealer !== me);
  const myKeys = [...new Set(mine.map(wKey))];
  const keys = [...new Set(WEB_OFFERS.map(wKey))]
    .map((k) => ({ k, dealers: new Set(WEB_OFFERS.filter((o) => wKey(o) === k).map((o) => o.dealer)).size, mineToo: myKeys.includes(k) }))
    .sort((a, b) => (b.mineToo - a.mineToo) || (b.dealers - a.dealers) || a.k.localeCompare(b.k));
  const [pick, setPick] = useState(null);
  const sel = keys.find((x) => x.k === pick) ? pick : (keys.find((x) => x.mineToo && x.dealers > 1) || keys[0] || {}).k;

  // What a dealer needs to know first.
  const notes = [];
  if (me) {
    const myLeases = mine.filter((o) => o.type === 'lease').length;
    const leaseRivals = new Set(rivals.filter((o) => o.type === 'lease').map((o) => o.dealer));
    if (mine.length && !myLeases && leaseRivals.size) notes.push({ kind: 'miss', text: <><b>{leaseRivals.size} competitors</b> post monthly lease payments. You post none, so payment shoppers compare them, not you.</> });
    for (const k of myKeys) {
      for (const type of ['lease', 'price']) {
        const myBest = bestPerDealer(mine.filter((o) => wKey(o) === k), type)[0];
        if (!myBest) continue;
        const top = bestPerDealer(rivals.filter((o) => wKey(o) === k), type)[0];
        const cmp = top && vsMine(top, myBest, type);
        if (cmp && cmp.status === 'them') {
          notes.push({ kind: 'beat', k, text: type === 'lease'
            ? <><b>{top.dealer}</b> leases a {wName(k)} for {money(top.monthly)}/mo with {money(top.due)} due ({money(wTrue(top))}/mo true cost). Yours: {money(wTrue(myBest))}/mo.</>
            : <><b>{top.dealer}</b> takes <b>{money(wOff(top))}</b> off a {wName(k)}. Your best is {money(wOff(myBest))} off.</> });
        }
      }
    }
    const theirOnly = [...new Set(rivals.map((o) => o.model))].filter((m) => !mine.some((o) => o.model === m));
    if (mine.length && theirOnly.length) notes.push({ kind: 'open', text: <>Competitors post specials on <b>{theirOnly.length} models you don't</b>: {theirOnly.slice(0, 6).join(', ')}{theirOnly.length > 6 ? '…' : ''}.</> });
  }
  const beatCount = notes.filter((n) => n.kind === 'beat').length;

  const list = WEB_OFFERS.filter((o) => wKey(o) === sel);
  const leases = bestPerDealer(list, 'lease');
  const prices = bestPerDealer(list, 'price');
  const myLease = leases.find((o) => o.dealer === me);
  const myPrice = prices.find((o) => o.dealer === me);
  const siteOf = (d) => WEB_SITES.find((s) => s.dealer === d) || {};

  return (
    <>
      <div className="ri-section-head"><h2>Website deals</h2><span className="ri-real">Real data · read {wWhen}</span></div>
      <p className="ri-note">Every new-Toyota special posted on Seattle-area dealer websites, read the way any shopper sees them. Type your dealership or your website.</p>
      <div className="ri-filters">
        <input type="search" list="ri-web-dealers" placeholder="Your dealership or website, e.g. toyotaofbellevue.com" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Your dealership or website" />
        <datalist id="ri-web-dealers">{WEB_SITES.map((s) => <option key={s.dealer} value={s.dealer} />)}</datalist>
      </div>

      {!site && q.trim() && <p className="ri-callout">We don't have “{q}” yet. In the live product, tracking starts the moment you add it. Try a Seattle-area Toyota store.</p>}

      {site && (
        <div className="ri-panel">
          <p className="ri-callout">
            <b>{site.dealer}</b> · {site.city}{site.group && <> · {site.group} group</>} · <a href={site.url} target="_blank" rel="noreferrer">{site.domain}</a>
            <br />{site.status === 'blocked' ? 'Your site blocks automated reading, so we compare you using your Google and Facebook ads instead (coming next).'
              : <>You post <b>{mine.length}</b> new-vehicle specials: {mine.filter((o) => o.type === 'lease').length} lease payments, {mine.filter((o) => o.type === 'price').length} price discounts.{beatCount > 0 && <> <b>{beatCount}</b> of your vehicles are beaten by a competitor's posted deal.</>}</>}
          </p>
          {notes.length > 0 && (
            <ul className="ri-lanes">
              {notes.map((n, i) => (
                <li key={i} className={n.kind === 'beat' ? 'beat' : n.kind}>
                  <span className="ic" aria-hidden="true">{n.kind === 'open' ? '◇' : '!'}</span>
                  <span>{n.text}{n.k && <> <button type="button" className="ri-linkbtn" onClick={() => setPick(n.k)}>Compare →</button></>}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="ri-section-head"><h2>Same vehicle, every dealer</h2><span className="ri-count">{keys.length} vehicles · {WEB_OFFERS.length} specials</span></div>
      <div className="ri-wchips" role="tablist" aria-label="Vehicle">
        {keys.map((x) => (
          <button key={x.k} type="button" role="tab" aria-selected={x.k === sel} className={x.k === sel ? 'on' : ''} onClick={() => setPick(x.k)}>
            {wName(x.k)} <small>{x.dealers}</small>{x.mineToo && <i className="you-dot" title="You post this one" />}
          </button>
        ))}
      </div>

      {leases.length > 0 && (
        <div className="ri-panel">
          <span className="ri-eyebrow">{wName(sel)} · lease, sorted by true monthly cost</span>
          <ul className="ri-wrows">
            {leases.map((o) => {
              const cmp = vsMine(o, myLease, 'lease');
              return (
                <li key={o.dealer} className={o.dealer === me ? 'me' : ''}>
                  <div className="top"><span className="name">{o.dealer}{o.dealer === me && <span className="ri-you-tag">You</span>}</span><b>{money(o.monthly)}/mo</b></div>
                  <div className="sub"><span>{money(o.due)} due · {o.term} mo</span><span>{money(wTrue(o))}/mo true cost</span>{o.drive && <span>{o.drive}</span>}{o.modelCode && <span>Model {o.modelCode}</span>}<span>Ends {o.expires}</span></div>
                  <div className="sub">{cmp && <VsBadge cmp={cmp} />}<a href={siteOf(o.dealer).url} target="_blank" rel="noreferrer">See it on their site</a></div>
                </li>
              );
            })}
          </ul>
          {me && !myLease && <p className="muted small">You don't post a lease on this vehicle.</p>}
        </div>
      )}

      {prices.length > 0 && (
        <div className="ri-panel">
          <span className="ri-eyebrow">{wName(sel)} · price, sorted by most off sticker</span>
          <ul className="ri-wrows">
            {prices.map((o) => {
              const cmp = vsMine(o, myPrice, 'price');
              return (
                <li key={o.dealer} className={o.dealer === me ? 'me' : ''}>
                  <div className="top"><span className="name">{o.dealer}{o.dealer === me && <span className="ri-you-tag">You</span>}</span><b>{money(wOff(o))} off</b></div>
                  <div className="sub"><span>Sticker {money(o.tsrp)}</span><span>{Math.round((wOff(o) / (o.tsrp || 1)) * 1000) / 10}% off</span>{o.price && <span>Posted price {money(o.price)}</span>}{o.drive && <span>{o.drive}</span>}<span>Ends {o.expires}</span></div>
                  <div className="sub">{cmp && <VsBadge cmp={cmp} />}<a href={siteOf(o.dealer).url} target="_blank" rel="noreferrer">See it on their site</a></div>
                </li>
              );
            })}
          </ul>
          {me && !myPrice && <p className="muted small">You don't post a price discount on this vehicle.</p>}
        </div>
      )}

      <div className="ri-section-head"><h2>Dealers we read</h2><span className="ri-count">{WEB_SITES.filter((s) => s.status === 'read').length} of {WEB_SITES.length} sites</span></div>
      <ul className="ri-wsites">
        {WEB_SITES.map((s) => (
          <li key={s.dealer}>
            <span className="name">{s.dealer}<span className="muted"> · {s.city}</span></span>
            <span className={`st ${s.status}`}>{s.status === 'read' ? `${s.count} specials` : s.status === 'blocked' ? 'Site blocks automated reading' : 'No specials posted'}</span>
          </li>
        ))}
      </ul>
      <p className="ri-note">Read once, like a shopper opening the page, following each site's robot rules. We never get around a block; for those dealers we'll use their public Google and Facebook ads. Prices and payments are as posted; doc fees and fine print vary by dealer.</p>
    </>
  );
}

// ------------------------------------------------------------------ all media: where each business sits
// Radio and broadcast TV come from the detections. Local cable and streaming TV are planned
// sources; until they're connected, their numbers are a fixed demo estimate per advertiser.
const CHANNELS = [
  { id: 'radio', label: 'Radio', status: 'Live in pilot', planned: false },
  { id: 'tv', label: 'Broadcast TV', status: 'Premium', planned: false },
  { id: 'cable', label: 'Local cable', status: 'Planned', planned: true },
  { id: 'stream', label: 'Streaming TV', status: 'Planned', planned: true },
];
const chLabel = (id) => CHANNELS.find((c) => c.id === id).label;
const listOf = (ids) => (ids.length <= 1 ? ids.join('') : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`);
const seedOf = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
};

function footprints(scoped) {
  const m = new Map();
  for (const d of scoped) {
    const k = d.creative.advertiser;
    const cur = m.get(k) || { name: k, creative: d.creative, category: d.creative.category, radio: 0, tv: 0, radioSpots: 0, tvSpots: 0 };
    if (d.station.media === 'TV') { cur.tv += d.estCost; cur.tvSpots += 1; } else { cur.radio += d.estCost; cur.radioSpots += 1; }
    if (d.creative.offer.phone && !cur.creative.offer.phone) cur.creative = d.creative;
    m.set(k, cur);
  }
  return [...m.values()].map((r) => {
    const national = r.creative.scope !== 'Local';
    const base = r.radio + r.tv;
    const a = seedOf(`${r.name}|cable`);
    const b = seedOf(`${r.name}|stream`);
    const v = {
      radio: r.radio,
      tv: r.tv,
      cable: a < (national ? 0.6 : 0.4) ? base * (0.12 + a * 0.4) : 0,
      stream: b < (national ? 0.9 : 0.35) ? base * (0.2 + b * 0.6) : 0,
    };
    const total = v.radio + v.tv + v.cable + v.stream;
    const on = CHANNELS.filter((c) => v[c.id] > 0).map((c) => c.id);
    return { ...r, v, total, on, off: CHANNELS.filter((c) => !on.includes(c.id)).map((c) => c.id), cableSpots: Math.round(v.cable / 45), streamViews: Math.round(v.stream / 0.035) };
  }).sort((x, y) => y.total - x.total);
}

function MixBar({ v, big = false }) {
  const total = CHANNELS.reduce((a, c) => a + v[c.id], 0) || 1;
  return (
    <span className={`ri-mixbar ${big ? 'big' : ''}`}>
      {CHANNELS.filter((c) => v[c.id] > 0).map((c) => (
        <i key={c.id} className={`seg ${c.id}`} style={{ width: `${(v[c.id] / total) * 100}%` }} title={`${c.label}: ${money(v[c.id])} est. (${Math.round((v[c.id] / total) * 100)}%)`} />
      ))}
    </span>
  );
}

function ChannelLegend() {
  return (
    <div className="ri-media-legend wrap">
      {CHANNELS.map((c) => <span key={c.id}><i className={`sw ${c.id}`} aria-hidden="true" />{c.label}{c.planned && <em> (demo)</em>}</span>)}
    </div>
  );
}

function MixSheet({ r, onClose, onAdvertiser }) {
  const [msg, setMsg] = useState('');
  const c = r.creative;
  const pct = (id) => Math.round((r.v[id] / (r.total || 1)) * 100);
  const strong = r.on.map(chLabel);
  const missing = r.off.map(chLabel);
  const email = [
    `Subject: ${c.advertiser}: where your ads are and aren't`,
    '',
    'Hi,',
    '',
    `We track every ad in Seattle across radio and TV. Over the ${PERIOD}, ${c.advertiser}'s estimated spend was ${r.on.map((id) => `${pct(id)}% ${chLabel(id).toLowerCase()}`).join(', ')}.`,
    missing.length ? `You're not on ${listOf(missing).toLowerCase()} right now, which is where some of your customers are watching and listening.` : 'You are on every channel we track.',
    `Your current offer, "${c.offer.headline}", would carry well there.`,
    '',
    'Could we take 15 minutes this week to walk through it?',
    '',
    'Thanks,',
  ].join('\n');
  const copy = async (text, what) => setMsg((await copyText(text)) ? `${what} copied.` : 'Your browser blocked copying. Select the text and copy it.');
  return (
    <div className="ri-sheet-wrap" onClick={onClose}>
      <div className="ri-sheet" role="dialog" aria-modal="true" aria-label={`${c.advertiser} media mix`} onClick={(e) => e.stopPropagation()}>
        <div className="ri-sheet-grip" />
        <div className="ri-sheet-head">
          <div>
            <span className="ri-eyebrow">Media mix · {c.category} · {c.scope}</span>
            <h3>{c.advertiser}</h3>
          </div>
          <button type="button" className="ri-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <p className="ri-callout">On <b>{r.on.length} of 4</b> channels. Est. <b>{money(r.total)}</b>, {PERIOD}.{missing.length > 0 && <> Not on {listOf(missing).toLowerCase()}.</>}</p>
        <MixBar v={r.v} big />
        <ChannelLegend />
        <dl className="ri-facts">
          {CHANNELS.map((ch) => (
            <div key={ch.id}>
              <dt><i className={`sw ${ch.id}`} aria-hidden="true" />{ch.label}{ch.planned && ' (demo)'}</dt>
              <dd>{r.v[ch.id] > 0 ? <>{money(r.v[ch.id])} · {pct(ch.id)}%<br /><span className="muted small">{{ radio: `${r.radioSpots} spots`, tv: `${r.tvSpots} spots`, cable: `~${r.cableSpots} spots`, stream: `~${r.streamViews.toLocaleString('en-US')} views` }[ch.id]}</span></> : 'Not on it'}</dd>
            </div>
          ))}
          <div className="wide"><dt>Their offer</dt><dd>{c.offer.headline}</dd></div>
        </dl>
        <span className="ri-eyebrow">Contact from their own ads</span>
        <dl className="ri-facts meta">
          <div><dt>Phone</dt><dd className="mono">{c.offer.phone || 'Not given in their ads'}</dd></div>
          <div><dt>Who decides</dt><dd>{c.scope === 'Local' ? 'Owner, GM or marketing manager' : 'Their ad agency'}</dd></div>
        </dl>
        <p className="muted small">Strong on {listOf(strong).toLowerCase()}{missing.length ? `; the pitch is ${listOf(missing).toLowerCase()}.` : '.'} Cable and streaming numbers are demo estimates until those sources are connected.</p>
        <div className="ri-sheet-actions">
          <button type="button" className="ri-btn" onClick={() => { onClose(); onAdvertiser(c.advertiser); }}>See their spots</button>
          {c.offer.phone && <button type="button" className="ri-btn" onClick={() => copy(c.offer.phone, 'Phone number')}>Copy phone</button>}
          <button type="button" className="ri-btn primary" onClick={() => copy(email, 'Pitch email')}>Copy pitch email</button>
        </div>
        {msg && <p className="muted small" role="status">{msg}</p>}
      </div>
    </div>
  );
}

function MixRows({ rows, onPick, me }) {
  if (!rows.length) return <p className="ri-empty">Nobody in this view has aired in the {PERIOD}.</p>;
  return (
    <ul className="ri-leads ri-gaps ri-mixrows">
      {rows.map((r) => (
        <li key={r.name} className={r.name === me ? 'me' : ''}>
          <button type="button" className="ri-gap-btn" onClick={() => onPick(r)}>
            <span className="top"><span className="name">{r.name}{r.name === me && <span className="ri-you-tag">You</span>}</span><b>{money(r.total)}</b></span>
            <MixBar v={r.v} />
            <span className="sub">
              <span>{r.category}</span>
              <span>{r.on.length} of 4 channels{r.on.length === 1 ? ` · ${chLabel(r.on[0]).toLowerCase()} only` : ''}</span>
              {r.off.length > 0 && <span>Not on {listOf(r.off.map(chLabel)).toLowerCase()}</span>}
              <span className="ri-gap-cta">Details →</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function MixView({ crossMedia, market, category, me, setMe, onAdvertiser }) {
  const [open, setOpen] = useState(null);
  const scoped = market === 'All' || market === 'Seattle' ? crossMedia.filter((d) => d.station.market === 'Seattle') : null;
  const rows = useMemo(() => (scoped ? footprints(scoped) : []), [crossMedia, market]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!scoped) return <p className="ri-note">All media covers Seattle, where TV is monitored in this demo. Set the market to Seattle or All.</p>;

  const meCat = (CREATIVES.find((c) => c.advertiser === me) || {}).category;
  const cat = category !== 'All' ? category : meCat;
  const mine = rows.find((r) => r.name === me);
  const catRows = rows.filter((r) => r.category === cat);
  const peers = catRows.filter((r) => r.name !== me);
  const catTotal = (id) => catRows.reduce((a, r) => a + r.v[id], 0);
  const catAll = catRows.reduce((a, r) => a + r.total, 0) || 1;
  const myShare = mine ? mine.total / catAll : 0;

  const lanes = [];
  if (cat && cat === meCat) {
    for (const ch of CHANNELS) {
      const peersOn = peers.filter((p) => p.v[ch.id] > 0).length;
      const meOn = mine && mine.v[ch.id] > 0;
      if (!meOn && peersOn > 0) lanes.push({ kind: 'miss', ch, text: <><b>{peersOn} of {peers.length}</b> {cat} competitors are on {ch.label.toLowerCase()}. You aren't.</> });
      else if (!meOn && peersOn === 0) lanes.push({ kind: 'open', ch, text: <>Nobody in {cat} is on {ch.label.toLowerCase()}. <b>Open lane:</b> the first one in has it to themselves.</> });
      else if (meOn && peersOn === 0) lanes.push({ kind: 'lead', ch, text: <>You're the <b>only</b> {cat} advertiser on {ch.label.toLowerCase()}.</> });
      else if (meOn) {
        const s = mine.v[ch.id] / (catTotal(ch.id) || 1);
        if (s < myShare * 0.6) lanes.push({ kind: 'miss', ch, text: <>You're <b>{Math.round(myShare * 100)}%</b> of {cat} spend overall but only <b>{Math.round(s * 100)}%</b> on {ch.label.toLowerCase()}.</> });
        else if (s > myShare * 1.5) lanes.push({ kind: 'lead', ch, text: <>You own <b>{Math.round(s * 100)}%</b> of {cat} {ch.label.toLowerCase()} spend.</> });
      }
    }
  }
  const beats = cat && cat === meCat ? dealsBeatingMe(me).slice(0, 4) : [];
  const single = rows.filter((r) => r.on.length === 1).slice(0, 8);
  const mkt = CHANNELS.reduce((o, c) => ({ ...o, [c.id]: rows.reduce((a, r) => a + r.v[c.id], 0) }), {});
  const mktTotal = CHANNELS.reduce((a, c) => a + mkt[c.id], 0) || 1;

  return (
    <>
      <div className="ri-section-head"><h2>All media: where every business sits</h2><span className="ri-count">Seattle · est. spend, {PERIOD}</span></div>
      <div className="ri-channels">
        {CHANNELS.map((c) => (
          <div key={c.id} className={`ri-channel ${c.planned ? 'planned' : ''}`}>
            <span className="nm"><i className={`sw ${c.id}`} aria-hidden="true" />{c.label}</span>
            <b>{money(mkt[c.id])}</b>
            <span className="st">{Math.round((mkt[c.id] / mktTotal) * 100)}% · {c.status}</span>
          </div>
        ))}
      </div>
      <p className="ri-note">Radio and broadcast TV come from the live feed. <b>Local cable and streaming TV are planned sources; their numbers are demo estimates</b> until those feeds are connected. Spend is always an estimate.</p>

      <div className="ri-mix-cols">
        <div className="ri-col">
          <div className="ri-section-head"><h2>Your footprint</h2>
            <span className="ri-you-pick">You: <b>{me}</b></span>
          </div>
          <div className="ri-panel">
            {mine ? (
              <>
                <p className="ri-callout"><b>{me}</b> is on <b>{mine.on.length} of 4</b> channels: est. {money(mine.total)}, {PERIOD}. {cat && <>That's {Math.round(myShare * 100)}% of all {cat} spend.</>}</p>
                <MixBar v={mine.v} big />
                <ChannelLegend />
              </>
            ) : <p className="ri-callout">{me} hasn't aired on radio or TV in the {PERIOD}. Here's where your competitors are.</p>}
            {lanes.length > 0 && (
              <ul className="ri-lanes">
                {lanes.map((l) => (
                  <li key={l.ch.id} className={l.kind}>
                    <span className="ic" aria-hidden="true">{l.kind === 'miss' ? '!' : l.kind === 'open' ? '◇' : '✓'}</span>
                    <span><i className={`sw ${l.ch.id}`} aria-hidden="true" />{l.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {beats.length > 0 && (
            <>
              <div className="ri-section-head"><h2>Deals that beat yours</h2><span className="ri-count">on air now · true monthly cost</span></div>
              <ul className="ri-leads ri-beats">
                {beats.map((b) => (
                  <li key={b.name}>
                    <span className="top"><span className="name">{b.name}</span><VsBadge cmp={b.cmp} /></span>
                    <span className="sub"><span>Them: {b.cmp.them.veh} {b.cmp.them.big} · {b.cmp.them.sub}</span><span>You: {b.cmp.you.veh} {b.cmp.you.big} · {b.cmp.you.sub}</span></span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="ri-col">
          <div className="ri-section-head"><h2>{cat || 'Everyone'} across all media</h2><span className="ri-count">{catRows.length} advertisers, {PERIOD}</span></div>
          <div className="ri-panel"><ChannelLegend /></div>
          <MixRows rows={cat ? catRows : rows.slice(0, 12)} onPick={setOpen} me={me} />
        </div>
      </div>

      <div className="ri-section-head"><h2>Only on one channel: pitch them the rest <span className="ri-premium">Station Premium</span></h2><span className="ri-count">all categories, {PERIOD}</span></div>
      <p className="ri-note">A business on just one channel is missing customers who watch and stream. For a station or cable seller, that's the call.</p>
      <MixRows rows={single} onPick={setOpen} me={me} />

      {open && <MixSheet r={open} onClose={() => setOpen(null)} onAdvertiser={onAdvertiser} />}
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
  // Neutral line; the "you" line (if any) is drawn in blue, dashed.
  const tone = trendDir(vals);
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
            : delta === 0 ? 'No change in 8 weeks.' : better ? 'A richer deal for shoppers than 8 weeks ago.' : 'A weaker deal for shoppers than 8 weeks ago.'}</span>
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

function TrendsView({ events, crossMedia, allEvents, watchlist, toggleWatch, onAdvertiser, me, ...filters }) {
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
      <p className="muted small ri-key">
        Lines show direction only. <span className="ri-vs-badge them">⚠ red</span> = their deal beats {me}’s, <span className="ri-vs-badge you">✓ green</span> = {me}’s is better. No color = not comparable.
      </p>
      {prices.length === 0 && <p className="ri-empty">No tracked price history in this market yet.</p>}
      <ul className="ri-prices">
        {prices.map((p) => {
          const first = p.values[0]; const last = p.values[p.values.length - 1];
          const fmt = (v) => `${money(v)}${p.unit}`;
          const mine = p.advertiser === me;
          const cmp = mine ? null : compareDeals(p.advertiser, me);
          const mo = momentumOf(p.advertiser);
          return (
            <li key={p.advertiser + p.product} className={mine ? 'me' : cmp ? `vs-${cmp.status}` : ''}>
              <div className="body">
                <button type="button" className="ri-link" onClick={() => onAdvertiser(p.advertiser)}>{p.advertiser}</button>
                <span className="muted small">{p.product} · {p.market}</span>
                <span className="move"><s>{fmt(first)}</s> → <b>{fmt(last)}</b></span>
                <span className="tags">
                  {mine ? <span className="ri-you-tag">You</span> : <VsBadge cmp={cmp} />}
                  <MomentumChip m={mo} />
                </span>
                <span className="read muted small">{mo.read}</span>
              </div>
              <button type="button" className="ri-spark-btn" onClick={() => setChart(p)} aria-label={`Open ${p.advertiser} price chart`}>
                <Sparkline values={p.values} />
                <span className="ri-spark-hint">Tap for chart</span>
              </button>
            </li>
          );
        })}
      </ul>
      {chart && <PriceChartSheet h={chart} mine={PRICE_HISTORY.find((x) => x.advertiser === me)} own={chart.advertiser === me} onClose={() => setChart(null)} />}

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
        <span className="ri-count">{sov.length} advertisers · {money(total)} est., {PERIOD}</span>
      </div>
      <ol className="ri-sov">
        {(showAll ? sov : sov.slice(0, 10)).map((r, i) => (
          <li key={r.name}>
            <span className="rank">{i + 1}</span>
            <div className="body">
              <div className="top">
                <span><button type="button" className="ri-link" onClick={() => onAdvertiser(r.name)}>{r.name}</button>{r.name === me && <> <span className="ri-you-tag">You</span></>}</span>
                <span className="pct">{((r.spend / total) * 100).toFixed(1)}%</span>
              </div>
              <div className="bar"><span style={{ width: `${(r.spend / maxSpend) * 100}%` }} /></div>
              <div className="sub"><span>{r.cat}</span>{cityOf(r.name) && <span>{cityOf(r.name)}</span>}<span>{r.spins} spins</span><span>{r.stations.size} stations</span><span>{money(r.spend)} est. / {WINDOW_MS / 3600000} hrs</span></div>
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
    ['Spots per hour', me.spots / hours, them.spots / hours, (v) => `${v.toFixed(1)}/hr`],
    ['Ad minutes per hour', me.secs / 60 / hours, them.secs / 60 / hours, (v) => `${v.toFixed(1)} min/hr`],
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
            <React.Fragment key={a}>{i ? ', ' : ''}<b>{a}</b></React.Fragment>
          )) : 'None'}</dd></div>
        </dl>
      </div>
    </>
  );
}

// "My station": every advertiser on your station, and the accounts you may be losing.
function MyStation({ events, home, hours, now, peers, rank, onAdvertiser, onOpen }) {
  const [all, setAll] = useState(false);
  const onHome = useMemo(() => events.filter((d) => d.station.id === home.id), [events, home]);
  const advs = useMemo(() => {
    const by = new Map();
    for (const d of onHome) {
      const k = d.creative.advertiser;
      const cur = by.get(k) || { name: k, cat: d.creative.category, spins: 0, spend: 0, offer: d.creative.offer.headline };
      cur.spins += 1; cur.spend += d.estCost;
      by.set(k, cur);
    }
    return [...by.values()].sort((a, b) => b.spend - a.spend).map((r) => {
      const w = weekOverWeek([`${r.name}@${home.id}`])[0]; // their spots on you, this week vs last
      const onYou = (w.now - w.last) / (w.last || 1);
      const overall = momentumOf(r.name).pct; // their airtime on all stations
      // Flag only clear moves: at least 25% fewer spots on you while they grow 15%+ overall.
      return { ...r, onYou, overall, atRisk: onYou <= -0.25 && overall >= 0.15 };
    });
  }, [onHome, home]);
  const spend = onHome.reduce((a, d) => a + d.estCost, 0);
  const atRisk = advs.filter((r) => r.atRisk);
  const pct = (v) => `${v > 0 ? '▲ +' : v < 0 ? '▼ ' : ''}${Math.round(v * 100)}%`;

  return (
    <>
      <p className="ri-lead-total">
        <b>{home.call}</b> aired <b>{onHome.length}</b> spots from <b>{advs.length}</b> advertisers in the last {hours.toFixed(1)} hrs, about <b>{money(spend)}</b> in est. ad revenue. That ranks <b>#{rank} of {peers}</b> {home.market} {home.media === 'TV' ? 'TV' : 'radio'} stations.
      </p>

      <div className="ri-section-head"><h2>At-risk accounts</h2><span className="ri-count">cutting you, buying elsewhere</span></div>
      {atRisk.length === 0 ? (
        <div className="ri-beat ok"><b>✓ No advertiser is cutting {home.call} while growing elsewhere.</b></div>
      ) : (
        <div className="ri-beat threat">
          <b>⚠ {atRisk.length} advertiser{atRisk.length > 1 ? 's are' : ' is'} moving money away from you</b>
          <ul>
            {atRisk.map((r) => (
              <li key={r.name}>
                <b className="nm">{r.name}</b>
                <span className="muted">Spots on {home.call} {pct(r.onYou)} vs last week, while their total airtime is {pct(r.overall)}.</span>
                <span className="gap">Call them before it shrinks further.</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="ri-section-head"><h2>Your advertisers</h2><span className="ri-count">by est. spend on {home.call}</span></div>
      <ul className="ri-leads mine">
        {(all ? advs : advs.slice(0, 12)).map((r) => (
          <li key={r.name} className={r.atRisk ? 'risk' : ''}>
            <div className="top">
              <b>{r.name}</b>
              <b>{money(r.spend)}</b>
            </div>
            <p className="offer">{r.offer}</p>
            <div className="sub">
              <span>{r.cat}</span><span>{r.spins} spots</span>
              <span>on you this wk: {pct(r.onYou)}</span>
              {r.atRisk && <span className="ri-vs-badge them">At risk</span>}
            </div>
          </li>
        ))}
      </ul>
      {advs.length > 12 && <button type="button" className="ri-more" onClick={() => setAll(!all)}>{all ? 'Show top 12' : `Show all ${advs.length}`}</button>}

      <div className="ri-section-head"><h2>Latest spots on {home.call}</h2><span className="ri-count">tap for the full ad</span></div>
      <ul className="ri-feed">
        {onHome.slice(0, 8).map((d) => <FeedCard key={d.id} d={d} now={now} onOpen={onOpen} />)}
      </ul>
    </>
  );
}

function StationsView({ events, now, onAdvertiser, onOpen }) {
  const [home, setHome] = useState(() => store('ri.home', 'KISW'));
  const [view, setView] = useState('mine');
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

      <div className="ri-seg" role="tablist" aria-label="Station view">
        {[['mine', `My station (${homeStation.call})`], ['vs', 'Vs other stations']].map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} className={view === id ? 'on' : ''} onClick={() => setView(id)}>{label}</button>
        ))}
      </div>

      {view === 'mine' && (() => {
        const peers = STATIONS.filter((s) => s.market === homeStation.market && s.media === homeStation.media);
        const ranked = [...peers].sort((a, b) => (perStation.get(b.id)?.spend || 0) - (perStation.get(a.id)?.spend || 0));
        return (
          <MyStation key={home} events={events} home={homeStation} hours={hours} now={now} peers={peers.length}
            rank={ranked.findIndex((s) => s.id === home) + 1} onAdvertiser={onAdvertiser} onOpen={onOpen} />
        );
      })()}

      {view === 'vs' && (
      <>
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
              <b>{l.name}</b>
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
                  <b>{l.name}</b>
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
      </>
      )}

      {view === 'mine' && (
      <>
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
      </>
      )}
      <p className="muted small">Radio call signs and frequencies come from public market lists (full-power commercial band). Seattle TV is the 8 main broadcast stations. Advertisers, spot counts, spend and stream status are simulated for this demo.</p>
    </>
  );
}

// ------------------------------------------------------------------ export

function ExportView({ rows, market, city = 'All', category, query, media, watchlist, toggleWatch, alertsOn, setAlertsOn, beatAlerts, setBeatAlerts, me, notify }) {
  const scope = [media === 'Both' ? 'Radio + TV' : media, market === 'All' ? 'All markets' : `${market} metro`, city !== 'All' && city, category === 'All' ? 'all categories' : category, query && `"${query}"`].filter(Boolean).join(', ');
  const feedUrl = `https://api.radiointel.network/v1/feed.csv?market=${market === 'All' ? 'all' : encodeURIComponent(market.toLowerCase())}${city !== 'All' ? `&city=${encodeURIComponent(city.toLowerCase())}` : ''}&key=YOUR_CLIENT_KEY`;
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

      <div className="ri-section-head"><h2>Alerts</h2><span className="ri-count">{watchlist.length} watched</span></div>
      <div className="ri-panel">
        <label className="ri-switch">
          <input id="ri-beat-alerts" type="checkbox" checked={beatAlerts} onChange={(e) => setBeatAlerts(e.target.checked)} />
          <span><b>Beat alert:</b> tell me when a competitor airs a deal that beats {me}’s (true monthly cost, same market)</span>
        </label>
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
        <p className="muted small">In this demo, alerts pop up inside the app. Text and phone push alerts, plus new-advertiser and gone-dark alerts, switch on with live data. <span className="tag amber">Needs API</span></p>
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
