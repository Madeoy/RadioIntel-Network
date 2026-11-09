import React, { useState, useEffect, useMemo, useRef } from 'react';
import './App.css';
import {
  HOME_MARKET, MARKETS, STATIONS, TV_STATIONS, CATEGORIES, DAYPARTS, TV_DAYPARTS, OFFER_CHANGES, PRICE_HISTORY, WEEKS, DAYS, EXPORT_COLUMNS,
  CREATIVES, MARKET_MOVES, CITIES_BY_MARKET, cityOf,
  seedDetections, makeDetection, heatGrid, airingHistory, CHECK_MAX_DAYS, daypartFor, tvDaypartFor, weekOverWeek, toTSV, toCSV,
} from './data.js';
import { WEB_CAPTURED, WEB_SITES, WEB_OFFERS } from './webdeals.js';
import { ROSTER } from './roster.js';
import { fetchReal } from './real.js';

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
// status: 'them' = their deal is lower than yours, 'you' = yours is better, 'even' = within a few dollars.
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
      short: status === 'them' ? `${money(gap)}/mo lower than yours` : status === 'you' ? `Yours is ${money(-gap)}/mo lower` : 'About even with you',
    };
  }
  if (ta.cashOff && ya.cashOff) {
    const gap = ta.cashOff - ya.cashOff; // above 0 = they give more off
    const status = Math.abs(gap) < 250 ? 'even' : gap > 0 ? 'them' : 'you';
    const side = (a) => ({ veh: a.vehicle, big: `${money(a.cashOff)} off`, sub: a.apr != null ? `or ${a.apr}% APR` : a.deal, tru: '' });
    return {
      status, gap: Math.abs(gap), sameBody: ta.body === ya.body, them: side(ta), you: side(ya),
      short: status === 'them' ? `${money(gap)} more off than yours` : status === 'you' ? `Yours gives ${money(-gap)} more off` : 'About even with you',
    };
  }
  return null;
}

// The market a business advertises in (null = national, shows everywhere).
function advMarket(name) {
  const c = dealOf(name) || CREATIVES.find((x) => x.advertiser === name);
  if (c) return c.market || null;
  // Businesses with no ad on air right now (gone quiet, price history) still belong to one market.
  const m = [...MARKET_MOVES, ...OFFER_CHANGES, ...PRICE_HISTORY].find((x) => x.advertiser === name);
  if (m) return m.market || null;
  return WEB_SITES.some((x) => x.dealer === name) || ROSTER.some((x) => x.name === name) ? 'Seattle' : null;
}
const sameMarket = (name, market) => !market || market === 'All' || !advMarket(name) || advMarket(name) === market;

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

