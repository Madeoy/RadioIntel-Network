// Real ads recorded off the air by the RadioIntel server (Seattle).
// Only available when the app is opened from the server (same login as the server page);
// on the public demo site /api/feed does not exist and the app stays on demo data.
import { STATION_BY_ID, daypartFor } from './data.js';

const FEED_URL = '/api/feed';

// Recorder station names -> app station ids.
const STATION_ID = { 'KIRO-AM': 'KIRO', 'KIRO-FM': 'KIRO-FM', 'KJEB-FM': 'KJEB', 'KQMV-FM': 'KQMV', 'KRWM-FM': 'KRWM', 'KPNW-FM': 'KPNW-FM' };

const CATEGORY_WORDS = [
  ['Auto Dealer', /auto|car|dealer|vehicle|truck|chevrolet|toyota|ford|honda/],
  ['Legal', /law|legal|attorney|injury/],
  ['Home Services', /home|roof|plumb|hvac|heat|window|remodel|closet|hot tub|spa|pest|solar/],
  ['QSR', /fast food|qsr|burger|pizza|quick/],
  ['Restaurant', /restaurant|dining|food/],
  ['Financial', /bank|credit|loan|mortgage|financ|invest/],
  ['Healthcare', /health|medical|dental|clinic|pharma|drug|hospital/],
  ['Telecom', /telecom|wireless|internet|phone|cable/],
  ['Insurance', /insurance/],
  ['Retail', /retail|store|shop|jewel|furniture|mattress/],
];
const categoryOf = (raw = '') => (CATEGORY_WORDS.find(([, re]) => re.test(raw.toLowerCase())) || ['Other'])[0];

// Server times are Pacific with no offset; November is PST.
const toTs = (t) => Date.parse(/[+-]\d\d:\d\d$|Z$/.test(t) ? t : `${t}-08:00`);
const CONF = { high: 'High', medium: 'Medium', low: 'Low' };

function creativeOf(a) {
  const headline = a.offer || a.price || a.monthly_payment || (a.product ? `${a.product} (no offer stated)` : 'No specific offer stated');
  const terms = [a.monthly_payment && `${a.monthly_payment}/mo`, a.due_at_signing && `${a.due_at_signing} due at signing`,
    a.term, a.apr && `APR ${a.apr}`, a.location].filter(Boolean);
  return {
    id: `REAL-${a.id}`,
    real: true,
    advertiser: a.advertiser,
    parent: 'Heard on air',
    category: categoryOf(a.category),
    rawCategory: a.category,
    city: null,
    length: 30,
    type: 'Produced',
    media: 'Radio',
    onScreen: [],
    notSpoken: [],
    market: 'Seattle',
    scope: 'Local',
    weight: 0,
    pool: [],
    firstSeen: a.first_heard,
    isNew: false,
    transcript: a.quote || '',
    keywords: a.quote ? [a.quote] : [],
    offer: {
      headline,
      offerType: a.offer || a.price ? 'Offer' : 'Brand',
      price: a.price || null,
      product: a.product || null,
      terms,
      expires: a.expires || null,
      exp: null,
      cta: a.phone || a.website || null,
      url: a.website || null,
      phone: a.phone || null,
      promoCode: null,
    },
    realConfidence: CONF[a.confidence] || 'Medium',
  };
}

export async function fetchReal() {
  const res = await fetch(FEED_URL, { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) throw new Error('no feed');
  const feed = await res.json();
  const events = [];
  for (const a of feed.ads || []) {
    const c = creativeOf(a);
    for (const p of a.plays || []) {
      const station = STATION_BY_ID[STATION_ID[p.station] || p.station];
      const ts = toTs(p.time);
      if (!station || !Number.isFinite(ts)) continue;
      events.push({
        id: `real-${a.id}-${p.station}-${p.time}`,
        ts,
        real: true,
        creative: c,
        station,
        daypart: daypartFor(new Date(ts)).name,
        program: null,
        pod: 'Recorded break',
        confidence: c.realConfidence,
        estCost: 0,
        newCreative: false,
      });
    }
  }
  return { events: events.sort((x, y) => y.ts - x.ts), stations: feed.stations || [], at: Date.now() };
}