function useIsPhone() {
  const q = '(max-width: 1023px)';
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

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
  const [tab, setTab] = useState('today');
  const [events, setEvents] = useState(() => seedDetections());
  // Real ads from the Seattle recorder (only when the app is opened from the server).
  const [real, setReal] = useState(null);
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
  // Station to open in Live > One station (set from a Stations stream row).
  const [onAir, setOnAir] = useState(null);
  const openStation = (id) => { setOnAir(id || 'pick'); setTab('live'); window.scrollTo({ top: 0 }); };
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
          setToast({ kind: 'threat', text: `${beat.d.creative.advertiser} just aired a lower deal than yours`, sub: `${beat.cmp.short} · ${beat.d.station.call}`, detection: beat.d });
        } else if (hit) {
          lastAlert.current = ts;
          setToast({ kind: 'alert', text: `${hit.creative.advertiser} just aired on ${hit.station.call}`, sub: hit.creative.offer.headline, detection: hit });
        }
      }
    }, LIVE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [live]);

  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const r = await fetchReal();
        if (stop) return;
        setReal(r);
        const cut = Date.now() - WINDOW_MS;
        setEvents((prev) => [...prev.filter((d) => !d.real), ...r.events.filter((d) => d.ts > cut)].sort((a, b) => b.ts - a.ts));
      } catch { /* demo site: no feed */ }
    };
    pull();
    const id = setInterval(pull, 20000);
    return () => { stop = true; clearInterval(id); };
  }, []);

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
      if (!d.real && d.confidence < adv.minConf) return false;
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
  // An empty name means "None · just browse": nothing is compared, the market and watchlist stay as they are.
  const chooseMe = (name) => {
    setMe(name);
    if (!name) return;
    const c = dealOf(name) || CREATIVES.find((x) => x.advertiser === name);
    if (c) {
      if (c.market) setMarket(c.market);
      setCategory('All'); setCity('All'); setQuery('');
      setWatchlist(rivalsFor(name));
    }
    // Real website dealers and the watch roster are all Seattle-area.
    else if (WEB_SITES.some((s) => s.dealer === name) || ROSTER.some((r) => r.name === name)) { setMarket('Seattle'); setCity('All'); }
  };
  // One market at a time: switching market also moves "Insights on" to a business in that market.
  const marketOf = (name) => {
    const c = dealOf(name) || CREATIVES.find((x) => x.advertiser === name);
    if (c) return c.market || null;
    return WEB_SITES.some((s) => s.dealer === name) || ROSTER.some((r) => r.name === name) ? 'Seattle' : null;
  };
  const changeMarket = (m) => {
    setMarket(m);
    const mm = me ? marketOf(me) : null;
    if (m === 'All' || !mm || mm === m) return;
    const cat = (dealOf(me) || CREATIVES.find((x) => x.advertiser === me))?.category || 'Auto Dealer';
    const pick = CREATIVES.find((x) => x.market === m && x.category === cat && x.auto) || CREATIVES.find((x) => x.market === m && x.category === cat) || CREATIVES.find((x) => x.market === m);
    if (pick) chooseMe(pick.advertiser);
  };
  const notify = (text, sub) => setToast({ kind: 'info', text, sub });
  const showAdvertiser = (name) => {
    setQuery(name);
    setCategory('All');
    setTab('live');
    window.scrollTo({ top: 0 });
  };

  const filterProps = { market, setMarket: changeMarket, category, setCategory, city, setCity, query, setQuery, adv, setAdv, media, setMedia };

  return (
    <div className="ri-app">
      <Header real={real} live={live} setLive={setLive} me={me} chooseMe={chooseMe} watchCount={watchlist.filter((n) => n !== me).length} market={market} />

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
        {tab === 'today' && real && <RealToday real={real} now={now} onOpen={setSelected} />}
        {tab === 'today' && <TodayView events={events} now={now} me={me} watchlist={watchlist} toggleWatch={toggleWatch} onOpen={setSelected} goTo={setTab} market={market} />}
        {tab === 'live' && (
          <LiveView events={filtered} allEvents={events} allCount={events.length} now={now} onOpen={setSelected}
            watchlist={watchlist} goTo={setTab} me={me} onAir={onAir} clearOnAir={() => setOnAir(null)} {...filterProps} />
        )}
        {tab === 'deals' && <DealsView events={filtered} onAdvertiser={showAdvertiser} me={me} chooseMe={chooseMe} filterProps={filterProps} />}
        {tab === 'market' && (
          <MarketView events={filtered} crossMedia={crossMedia} allEvents={events} watchlist={watchlist} toggleWatch={toggleWatch}
            onAdvertiser={showAdvertiser} me={me} setMe={setMe} filterProps={filterProps} />
        )}
        {tab === 'check' && <CheckView events={events} now={now} me={me} onOpen={setSelected} notify={notify} />}
        {tab === 'stations' && <StationsView events={events} now={now} onAdvertiser={showAdvertiser} onOpen={setSelected} openStation={openStation} />}
        {tab === 'sheets' && (
          <SheetsView rows={filtered} market={market} city={city} category={category} query={query} media={media}
            watchlist={watchlist} toggleWatch={toggleWatch} alertsOn={alertsOn} setAlertsOn={setAlertsOn}
            beatAlerts={beatAlerts} setBeatAlerts={setBeatAlerts} me={me} notify={notify} />
        )}
      </main>

      <BottomNav tab={tab} setTab={setTab} />

      {selected && (
        <DetailSheet d={selected} onClose={() => setSelected(null)} watched={watchlist.includes(selected.creative.advertiser)}
          toggleWatch={toggleWatch} notify={notify} me={me} events={events} />
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
  // market: null = national (shows in every market). Website dealers and the watch roster are Seattle-area.
  const add = (name, group, meta, market) => { if (!seen.has(name)) { seen.add(name); out.push({ name, group, meta, market }); } };
  for (const c of CREATIVES) add(c.advertiser, 'air', [c.category, c.city || c.market || 'National'].filter(Boolean).join(' · '), c.market || null);
  for (const s of WEB_SITES) add(s.dealer, 'web', ['Auto Dealer', s.city].filter(Boolean).join(' · '), 'Seattle');
  for (const r of ROSTER) add(r.name, 'watch', [r.category, r.area].filter(Boolean).join(' · '), 'Seattle');
  return out.sort((a, b) => a.name.localeCompare(b.name));
})();
const GROUPS = [['none', ''], ['air', 'On air now · demo ads'], ['web', 'Website deals · real'], ['watch', 'Watching · no ads heard yet'], ['other', 'Other markets']];

function MeBar({ me, chooseMe, watchCount, market = 'All' }) {
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
  // Only the selected market (plus national brands). Typed names from other markets go under "Other markets".
  const inMkt = (d) => market === 'All' || !d.market || d.market === market;
  const hits = showAll ? DIRECTORY : DIRECTORY.filter((d) =>
    `${d.name} ${d.meta}`.toLowerCase().includes(q) || (siteHit && d.name === siteHit.dealer));
  const list = [...hits.filter(inMkt), ...(showAll ? [] : hits.filter((d) => !inMkt(d)).map((d) => ({ ...d, group: 'other', meta: `${d.meta} · ${d.market}` })))];
  // "None · just browse" sits at the top of the full list, or when typed.
  const noneRow = { name: '', group: 'none', meta: 'See every ad without comparing to anyone' };
  const wantsNone = showAll || /^(none|browse|just|no )/.test(q);
  const ordered = [...(wantsNone ? [noneRow] : []), ...GROUPS.flatMap(([g]) => list.filter((d) => d.group === g))];

  const pick = (name) => {
    setOpen(false);
    setText(name);
    if (name !== me) chooseMe(name);
    document.activeElement?.blur();
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, ordered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Escape') { setOpen(false); setText(me); }
  };
  const submit = (e) => {
    e.preventDefault();
    // Cleared the box and pressed Go: just browse.
    if (!text.trim()) { pick(''); return; }
    if (showAll) { setOpen(false); document.activeElement?.blur(); return; }
    const row = ordered[hi] || ordered[0];
    pick(row ? row.name : text.trim());
  };

  const c = dealOf(me) || CREATIVES.find((x) => x.advertiser === me);
  const site = WEB_SITES.find((s) => s.dealer === me);
  const status = !me
    ? 'Just browsing · no business picked. Pick one to compare every ad against it.'
    : c
    ? `${c.category} · ${c.market || 'all markets'} · comparing with ${watchCount} competitor${watchCount === 1 ? '' : 's'}`
    : site ? 'Not heard on air yet · real website deals in Deals › On their websites'
      : 'Watching · no ads heard yet. Data starts the moment they air.';
  let i = -1;
  return (
    <form className="ri-mebar" onSubmit={submit} role="search" ref={box}>
      <label htmlFor="ri-me-input">Insights on</label>
      <div className="ri-combo">
        <input id="ri-me-input" type="text" value={text} autoComplete="off" enterKeyHint="go"
          placeholder="None · just browsing (type a business)" role="combobox" aria-expanded={open} aria-controls="ri-me-list"
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
                  {label && <li className="ri-combo-group" role="presentation">{label} <span>{rows.length}</span></li>}
                  {rows.map((d) => {
                    i += 1;
                    const n = i;
                    return (
                      <li key={d.name || '(none)'} role="option" aria-selected={n === hi}
                        className={`ri-combo-opt ${g === 'none' ? 'none' : ''} ${n === hi ? 'hi' : ''} ${d.name === me ? 'cur' : ''}`}
                        onPointerDown={(e) => e.preventDefault()} onClick={() => pick(d.name)} onPointerEnter={() => setHi(n)}>
                        <span className="nm">{d.name || 'None · just browse'}</span><span className="meta">{d.meta}</span>
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

function Header({ real, live, setLive, me, chooseMe, watchCount, market = 'All' }) {
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
          <span className="ri-node"><span className="wide">Node </span>{market === 'All' ? 'All markets' : `${market}-01`} ·{clock.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>
        </div>
      </div>
      <div className="ri-header-actions">
        {real
          ? <span className="ri-demo ri-real" title="Real ads recorded on 6 Seattle stations are mixed in and marked Real; everything else is demo">Real<span className="wide"> + demo</span></span>
          : <span className="ri-demo" title="Station names are real; every detection and offer is simulated">Demo<span className="wide"> data</span></span>}
        <button type="button" className={`ri-live ${live ? 'on' : ''}`} onClick={() => setLive(!live)} aria-pressed={live}>
          <span className="dot" />{live ? 'Live' : 'Paused'}
        </button>
      </div>
      <MeBar me={me} chooseMe={chooseMe} watchCount={watchCount} market={market} />
    </header>
  );
}

// Phone bar: the first five plus More. A computer shows all of them in the side menu.
const NAV = [
  ['today', 'Today', 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'],
  ['live', 'Live', 'M3 12h3l3-8 4 16 3-8h5'],
  ['deals', 'Deals', 'M20 12l-8 8-9-9V3h8zM7.5 7.5h.01'],
  ['market', 'Market', 'M3 3v18h18M7 15l4-4 3 3 6-7'],
  ['check', 'My Ads', 'M9 12l2 2 4-4M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18'],
  ['sheets', 'Sheets & Alerts', 'M4 4h16v16H4zM4 10h16M4 15h16M10 4v16', true],
  ['stations', 'Stations', 'M5 9a10 10 0 0 1 14 0M8 12a6 6 0 0 1 8 0M12 15v6M9 21h6', true],
];

function NavIcon({ path }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function BottomNav({ tab, setTab }) {
  const [more, setMore] = useState(false);
  const go = (id) => { setTab(id); setMore(false); window.scrollTo({ top: 0 }); };
  const inMore = NAV.some((n) => n[3] && n[0] === tab);
  return (
    <>
      {more && (
        <div className="ri-more-wrap" onClick={() => setMore(false)}>
          <div className="ri-more-menu" role="menu" onClick={(e) => e.stopPropagation()}>
            {NAV.filter((n) => n[3]).map(([id, label, path]) => (
              <button key={id} type="button" role="menuitem" className={tab === id ? 'active' : ''} onClick={() => go(id)}>
                <NavIcon path={path} />
                <span><b>{label}</b><small>{id === 'stations' ? 'For station sales teams' : 'Your data in Google Sheets, plus alert settings'}</small></span>
              </button>
            ))}
          </div>
        </div>
      )}
      <nav className="ri-nav" aria-label="Sections">
        {NAV.map(([id, label, path, extra]) => (
          <button key={id} type="button" className={`${tab === id ? 'active' : ''} ${extra ? 'extra' : ''}`} onClick={() => go(id)}>
            <NavIcon path={path} /><span>{label}</span>
          </button>
        ))}
        <button type="button" className={`more ${more || inMore ? 'active' : ''}`} onClick={() => setMore(!more)} aria-expanded={more}>
          <NavIcon path="M5 12h.01M12 12h.01M19 12h.01" /><span>More</span>
        </button>
      </nav>
    </>
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

// compact: phone-first. Search plus one "Filters" button; media, market, category, city and the rest open below it.
function Filters({ market, setMarket, category, setCategory, city, setCity, query, setQuery, adv, setAdv, media, setMedia, showSearch = true, showAdvanced = true, compact = false }) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState(false);
  const count = adv ? activeAdvCount(adv) : 0;
  const set = (k, v) => setAdv({ ...adv, [k]: v });
  const tvMissing = media === 'TV' && market !== 'All' && market !== 'Seattle';
  const search = showSearch && (
    <input id="ri-search" type="search" placeholder="Search advertiser, city, offer, vehicle, code…" value={query}
      onChange={(e) => setQuery(e.target.value)} aria-label="Search detections" />
  );
  if (compact) {
    const changed = (category !== 'All') + (city && city !== 'All' ? 1 : 0) + (media && media !== 'Radio' ? 1 : 0) + count;
    return (
      <div className="ri-filters-wrap">
        <div className="ri-quick">
          {search}
          <button type="button" className={`ri-filter-btn ${panel || changed ? 'on' : ''}`} onClick={() => setPanel(!panel)} aria-expanded={panel}>
            {search ? 'Filters' : [market === 'All' ? 'All markets' : market, media === 'Both' ? 'Radio + TV' : media, category !== 'All' ? category : 'All categories', city && city !== 'All' ? city : null].filter(Boolean).join(' · ')}{changed ? ` · ${changed} set` : ''} <span aria-hidden="true">{panel ? '▴' : '▾'}</span>
          </button>
        </div>
        {tvMissing && <p className="ri-note">TV monitoring covers Seattle in this demo. Switch the market to Seattle to see TV spots.</p>}
        {panel && (
          <div className="ri-filter-panel">
            <Filters {...{ market, setMarket, category, setCategory, city, setCity, query, setQuery, adv, setAdv, media, setMedia, showAdvanced }} showSearch={false} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="ri-filters-wrap">
      {setMedia && <MediaSwitch media={media} setMedia={setMedia} />}
      {tvMissing && <p className="ri-note">TV monitoring covers Seattle in this demo. Switch the market to Seattle to see TV spots.</p>}
      <div className="ri-filters">
        {search}
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
// Top-of-panel summary: how deals on air in your market compare with yours right now.
function BeatBanner({ me, watchlist, toggleWatch }) {
  const mine = dealOf(me);
  if (!me) return <p className="ri-note">Just browsing. Pick a business in “Insights on” to see how deals on air compare with theirs.</p>;
  if (!mine) {
    return <p className="ri-note">Deal-vs-deal checks cover car dealers for now. Airtime, share of voice and momentum work for every category.</p>;
  }
  const beats = dealsBeatingMe(me);
  if (beats.length === 0) {
    return <div className="ri-beat ok"><b>✓ Your deal is the lowest car deal on air in {mine.market} right now.</b></div>;
  }
  return (
    <div className="ri-beat threat">
      <b>{beats.length} deal{beats.length > 1 ? 's' : ''} on air {beats.length > 1 ? 'are' : 'is'} lower than yours</b>
      <ul>
        {beats.map(({ name, cmp }) => (
          <li key={name}>
            <span className="nm">{name}</span>
            <span className="muted">{cmp.them.veh} · {cmp.them.big}{cmp.them.tru ? ` · ${cmp.them.tru}` : ''}</span>
            <span className="gap">{cmp.short}</span>
            {!watchlist.includes(name) && <button type="button" className="ri-chip" onClick={() => toggleWatch(name)}>☆ Track</button>}
          </li>
        ))}
      </ul>
      <p className="muted small">Compared on true monthly cost: the payment plus money due at signing, spread over the term. Vehicles differ, so judge the fit.</p>
    </div>
  );
}

// "What changed": the 4 things that matter most this week for the Insights-on business.
// Order: a change that now beats you, price changes, airtime swings, new ads, gone quiet.
function WhatChanged({ me, watchlist, events, onOpen }) {
  const [all, setAll] = useState(false);
  const mine = dealOf(me) || CREATIVES.find((c) => c.advertiser === me);
  if (!me) return null;
  if (!mine) {
    return (
      <section className="ri-changed empty">
        <span className="ri-eyebrow">What changed this week</span>
        <p>{me} isn't on air yet. Changes from their competitors show here once we hear them.</p>
      </section>
    );
  }
  const items = [];
  // One market at a time: a watched business from another market never shows here.
  for (const n of watchlist.filter((x) => x !== me && sameMarket(x, mine.market))) {
    const parts = []; let pri = 9; let ic = ''; let priced = false;
    const ch = OFFER_CHANGES.find((x) => x.advertiser === n);
    const h = PRICE_HISTORY.find((x) => x.advertiser === n);
    if (ch) { parts.push(`changed ${ch.product}: ${ch.from} → ${ch.to} (${ch.date})`); pri = 1; ic = '⇄'; priced = true; }
    else if (h && h.values[h.values.length - 1] !== h.values[h.values.length - 2]) {
      const a = h.values[h.values.length - 2]; const b = h.values[h.values.length - 1];
      const better = h.lowerIsBetter ? b < a : b > a;
      parts.push(`${better ? (h.lowerIsBetter ? 'cut' : 'deepened') : (h.lowerIsBetter ? 'raised' : 'shrank')} ${h.product}: ${fmtUnit(a, h.unit)} → ${fmtUnit(b, h.unit)}`);
      pri = 1; ic = better && h.lowerIsBetter ? '▼' : '▲'; priced = true;
    }
    const t = trendOf(n);
    if (Math.abs(t.pct) >= 0.3) {
      parts.push(`${t.pct > 0 ? 'upped' : 'cut'} airtime ${Math.round(Math.abs(t.pct) * 100)}% (${t.w.last} → ${t.w.now} spots)`);
      if (pri > 2) { pri = 2; ic = t.pct > 0 ? '▲' : '▼'; }
    }
    const nc = CREATIVES.find((c) => c.advertiser === n && c.isNew);
    if (nc) { parts.push(`started a new ad: ${nc.offer.headline}`); if (pri > 3) { pri = 3; ic = '✦'; } }
    const cmp = compareDeals(n, me);
    const beats = cmp && cmp.status === 'them';
    if (beats) {
      const s = cmp.short.charAt(0).toLowerCase() + cmp.short.slice(1);
      // "now" only when their deal itself changed; an airtime swing doesn't change who's cheaper.
      parts.push(priced ? `now ${s}` : `${s} (${cmp.them.veh})`);
      pri = priced ? 0 : Math.min(pri, 1.5);
      ic = '⚠';
    }
    if (parts.length) items.push({ n, pri, ic, parts, beats });
  }
  for (const m of MARKET_MOVES) {
    if (m.market !== mine.market || m.category !== mine.category || m.advertiser === me || items.some((i) => i.n === m.advertiser)) continue;
    items.push({ n: m.advertiser, pri: 3, ic: m.kind === 'dark' ? '◌' : '✦', parts: [m.kind === 'dark' ? `went quiet: ${m.note}` : `started advertising: ${m.note}`] });
  }
  items.sort((a, b) => a.pri - b.pri);
  const top = all ? items : items.slice(0, 3);
  return (
    <section className="ri-changed" aria-label="What changed this week">
      <div className="ri-changed-head">
        <span className="ri-eyebrow">What changed this week · vs {me}</span>
        {items.length > 0 && <span className="ri-count">{items.length} change{items.length === 1 ? '' : 's'}</span>}
      </div>
      {top.length === 0 && <p className="ri-changed-none">No changes from your competitors this week.</p>}
      <ul>
        {top.map((x) => {
          const latest = events.find((e) => e.creative.advertiser === x.n);
          return (
            <li key={x.n}>
              <button type="button" className={x.beats ? 'threat' : ''} disabled={!latest} onClick={() => latest && onOpen(latest)}>
                <span className="ic" aria-hidden="true">{x.ic}</span>
                <span className="tx"><b>{x.n}</b> {x.parts.join(' · ')}</span>
                {latest && <span className="go" aria-hidden="true">›</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {items.length > 3 && (
        <button type="button" className="ri-changed-more" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${items.length}`}</button>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ grouped tabs

// Small section switch used at the top of the grouped tabs. Remembers the last pick per tab.
function Sections({ id, items, value, onChange }) {
  return (
    <div className="ri-seg ri-sections" role="tablist" aria-label={id}>
      {items.map(([k, label]) => (
        <button key={k} type="button" role="tab" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  );
}
function useSection(key, fallback) {
  const [v, setV] = useState(() => store(key, fallback));
  useEffect(() => save(key, v), [key, v]);
  return [v, setV];
}

// Deals: what competitors are offering, on air and on their own websites.
function DealsView({ events, onAdvertiser, me, chooseMe, filterProps }) {
  const [part, setPart] = useSection('ri.part.deals', 'air');
  return (
    <>
      <p className="ri-purpose"><b>Deals</b> shows exactly what your competitors are offering shoppers, so you can see how yours compares.</p>
      <Sections id="Deals" value={part} onChange={setPart} items={[['air', 'In their ads'], ['web', 'On their websites']]} />
      {part === 'air' && <OffersView events={events} onAdvertiser={onAdvertiser} me={me} {...filterProps} />}
      {part === 'web' && <WebDealsView me={me} chooseMe={chooseMe} />}
    </>
  );
}

// Market: where the money and the airtime go, when, and how prices move.
function MarketView({ events, crossMedia, allEvents, watchlist, toggleWatch, onAdvertiser, me, setMe, filterProps }) {
  const phone = useIsPhone();
  const [part, setPart] = useSection('ri.part.market', 'spend');
  const purpose = {
    spend: 'Who is spending the most on advertising, who is speeding up or slowing down, and your share of it.',
    timing: 'When ads run, hour by hour, so you can buy the best time slots.',
    prices: 'How each advertised deal has moved over the last 8 weeks.',
    media: 'Which channels each business is on (radio, TV, cable, streaming) and where you have gaps.',
  }[part];
  return (
    <>
      <p className="ri-purpose"><b>Market</b>: {purpose}</p>
      <Sections id="Market" value={part} onChange={setPart} items={[['spend', 'Spending'], ['timing', 'Timing'], ['prices', 'Prices'], ['media', 'All media']]} />
      {part !== 'media' && <Filters {...filterProps} showSearch={false} showAdvanced={false} compact={phone} />}
      {part === 'media'
        ? <MixView crossMedia={crossMedia} market={filterProps.market} category={filterProps.category} me={me} setMe={setMe} onAdvertiser={onAdvertiser} />
        : <TrendsView part={part} events={events} crossMedia={crossMedia} allEvents={allEvents} watchlist={watchlist} toggleWatch={toggleWatch} onAdvertiser={onAdvertiser} me={me} {...filterProps} />}
    </>
  );
}

// Station sellers: advertisers leaning on one medium, worth a pitch for the other.
function StationProspects({ events, home }) {
  const [opp, setOpp] = useState(null);
  if (home.market !== 'Seattle') return null;
  const gaps = mediaGaps(events.filter((d) => d.station.market === 'Seattle'));
  return (
    <>
      <div className="ri-section-head"><h2>{home.media === 'TV' ? 'Mostly radio: pitch them TV' : 'Mostly TV: pitch them radio'} <span className="ri-premium">Station Premium</span></h2><span className="ri-count">85%+ of spend on one medium, {PERIOD}</span></div>
      <GapList rows={home.media === 'TV' ? gaps.needTv : gaps.needRadio} pitch={home.media === 'TV' ? 'tv' : 'radio'} onPick={setOpp} />
      {opp && <OpportunitySheet o={opp} onClose={() => setOpp(null)} />}
    </>
  );
}

// ------------------------------------------------------------------ live

function LiveView({ events, allEvents, allCount, now, onOpen, watchlist, goTo, me, onAir, clearOnAir, ...filters }) {
  const [limit, setLimit] = useState(FEED_PAGE);
  const [view, setView] = useState(onAir ? 'station' : 'all');
  const [stationId, setStationId] = useState(() => (onAir && onAir !== 'pick' ? onAir : store('ri.home', 'KISW')));
  useEffect(() => {
    if (!onAir) return;
    setView('station');
    if (onAir !== 'pick') setStationId(onAir);
    clearOnAir();
  }, [onAir]); // eslint-disable-line react-hooks/exhaustive-deps
  const tracked = [me, ...watchlist].filter(Boolean);
  const shown = view === 'mine' ? events.filter((d) => tracked.includes(d.creative.advertiser)) : events;
  return (
    <>
      <Sections id="Feed view" value={view} onChange={(v) => { setView(v); setLimit(FEED_PAGE); }}
        items={[['all', 'Every ad'], ['mine', 'Competitors'], ['station', 'One station']]} />
      {view === 'station' ? (
        <StationLive events={allEvents} now={now} stationId={stationId} setStationId={setStationId} onOpen={onOpen} />
      ) : (
        <>
          <Filters {...filters} compact />
          <Kpis events={shown} market={filters.market} media={filters.media} category={filters.category} now={now} />
          <div className="ri-section-head">
            <h2><span className="ri-live-dot" aria-hidden="true" />{view === 'mine' ? 'You and your competitors' : 'Every ad, as it airs'}</h2>
            <span className="ri-count">{shown.length.toLocaleString('en-US')} of {allCount.toLocaleString('en-US')} spots · last 3 hrs</span>
          </div>
          <p className="ri-feed-explain">
            Newest on top. Tap any ad for the full offer and how it compares with yours.{' '}
            <button type="button" className="ri-link" onClick={() => { goTo('sheets'); window.scrollTo({ top: 0 }); }}>Get this in Google Sheets →</button>
          </p>
          {view === 'mine' && tracked.length <= 1 && <p className="ri-empty">You're not tracking any competitors yet. Add them on Today.</p>}
          {shown.length === 0 && <p className="ri-empty">No spots match these filters. Clear the search or loosen a filter.</p>}
          <ul className="ri-feed">
            {shown.slice(0, limit).map((d) => <FeedCard key={d.id} d={d} now={now} onOpen={onOpen} />)}
          </ul>
          {shown.length > limit && (
            <button type="button" className="ri-more" onClick={() => setLimit(limit + FEED_PAGE)}>Show {Math.min(FEED_PAGE, shown.length - limit)} more</button>
          )}
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ today (home: you vs your competitors)
// One screen that answers "how am I doing against my competitors right now?"
// On a computer it's a 3-column board meant to stay open all day; on a phone it stacks.

// Your share of all spots in your category and market (last 3 hrs).
function shareOfVoice(events, me) {
  const mine = dealOf(me) || CREATIVES.find((c) => c.advertiser === me);
  if (!mine) return null;
  const pool = events.filter((d) => d.creative.category === mine.category && (!mine.market || d.station.market === mine.market));
  if (!pool.length) return null;
  const by = new Map();
  for (const d of pool) by.set(d.creative.advertiser, (by.get(d.creative.advertiser) || 0) + 1);
  const ranked = [...by.entries()].sort((a, b) => b[1] - a[1]);
  const idx = ranked.findIndex(([n]) => n === me);
  return { pct: Math.round(((by.get(me) || 0) / pool.length) * 100), rank: idx + 1, of: ranked.length, leader: ranked[0][0], cat: mine.category, market: mine.market };
}

function Tile({ label, value, sub, tone = '', def, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`ri-tile ${tone} ${onClick ? 'tap' : ''}`} onClick={onClick}>
      <span className="l">{label}</span>
      <span className="v">{value}</span>
      {sub && <span className="s">{sub}</span>}
      {def && <span className="d">{def}</span>}
    </Tag>
  );
}

function Scoreboard({ events, me, now, goTo }) {
  const deal = dealOf(me);
  const mineAny = deal || CREATIVES.find((c) => c.advertiser === me);
  const sov = shareOfVoice(events, me);
  const mo = momentumOf(me);
  const mySpots = events.filter((d) => d.creative.advertiser === me);
  const kind = deal ? (deal.auto.monthly ? 'lease' : 'cash') : null;
  const board = deal ? rankBoard(deal.market, kind) : [];
  const pos = board.findIndex((x) => x.n === me) + 1;
  const beats = dealsBeatingMe(me);
  return (
    <section className="ri-tiles" aria-label={`Scoreboard for ${me}`}>
      {deal ? (
        <Tile label="Your deal" tone={beats.length ? 'them' : 'you'}
          value={pos ? `#${pos} of ${board.length}` : '–'}
          sub={beats.length ? `${beats.length} lower deal${beats.length > 1 ? 's' : ''} on air` : 'Yours is the lowest on air'}
          def={`Your ${kind === 'lease' ? 'lease' : 'cash-off'} deal ranked against every ${deal.market} dealer ${kind === 'lease' ? 'lease on air, by true monthly cost' : 'cash-off deal on air'}.`}
          onClick={() => goTo('deals')} />
      ) : (
        <Tile label="Your deal" value="–" sub={mineAny ? 'Deal ranking covers car dealers for now' : 'Not on air yet'} def="Ranks your advertised deal against your market." />
      )}
      <Tile label="Share of voice" value={sov && sov.rank ? `${sov.pct}%` : '0%'}
        sub={sov ? (sov.rank ? `#${sov.rank} of ${sov.of} ${sov.cat.toLowerCase()} advertisers${sov.rank !== 1 ? ` · leader ${sov.leader}` : ''}` : `Not heard · leader ${sov.leader}`) : 'No category ads heard yet'}
        def={`Your share of all ${sov ? sov.cat.toLowerCase() : 'category'} spots heard${sov?.market ? ` in ${sov.market}` : ''}, last 3 hrs.`}
        onClick={() => goTo('market')} />
      <Tile label="Your airtime" value={`${mo.pct > 0 ? '+' : ''}${Math.round(mo.pct * 100)}%`}
        sub={`${mo.last} → ${mo.now} spots, last week → this week`}
        def="How many spots you ran this week compared with last week, all stations." />
      <Tile label="Your ads heard" value={mySpots.length}
        sub={mySpots[0] ? `Last on ${mySpots[0].station.call}, ${ago(mySpots[0].ts, now)}` : 'None in the last 3 hrs'}
        def="Spots we heard from you in the last 3 hrs. Tap to check them against what you bought."
        onClick={() => goTo('check')} />
    </section>
  );
}

// One row per competitor: when they last aired, how much, which way they're trending, and their deal vs yours.
function CompetitorMeter({ events, me, watchlist, toggleWatch, now, onOpen, market }) {
  const mine = dealOf(me) || CREATIVES.find((c) => c.advertiser === me);
  const names = watchlist.filter((n) => n !== me && sameMarket(n, market));
  const rivals = mine
    ? [...new Set(CREATIVES.filter((c) => c.category === mine.category && c.advertiser !== me && (!mine.market || !c.market || c.market === mine.market)).map((c) => c.advertiser))]
        .filter((n) => !watchlist.includes(n)).sort()
    : [];
  const row = (name, isMe) => {
    const evs = events.filter((d) => d.creative.advertiser === name);
    const latest = evs[0];
    const mo = momentumOf(name);
    const cmp = isMe ? null : compareDeals(name, me);
    const d = dealOf(name);
    const dealTxt = d?.auto ? (d.auto.monthly ? `${money(d.auto.monthly)}/mo · ${money(d.auto.due)} due` : `${money(d.auto.cashOff)} off`) : (latest?.creative.offer.headline || (CREATIVES.find((c) => c.advertiser === name)?.offer.headline) || '–');
    const veh = d?.auto?.vehicle;
    return (
      <li key={name} className={`ri-meter-row ${isMe ? 'me' : ''} ${cmp?.status === 'them' ? 'them' : ''}`}>
        <button type="button" className="main" onClick={() => latest && onOpen(latest)} disabled={!latest}>
          <span className="c-name"><b>{name}</b>{isMe && <span className="ri-you-tag">You</span>}{cityOf(name) && <span className="muted"> {cityOf(name)}</span>}</span>
          <span className="c-last"><span className={`dot ${latest && now - latest.ts < 15 * 60000 ? 'on' : ''}`} />{latest ? `${ago(latest.ts, now)} · ${latest.station.call}` : 'Not heard, 3 hrs'}</span>
          <span className="c-num"><b>{evs.length}</b><small>spots</small></span>
          <span className={`c-mo ${mo.dir}`}>{mo.dir === 'up' ? '▲' : mo.dir === 'down' ? '▼' : '■'} {mo.pct > 0 ? '+' : ''}{Math.round(mo.pct * 100)}%</span>
          <span className="c-deal">{dealTxt}{veh && <small>{veh}</small>}</span>
          <span className="c-vs">{isMe ? <span className="muted small">baseline</span> : cmp ? <VsBadge cmp={cmp} /> : <span className="muted small" title="One is a lease and the other is cash off, so there's no fair dollar comparison">Different deal type</span>}</span>
        </button>
        {isMe ? <span className="ri-x-spacer" aria-hidden="true" /> : <button type="button" className="ri-x" onClick={() => toggleWatch(name)} aria-label={`Stop tracking ${name}`} title="Stop tracking">×</button>}
      </li>
    );
  };
  return (
    <section className="ri-panel ri-meter" aria-label="Competitor meter">
      <div className="ri-panel-head">
        <h2>Competitor meter</h2>
        <span className="ri-count">{names.length} tracked · tap a row for their latest ad</span>
      </div>
      <div className="ri-meter-cols" aria-hidden="true">
        <span>Business</span><span>Last heard</span><span>Spots · 3 hrs</span><span>Spots vs last wk</span><span>Current deal</span><span>Vs your deal</span>
      </div>
      <ul>
        {me && row(me, true)}
        {names.map((n) => row(n, false))}
      </ul>
      {names.length === 0 && <p className="muted small">You're not tracking anyone yet. Add a competitor below.</p>}
      {rivals.length > 0 && (
        <label className="ri-add-rival">
          <span>Track another</span>
          <select value="" onChange={(e) => e.target.value && toggleWatch(e.target.value)}>
            <option value="">+ Add {mine.category.toLowerCase()} competitor…</option>
            {rivals.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}
      <p className="ri-defs">
        <b>Spots vs last wk</b>: their spot count this week compared with last week (more airtime = pushing harder).{' '}
        <b>Vs your deal</b>: red = their deal costs a shopper less than yours, green = yours costs less, compared on true monthly cost (payment plus money due spread over the term).
      </p>
    </section>
  );
}

// Newest ads from you and the businesses you track.
// Real ads recorded today by the Seattle server, newest first. Fills in as breaks are heard.
function RealToday({ real, now, onOpen }) {
  const [open, setOpen] = useState(false);
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const today = real.events.filter((d) => d.ts >= start.getTime());
  const list = open ? today : today.slice(0, 8);
  const advs = new Set(today.map((d) => d.creative.advertiser)).size;
  const label = (st) => (typeof st.status === 'string' ? st.status : st.status?.status || st.status?.state || '');
  return (
    <section className="ri-panel ri-minifeed ri-realtoday" aria-label="Real ads heard today">
      <div className="ri-panel-head">
        <h2><span className="ri-live-dot" aria-hidden="true" />Real ads heard today</h2>
        <span className="ri-count">{today.length} plays · {advs} advertisers · updated {timeOf(real.at)}</span>
      </div>
      <p className="muted small">Recorded off the air on {real.stations.length} Seattle stations. Everything below this box is still demo data.</p>
      {real.stations.length > 0 && (
        <div className="ri-real-stations">
          {real.stations.map((st) => {
            const l = label(st);
            return <span key={st.call} className={`tag ${/BLACK|OFF|DOWN/i.test(l) ? 'amber' : ''}`} title={l}>{st.call}{/BREAK/i.test(l) ? ' · in break' : /BLACK/i.test(l) ? ' · blacked out' : ''}</span>;
          })}
        </div>
      )}
      {today.length === 0 && <p className="muted small">No ads heard yet today. They show up here within a few minutes of airing.</p>}
      <ul>
        {list.map((d) => (
          <li key={d.id}>
            <button type="button" className={now - d.ts < 15 * 60000 ? 'fresh' : ''} onClick={() => onOpen(d)}>
              <span className="t mono">{timeOf(d.ts)}</span>
              <span className="b"><b>{d.creative.advertiser}</b><span>{d.creative.offer.headline}</span></span>
              <span className="st">{d.station.call}</span>
            </button>
          </li>
        ))}
      </ul>
      {today.length > 8 && <button type="button" className="ri-btn ghost small" onClick={() => setOpen(!open)}>{open ? 'Show fewer' : `Show all ${today.length}`}</button>}
    </section>
  );
}

function MiniFeed({ events, names, now, onOpen, title, limit = 12, empty }) {
  const list = events.filter((d) => !names || names.includes(d.creative.advertiser)).slice(0, limit);
  return (
    <section className="ri-panel ri-minifeed" aria-label={title}>
      <div className="ri-panel-head"><h2><span className="ri-live-dot" aria-hidden="true" />{title}</h2><span className="ri-count">newest first</span></div>
      {list.length === 0 && <p className="muted small">{empty}</p>}
      <ul>
        {list.map((d) => (
          <li key={d.id}>
            <button type="button" className={now - d.ts < 10000 ? 'fresh' : ''} onClick={() => onOpen(d)}>
              <span className="t mono">{timeOf(d.ts)}</span>
              <span className="b"><b>{d.creative.advertiser}{d.real && <span className="tag real mini">Real</span>}</b><span>{d.creative.offer.headline}</span></span>
              <span className="st">{d.station.call}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Car dealers: "What can I adjust today?" Three cards, one plain suggestion each.
// Built only from ads on air (we never see a dealer's books), and worded neutrally: facts, not "beating you".
const fmtDay = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
function AdjustToday({ me, events, now, goTo }) {
  const [open, setOpen] = useState(false);
  const mine = dealOf(me);
  if (!mine || !mine.auto) return null;
  const mkt = mine.market;
  const a = mine.auto; const lease = !!a.monthly;

  // 1. Your deal vs the market
  const names = [...new Set(CREATIVES.filter((c) => c.auto && c.market === mkt && c.advertiser !== me).map((c) => c.advertiser))];
  const cmps = names.map((n) => ({ name: n, cmp: compareDeals(n, me) })).filter((x) => x.cmp);
  const lower = cmps.filter((x) => x.cmp.status === 'them').sort((x, y) => y.cmp.gap - x.cmp.gap);
  const higher = cmps.filter((x) => x.cmp.status === 'you');
  const even = cmps.filter((x) => x.cmp.status === 'even');
  const myLine = lease ? `${a.vehicle} lease is ${money(a.monthly)}/mo` : `${a.vehicle} deal is ${money(a.cashOff)} off`;
  // Only suggest a price move against the same kind of vehicle (sedan vs sedan, SUV vs SUV).
  const lowerSame = lower.filter((x) => x.cmp.sameBody);
  const kind = (a.body || 'vehicle').toLowerCase();
  const move1 = !cmps.length ? 'No similar deals on air in your market right now, so yours stands alone. Keep it on the air.'
    : lowerSame.length
      ? `${lease ? `About ${money(lowerSame[0].cmp.gap + 5)}/mo less in true monthly cost` : `About ${money(lowerSame[0].cmp.gap + 250)} more off`} would make yours the best ${kind} deal on air. Or keep your price and give shoppers another reason to call, like a weekend bonus.`
      : lower.length
        ? `The lower deal${lower.length > 1 ? 's are' : ' is'} on a different kind of vehicle, so yours is the best ${kind} deal on air. Keep it on the air so shoppers hear it.`
        : 'Yours is already the best deal on air. The move is to keep it on the air so shoppers hear it.';

  // 2. Where and when to be heard: stations with the fewest car ads
  const scoped = events.filter((d) => d.station.market === mkt);
  const isCar = (d) => d.creative.category === 'Auto Dealer';
  const byStation = {};
  for (const d of scoped) {
    const s = byStation[d.station.call] || (byStation[d.station.call] = { call: d.station.call, all: 0, car: 0, dp: {} });
    s.all += 1; if (isCar(d)) s.car += 1;
    const p = s.dp[d.daypart] || (s.dp[d.daypart] = { all: 0, car: 0 }); p.all += 1; if (isCar(d)) p.car += 1;
  }
  const lanes = Object.values(byStation).filter((s) => s.all >= 5).sort((x, y) => x.car / x.all - y.car / y.all || y.all - x.all);
  const best = lanes[0];
  const bestDp = best && Object.entries(best.dp).filter(([, v]) => v.all >= 2).sort((x, y) => x[1].car / x[1].all - y[1].car / y[1].all)[0];

  // 3. What's changing: only real changes from car dealers in your market
  const autoNames = new Set(names);
  const soon = now + 7 * 864e5;
  const changes = [
    ...OFFER_CHANGES.filter((c) => c.market === mkt && autoNames.has(c.advertiser))
      .map((c) => ({ ic: '⇄', text: <><b>{c.advertiser}</b> changed {c.product}: {c.from} → {c.to} ({c.date})</>, move: `${c.advertiser} changed their ${c.product} deal. Worth checking how yours compares on a similar model.` })),
    ...CREATIVES.filter((c) => c.auto && c.market === mkt && c.advertiser !== me && c.offer?.exp && Date.parse(c.offer.exp) >= now && Date.parse(c.offer.exp) <= soon)
      .map((c) => ({ ic: '⏱', text: <><b>{c.advertiser}</b>'s {c.auto.vehicle} deal ends {fmtDay(c.offer.exp)}</>, move: `${c.advertiser}'s deal ends ${fmtDay(c.offer.exp)}. Shoppers looking after that will be comparing fresh offers.` })),
    ...MARKET_MOVES.filter((m) => m.market === mkt && m.category === 'Auto Dealer' && m.advertiser !== me)
      .map((m) => m.kind === 'new'
        ? { ic: '★', text: <><b>{m.advertiser}</b> just started advertising ({m.date}). {m.note}</>, move: `${m.advertiser} is new on the air. Shoppers are hearing a new name, so it's a good week to keep yours steady.` }
        : { ic: '◌', text: <><b>{m.advertiser}</b> went quiet ({m.date}). {m.note}</>, move: `${m.advertiser} went quiet, so fewer car deals are on the air. That's more room for yours to be heard.` }),
  ].slice(0, 3);

  return (
    <section className="ri-adjust" aria-label="What can I adjust today">
      <div className="ri-adjust-head">
        <h2>What can I adjust today?</h2>
        <span className="muted small">{me} · {mkt} · from the ads on air</span>
      </div>
      <div className="ri-adjust-cards">
        <article className="ri-adjust-card">
          <span className="ri-eyebrow">1 · Your deal vs the market</span>
          <p className="ri-adjust-big">Your {myLine}.</p>
          {cmps.length > 0 && (
            <button type="button" className="ri-link" onClick={() => setOpen(!open)} aria-expanded={open}>
              {lower.length} lower · {higher.length} higher{even.length ? ` · ${even.length} about even` : ''} {open ? '▴' : '▾'}
            </button>
          )}
          {open && (
            <ul className="ri-adjust-list">
              {[...lower, ...even, ...higher].map(({ name, cmp }) => (
                <li key={name}><b>{name}</b><span className="muted">{cmp.them.veh} · {cmp.them.big}</span><span className={`ri-vs-badge ${cmp.status}`}>{cmp.short}</span></li>
              ))}
            </ul>
          )}
          <p className="ri-adjust-move"><b>Today's move:</b> {move1}</p>
        </article>
        <article className="ri-adjust-card">
          <span className="ri-eyebrow">2 · Where and when to be heard</span>
          {best ? (
            <>
              <p className="ri-adjust-big">{best.call} played {best.car} car ad{best.car === 1 ? '' : 's'} out of {best.all}.</p>
              {lanes[1] && <p className="muted small">Next: {lanes[1].call}, {lanes[1].car} of {lanes[1].all}. Counted over the {PERIOD}.</p>}
              <p className="ri-adjust-move"><b>Today's move:</b> Fewer car ads there means more room for your deal to stand out. Ask your rep about {bestDp ? bestDp[0] : 'open times'} on {best.call}.</p>
            </>
          ) : <p className="muted">Not enough ads heard in {mkt} yet. This fills in as the day goes on.</p>}
        </article>
        <article className="ri-adjust-card">
          <span className="ri-eyebrow">3 · What's changing</span>
          {changes.length ? (
            <>
              <ul className="ri-adjust-list">
                {changes.map((c, i) => <li key={i}><span className="ic" aria-hidden="true">{c.ic}</span><span>{c.text}</span></li>)}
              </ul>
              <p className="ri-adjust-move"><b>Today's move:</b> {changes[0].move}</p>
            </>
          ) : <p className="muted">No new deals, price changes or deadlines from car dealers in {mkt} this week.</p>}
        </article>
      </div>
      <div className="ri-adjust-foot">
        <button type="button" className="ri-btn ghost small" onClick={() => goTo('deals')}>See all deals →</button>
        <span className="muted small">Ideas to try, based only on the ads we heard. We never see your books.</span>
      </div>
    </section>
  );
}

function TodayView({ events, now, me, watchlist, toggleWatch, onOpen, goTo, market }) {
  const scoped = events.filter((d) => market === 'All' || d.station.market === market);
  if (!me) {
    return (
      <>
        <div className="ri-panel ri-today-empty">
          <h2>Pick your business to see your scoreboard</h2>
          <p className="muted">Type your business in <b>Insights on</b> at the top. This page then shows how you stack up: your deal rank, your share of voice, each competitor's airtime and deal, and whether your own ads ran.</p>
        </div>
        <MiniFeed events={scoped} now={now} onOpen={onOpen} title={`Live: every ad${market !== 'All' ? ` in ${market}` : ''}`} empty="No ads heard yet." />
      </>
    );
  }
  const tracked = [me, ...watchlist];
  const dealer = !!dealOf(me)?.auto;
  return (
    <>
    <AdjustToday me={me} events={events} now={now} goTo={goTo} />
    <div className="ri-today">
      <div className="ri-today-a">
        <Scoreboard events={scoped} me={me} now={now} goTo={goTo} />
        <CompetitorMeter events={scoped} me={me} watchlist={watchlist} toggleWatch={toggleWatch} now={now} onOpen={onOpen} market={market} />
      </div>
      <div className="ri-today-b">
        <WhatChanged me={me} watchlist={watchlist} events={scoped} onOpen={onOpen} />
        {!dealer && <BeatBanner me={me} watchlist={watchlist} toggleWatch={toggleWatch} />}
      </div>
      <div className="ri-today-c">
        <MiniFeed events={scoped} names={tracked} now={now} onOpen={onOpen} title="Live: you and your competitors"
          empty="Nobody you track has aired in the last 3 hours." />
      </div>
    </div>
    </>
  );
}

function FeedCard({ d, now, onOpen }) {
  const c = d.creative;
  const o = c.offer;
  const fresh = now - d.ts < 10000;
  const brand = o.offerType === 'Brand';
  const ending = daysUntil(o) <= 7;
  const tr = d.real ? { freq: 'flat' } : trendOf(c.advertiser);
  const pd = !d.real && tr.price && tr.price.dir !== 'same' ? tr.price : null;
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
          {d.real && <span className="tag real">Real · heard on air</span>}
          {fresh && <span className="tag new">Just aired</span>}
          {tr.freq === 'up' && <span className="tag trend">▲ Airtime +{Math.round(tr.pct * 100)}%</span>}
          {tr.freq === 'down' && <span className="tag trend">▼ Airtime −{Math.round(-tr.pct * 100)}%</span>}
          {pd && <span className="tag trend">{pd.dir === 'better' ? (pd.h.lowerIsBetter ? '▼ Price cut' : '▲ Bigger discount') : (pd.h.lowerIsBetter ? '▲ Price up' : '▼ Smaller discount')}</span>}
          {d.newCreative && <span className="tag amber">New creative</span>}
          {ending && <span className="tag amber">Ends soon</span>}
          {c.type === 'Live Read' && <span className="tag amber">Live read</span>}
          {o.promoCode && <span className="tag">Code {o.promoCode}</span>}
          {c.notSpoken.length > 0 && <span className="tag tv">{c.notSpoken.length} fine-print terms</span>}
          <span className="tag">{d.daypart}</span>
          <span className="tag mono">{d.real ? `${d.confidence} confidence` : `${d.confidence}%`}</span>
          {!d.real && <span className="ri-cost">est. {money(d.estCost)}</span>}
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

// Where an advertiser is heading: airtime week over week, and its price over the last 8 weeks.
function trendOf(name) {
  const w = weekOverWeek([name])[0];
  const pct = w.last ? (w.now - w.last) / w.last : 0;
  const freq = pct >= 0.15 ? 'up' : pct <= -0.15 ? 'down' : 'flat';
  const h = PRICE_HISTORY.find((p) => p.advertiser === name);
  let price = null;
  if (h) {
    const first = h.values[0]; const last = h.values[h.values.length - 1];
    const better = h.lowerIsBetter ? last < first : last > first;
    const worse = h.lowerIsBetter ? last > first : last < first;
    const moves = h.values.filter((v, i) => i > 0 && v !== h.values[i - 1]).length;
    price = { dir: better ? 'better' : worse ? 'worse' : 'same', first, last, moves, h };
  }
  return { w, pct, freq, price, change: OFFER_CHANGES.find((x) => x.advertiser === name) || null };
}
const fmtUnit = (v, unit) => (unit === '/mo' ? `${money(v)}/mo` : `${money(v)}${unit}`);

function Spark({ values }) {
  const W = 84; const H = 22; const lo = Math.min(...values); const hi = Math.max(...values); const span = hi - lo || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - 2 - ((v - lo) / span) * (H - 4)}`).join(' ');
  return <svg className="ri-spark" viewBox={`0 0 ${W} ${H}`} aria-hidden="true"><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>;
}

// "Insights" for any ad: what their airtime, prices and timing say about where they're going.
// Read from the ads only (never their books), so it says "reads like", not "they are".
function AdInsights({ d, events, now }) {
  const c = d.creative;
  const name = c.advertiser;
  const t = c.real ? { freq: 'none', w: {} } : trendOf(name);
  const theirs = events.filter((e) => e.creative.advertiser === name);
  const lastHr = theirs.filter((e) => e.ts > now - 3600 * 1000).length;
  const perHr = theirs.length / (WINDOW_MS / 3600000);
  const stations = new Set(theirs.map((e) => e.station.id)).size;
  const dayparts = new Set(theirs.map((e) => e.daypart)).size;
  const left = daysUntil(c.offer);
  const isNew = c.isNew || d.newCreative;
  const sig = [];

  if (t.freq === 'up') sig.push({ ic: '▲', h: 'Upping frequency', t: `${Math.round(t.pct * 100)}% more spots than last week (${t.w.now} vs ${t.w.last})` });
  else if (t.freq === 'down') sig.push({ ic: '▼', h: t.pct <= -0.4 ? 'Getting quiet' : 'Lowering frequency', t: `${Math.round(-t.pct * 100)}% fewer spots than last week (${t.w.now} vs ${t.w.last})` });
  else if (t.freq === 'none') sig.push({ ic: '●', h: 'Heard on air', t: 'Recorded on a real Seattle station. Week-over-week trends start once we have a week of recordings.' });
  else sig.push({ ic: '■', h: 'Steady frequency', t: `About the same as last week (${t.w.now} vs ${t.w.last} spots)` });

  if (theirs.length >= 3 && lastHr >= 2 && lastHr >= perHr * 1.5) sig.push({ ic: '↗', h: 'Heating up right now', t: `${lastHr} spots in the last hour vs ${perHr.toFixed(1)}/hr on average` });
  else if (theirs.length >= 3 && lastHr === 0) sig.push({ ic: '↘', h: 'Quiet this hour', t: `No spots in the last hour after ${theirs.length} in the ${PERIOD}` });

  const p = t.price;
  if (p && p.dir !== 'same') {
    const disc = !p.h.lowerIsBetter;
    const head = p.dir === 'better' ? (disc ? 'Bigger discount' : 'Lowering the price') : (disc ? 'Smaller discount' : 'Raising the price');
    sig.push({ ic: p.dir === 'better' ? (disc ? '▲' : '▼') : (disc ? '▼' : '▲'), h: head,
      t: `${p.h.product}: ${fmtUnit(p.first, p.h.unit)} → ${fmtUnit(p.last, p.h.unit)} over 8 weeks, ${p.moves} change${p.moves === 1 ? '' : 's'}`, spark: p.h.values });
  } else if (t.change) {
    sig.push({ ic: '⇄', h: 'Changed the offer', t: `${t.change.product}: ${t.change.from} → ${t.change.to} (${t.change.date})` });
  } else if (c.offer.offerType !== 'Brand') {
    sig.push({ ic: '=', h: 'Price holding', t: 'No change to this offer since we first heard it' });
  }
  if (isNew) sig.push({ ic: '✦', h: 'New ad', t: `First heard ${c.firstSeen}` });
  if (left > 0 && left <= 10) sig.push({ ic: '⏱', h: 'Deadline push', t: `Offer ends in ${Math.ceil(left)} day${Math.ceil(left) === 1 ? '' : 's'} (${c.offer.expires})` });
  if (theirs.length) sig.push({ ic: '◎', h: 'Reach', t: `${stations} station${stations === 1 ? '' : 's'}, ${dayparts} daypart${dayparts === 1 ? '' : 's'} in the ${PERIOD}` });

  const better = p ? p.dir === 'better' : false;
  const worse = p ? p.dir === 'worse' : false;
  let read;
  if (t.freq === 'up' && better) read = 'Pushing hard: more airtime and a better deal at the same time. That pattern usually means a sales push, often to move inventory.';
  else if (t.freq === 'up' && worse) read = 'More airtime but a less generous deal. They may be riding strong demand, or incentives ended.';
  else if (t.freq === 'up') read = 'Same deal, more airtime: they believe this offer works and are buying more reach.';
  else if (t.freq === 'down' && better) read = 'Fewer spots but a better deal: leaning on price instead of airtime, possibly a tighter budget.';
  else if (t.freq === 'down') read = 'Pulling back on air. Could be a budget cut, the end of a flight, or a pause before a new offer. Watch for a new ad.';
  else if (better) read = 'Same airtime, better deal: they are competing on price.';
  else if (worse) read = 'Same airtime, less generous deal: they may not feel price pressure right now.';
  else read = 'Business as usual: steady airtime, steady offer.';
  if (left > 0 && left <= 10) read += ` The offer ends in ${Math.ceil(left)} days, so expect a final push.`;
  if (isNew) read += ' New ads usually run heaviest in their first week or two.';
  if (c.auto && new Date(now).getDate() >= 24) read += ' It is month-end, when dealers push to hit targets.';

  return (
    <section className="ri-insights" aria-label={`Insights on ${name}`}>
      <span className="ri-eyebrow">Insights · where {name} is heading</span>
      <ul>
        {sig.map((s) => (
          <li key={s.h}>
            <span className="ic" aria-hidden="true">{s.ic}</span>
            <span className="tx"><b>{s.h}</b><span>{s.t}</span></span>
            {s.spark && <Spark values={s.spark} />}
          </li>
        ))}
      </ul>
      <p className="ri-insights-read"><span className="ri-eyebrow">The read</span><span>{read}</span></p>
      <p className="ri-insights-foot">Read from their ads (airtime, prices, timing), not their books. Week-over-week numbers are demo data until the recorder runs.</p>
    </section>
  );
}

// Every car deal on air in a market, best first: lowest true monthly (lease) or most cash off.
function rankBoard(market, kind) {
  const names = [...new Set(CREATIVES.filter((c) => c.auto && c.market === market).map((c) => c.advertiser))];
  return names.map((n) => ({ n, a: dealOf(n).auto }))
    .filter((x) => (kind === 'lease' ? x.a.monthly : x.a.cashOff))
    .sort((p, q) => (kind === 'lease' ? trueMonthly(p.a) - trueMonthly(q.a) : q.a.cashOff - p.a.cashOff));
}

// "So what?" for any ad: where it lands against the business in "Insights on".
// Facts from the ads only (price, airtime, rank). Never a guess about anyone's profit.
function WhereItLands({ d, me, events }) {
  const c = d.creative;
  const isMe = c.advertiser === me;
  const mine = dealOf(me);
  const meC = mine || CREATIVES.find((x) => x.advertiser === me);
  const airs = events.filter((e) => e.creative.advertiser === c.advertiser);
  const stations = new Set(airs.map((e) => e.station.id)).size;
  const spend = airs.reduce((s, e) => s + e.estCost, 0);
  const myAirs = events.filter((e) => e.creative.advertiser === me).length;
  const air = (
    <p className="ri-land-air">
      <b>{airs.length}</b> spot{airs.length === 1 ? '' : 's'} on <b>{stations}</b> station{stations === 1 ? '' : 's'} in the {PERIOD} · est. {money(spend)}
      {!isMe && meC && <> · {me}: <b>{myAirs}</b></>}
    </p>
  );
  const shell = (body) => (
    <section className="ri-land" aria-label={`Where this lands vs ${me}`}>
      <span className="ri-eyebrow">Where this lands vs {isMe ? 'the market' : me}</span>
      {body}
      {air}
    </section>
  );

  if (!c.auto) {
    const same = meC && meC.category === c.category;
    return shell(<p className="ri-land-note">{same
      ? <>Same category as {me}. Deal-vs-deal pricing covers car dealers for now; compare airtime below.</>
      : <>Not a {meC ? meC.category.toLowerCase() : ''} competitor of {me}. Shown for the full picture of who's on air.</>}</p>);
  }

  const market = c.market || d.station.market;
  const kind = c.auto.monthly ? 'lease' : 'cash';
  const board = rankBoard(market, kind);
  const pos = board.findIndex((x) => x.n === c.advertiser) + 1;
  const myPos = board.findIndex((x) => x.n === me) + 1;
  const label = kind === 'lease' ? 'lease deals' : 'cash-off deals';
  const rank = pos > 0 && (
    <p className="ri-land-rank">
      <b>#{pos}</b> of {board.length} {label} on air in {market}{kind === 'lease' ? ' (true monthly cost)' : ''}
      {!isMe && (myPos ? <> · {me} is <b>#{myPos}</b></> : '')}
    </p>
  );

  if (isMe) return shell(<><p className="ri-land-verdict me">This is {me}'s ad.</p>{rank}</>);

  const cmp = compareDeals(c.advertiser, me);
  if (!cmp) {
    const why = !mine ? `${me} has no car deal on air to compare yet.`
      : mine.market !== market ? `${me} advertises in ${mine.market}; this ad runs in ${market}.`
        : `Different kind of deal (${kind === 'lease' ? 'lease' : 'cash off'} vs ${mine.auto.monthly ? 'lease' : 'cash off'}), so not a straight price match.`;
    return shell(<>{rank}<p className="ri-land-note">Not a head-to-head: {why}</p></>);
  }

  const lease = !!cmp.them.tru;
  const ya = mine.auto;
  const dueCut = lease ? Math.round((cmp.gap * (ya.term || 36)) / 50) * 50 : 0;
  const fit = cmp.sameBody ? `Same class (${c.auto.body}) as ${me}'s ${ya.vehicle}.`
    : `Different class (${c.auto.body} vs ${ya.body}), so shoppers may not cross-shop. Judge the fit.`;
  let verdict; let move;
  if (cmp.status === 'them') {
    verdict = <p className="ri-land-verdict them">{lease ? `${money(cmp.gap)}/mo lower` : `${money(cmp.gap)} more off`} than {me}</p>;
    move = lease
      ? <>To match on true monthly cost, {me} would need about <b>{money(cmp.gap)}/mo</b> off the payment, or about <b>{money(dueCut)}</b> less due at signing.</>
      : <>To match, {me} would need about <b>{money(cmp.gap)}</b> more off.</>;
  } else if (cmp.status === 'you') {
    verdict = <p className="ri-land-verdict you">✓ {me}'s deal is lower by {lease ? `${money(cmp.gap)}/mo` : `${money(cmp.gap)} off`}</p>;
    move = myAirs < airs.length
      ? <>{me} has the lower price. They've aired <b>{airs.length}</b> times and {me} <b>{myAirs}</b>. A good deal works best when shoppers hear it.</>
      : <>{me} has the lower price and more airtime. Keeping the offer on air through the weekend keeps it in front of shoppers.</>;
  } else {
    verdict = <p className="ri-land-verdict even">≈ About even with {me}</p>;
    move = <>Price is a wash, so airtime decides: they aired <b>{airs.length}</b>, {me} aired <b>{myAirs}</b>.</>;
  }
  const say = cmp.status === 'them'
    ? `"Right now ${c.advertiser} is on ${d.station.call} with a ${cmp.them.veh} at ${cmp.them.big}${lease ? ` (${cmp.them.tru})` : ''}. That's ${lease ? `${money(cmp.gap)} a month` : money(cmp.gap)} better than yours, and payment shoppers hear it before they hear you."`
    : cmp.status === 'you'
      ? `"Your ${cmp.you.veh} deal is lower than ${c.advertiser}'s. They've run ${airs.length} spots in the ${PERIOD}${myAirs < airs.length ? ` and you've run ${myAirs}` : ''}. More airtime could get your deal heard by more people."`
      : `"You and ${c.advertiser} are priced the same. Whoever's on air more gets the call."`;

  return shell(
    <>
      {verdict}
      <div className="ri-land-vs">
        <div><span className="who">{c.advertiser}</span><b>{cmp.them.big}</b><span>{cmp.them.veh}</span>{cmp.them.tru && <span>{cmp.them.tru}</span>}</div>
        <div className="mine"><span className="who">{me}</span><b>{cmp.you.big}</b><span>{cmp.you.veh}</span>{cmp.you.tru && <span>{cmp.you.tru}</span>}</div>
      </div>
      {rank}
      <p className="ri-land-note">{fit}</p>
      <p className="ri-land-move"><span className="ri-eyebrow">Suggested move</span><span>{move}</span></p>
      <p className="ri-land-say"><span className="ri-eyebrow">Say it like this</span><span>{say}</span></p>
    </>,
  );
}

function DetailSheet({ d, onClose, watched, toggleWatch, notify, me, events }) {
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
    ['Match confidence', d.real ? d.confidence : `${d.confidence}%`],
    ['Est. cost', d.real ? 'Not estimated yet' : money(d.estCost)],
    ...(d.real ? [['Source', 'Real: recorded off the air by RadioIntel']] : []),
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

        {/* The ad first, then what it means. */}
        <AdInsights d={d} events={events || []} now={Date.now()} />
        {me && <WhereItLands d={d} me={me} events={events || []} />}

        <span className="ri-eyebrow">{c.media === 'TV' ? 'Voiceover transcript' : 'Transcript'}</span>
        <blockquote className="ri-transcript">{highlight(c.transcript, c.keywords)}</blockquote>
        <HearIt text={c.transcript} />

        <span className="ri-eyebrow">Airing details</span>
        <dl className="ri-facts meta">
          {meta.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>

        {/* Pinned to the bottom of the sheet: watch, copy and close without scrolling. */}
        <div className="ri-sheet-actions ri-dock">
          <button type="button" className={`ri-btn watch ${watched ? 'on' : ''}`} onClick={() => toggleWatch(c.advertiser)} aria-pressed={watched}
            title={watched ? `Stop tracking ${c.advertiser}` : `Track ${c.advertiser} as a competitor`}>
            {watched ? '★ Tracking' : '☆ Track'}
          </button>
          <button type="button" className="ri-btn primary" onClick={copyRow}>Copy for Sheets</button>
          <button type="button" className="ri-btn" onClick={onClose}>Close</button>
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
  const phone = useIsPhone();
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
      <Filters {...filters} showSearch={false} compact={phone} />
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
      <p className="ri-note">Every dealer with a lease ad on air, ranked. {me
        ? <><span className="ri-vs-badge them">red</span> = their deal is lower than <b>{me}</b>’s, <span className="ri-vs-badge you">green</span> = {me}’s is lower. Change “Insights on” at the top to look at another business.</>
        : <>Pick a business in “Insights on” at the top to color each deal against theirs.</>}</p>
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

function RadioVsTv({ crossMedia, market, dealer = false }) {
  const [picked, setPicked] = useState(null);
  const [opp, setOpp] = useState(null);
  const scoped = market === 'All' || market === 'Seattle' ? crossMedia.filter((d) => d.station.market === 'Seattle') : null;
  if (!scoped) {
    return <p className="ri-note">Radio vs TV: we don't record TV in {market} yet, so everything on this tab is {market} radio. The TV comparison turns on when {market}'s TV stations are added.</p>;
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

      {!dealer && (<>
      <div className="ri-section-head"><h2>Mostly TV: pitch them radio <span className="ri-premium">Station Premium</span></h2><span className="ri-count">85%+ of spend on TV, {PERIOD}</span></div>
      <GapList rows={gaps.needRadio} pitch="radio" onPick={setOpp} />

      <div className="ri-section-head"><h2>Mostly radio: pitch them TV <span className="ri-premium">Station Premium</span></h2><span className="ri-count">85%+ of spend on radio, {PERIOD}</span></div>
      <GapList rows={gaps.needTv} pitch="tv" onPick={setOpp} />
      {opp && <OpportunitySheet o={opp} onClose={() => setOpp(null)} />}
      </>)}

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
    return gap > 0 ? { status: 'them', short: `${money(gap)}/mo lower than yours` } : { status: 'you', short: `Yours is ${money(-gap)}/mo lower` };
  }
  const gap = wOff(o) - wOff(mine);
  if (Math.abs(gap) < 250) return { status: 'even', short: 'About even with you' };
  return gap > 0 ? { status: 'them', short: `${money(gap)} more off than you` } : { status: 'you', short: `You take ${money(-gap)} more off` };
}

// Website deal value, as shown on a ranking row.
const wVal = (o, type) => (type === 'lease' ? `${money(wTrue(o))}/mo true` : `${money(wOff(o))} off`);
const wGap = (mine, best, type) => (type === 'lease' ? Math.round(wTrue(mine) - wTrue(best)) : wOff(best) - wOff(mine));

// The dealer comes from "Insights on" at the top, so the whole app looks at one business.
function WebDealsView({ me: meName, chooseMe }) {
  const site = WEB_SITES.find((s) => s.dealer === meName) || null;
  const me = site ? site.dealer : null;
  const boardRef = useRef(null);
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
    if (mine.length && !myLeases && leaseRivals.size) notes.push({ kind: 'miss', text: <><b>{leaseRivals.size} competitors</b> post monthly lease payments. You don't post one yet, and payment shoppers often compare by monthly price.</> });
    const theirOnly = [...new Set(rivals.map((o) => o.model))].filter((m) => !mine.some((o) => o.model === m));
    if (mine.length && theirOnly.length) notes.push({ kind: 'open', text: <>Competitors post specials on <b>{theirOnly.length} models you don't</b>: {theirOnly.slice(0, 6).join(', ')}{theirOnly.length > 6 ? '…' : ''}.</> });
  }
  // Your rankings: for every vehicle you post, where your best deal ranks among every dealer posting it.
  const ranks = [];
  if (me) {
    for (const k of myKeys) {
      for (const type of ['lease', 'price']) {
        const ranked = bestPerDealer(WEB_OFFERS.filter((o) => wKey(o) === k), type);
        const r = ranked.findIndex((o) => o.dealer === me);
        if (r < 0) continue;
        ranks.push({ k, type, rank: r + 1, of: ranked.length, mine: ranked[r], best: ranked[0] });
      }
    }
    ranks.sort((a, b) => a.rank - b.rank || b.of - a.of || a.k.localeCompare(b.k));
  }
  // Only real head-to-heads get a row: 2+ dealers posting, and for price at least someone discounting.
  const h2h = ranks.filter((x) => x.of > 1 && !(x.type === 'price' && wOff(x.best) === 0));
  const solo = [...new Set(ranks.filter((x) => x.of === 1 && (x.type === 'lease' || wOff(x.mine) > 0)).map((x) => wName(x.k)))];
  const beatCount = ranks.filter((x) => x.rank > 1 && wGap(x.mine, x.best, x.type) > (x.type === 'lease' ? 4 : 249)).length;
  const goBoard = (k) => { setPick(k); setTimeout(() => boardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30); };

  const list = WEB_OFFERS.filter((o) => wKey(o) === sel);
  const leases = bestPerDealer(list, 'lease');
  const prices = bestPerDealer(list, 'price');
  const myLease = leases.find((o) => o.dealer === me);
  const myPrice = prices.find((o) => o.dealer === me);
  const siteOf = (d) => WEB_SITES.find((s) => s.dealer === d) || {};

  return (
    <>
      <div className="ri-section-head"><h2>Website deals</h2><span className="ri-real">Real data · read {wWhen}</span></div>
      <p className="ri-note">Every new-Toyota special posted on Seattle-area dealer websites, read the way any shopper sees them, then ranked best deal first.</p>

      {!site && (
        <div className="ri-panel">
          <p className="ri-callout">{meName ? <>“Insights on” is set to <b>{meName}</b>. We don't read a website for them yet. In the live product, reading starts the moment you add a dealer. Pick one we read:</> : <>Just browsing: every deal is ranked below. To see your own rankings, pick your dealer in “Insights on”, or one of these:</>}</p>
          <div className="ri-chips">
            {WEB_SITES.filter((s) => s.status === 'read').map((s) => (
              <button key={s.dealer} type="button" className="ri-chip" onClick={() => { chooseMe(s.dealer); window.scrollTo({ top: 0 }); }}>{s.dealer}</button>
            ))}
          </div>
        </div>
      )}

      {site && (
        <div className="ri-panel">
          <p className="ri-callout">
            <b>{site.dealer}</b> · {site.city}{site.group && <> · {site.group} group</>} · <a href={site.url} target="_blank" rel="noreferrer">{site.domain}</a>
            <br />{site.status === 'blocked' ? 'Your site blocks automated reading, so we compare you using your Google and Facebook ads instead (coming next).'
              : <>You post <b>{mine.length}</b> new-vehicle specials: {mine.filter((o) => o.type === 'lease').length} lease payments, {mine.filter((o) => o.type === 'price').length} price discounts.{beatCount > 0 && <> On <b>{beatCount}</b> of them a competitor posts a better deal.</>}</>}
          </p>
          {h2h.length > 0 && (
            <>
              <span className="ri-eyebrow">Your rankings vs other dealers · best first · tap to see the board</span>
              <ol className="ri-ranks">
                {h2h.map((x) => {
                  const gap = wGap(x.mine, x.best, x.type);
                  const top = x.rank === 1;
                  return (
                    <li key={x.k + x.type}>
                      <button type="button" className={top ? 'win' : 'lose'} onClick={() => goBoard(x.k)}>
                        <span className="pos">#{x.rank}<small>of {x.of}</small></span>
                        <span className="what">
                          <b>{wName(x.k)}</b> <span className="ty">{x.type === 'lease' ? 'Lease' : 'Price'}</span>
                          <span className="det">
                            You: {wVal(x.mine, x.type)}
                            {top ? ' · best deal posted'
                              : <> · best: {x.best.dealer}, {x.type === 'lease' ? `${money(gap)}/mo cheaper` : `${money(gap)} more off`}</>}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
          {solo.length > 0 && (
            <p className="ri-rankline">Only you post a special on <b>{solo.length}</b>: {solo.slice(0, 6).join(', ')}{solo.length > 6 ? '…' : ''}. No one to rank against yet.</p>
          )}
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

      <div className="ri-section-head" ref={boardRef}><h2>Same vehicle, every dealer, ranked</h2><span className="ri-count">{keys.length} vehicles · {WEB_OFFERS.length} specials</span></div>
      <div className="ri-wchips" role="tablist" aria-label="Vehicle">
        {keys.map((x) => (
          <button key={x.k} type="button" role="tab" aria-selected={x.k === sel} className={x.k === sel ? 'on' : ''} onClick={() => setPick(x.k)}>
            {wName(x.k)} <small>{x.dealers}</small>{x.mineToo && <i className="you-dot" title="You post this one" />}
          </button>
        ))}
      </div>

      {leases.length > 0 && (
        <div className="ri-panel">
          <span className="ri-eyebrow">{wName(sel)} · lease, best true monthly cost first</span>
          {myLease && <p className="ri-rankline">{me} ranks <b>#{leases.indexOf(myLease) + 1} of {leases.length}</b> on this lease.</p>}
          <ul className="ri-wrows">
            {leases.map((o, i) => {
              const cmp = vsMine(o, myLease, 'lease');
              return (
                <li key={o.dealer} className={o.dealer === me ? 'me' : ''}>
                  <div className="top"><span className="name"><span className="rk">#{i + 1}</span>{o.dealer}{o.dealer === me && <span className="ri-you-tag">You</span>}{i === 0 && leases.length > 1 && <span className="ri-best-tag">Best deal</span>}</span><b>{money(o.monthly)}/mo</b></div>
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
          <span className="ri-eyebrow">{wName(sel)} · price, most off sticker first</span>
          {myPrice && <p className="ri-rankline">{me} ranks <b>#{prices.indexOf(myPrice) + 1} of {prices.length}</b> on price.</p>}
          <ul className="ri-wrows">
            {prices.map((o, i) => {
              const cmp = vsMine(o, myPrice, 'price');
              return (
                <li key={o.dealer} className={o.dealer === me ? 'me' : ''}>
                  <div className="top"><span className="name"><span className="rk">#{i + 1}</span>{o.dealer}{o.dealer === me && <span className="ri-you-tag">You</span>}{i === 0 && prices.length > 1 && <span className="ri-best-tag">Best deal</span>}</span><b>{money(wOff(o))} off</b></div>
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
  if (!scoped) return <p className="ri-note">We don't record TV, cable or streaming in {market} yet, so there's no channel mix to show. It turns on when {market}'s TV stations are added. Radio for {market} is on Live, Deals and Market.</p>;

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
            {me && <span className="ri-you-pick">You: <b>{me}</b></span>}
          </div>
          <div className="ri-panel">
            {mine ? (
              <>
                <p className="ri-callout"><b>{me}</b> is on <b>{mine.on.length} of 4</b> channels: est. {money(mine.total)}, {PERIOD}. {cat && <>That's {Math.round(myShare * 100)}% of all {cat} spend.</>}</p>
                <MixBar v={mine.v} big />
                <ChannelLegend />
              </>
            ) : !me ? <p className="ri-callout">Just browsing. Pick a business in “Insights on” to see its footprint and open lanes.</p>
              : <p className="ri-callout">{me} hasn't aired on radio or TV in the {PERIOD}. Here's where your competitors are.</p>}
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
              <div className="ri-section-head"><h2>Deals lower than yours</h2><span className="ri-count">on air now · true monthly cost</span></div>
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

// What "When ads run" counts, in plain words, plus the terms the hour card uses.
function HeatHelp({ market, category, media, grid, onPick }) {
  const inMkt = (s) => market === 'All' || s.market === market;
  const radio = STATIONS.filter((s) => s.media === 'Radio' && !s.nc && inMkt(s)).length;
  const tvN = STATIONS.filter((s) => s.media === 'TV' && inMkt(s)).length;
  const where = market === 'All' ? 'every market' : market;
  const stations = media === 'Radio' ? `${radio} radio stations`
    : media === 'TV' ? `${tvN} TV stations`
      : `${radio} radio and ${tvN} TV stations`;
  const what = category === 'All' ? <><b>All ads</b>, every category,</> : <>Only <b>{category}</b> ads</>;
  const tvParts = media === 'TV';

  // Quick answer: the best-value prime slot. Prime = drive time on radio (6-10 AM, 3-7 PM), early news and prime on TV.
  // For each prime hour, compare the lightest weekday with the busiest weekday at that same hour (same audience, same rate).
  const primeHours = tvParts ? [16, 17, 18, 20, 21, 22] : [6, 7, 8, 9, 15, 16, 17, 18];
  let pick = null;
  if (grid && grid.length) {
    for (const h of primeHours) {
      const days = [0, 1, 2, 3, 4].map((d) => ({ d, v: grid[d][h] }));
      const lo = days.reduce((a, b) => (b.v < a.v ? b : a));
      const hi = days.reduce((a, b) => (b.v > a.v ? b : a));
      const save = hi.v ? 1 - lo.v / hi.v : 0;
      if (!pick || save > pick.save) pick = { d: lo.d, h, save, hiD: hi.d };
    }
  }
  const prime = tvParts ? 'prime-time' : 'drive-time';
  return (
    <div className="ri-heat-help">
      <div className="ri-heat-why">
        <p><b>What it's for: picking the best time to buy {tvParts ? 'TV' : 'radio'}.</b> Every square is one hour of the week, colored by how many ads ran. Bright squares are where the ads pile up; dark squares are quiet.</p>
        <ul className="ri-heat-uses">
          <li><b>Find the best time to buy</b><span>A big audience but fewer competing ads, so yours stands out. Look for "Better value" in an hour's details.</span></li>
          <li><b>See when your category is busiest</b><span>Pick your category in the filters. Car dealers, for example, pile on Thursday to Saturday before the weekend.</span></li>
          <li><b>Know the price before you call</b><span>Each hour shows what a :30 spot about costs, so you can tell a fair rate from a high one when a station quotes you.</span></li>
          <li><b>Check the schedule you're sold</b><span>If your spots land in the brightest squares, you're paying for the most crowded breaks. Ask the station for the quieter days at the same hour.</span></li>
        </ul>
        {pick && pick.save >= 0.05 && (
          <p className="ri-heat-pick">
            <b>Quick answer:</b> the best-value {prime} slot here is{' '}
            <button type="button" className="ri-link" onClick={() => onPick && onPick({ d: pick.d, h: pick.h })}>{DAYS[pick.d]} {hourLabel(pick.h)}</button>.
            {' '}About {Math.round(pick.save * 100)}% fewer ads than {DAYS[pick.hiD]} at the same hour and rate.
          </p>
        )}
      </div>
      <p>{what} on the <b>{stations}</b> in {where}, added up for each hour of the last 7 days. Brighter green means more ads.</p>
      <p className="muted small">{category === 'All' ? 'Pick a category in the filters to see only your kind of business.' : 'Set Category to All to see every ad.'} Radio/TV switches which stations are counted.</p>
      <details className="ri-defs">
        <summary>What the terms mean</summary>
        <dl>
          <div><dt>Spot</dt><dd>One airing of one ad. The same ad played 10 times is 10 spots.</dd></div>
          <div><dt>Spots per hour</dt><dd>All spots in that hour, added across every station counted above.</dd></div>
          <div><dt>Daypart</dt><dd>{tvParts
            ? 'The blocks TV stations sell by: Early Morning 5–9 AM, Daytime 9 AM–4 PM, Early News 4–7 PM, Prime Access 7–8 PM, Prime 8–11 PM, Late News 11 PM–midnight, Late Night midnight–5 AM.'
            : 'The blocks radio stations sell by: AM Drive 6–10 AM, Midday 10 AM–3 PM, PM Drive 3–7 PM, Evening 7 PM–midnight, Overnight midnight–6 AM.'} Rates are set by daypart, so every hour in a daypart costs about the same.</dd></div>
          <div><dt>Typical hour</dt><dd>The average hour of the week for what's shown here. "1.9× a typical hour" means almost twice the usual number of ads.</dd></div>
          <div><dt>Ads per station per hour</dt><dd>How crowded a station's breaks are. More ads means yours has more to compete with. Light is under 6, normal 6–10, crowded 10 or more.</dd></div>
          <div><dt>Cost per :30</dt><dd>The estimated price of one 30-second spot at that daypart, on an average station and on the most expensive one.</dd></div>
          <div><dt>Better value</dt><dd>The same hour on a similar day (weekday with weekday, weekend with weekend) with fewer ads. The audience and rate are about the same, but your ad stands out more.</dd></div>
          <div><dt>Leans in / quiet</dt><dd>Whether your category runs heavier or lighter at that hour than the market overall. Leaning in means more businesses like yours are on the air then.</dd></div>
          <div><dt>Heard today</dt><dd>Advertisers we actually picked up in that daypart today, from the live feed.</dd></div>
        </dl>
        <p className="muted small">Weekly volume and rates are demo estimates until real recordings fill in.</p>
      </details>
    </div>
  );
}

// Tap an hour on "When ads run": what it costs, how crowded it is, who you're up against, and a better-value slot.
const DP_NOTE = {
  'AM Drive': 'Commute in. The biggest radio audience of the day, priced to match.',
  Midday: 'At-work listening. Steady audience, lower rates than drive time.',
  'PM Drive': 'Commute home, close to when people shop. Second-biggest audience.',
  Evening: 'Fewer listeners and cheaper spots. Good for frequency on a budget.',
  Overnight: 'Smallest audience and the lowest rates.',
  'Early Morning': 'Morning news. Commuters and parents getting ready.',
  Daytime: 'Talk and game shows. The cheapest daytime TV.',
  'Early News': 'Local news. A loyal, older audience.',
  'Prime Access': 'The hour before prime. A prime-like audience at a lower rate.',
  Prime: 'The biggest TV audience and the highest rates.',
  'Late News': '11 PM news. Good reach at below-prime rates.',
  'Late Night': 'Late-night talk. A small, cheap audience.',
};

function HourDetail({ cell, isPeak, grid, market, category, media, me, events, onClose }) {
  const { d, h } = cell;
  const v = grid[d][h];
  const tv = media === 'TV';
  const dpOf = (hr) => { const t = new Date(2026, 0, 5, hr); return tv ? tvDaypartFor(t) : daypartFor(t); };
  const dp = dpOf(h);
  const flat = grid.flat();
  const avg = flat.reduce((a, x) => a + x, 0) / (flat.length || 1);
  const vsAvg = v / (avg || 1);
  const where = market === 'All' ? 'all markets' : market;

  // Crowding: estimated ads per station in that hour.
  const sts = STATIONS.filter((st) => !st.nc && (tv ? st.media === 'TV' : st.media === 'Radio') && (market === 'All' || st.market === market));
  const wsum = sts.reduce((a, st) => a + st.weight, 0) || 1;
  const perSt = v / wsum;
  const crowd = perSt >= 10 ? 'crowded' : perSt >= 6 ? 'normal' : 'light';

  // Cost: a :30 at this daypart's rate, on the average station and the top station.
  const rateAvg = sts.length ? sts.reduce((a, st) => a + st.rate60, 0) / sts.length : 0;
  const rateTop = sts.length ? Math.max(...sts.map((st) => st.rate60)) : 0;
  const c30 = (r) => Math.round((r * 0.7 * dp.factor) / 5) * 5;

  // Better value: the same hour on comparable days (weekday vs weekday, weekend vs weekend).
  // Same hour = a similar audience at the same rate, so fewer ads really means less clutter.
  const wkend = d >= 5;
  const same = grid.map((row, dd) => ({ d: dd, h, v: row[h] })).filter((x) => (x.d >= 5) === wkend);
  const best = [...same].sort((a, b) => a.v - b.v)[0];
  const cut = best ? 1 - best.v / (v || 1) : 0;
  const busiest = [...same].sort((a, b) => b.v - a.v)[0];

  // Your category's push: does it lean into this hour more than the market does?
  const meC = me ? (dealOf(me) || CREATIVES.find((x) => x.advertiser === me)) : null;
  const cat = category !== 'All' ? category : meC?.category;
  let push = null;
  if (cat) {
    const g = heatGrid(market, cat, media);
    const f = g.flat();
    const ca = f.reduce((a, x) => a + x, 0) / (f.length || 1);
    push = (g[d][h] / (ca || 1)) / (vsAvg || 1);
  }

  // Who we actually heard in this daypart today (from the live feed).
  const heard = new Map();
  let mine = 0;
  for (const e of events) {
    if (e.daypart !== dp.name) continue;
    if (cat && e.creative.category !== cat) continue;
    if (e.creative.advertiser === me) mine += 1;
    else heard.set(e.creative.advertiser, (heard.get(e.creative.advertiser) || 0) + 1);
  }
  const top = [...heard.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  const rows = [];
  rows.push({
    ic: '◷',
    b: `${dp.name} · ${crowd} hour`,
    t: `About ${Math.max(1, Math.round(perSt))} ads per station per hour · ${vsAvg >= 1 ? `${vsAvg.toFixed(1)}× a typical hour` : `${Math.round((1 - vsAvg) * 100)}% quieter than a typical hour`}`,
  });
  if (rateAvg) {
    rows.push({ ic: '$', b: `About ${money(c30(rateAvg))} per :30`, t: `Average ${tv ? 'TV' : 'radio'} station in ${where} at this daypart · the top station is about ${money(c30(rateTop))}` });
  }
  const dayKind = wkend ? 'weekend' : 'weekday';
  if (best && best.d !== d && cut >= 0.08) {
    rows.push({ ic: '↘', b: `Better value: ${DAYS[best.d]} ${hourLabel(h)}`, t: `Same hour and rate, about ${Math.round(cut * 100)}% fewer competing ads, so your spot stands out more.` });
  } else if (best && busiest && busiest.d !== d) {
    rows.push({ ic: '✓', b: `The lightest ${dayKind} at ${hourLabel(h)}`, t: `${DAYS[busiest.d]} at this hour carries about ${Math.round((busiest.v / (v || 1) - 1) * 100)}% more ads for the same rate. Good value.` });
  }
  if (push != null) {
    const who = cat.toLowerCase();
    if (push >= 1.15) rows.push({ ic: '▲', b: `${cat} leans in here`, t: `${cat} advertisers run ${Math.round((push - 1) * 100)}% heavier at this hour than the market overall. More businesses like yours are on the air now.` });
    else if (push <= 0.87) rows.push({ ic: '▼', b: `${cat} is quiet here`, t: `${cat} advertisers run ${Math.round((1 - push) * 100)}% lighter at this hour than the market overall. Fewer businesses like yours are on the air now.` });
    else rows.push({ ic: '≈', b: `${cat} runs at its normal pace here`, t: `No special push from ${who} advertisers at this hour.` });
  }
  if (top.length) {
    rows.push({ ic: '◉', b: `Heard in ${dp.name} today${cat ? ` · ${cat}` : ''}`, t: top.map(([n, k]) => `${n} (${k})`).join(', ') + (meC ? ` · ${me}: ${mine}` : '') });
  }

  return (
    <section className="ri-insights ri-hour" aria-label={`${DAYS[d]} ${hourLabel(h)} details`}>
      <div className="ri-hour-head">
        <span>{isPeak && <span className="ri-eyebrow">Busiest hour</span>}<b>{DAYS[d]} {hourLabel(h)}</b> · {v.toLocaleString('en-US')} spots{category !== 'All' ? ` in ${category}` : ''}</span>
        {onClose && <button type="button" className="ri-chip" onClick={onClose}>Back to busiest</button>}
      </div>
      <p className="ri-hour-note">{DP_NOTE[dp.name]}</p>
      <ul>
        {rows.map((r) => (
          <li key={r.b}><span className="ic" aria-hidden="true">{r.ic}</span><span className="tx"><b>{r.b}</b><span>{r.t}</span></span></li>
        ))}
      </ul>
      <p className="ri-insights-foot">Weekly volume and rates are demo estimates; rates follow each daypart's audience. “Heard today” comes from the live feed.</p>
    </section>
  );
}

function TrendsView({ part = 'spend', events, crossMedia, allEvents, watchlist, toggleWatch, onAdvertiser, me, ...filters }) {
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
  // The hour shown in the details: the one pointed at or tapped, otherwise the busiest.
  const shown = cell && grid[cell.d] ? cell : { d: peak.d, h: peak.h };
  const sideRef = useRef(null);

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
  const shareMkts = market === 'All' ? MARKETS : [market];
  const shareMax = Math.max(...shareMkts.flatMap((m) => CATEGORIES.map((c) => (share.counts[`${m}|${c}`] || 0) / (share.totals[m] || 1))));

  return (
    <>
      {part === 'spend' && <RadioVsTv crossMedia={crossMedia} market={market} dealer />}

      {part === 'timing' && (<>
      <div className="ri-section-head">
        <h2>When ads run{media !== 'Both' ? ` on ${media}` : ''}</h2>
        <span className="ri-count">spots per hour · last 7 days</span>
      </div>
      <HeatHelp market={market} category={category} media={media} grid={grid} onPick={setCell} />
      {/* The details sit beside the grid on a computer and below it on a phone, so the grid never jumps. */}
      <div className="ri-panel ri-heat-wrap">
        <div className="ri-heat-main">
        <p className="ri-callout">Busiest hour: <b>{DAYS[peak.d]} {hourLabel(peak.h)}</b>, {peak.v.toLocaleString('en-US')} spots. <span className="hover-hint">Point at any square to see its details.</span><span className="tap-hint">Tap any square; its details show below.</span></p>
        <div className="ri-heat-scroll">
          <div className="ri-heat" role="grid" aria-label="Ad volume by day and hour">
            <span />
            {Array.from({ length: 24 }, (_, h) => <span key={h} className="hh">{h % 6 === 0 ? hourLabel(h).replace(' ', '') : ''}</span>)}
            {grid.map((row, d) => (
              <React.Fragment key={d}>
                <span className="dd">{DAYS[d]}</span>
                {row.map((v, h) => (
                  <button key={h} type="button" className={`c l${level(v)} ${shown.d === d && shown.h === h ? 'sel' : ''}`}
                    onPointerEnter={(e) => { if (e.pointerType === 'mouse') setCell({ d, h }); }}
                    onFocus={() => setCell({ d, h })}
                    onClick={(e) => {
                      setCell({ d, h });
                      // Touch: bring the details into view only if they're off screen, without moving the grid first.
                      if (e.nativeEvent.pointerType !== 'mouse') setTimeout(() => sideRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 0);
                    }}
                    aria-label={`${DAYS[d]} ${hourLabel(h)}: ${v} spots`} />
                ))}
              </React.Fragment>
            ))}
          </div>
        </div>
        <div className="ri-legend"><span>Fewer</span>{[0, 1, 2, 3, 4].map((l) => <i key={l} className={`c l${l}`} />)}<span>More</span></div>
        </div>
        <div className="ri-heat-side" ref={sideRef} aria-live="polite">
          <HourDetail cell={shown} isPeak={!cell} grid={grid} market={market} category={category} media={media} me={me} events={events} onClose={cell ? () => setCell(null) : null} />
        </div>
      </div>

      </>)}

      {part === 'prices' && (<>
      <div className="ri-section-head"><h2>Price moves</h2><span className="ri-count">8 weeks, {WEEKS[0]} to {WEEKS[WEEKS.length - 1]}</span></div>
      <p className="muted small ri-key">
        Lines show direction only.{me && <> <span className="ri-vs-badge them">red</span> = their deal is lower than {me}’s, <span className="ri-vs-badge you">green</span> = {me}’s is lower. No color = not comparable.</>}
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

      </>)}

      {part === 'spend' && (<>
      <div className="ri-section-head"><h2>Rising and falling</h2><span className="ri-count">spots this week vs last</span></div>
      <ul className="ri-wow">
        {rising.map((r) => (
          <li key={r.name}><button type="button" className="ri-link" onClick={() => onAdvertiser(r.name)}>{r.name}</button><span className="up">▲ {Math.round(r.pct * 100)}%</span><span className="muted">{r.last} → {r.now}</span></li>
        ))}
        {falling.map((r) => (
          <li key={r.name}><button type="button" className="ri-link" onClick={() => onAdvertiser(r.name)}>{r.name}</button><span className="down">▼ {Math.round(-r.pct * 100)}%</span><span className="muted">{r.last} → {r.now}</span></li>
        ))}
      </ul>

      <div className="ri-section-head"><h2>{market === 'All' ? 'Category share by market' : `Category share in ${market}`}</h2><span className="ri-count">% of {market === 'All' ? "each market's" : market} spots</span></div>
      <div className="ri-table-wrap">
        <table className="ri-table ri-share">
          <thead><tr><th>Category</th>{shareMkts.map((m) => <th key={m} className="num">{m}</th>)}</tr></thead>
          <tbody>
            {CATEGORIES.map((c) => (
              <tr key={c}>
                <td>{c}</td>
                {shareMkts.map((m) => {
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
      </>)}
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
  const peers = STATIONS.filter((s) => s.market === home.market && s.media === home.media && !s.nc);
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
      <div className="ri-section-head"><h2>Side by side</h2><span className="ri-count">last {hours.toFixed(1)} hrs</span></div>
      <div className="ri-panel ri-h2h">
        <div className="ri-h2h-pick">
          <span className="me">{home.call}</span>
          <span className="vs">vs</span>
          <select id="ri-rival" value={rival.id} onChange={(e) => setRivalId(e.target.value)} aria-label="Compare with">
            {rivals.map((s) => <option key={s.id} value={s.id}>{s.call} {s.network || s.band}</option>)}
          </select>
        </div>
        <p className="ri-callout">
          How {home.call} and {rival.call} compare over the same hours. Every station's numbers come from the same recordings.
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
          <div className="wide"><dt>Advertising on radio, not yet on {home.call}</dt><dd>{onlyThem.length ? onlyThem.slice(0, 6).map((a, i) => (
            <React.Fragment key={a}>{i ? ', ' : ''}<b>{a}</b></React.Fragment>
          )) : 'None'}</dd></div>
        </dl>
      </div>
    </>
  );
}

// "My station": every advertiser on your station, and accounts airing less this week (a good time to check in).
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
        <b>{home.call}</b> aired <b>{onHome.length}</b> spots from <b>{advs.length}</b> advertisers in the last {hours.toFixed(1)} hrs, about <b>{money(spend)}</b> in est. ad revenue. 
      </p>

      <div className="ri-section-head"><h2>Accounts to check in with</h2><span className="ri-count">airing less with you this week</span></div>
      {atRisk.length === 0 ? (
        <div className="ri-beat ok"><b>✓ Every advertiser on {home.call} is steady or growing this week.</b></div>
      ) : (
        <div className="ri-beat threat">
          <b>{atRisk.length} advertiser{atRisk.length > 1 ? 's are' : ' is'} airing less with you this week</b>
          <ul>
            {atRisk.map((r) => (
              <li key={r.name}>
                <b className="nm">{r.name}</b>
                <span className="muted">Spots on {home.call} {pct(r.onYou)} vs last week, while their total airtime is {pct(r.overall)}.</span>
                <span className="gap">A good time for a friendly check-in.</span>
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
              {r.atRisk && <span className="ri-vs-badge them">Check in</span>}
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

function StationsView({ events, now, onAdvertiser, onOpen, openStation }) {
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
      <p className="ri-purpose"><b>Stations</b> is for station sales teams: who advertises on your station, who to check in with, and businesses on radio that aren't with you yet.</p>
      <div className="ri-home">
        <label htmlFor="ri-home">Your station</label>
        <select id="ri-home" value={home} onChange={(e) => setHome(e.target.value)}>
          <optgroup label="Seattle TV">
            {TV_STATIONS.map((s) => <option key={s.id} value={s.id}>{s.call} {s.network}</option>)}
          </optgroup>
          {MARKETS.map((mk) => (
            <optgroup key={mk} label={`${mk} radio`}>
              {STATIONS.filter((s) => s.market === mk && s.media === 'Radio' && !s.nc).map((s) => <option key={s.id} value={s.id}>{s.call} {s.band}</option>)}
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
        const peers = STATIONS.filter((s) => s.market === homeStation.market && s.media === homeStation.media && !s.nc);
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
      <StationProspects events={events} home={homeStation} />
      </>
      )}

      {view === 'mine' && (
      <>
      <div className="ri-section-head"><h2>Coverage</h2><span className="ri-count">{STATIONS.length} stations monitored · {STATIONS.filter((s) => s.nc).length} non-commercial</span></div>
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

      <div className="ri-section-head"><h2>{homeStation.market} stream monitor</h2><span className="ri-count">{marketStations.length} streams · tap one to watch it live in Live</span></div>
      <div className="ri-table-wrap">
        <table className="ri-table">
          <thead><tr><th>Station</th><th>Status</th><th className="num">Spots/hr</th><th className="num">Ad min/hr</th><th className="num">Est. $</th><th>Last spot</th></tr></thead>
          <tbody>
            {marketStations.map(({ s, p }) => (
              <tr key={s.id} className={`ri-row-tap ${s.id === home ? 'home' : ''}`} onClick={() => openStation(s.id)} title={`Watch ${s.call} live`}>
                <td><b>{s.call}</b> <span className="muted">{s.network || s.band}{s.nc ? ' · non-comm.' : ''}</span></td>
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
      <p className="muted small">Radio call signs and frequencies come from public market lists (full-power stations, 88.1 to 107.9 FM plus AM; Seattle includes the non-commercial band, which airs sponsor credits, not ads). Seattle TV is the 8 main broadcast stations. Advertisers, spot counts, spend and stream status are simulated for this demo.</p>
    </>
  );
}

// ------------------------------------------------------------------ on air now (station mode)

// Station picker: every market, FM in dial order (88.1 first), non-commercial marked.
function StationPicker({ id, value, onChange, label }) {
  return (
    <div className="ri-home">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <optgroup label="Seattle TV">
          {TV_STATIONS.map((s) => <option key={s.id} value={s.id}>{s.call} {s.network}</option>)}
        </optgroup>
        {MARKETS.map((mk) => (
          <optgroup key={mk} label={`${mk} radio`}>
            {STATIONS.filter((s) => s.market === mk && s.media === 'Radio').map((s) => (
              <option key={s.id} value={s.id}>{s.call} {s.band}{s.nc ? ' · non-commercial' : ''}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

// Spots less than 4 minutes apart on the same station count as one ad break.
function toBreaks(spots) {
  const out = [];
  for (const d of spots) {
    const cur = out[out.length - 1];
    if (cur && cur.start - d.ts < 4 * 60000) { cur.spots.push(d); cur.start = d.ts; } else out.push({ start: d.ts, spots: [d] });
  }
  return out;
}

// Pick one station and watch every ad on it, in order, as it airs.
function StationLive({ events, now, stationId, setStationId, onOpen }) {
  const [limit, setLimit] = useState(12);
  const st = STATIONS.find((s) => s.id === stationId) || STATIONS[0];
  const spots = useMemo(() => events.filter((d) => d.station.id === st.id), [events, st]);
  const hourAgo = now - 3600000;
  const lastHour = spots.filter((d) => d.ts > hourAgo);
  const adMin = lastHour.reduce((a, d) => a + d.creative.length, 0) / 60;
  const breaks = toBreaks(spots);
  const last = spots[0];
  return (
    <>
      <StationPicker id="ri-onair" value={st.id} onChange={(v) => { setStationId(v); setLimit(12); }} label="Watch this station" />
      <div className="ri-onair-card">
        <div className="top">
          <span className="ri-onair-badge"><span className="ri-live-dot" aria-hidden="true" />On air</span>
          <b>{st.call}</b>
          <span className="muted">{st.network || st.band} · {st.market}</span>
          <span className={`ri-status ${st.status}`} title={st.note || ''}>{st.status === 'live' ? 'Stream live' : 'Degraded'}</span>
        </div>
        {st.nc ? (
          <p className="muted">Non-commercial station. It airs sponsor credits ("underwriting"), not paid ads. We'll list sponsor mentions here once recording starts; the demo has none.</p>
        ) : (
          <div className="ri-onair-stats">
            <div><b>{lastHour.length}</b><span>ads, last hour</span></div>
            <div><b>{adMin.toFixed(1)}</b><span>ad minutes, last hour</span></div>
            <div><b>{last ? ago(last.ts, now) : '–'}</b><span>last ad</span></div>
          </div>
        )}
        {st.note && <p className="ri-note"><span className="ri-status degraded">Degraded</span> {st.note}. Spots may be missed until it recovers.</p>}
      </div>
      {!st.nc && (
        <>
          <div className="ri-section-head">
            <h2>Every ad on {st.call}, in order</h2>
            <span className="ri-count">newest on top · last 3 hrs</span>
          </div>
          <p className="ri-feed-explain">New ads drop in at the top the moment they air. Spots within 4 minutes of each other are grouped as one break. Tap an ad for the full offer.</p>
          {breaks.length === 0 && <p className="ri-empty">No ads heard on {st.call} in the last 3 hours of the demo.</p>}
          <ol className="ri-breaks">
            {breaks.slice(0, limit).map((b) => {
              const secs = b.spots.reduce((a, d) => a + d.creative.length, 0);
              return (
                <li key={b.spots[0].id}>
                  <div className="ri-break-head">
                    <span className="mono">{timeOf(b.start)}</span>
                    <span>{b.spots.length > 1 ? `Break · ${b.spots.length} ads` : 'Ad'} · {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</span>
                    <span className="muted">{b.spots[0].daypart}</span>
                  </div>
                  <ul>
                    {[...b.spots].reverse().map((d) => (
                      <li key={d.id}>
                        <button type="button" className={`ri-break-spot ${now - d.ts < 10000 ? 'fresh' : ''}`} onClick={() => onOpen(d)}>
                          <span className="mono t">{timeOf(d.ts)}</span>
                          <span className="len">:{d.creative.length}</span>
                          <span className="nm"><b>{d.creative.advertiser}</b><span>{d.creative.offer.headline}</span></span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ol>
          {breaks.length > limit && <button type="button" className="ri-more" onClick={() => setLimit(limit + 12)}>Show earlier breaks</button>}
          <p className="muted small">Demo: only the demo advertisers are shown, so breaks look thin. With real recording, every spot in every break is logged (no audio kept, just the facts).</p>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ ad check (did my ads run?)

const CHECK_WINDOWS = [['1h', '1 hr', 1 / 24, 'last hour'], ['24h', '24 hrs', 1, 'last 24 hrs'], ['7d', '7 days', 7, 'last 7 days'], ['30d', '30 days', CHECK_MAX_DAYS, 'last 30 days']];
const ADVERTISERS = [...new Set(CREATIVES.map((c) => c.advertiser))].sort();

// ---------------------------------------------------------------- spot-by-spot invoice check
// The station's invoice/affidavit lists every spot it says aired. We read only station, date and
// time from each line (dollar amounts can be blacked out first) and check each one against what
// we recorded. Everything runs in the browser: nothing is uploaded or saved.
const AUDIT_TOL_MS = 10 * 60000; // station's logged time vs the time we heard it
const RIVAL_GAP_MS = 4 * 60000; // a same-category ad this close is in the same break
const PRICE_RE = /\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*\.\d{2}\b/g;
const redactPrices = (t) => t.replace(PRICE_RE, '[$ hidden]');
const CALL_RE = /\b([KW][A-Z]{2,3}(?:-(?:FM|AM|TV))?)\b/g;
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const US_DATE_RE = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/;
const TIME_RE = /\b(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp])?\.?[Mm]?\.?/;
const bareCall = (c) => c.replace(/-(FM|AM|TV)$/, '');

function parseSpotLines(text, now) {
  const byId = new Map(STATIONS.map((s) => [s.id, s]));
  const byBare = new Map();
  for (const s of STATIONS) if (!byBare.has(bareCall(s.id)) || s.band === 'FM') byBare.set(bareCall(s.id), s);
  const lookup = (c) => byId.get(c) || byBare.get(bareCall(c));
  const claims = [];
  let skipped = 0;
  let st = null;
  let day = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/\b(printed|page \d|run date)\b/i.test(line)) { skipped += 1; continue; }
    for (const m of line.matchAll(CALL_RE)) { const s = lookup(m[1]); if (s) { st = s; break; } }
    const iso = line.match(ISO_DATE_RE);
    const us = !iso && line.match(US_DATE_RE);
    if (iso) day = new Date(+iso[1], +iso[2] - 1, +iso[3]);
    else if (us) {
      let y = us[3] ? +us[3] : new Date(now).getFullYear();
      if (y < 100) y += 2000;
      day = new Date(y, +us[1] - 1, +us[2]);
      if (!us[3] && day.getTime() > now + 86400000) day.setFullYear(y - 1);
    }
    const tm = line.replace(ISO_DATE_RE, ' ').replace(US_DATE_RE, ' ').match(TIME_RE);
    if (!tm || !st || !day) { skipped += 1; continue; }
    let h = +tm[1];
    const ap = tm[3] && tm[3].toLowerCase();
    if (ap === 'p' && h < 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
    if (h > 23 || +tm[2] > 59) { skipped += 1; continue; }
    const d = new Date(day); d.setHours(h, +tm[2], 0, 0);
    claims.push({ id: claims.length, ts: d.getTime(), station: st, line });
  }
  return { claims, skipped };
}

function auditClaims(claims, mine, rivals, recordedFrom, recordedTo) {
  const used = new Set();
  const out = claims.map((c) => ({ ...c, status: null, heard: null, rival: null }));
  // Pass 1: the spot ran at (about) the logged time. Closest pairs win first.
  const pairs = [];
  for (const c of out) for (const a of mine) {
    if (a.station.id !== c.station.id) continue;
    const dt = Math.abs(a.ts - c.ts);
    if (dt <= AUDIT_TOL_MS) pairs.push([dt, c, a]);
  }
  pairs.sort((x, y) => x[0] - y[0]);
  for (const [, c, a] of pairs) {
    if (c.status || used.has(a.id)) continue;
    c.status = 'ran'; c.heard = a; used.add(a.id);
  }
  // Pass 2: whatever is left.
  for (const c of out.filter((x) => !x.status)) {
    if (c.station.nc) { c.status = 'unmon'; continue; }
    if (c.ts < recordedFrom || c.ts > recordedTo) { c.status = 'out'; continue; }
    const day = new Date(c.ts).toDateString();
    const left = mine.filter((a) => !used.has(a.id) && a.station.id === c.station.id && new Date(a.ts).toDateString() === day)
      .sort((x, y) => Math.abs(x.ts - c.ts) - Math.abs(y.ts - c.ts))[0];
    if (left) { c.status = 'moved'; c.heard = left; used.add(left.id); } else c.status = 'missed';
  }
  for (const c of out) {
    if (!c.heard) continue;
    const r = rivals.find((a) => a.station.id === c.heard.station.id && Math.abs(a.ts - c.heard.ts) <= RIVAL_GAP_MS);
    if (r) c.rival = r.creative.advertiser;
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// Demo only: an invoice built from the spots we heard, with a few lines the station
// can't back up (not heard, or heard at a different time of day).
function sampleInvoice(name, mine, now) {
  const radio = mine.filter((a) => a.station.media === 'Radio' && a.ts < now - 30 * 60000);
  const counts = new Map();
  for (const a of radio) counts.set(a.station.id, (counts.get(a.station.id) || 0) + 1);
  let top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => id);
  if (!top.length) return '';
  // Yesterday, a full day, like one page of a monthly invoice.
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0); dayStart.setDate(dayStart.getDate() - 1);
  const dayEnd = dayStart.getTime() + 86400000;
  const onDay = (ids) => radio.filter((a) => ids.includes(a.station.id) && a.ts >= dayStart.getTime() && a.ts < dayEnd).sort((a, b) => a.ts - b.ts);
  let picked = onDay(top);
  if (picked.length > 40) { top = top.slice(0, 1); picked = onDay(top); }
  const rng = mulberry(hashStr(name));
  const fmt = (ts) => {
    const d = new Date(ts);
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}  ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
  };
  const clear = (sid, ts) => !radio.some((a) => a.station.id === sid && Math.abs(a.ts - ts) < 3 * AUDIT_TOL_MS);
  const lines = picked.map((a) => ({ sid: a.station.id, ts: a.ts - Math.floor(rng() * 50000), len: a.creative.length, rate: a.estCost }));
  // One spot logged in morning drive that we actually heard at another time of day.
  const off = lines.find((l) => daypartFor(new Date(l.ts)).name !== 'AM Drive');
  if (off) {
    for (const [h, m] of [[7, 50], [8, 20], [6, 40], [9, 10]]) {
      const d = new Date(dayStart); d.setHours(h, m, 0, 0);
      if (clear(off.sid, d.getTime())) { off.ts = d.getTime(); off.rate = Math.round(off.rate * 1.8); break; }
    }
  }
  // Three morning- and afternoon-drive spots on the invoice that never aired.
  let added = 0;
  for (let tries = 0; tries < 60 && added < 3; tries++) {
    const sid = top[tries % top.length];
    const d = new Date(dayStart);
    d.setHours(rng() < 0.6 ? 6 + Math.floor(rng() * 4) : 15 + Math.floor(rng() * 4), Math.floor(rng() * 60), 0, 0);
    if (clear(sid, d.getTime()) && !lines.some((l) => l.sid === sid && Math.abs(l.ts - d.getTime()) < 3 * AUDIT_TOL_MS)) {
      lines.push({ sid, ts: d.getTime(), len: 30, rate: 120 + Math.floor(rng() * 80) });
      added += 1;
    }
  }
  lines.sort((a, b) => a.ts - b.ts);
  return [
    `SAMPLE INVOICE / AFFIDAVIT (demo) · Advertiser: ${name}`,
    'Station   Date      Time      Len  Rate',
    ...lines.map((l) => `${l.sid.padEnd(9)} ${fmt(l.ts)}  :${l.len}  $${l.rate}.00`),
  ].join('\n');
}
const hashStr = (s) => [...s].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619), 2166136261) >>> 0;
function mulberry(seed) {
  return () => { let t = (seed += 0x6d2b79f5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function readSpotFile(file) {
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
    const pdfjs = await import('pdfjs-dist');
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const out = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const rows = new Map();
      for (const it of (await page.getTextContent()).items) {
        if (!it.str) continue;
        const y = Math.round(it.transform[5] / 3);
        if (!rows.has(y)) rows.set(y, []);
        rows.get(y).push([it.transform[4], it.str]);
      }
      [...rows.entries()].sort((a, b) => b[0] - a[0])
        .forEach(([, items]) => out.push(items.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(' ')));
    }
    return out.join('\n');
  }
  return file.text();
}

const AUDIT_LABEL = {
  ran: ['ok', '✓ Ran'], moved: ['extra', 'Wrong time'], missed: ['short', 'Not heard'],
  out: ['muted', 'Not recorded yet'], unmon: ['muted', "Station we don't record"],
};

function SpotAudit({ name, events, now, cutoff, copy }) {
  const [hide, setHide] = useState(true);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef(null);
  useEffect(() => { setText(''); setErr(''); }, [name]);

  const recordedFrom = now - CHECK_MAX_DAYS * 86400000;
  const hourKey = Math.floor(now / 3600000);
  const me = CREATIVES.find((c) => c.advertiser === name);
  const mine = useMemo(() => {
    const hist = airingHistory(name, recordedFrom, Math.min(cutoff, now));
    return [...events.filter((d) => d.creative.advertiser === name), ...hist];
  }, [name, hourKey, events.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = useMemo(() => (text.trim() ? parseSpotLines(text, now) : { claims: [], skipped: 0 }), [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const rivals = useMemo(() => {
    if (!parsed.claims.length || !me) return [];
    const lo = Math.min(...parsed.claims.map((c) => c.ts)) - 86400000;
    const hi = Math.max(...parsed.claims.map((c) => c.ts)) + 86400000;
    const names = [...new Set(CREATIVES.filter((c) => c.category === me.category && c.advertiser !== name && (!c.market || !me.market || c.market === me.market)).map((c) => c.advertiser))];
    return [
      ...events.filter((d) => names.includes(d.creative.advertiser)),
      ...names.flatMap((n) => airingHistory(n, Math.max(lo, recordedFrom), Math.min(hi, cutoff, now))),
    ];
  }, [parsed, name]); // eslint-disable-line react-hooks/exhaustive-deps
  const results = useMemo(() => auditClaims(parsed.claims, mine, rivals, recordedFrom, now), [parsed, mine, rivals]); // eslint-disable-line react-hooks/exhaustive-deps

  const n = (s) => results.filter((r) => r.status === s).length;
  const ran = n('ran'); const moved = n('moved'); const missed = n('missed');
  const nextToRival = results.filter((r) => r.rival).length;
  const isSample = text.startsWith('SAMPLE INVOICE');

  const take = (t) => setText(hide ? redactPrices(t) : t);
  const onFile = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    setErr(''); setBusy(true);
    try {
      const t = await readSpotFile(f);
      if (!t.trim()) setErr("We couldn't find any text in that file. A scanned paper invoice is a photo inside a PDF; reading those needs our server (coming with the recorder).");
      take(t);
    } catch {
      setErr("We couldn't read that file. Try a PDF, CSV or text export from the station, or paste the spot lines below.");
    } finally { setBusy(false); }
  };
  const when = (ts) => new Date(ts).toLocaleString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const note = () => [
    `${name}: spot-by-spot check of the station invoice${isSample ? ' (SAMPLE)' : ''}`,
    `${results.length} spots listed · ${ran} heard as logged · ${moved} heard at a different time · ${missed} not heard`,
    ...results.filter((r) => r.status === 'missed').map((r) => `NOT HEARD: ${r.station.call} ${when(r.ts)}`),
    ...results.filter((r) => r.status === 'moved').map((r) => `WRONG TIME: ${r.station.call} logged ${when(r.ts)} (${daypartFor(new Date(r.ts)).name}), heard ${when(r.heard.ts)} (${r.heard.daypart})`),
    ...results.filter((r) => r.rival).map((r) => `SAME BREAK AS A COMPETITOR: ${r.station.call} ${when(r.heard.ts)} next to ${r.rival}`),
    'Please confirm and schedule makegoods for the spots above.',
  ].join('\n');

  return (
    <>
      <div className="ri-section-head"><h2>Check the station's invoice, spot by spot</h2><span className="ri-count">what they say aired vs what we heard</span></div>
      <p className="ri-feed-explain">
        Each month the station sends an invoice (the "affidavit") listing every spot it says aired. Add it here and we check each line against what we recorded: ran on time, ran at the wrong time of day, or never heard.
      </p>
      <label className="ri-audit-priv">
        <input type="checkbox" checked={hide} onChange={(e) => { setHide(e.target.checked); if (e.target.checked) setText((t) => redactPrices(t)); }} />
        <span><b>Hide what I paid</b> (recommended). Dollar amounts are blacked out before anything is read. We only need station, date and time.</span>
      </label>
      <div className="ri-audit-in">
        <button type="button" className="ri-btn" onClick={() => fileRef.current && fileRef.current.click()} disabled={busy}>{busy ? 'Reading…' : 'Choose invoice file'}</button>
        <input ref={fileRef} type="file" hidden accept=".pdf,.csv,.tsv,.txt,application/pdf,text/*" onChange={onFile} />
        <button type="button" className="ri-link" onClick={() => take(sampleInvoice(name, mine, now))}>Try a sample invoice</button>
        {text && <button type="button" className="ri-link" onClick={() => setText('')}>Clear</button>}
      </div>
      <textarea className="ri-audit-text" rows={text ? 7 : 3} value={text} onChange={(e) => take(e.target.value)}
        placeholder="…or paste the spot lines here (station, date, time on each line)" spellCheck={false} />
      <p className="muted small">PDF, CSV or text exports. Read on this device: nothing is uploaded or saved. Photos of paper invoices come later, since they need our server to read them.</p>
      {err && <p className="ri-empty">{err}</p>}

      {text.trim() && results.length === 0 && (
        <p className="ri-empty">No spot lines found. Each line needs a station's call letters (e.g. KPLZ), a date and a time.</p>
      )}
      {results.length > 0 && (
        <>
          {isSample && <p className="muted small"><b>Sample:</b> built from the demo spots, with a few lines added that the station can't back up.</p>}
          <div className="ri-onair-stats wide">
            <div><b>{results.length}</b><span>spots listed</span></div>
            <div><b>{ran}</b><span>heard as logged</span></div>
            <div><b>{moved}</b><span>wrong time</span></div>
            <div><b>{missed}</b><span>not heard</span></div>
          </div>
          {missed + moved + nextToRival > 0 ? (
            <div className="ri-beat threat">
              <b>{[missed && `${missed} spot${missed > 1 ? 's' : ''} not heard`, moved && `${moved} at a different time of day than billed`, nextToRival && `${nextToRival} in the same break as a competitor`].filter(Boolean).join(' · ')}</b>
              <span className="muted">Ask the station rep to confirm and schedule makegoods.</span>
              <button type="button" className="ri-link" onClick={() => copy(note(), 'Makegood note copied')}>Copy a note to the rep →</button>
            </div>
          ) : (
            <div className="ri-beat ok"><b>✓ Every spot we could check ran as logged.</b></div>
          )}
          <div className="ri-table-wrap">
            <table className="ri-table ri-check-table ri-audit-table">
              <thead><tr><th>Station says</th><th>Station</th><th>What we heard</th></tr></thead>
              <tbody>
                {results.map((r) => {
                  const [cls, label] = AUDIT_LABEL[r.status];
                  return (
                    <tr key={r.id}>
                      <td>{new Date(r.ts).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' })}<br /><b>{timeOf(r.ts)}</b></td>
                      <td><b>{r.station.id}</b></td>
                      <td>
                        {cls === 'muted' ? <span className="muted small">{label}</span> : <span className={`ri-check-tag ${cls}`}>{label}</span>}
                        {r.status === 'ran' && <span className="muted small"> {timeOf(r.heard.ts)}</span>}
                        {r.status === 'moved' && <span className="muted small"> heard {timeOf(r.heard.ts)}{r.heard.daypart !== daypartFor(new Date(r.ts)).name ? `, ${r.heard.daypart} instead of ${daypartFor(new Date(r.ts)).name}` : ''}</span>}
                        {r.rival && <div className="ri-audit-rival">⚠ Same break as {r.rival}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {parsed.skipped > 0 && <p className="muted small">Skipped {parsed.skipped} line{parsed.skipped > 1 ? 's' : ''} without a station, date and time (headers, totals).</p>}
          <p className="muted small">
            "Heard as logged" = within {AUDIT_TOL_MS / 60000} minutes of the station's time (stream and log clocks differ a little). "Same break" = a same-category ad within {RIVAL_GAP_MS / 60000} minutes. We check only stations we record, over the last {CHECK_MAX_DAYS} days. Demo: older spots are simulated.
          </p>
        </>
      )}
    </>
  );
}

function CheckView({ events, now, me, onOpen, notify }) {
  const [name, setName] = useState(() => (me && ADVERTISERS.includes(me) ? me : ''));
  const [typed, setTyped] = useState(name);
  const [win, setWin] = useState('7d');
  const [keyword, setKeyword] = useState('');
  const [orders, setOrders] = useState(() => store('ri.orders.v1', {}));
  const [addSt, setAddSt] = useState('');
  const [addN, setAddN] = useState('');
  const [limit, setLimit] = useState(30);
  useEffect(() => save('ri.orders.v1', orders), [orders]);

  const creatives = CREATIVES.filter((c) => c.advertiser === name);
  const market = creatives.find((c) => c.market)?.market || null;
  const days = CHECK_WINDOWS.find((w) => w[0] === win)[2];
  const from = now - days * 86400000;
  const hourKey = Math.floor(now / 3600000);
  // The live feed covers the last 3 hours; older spots come from the stored log (rebuilt for the demo).
  const cutoff = events.length ? events[events.length - 1].ts : now - WINDOW_MS;
  const history = useMemo(() => (name ? airingHistory(name, from, Math.min(cutoff, now)) : []), [name, win, hourKey, cutoff > from]); // eslint-disable-line react-hooks/exhaustive-deps
  const kw = keyword.trim().toLowerCase();
  const airings = useMemo(() => {
    const recent = events.filter((d) => d.creative.advertiser === name && d.ts >= from);
    const all = [...recent, ...history].sort((a, b) => b.ts - a.ts);
    if (!kw) return all;
    return all.filter((d) => [d.creative.offer.headline, d.creative.offer.product, d.creative.transcript, d.creative.offer.promoCode].some((v) => v && String(v).toLowerCase().includes(kw)));
  }, [events, history, name, from, kw]);

  const order = orders[name] || {};
  const orderIds = Object.keys(order);
  const byStation = new Map();
  for (const d of airings) {
    const cur = byStation.get(d.station.id) || { s: d.station, n: 0, secs: 0, last: 0 };
    cur.n += 1; cur.secs += d.creative.length; cur.last = Math.max(cur.last, d.ts);
    byStation.set(d.station.id, cur);
  }
  const scale = days / 7;
  const rows = [
    ...orderIds.map((id) => {
      const s = STATIONS.find((x) => x.id === id);
      const h = byStation.get(id);
      const bought = Math.round(order[id] * scale);
      const heard = h ? h.n : 0;
      const short = Math.max(0, bought - heard);
      const avg = (s?.rate60 || 0) * 0.7; // a :30 at an average daypart
      return { id, s, bought, heard, short, value: short * avg, status: heard === 0 ? 'none' : heard >= bought * 0.95 ? 'ok' : 'short' };
    }),
    ...[...byStation.values()].filter((h) => !order[h.s.id]).map((h) => ({ id: h.s.id, s: h.s, bought: null, heard: h.n, short: 0, value: 0, status: 'extra' })),
  ].sort((a, b) => (b.bought ?? -1) - (a.bought ?? -1) || b.heard - a.heard);
  const shortRows = rows.filter((r) => r.status === 'short' || r.status === 'none');
  const missedValue = shortRows.reduce((a, r) => a + r.value, 0);
  const canCompare = days >= 1 && orderIds.length > 0;

  // Counts by hour (1h and 24h views) or by day (7 and 30 days).
  const buckets = useMemo(() => {
    if (days <= 1) {
      const n = days < 1 ? 12 : 24;
      const size = days < 1 ? 5 * 60000 : 3600000;
      const end = Math.ceil(now / size) * size;
      return Array.from({ length: n }, (_, i) => {
        const s = end - (n - i) * size;
        return { label: days < 1 ? timeOf(s) : hourLabel(new Date(s).getHours()), n: airings.filter((d) => d.ts >= s && d.ts < s + size).length };
      });
    }
    const n = Math.round(days);
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    return Array.from({ length: n }, (_, i) => {
      const s = today.getTime() - (n - 1 - i) * 86400000;
      return { label: new Date(s).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }), n: airings.filter((d) => d.ts >= s && d.ts < s + 86400000).length };
    });
  }, [airings, days, now]);
  const peak = Math.max(1, ...buckets.map((b) => b.n));

  const pick = (v) => {
    const hit = ADVERTISERS.find((a) => a.toLowerCase() === v.trim().toLowerCase()) || ADVERTISERS.find((a) => a.toLowerCase().includes(v.trim().toLowerCase()));
    setTyped(hit || v); setName(hit || ''); setLimit(30);
  };
  const addOrder = () => {
    const n = parseInt(addN, 10);
    if (!addSt || !(n > 0)) return;
    setOrders({ ...orders, [name]: { ...order, [addSt]: n } });
    setAddSt(''); setAddN('');
  };
  const removeOrder = (id) => { const o = { ...order }; delete o[id]; setOrders({ ...orders, [name]: o }); };
  const winLabel = CHECK_WINDOWS.find((w) => w[0] === win)[3];
  const copy = async (text, msg) => {
    try { await navigator.clipboard.writeText(text); notify(msg, 'Paste it into Sheets, an email or a text'); } catch { notify('Copy failed', 'Your browser blocked the clipboard'); }
  };
  const makegoodNote = () => [
    `${name}: radio schedule check, ${winLabel} (to ${new Date(now).toLocaleString('en-US')})`,
    ...shortRows.map((r) => `${r.s?.call || r.id}: ordered ${r.bought}, heard ${r.heard}, short ${r.short}${r.value ? ` (about ${money(r.value)})` : ''}`),
    'Please confirm the missing spots and schedule makegoods.',
  ].join('\n');
  const stationChoices = STATIONS.filter((s) => !s.nc && (market ? s.market === market : true) && !order[s.id] && (s.media === 'Radio' || !market || market === 'Seattle'));

  return (
    <>
      <div className="ri-section-head"><h2>Ad Check</h2><span className="ri-count">did my ads run?</span></div>
      <p className="ri-feed-explain">
        Type your business and see every spot we heard, by hour or by day, on each station. Add what you bought and we flag any station that came up short, so you can ask for makegoods.
      </p>

      <form className="ri-check-form" onSubmit={(e) => { e.preventDefault(); pick(typed); }}>
        <label htmlFor="ri-check-name">Business</label>
        <div className="row">
          <input id="ri-check-name" list="ri-check-list" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Dealer or business name" autoComplete="off" />
          <button type="submit" className="ri-btn">Check</button>
        </div>
        <datalist id="ri-check-list">{ADVERTISERS.map((a) => <option key={a} value={a} />)}</datalist>
        {me && me !== name && ADVERTISERS.includes(me) && (
          <button type="button" className="ri-link" onClick={() => pick(me)}>Use {me} (Insights on)</button>
        )}
      </form>

      {!name && typed.trim() && (
        <p className="ri-empty">We haven't heard any ads for "{typed.trim()}" yet. Once recording runs, every airing lands here within seconds.</p>
      )}

      {name && (
        <>
          <div className="ri-seg" role="tablist" aria-label="Time window">
            {CHECK_WINDOWS.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={win === id} className={win === id ? 'on' : ''} onClick={() => { setWin(id); setLimit(30); }}>{label}</button>
            ))}
          </div>
          <input className="ri-check-kw" value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="Only ads that mention… (optional: a promo, a model, a sale name)" />

          <div className="ri-onair-stats wide">
            <div><b>{airings.length}</b><span>spots heard</span></div>
            <div><b>{byStation.size}</b><span>stations</span></div>
            <div><b>{(airings.reduce((a, d) => a + d.creative.length, 0) / 60).toFixed(1)}</b><span>ad minutes</span></div>
            <div><b>{airings[0] ? ago(airings[0].ts, now) : '–'}</b><span>last heard</span></div>
          </div>

          <div className="ri-section-head"><h2>{days <= 1 ? 'By hour' : 'By day'}</h2><span className="ri-count">spots heard · {winLabel}</span></div>
          <div className={`ri-check-bars ${buckets.length > 14 ? 'dense' : ''}`}>
            {buckets.map((b) => (
              <div key={b.label} className="bar" title={`${b.label}: ${b.n} spots`}>
                <span className="n">{b.n || ''}</span>
                <span className="fill" style={{ height: `${(b.n / peak) * 100}%` }} />
                <span className="lb">{b.label}</span>
              </div>
            ))}
          </div>

          <div className="ri-section-head"><h2>What you bought vs what aired</h2><span className="ri-count">by station</span></div>
          {orderIds.length === 0 && (
            <p className="ri-feed-explain">Add each station on your order and the spots per week. Without an order we still list every station we heard you on.</p>
          )}
          <div className="ri-check-add">
            <select value={addSt} onChange={(e) => setAddSt(e.target.value)} aria-label="Station you bought">
              <option value="">Add a station you bought…</option>
              {stationChoices.map((s) => <option key={s.id} value={s.id}>{s.call} {s.network || s.band}{s.market !== market ? ` · ${s.market}` : ''}</option>)}
            </select>
            <input type="number" min="1" inputMode="numeric" value={addN} onChange={(e) => setAddN(e.target.value)} placeholder="Per week" aria-label="Spots per week" />
            <button type="button" className="ri-btn" onClick={addOrder} disabled={!addSt || !(parseInt(addN, 10) > 0)}>Add</button>
          </div>
          {rows.length > 0 && (
            <div className="ri-table-wrap">
              <table className="ri-table ri-check-table">
                <thead><tr><th>Station</th><th className="num">Bought</th><th className="num">Heard</th><th>Result</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td><b>{r.s?.call || r.id}</b>{r.bought != null && <button type="button" className="ri-x" onClick={() => removeOrder(r.id)} aria-label={`Remove ${r.s?.call || r.id}`}>×</button>}</td>
                      <td className="num">{r.bought == null ? '–' : `${days < 1 ? '' : days === 7 ? '' : '≈'}${r.bought}`}</td>
                      <td className="num">{r.heard}</td>
                      <td>
                        {r.status === 'ok' && <span className="ri-check-tag ok">✓ Ran</span>}
                        {r.status === 'short' && canCompare && <span className="ri-check-tag short">Short {r.short}</span>}
                        {r.status === 'none' && canCompare && <span className="ri-check-tag short">Not heard</span>}
                        {r.status === 'extra' && orderIds.length > 0 && <span className="ri-check-tag extra" title="Heard on this station, but it isn't on the order you entered">Not ordered</span>}
                        {!canCompare && r.status !== 'extra' && <span className="muted small">use 24 hrs+</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {canCompare && (shortRows.length === 0 ? (
            <div className="ri-beat ok"><b>✓ Every station on your order delivered its spots for the {winLabel}.</b></div>
          ) : (
            <div className="ri-beat threat">
              <b>{shortRows.reduce((a, r) => a + r.short, 0)} ordered spots not heard on {shortRows.length} station{shortRows.length > 1 ? 's' : ''}</b>
              <span className="muted">{missedValue > 0 ? `About ${money(missedValue)} at typical :30 rates (an estimate). ` : ''}Ask the station rep for makegoods.</span>
              <button type="button" className="ri-link" onClick={() => copy(makegoodNote(), 'Makegood note copied')}>Copy a note to the rep →</button>
            </div>
          ))}
          {orderIds.length > 0 && days !== 7 && days >= 1 && <p className="muted small">Bought is your weekly count spread over the {winLabel}, so ≈ is a pro-rated target. Flights that skip days can look short on a single day; the 7-day view is exact.</p>}

          <SpotAudit name={name} events={events} now={now} cutoff={cutoff} copy={copy} />

          <div className="ri-section-head"><h2>Airing log</h2><span className="ri-count">newest first · tap for the ad</span></div>
          <button type="button" className="ri-link" onClick={() => copy(toTSV(airings), `${airings.length} spots copied`)}>Copy the log for Google Sheets →</button>
          <ul className="ri-check-log">
            {airings.slice(0, limit).map((d) => (
              <li key={d.id}>
                <button type="button" onClick={() => onOpen(d)}>
                  <span className="mono when">{new Date(d.ts).toLocaleString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                  <b>{d.station.call}</b>
                  <span className="muted">:{d.creative.length} · {d.daypart}</span>
                  <span className="mono muted">{d.confidence}%</span>
                  <span className="hl">{d.creative.offer.headline}</span>
                </button>
              </li>
            ))}
          </ul>
          {airings.length > limit && <button type="button" className="ri-more" onClick={() => setLimit(limit + 50)}>Show {Math.min(50, airings.length - limit)} more</button>}
          <p className="muted small">
            Proof of airing = station, exact time, length and the words we matched (the % is match confidence). We keep up to {CHECK_MAX_DAYS} days and store no audio.
            Demo: the live 3 hours are the feed; older spots are rebuilt at the same pace, so they're simulated.
          </p>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ sheets & alerts
// The purpose first: your market, live, in a Google Sheet you own. Then what's in it, how you get it, and alerts.

const SHEET_TABS = [
  ['Every ad', 'One row for every spot we hear: time, station, business, the offer, payment, due at signing, term, APR and est. cost.'],
  ['Deal board', "Each competitor's current deal beside yours, ranked by true monthly cost. Red = theirs costs a shopper less."],
  ['Competitors', 'Each business you track: spots this week vs last, share of voice, last heard and which stations.'],
  ['Changes', 'Every price change, new ad, new advertiser, and anyone who went quiet, with the date.'],
  ['My ads', 'Every spot of yours we heard, by station and hour, to check against what you bought.'],
];

function SheetsView({ rows, market, city = 'All', category, query, media, watchlist, toggleWatch, alertsOn, setAlertsOn, beatAlerts, setBeatAlerts, me, notify }) {
  const scope = [media === 'Both' ? 'Radio + TV' : media, market === 'All' ? 'All markets' : `${market} metro`, city !== 'All' && city, category === 'All' ? 'all categories' : category, query && `"${query}"`].filter(Boolean).join(', ');
  const feedUrl = `https://api.radiointel.network/v1/feed.csv?market=${market === 'All' ? 'all' : encodeURIComponent(market.toLowerCase())}${city !== 'All' ? `&city=${encodeURIComponent(city.toLowerCase())}` : ''}&key=YOUR_CLIENT_KEY`;
  const formula = `=IMPORTDATA("${feedUrl}")`;
  const deal = dealOf(me);
  const board = deal ? rankBoard(deal.market, deal.auto.monthly ? 'lease' : 'cash').slice(0, 6) : [];

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
      <section className="ri-panel ri-sheets-hero">
        <span className="ri-eyebrow">Sheets</span>
        <h2>Your market, live, in your own Google Sheet</h2>
        <p>Every competitor's ads, deals and airtime land in a Google Sheet you own, and it keeps itself up to date. Sort it, filter it, share it with your GM, or build your own charts. Nothing new to log in to.</p>
      </section>

      <div className="ri-section-head"><h2>What's in your sheet</h2><span className="ri-count">{SHEET_TABS.length} tabs</span></div>
      <ol className="ri-sheet-tabs">
        {SHEET_TABS.map(([t, d], i) => (
          <li key={t}><span className="n">{i + 1}</span><span><b>{t}</b><span className="muted">{d}</span></span></li>
        ))}
      </ol>

      {board.length > 0 && (
        <>
          <div className="ri-section-head"><h2>Preview: your Deal board tab</h2><span className="ri-count">{deal.market} · {deal.auto.monthly ? 'leases' : 'cash off'} on air</span></div>
          <div className="ri-table-wrap ri-sheet-preview">
            <table className="ri-table">
              <thead><tr><th>#</th><th>Dealer</th><th>Vehicle</th>{deal.auto.monthly ? <><th className="num">Payment</th><th className="num">Due</th><th className="num">True / mo</th></> : <th className="num">Cash off</th>}<th>Vs you</th></tr></thead>
              <tbody>
                {board.map((x, i) => {
                  const cmp = compareDeals(x.n, me);
                  return (
                    <tr key={x.n} className={x.n === me ? 'home' : ''}>
                      <td className="num">{i + 1}</td>
                      <td><b>{x.n}</b></td>
                      <td>{x.a.vehicle}</td>
                      {deal.auto.monthly
                        ? <><td className="num">{money(x.a.monthly)}</td><td className="num">{money(x.a.due)}</td><td className="num">{money(trueMonthly(x.a))}</td></>
                        : <td className="num">{money(x.a.cashOff)}</td>}
                      <td>{x.n === me ? <span className="ri-you-tag">You</span> : <VsBadge cmp={cmp} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="ri-section-head"><h2>How you get it</h2><span className="tag amber">Turns on with live recording</span></div>
      <ol className="ri-pipeline">
        <li><b>We set up your sheet</b><span>We create it and share it with your email. You own it.</span></li>
        <li><b>It fills on its own</b><span>New ads show up within minutes of airing. Deals and changes update as they happen.</span></li>
        <li><b>Open it anywhere</b><span>Computer or phone. Share it like any Google Sheet.</span></li>
      </ol>

      <div className="ri-section-head"><h2>Take the current data now</h2></div>
      <div className="ri-panel">
        <p>Copies the ads that match your current filters: <b>{scope}</b>. That's <b>{rows.length.toLocaleString('en-US')} rows</b> with {EXPORT_COLUMNS.length} columns, with payments, money due, term and APR as numbers.</p>
        <div className="ri-sheet-actions">
          <button type="button" className="ri-btn primary" onClick={copyRows}>Copy rows for Sheets</button>
          {!IS_PREVIEW && <button type="button" className="ri-btn" onClick={() => downloadCSV(rows)}>Download CSV</button>}
        </div>
      </div>

      <div className="ri-section-head"><h2>Alerts</h2><span className="ri-count">{watchlist.length} competitors tracked</span></div>
      <div className="ri-panel">
        <label className="ri-switch">
          <input id="ri-beat-alerts" type="checkbox" checked={beatAlerts} onChange={(e) => setBeatAlerts(e.target.checked)} />
          <span><b>Price alert:</b> tell me when a deal lower than {me ? `${me}’s` : 'yours (pick your business in “Insights on”)'} airs (true monthly cost, same market)</span>
        </label>
        <label className="ri-switch">
          <input id="ri-alerts" type="checkbox" checked={alertsOn} onChange={(e) => setAlertsOn(e.target.checked)} />
          <span><b>Competitor alert:</b> tell me when a competitor I track airs (at most one every 45 seconds)</span>
        </label>
        <div className="ri-chips">
          {watchlist.length === 0 && <span className="muted">Nobody tracked yet. Add competitors on Today.</span>}
          {watchlist.map((w) => (
            <button key={w} type="button" className="ri-chip" onClick={() => toggleWatch(w)} aria-label={`Stop tracking ${w}`}>{w} <span aria-hidden="true">×</span></button>
          ))}
        </div>
        <p className="muted small">Alerts pop up inside the app for now. Text and email alerts turn on with live recording.</p>
      </div>

      <details className="ri-details">
        <summary>For your IT person: the feed formula</summary>
        <p>Each client gets a private feed address. This formula in a Google Sheet pulls new ads on its own (Google refreshes it about once an hour; the full service writes rows within minutes).</p>
        <code className="ri-code">{formula}</code>
        <button type="button" className="ri-btn" onClick={copyFormula}>Copy formula</button>
      </details>
      <details className="ri-details">
        <summary>Every column in the Every ad tab ({EXPORT_COLUMNS.length})</summary>
        <div className="ri-chips">
          {EXPORT_COLUMNS.map(([name]) => <span key={name} className="ri-chip static">{name}</span>)}
        </div>
      </details>
      <details className="ri-details">
        <summary>How an ad becomes a row</summary>
        <ol className="ri-pipeline">
          <li><b>Capture</b><span>Record every commercial station around the clock.</span></li>
          <li><b>Detect</b><span>Find ad breaks and fingerprint each spot so repeats match instantly.</span></li>
          <li><b>Transcribe</b><span>Turn each new ad into text, including the fast-read fine print.</span></li>
          <li><b>Pull out the offer</b><span>Price, vehicle, payment, money down, term, APR, promo code, end date, phone and website.</span></li>
          <li><b>Deliver</b><span>The ad lands in the live feed, your alerts and your sheet.</span></li>
        </ol>
      </details>
    </>
  );
}
