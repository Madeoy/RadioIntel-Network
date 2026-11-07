// RadioIntel demo data model.
// Station call signs and frequencies are real (from Wikipedia market lists, full-power
// commercial-band stations only; unverified). Every advertiser detection, offer, rate and
// trend below is SIMULATED. Local advertisers are fictional; phone numbers use 555.
// In production these records come from: stream capture -> ad-break detection ->
// speech-to-text -> offer extraction (AI fills the `offer` / `auto` fields) -> creative dedupe.

export const HOME_MARKET = 'Seattle';
export const MARKETS = ['Seattle', 'Portland', 'Spokane', 'Boise', 'Nashville'];

const RAW_STATIONS = {
  Seattle: {
    fm: 'KQMV 92.5,KJR-FM 93.3,KLSY 93.7,KSWD 94.1,KJEB 95.7,KXXO 96.1,KJAQ 96.5,KIRO-FM 97.3,KPNW-FM 98.9,KDDS-FM 99.3,KISW 99.9,KKWF 100.7,KPLZ-FM 101.5,KZOK-FM 102.5,KZTM 102.9,KHTP 103.7,KLSW 104.5,KTDD 104.9,KCMS 105.3,KBKS-FM 106.1,KRWM 106.9,KNDD 107.7',
    am: 'KVI 570,KCIS 630,KIRO 710,KTTH 770,KGNW 820,KHHO 850,KIXI 880,KJR 950,KNWN 1000,KBLE 1050,KPTR 1090,KKNW 1150,KLAY 1180,KMIA 1210,KWYZ 1230,KKDZ 1250,KKOL 1300,KGRG 1330,KKMO 1360,KRKO 1380,KITZ 1400,KRIZ 1420,KSUH 1450,KBRO 1480,KKXA 1520,KXPA 1540,KZIZ 1560,KLFE 1590,KYIZ 1620,KNTS 1680',
    fmRate: [450, 900], amRate: [70, 240],
  },
  Portland: {
    fm: 'KGON 92.3,KRYP 93.1,KPDQ-FM 93.9,KZZR 94.3,KNRK 94.7,KBFF 95.5,KKWA 96.3,KYCH-FM 97.1,KLVP 97.9,KUPL 98.7,KWJJ-FM 99.5,KKRZ 100.3,KXL-FM 101.1,KINK 101.9,KKCW 103.3,KPOZ 104.1,KPLP 104.5,KRSK-FM 105.1,KFBW 105.9,KLTH 106.7,KXJM 107.5',
    am: 'KPOJ 620,KXTG 750,KPDQ 800,KPAM 860,KWIP 880,KMTT 910,KWBY 940,KUFO 970,KOOR 1010,KXPD 1040,KRSK 1080,KQRR 1130,KEX 1190,KRYN 1410,KBNP 1450,KBPS 1480,KBMS 1520,KGDD 1550,KKOV 1640',
    fmRate: [340, 700], amRate: [60, 190],
  },
  Spokane: {
    fm: 'KZZU-FM 92.9,KDRK-FM 93.7,KHTQ 94.5,KPND 95.3,KFOO-FM 96.1,KEZE 96.9,KKRS 97.3,KISC 98.1,KKZX 98.9,KXLY-FM 99.9,KEYF-FM 101.1,KTSL 101.9,KICR 102.3,KCDA 103.1,KBBD 103.9,KJYR 104.5,KEEH 104.9,KZBD 105.7,KLSN 106.5,KBNW-FM 107.1',
    am: 'KQNT 590,KTRW 630,KXLX 700,KJRB 790,KXLY 920,KTTO 970,KSPO 1050,KVNI 1080,KSBN 1230,KZFS 1280,KYOZ 1330,KGA 1510',
    fmRate: [100, 230], amRate: [35, 90],
  },
  Boise: {
    fm: 'KIZN 92.3,KBOI-FM 93.1,KBXL 94.1,KRVB 94.9,KSRV-FM 96.1,KKGL 96.9,KQFC 97.9,KARO 98.7,KLXI 99.5,KQXR 100.3,KPDA 100.7,KWYD 101.1,KQBL 101.9,KZMG 102.7,KSAS-FM 103.5,KAWO 104.3,KJOT 105.1,KCIX 105.9,KDBI-FM 106.3,KTHI 107.1,KXLT-FM 107.9',
    am: 'KIDO 580,KFXD 630,KBOI 670,KSPD 790,KYWN 890,KMHR 950,KBGN 1060,KGEM 1140,KMHI 1240,KKOO 1260,KTIK 1350,KTRP 1450,KCID 1490',
    fmRate: [95, 210], amRate: [30, 80],
  },
  Nashville: {
    fm: 'WQQK 92.1,WJXA 92.9,WFFI 93.7,WAIV 94.1,WHPY-FM 94.5,WSM-FM 95.5,WCJK 96.3,WLVU 97.1,WSIX-FM 97.9,WANT 98.9,WWTN 99.7,WRLT 100.1,WUBT 101.1,WPRT-FM 102.5,WBUZ 102.9,WKDF 103.3,WGFX 104.5,WLVN 104.9,WNRQ 105.9,WNFN 106.7,WRVW 107.5',
    am: 'WNSR 560,WSM 650,WENO 760,WNTC 790,WQZQ 830,WMDB 880,WKDA 900,WYFN 980,WCRT 1160,WFCN 1200,WNVL 1240,WNQM 1300,WNAH 1360,WHEW 1380,WYGI 1430,WGNS 1450,WVOL 1470,WCOR 1490,WLAC 1510',
    fmRate: [240, 460], amRate: [45, 140],
  },
};

const DEGRADED = { KTDD: 'Stream buffering, 2.1% packet loss', KLXI: 'Stream offline for 6 min, reconnecting' };

export function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s) => [...s].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619), 2166136261) >>> 0;

export const STATIONS = MARKETS.flatMap((market) => {
  const m = RAW_STATIONS[market];
  const parse = (list, band, [lo, hi]) => list.split(',').map((entry) => {
    const [id, freq] = entry.trim().split(' ');
    const r = mulberry32(hash(id))();
    return {
      id, freq, band, market,
      call: `${id} ${freq}`,
      rate60: Math.round((lo + r * (hi - lo)) / 10) * 10,
      weight: band === 'FM' ? 1 : 0.3,
      status: DEGRADED[id] ? 'degraded' : 'live',
      note: DEGRADED[id],
    };
  });
  return [...parse(m.fm, 'FM', m.fmRate), ...parse(m.am, 'AM', m.amRate)].map((s) => ({ ...s, media: 'Radio' }));
});

// Seattle broadcast TV (call signs from memory; verify against FCC). TV is Seattle-only in the demo.
// rate60 is a :60-equivalent base; a prime :30 lands around $3–6K.
const TV_RAW = [
  ['KOMO-TV', '4', 'ABC'], ['KING-TV', '5', 'NBC'], ['KIRO-TV', '7', 'CBS'], ['KSTW', '11', 'CW'],
  ['KCPQ', '13', 'FOX'], ['KONG', '16', 'Independent'], ['KZJO', '22', 'MyNetworkTV'], ['KUNS-TV', '51', 'Univision'],
];
export const TV_STATIONS = TV_RAW.map(([id, ch, network]) => {
  const r = mulberry32(hash(id))();
  const big = ['ABC', 'NBC', 'CBS', 'FOX'].includes(network);
  return {
    id, freq: `Ch ${ch}`, band: 'TV', media: 'TV', market: 'Seattle', network,
    call: `${id} ${ch}`,
    rate60: Math.round(((big ? 1900 : 650) + r * (big ? 1600 : 600)) / 50) * 50,
    weight: big ? 1 : 0.55,
    status: 'live',
  };
});
STATIONS.push(...TV_STATIONS);

export const STATION_BY_ID = Object.fromEntries(STATIONS.map((s) => [s.id, s]));

export const CATEGORIES = ['Auto Dealer', 'Legal', 'Home Services', 'QSR', 'Retail', 'Financial', 'Healthcare', 'Telecom', 'Insurance', 'Restaurant'];
export const DAYPARTS = ['AM Drive', 'Midday', 'PM Drive', 'Evening', 'Overnight'];

const fmtDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// ------------------------------------------------------------- creative library
// One entry = one unique ad. `auto` holds the structured numbers for car deals.
const RAW_CREATIVES = [
  // ---- national
  { id: 'BK-WHOP7-30', advertiser: 'Burger King', parent: 'Restaurant Brands Intl.', category: 'QSR', length: 30, weight: 9, firstSeen: 'Nov 1',
    offer: { headline: '2 Whopper sandwiches for $7', offerType: 'Bundle price', price: '$7.00', product: 'Whopper (x2)', terms: ['BK app or BK.com orders only', 'Participating U.S. restaurants', 'Limited time'], exp: '2026-11-30', cta: 'Order in the BK app', url: 'bk.com' },
    transcript: 'Right now get two flame-grilled Whopper sandwiches for just seven bucks, only when you order in the BK app. Participating restaurants, limited time.', keywords: ['two flame-grilled Whopper sandwiches', 'seven bucks', 'BK app'] },
  { id: 'WEN-BIGGIE5-30', advertiser: "Wendy's", parent: "The Wendy's Company", category: 'QSR', length: 30, weight: 7, firstSeen: 'Oct 20',
    offer: { headline: '$5 Biggie Bag', offerType: 'Value meal', price: '$5.00', product: 'Sandwich, 4-pc nuggets, small fries, drink', terms: ['Jr. Bacon Cheeseburger or Crispy Chicken', 'Price and participation may vary'], exp: null, cta: "Visit Wendy's or order in the app", url: 'wendys.com' },
    transcript: 'The five dollar Biggie Bag is back. A Jr. Bacon Cheeseburger, four-piece nuggets, small fries and a drink, all for five bucks.', keywords: ['five dollar Biggie Bag', 'five bucks'] },
  { id: 'MCD-FRIFRY-15', advertiser: "McDonald's", parent: "McDonald's Corp.", category: 'QSR', length: 15, weight: 6, firstSeen: 'Nov 4', isNew: true,
    offer: { headline: 'Free medium fries on Fridays', offerType: 'Free item w/ purchase', price: 'Free with $1+ purchase', product: 'Medium fries', terms: ["McDonald's app only", '$1 minimum purchase', 'Once per day'], exp: '2026-12-31', cta: "Download the McDonald's app", url: 'mcdonalds.com' },
    transcript: "Free Fry Fridays. Free medium fries every Friday with a one dollar minimum purchase, only in the McDonald's app.", keywords: ['free medium fries', 'one dollar minimum purchase'] },
  { id: 'GEICO-15PCT-15', advertiser: 'GEICO', parent: 'Berkshire Hathaway', category: 'Insurance', length: 15, weight: 6, firstSeen: 'Sep 2',
    offer: { headline: 'No specific offer: brand awareness', offerType: 'Brand', price: null, product: 'Auto insurance', terms: ['Claim: "15 minutes could save you 15% or more"'], exp: null, cta: 'Get a quote at geico.com', url: 'geico.com' },
    transcript: 'Fifteen minutes could save you fifteen percent or more on car insurance.', keywords: ['fifteen percent or more'] },
  { id: 'SF-BUNDLE-60', advertiser: 'State Farm', parent: 'State Farm Mutual', category: 'Insurance', length: 60, weight: 3, firstSeen: 'Oct 12',
    offer: { headline: 'Bundle home and auto (no price stated)', offerType: 'Brand', price: null, product: 'Home + auto insurance', terms: ['No dollar amount stated'], exp: null, cta: 'Talk to a local agent', url: 'statefarm.com' },
    transcript: 'Bundle your home and auto and save. Talk to a local State Farm agent today.', keywords: ['Bundle your home and auto'] },
  { id: 'TMO-4LINES-30', advertiser: 'T-Mobile', parent: 'T-Mobile US', category: 'Telecom', length: 30, weight: 4, firstSeen: 'Oct 27',
    offer: { headline: '4 lines for $25/line per month', offerType: 'Plan price', price: '$25/line/mo', product: 'Essentials plan, 4 lines', terms: ['With AutoPay', 'Plus taxes and fees'], exp: null, cta: 'Switch at T-Mobile.com', url: 't-mobile.com' },
    transcript: 'Four lines for just twenty-five bucks a line with AutoPay. Plus taxes and fees.', keywords: ['Four lines', 'twenty-five bucks a line'] },
  { id: 'HD-BF40-30', advertiser: 'The Home Depot', parent: 'The Home Depot Inc.', category: 'Retail', length: 30, weight: 4, firstSeen: 'Nov 5', isNew: true,
    offer: { headline: 'Black Friday savings: up to 40% off select appliances', offerType: 'Sale event', price: 'Up to 40% off', product: 'Major appliances', terms: ['Select appliances $396+', 'In store and online'], exp: '2026-12-03', cta: 'Shop homedepot.com', url: 'homedepot.com' },
    transcript: 'Black Friday savings start now. Up to forty percent off select appliances, through December third.', keywords: ['up to forty percent', 'December third'] },
  { id: 'MF-VETDAY-30', advertiser: 'Mattress Firm', parent: 'Tempur Sealy', category: 'Retail', length: 30, weight: 4, firstSeen: 'Nov 2',
    offer: { headline: 'Veterans Day Sale: up to 50% off + free adjustable base', offerType: 'Sale event', price: 'Up to 50% off', product: 'Mattresses', terms: ['Free base with mattress $1,299+', 'Select models'], exp: '2026-11-11', cta: 'Shop in store or online', url: 'mattressfirm.com' },
    transcript: 'The Veterans Day Sale is on. Up to fifty percent off plus a free adjustable base on select mattresses. Ends November eleventh.', keywords: ['Up to fifty percent off', 'free adjustable base', 'November eleventh'] },

  // ---- Seattle (fictional local advertisers)
  { id: 'PST-CAMRY309-60', advertiser: 'Puget Sound Toyota', category: 'Auto Dealer', market: 'Seattle', n: 7, length: 60, weight: 6, firstSeen: 'Nov 3',
    offer: { headline: 'Lease a 2026 Camry SE for $309/mo', offerType: 'Lease', price: '$309/mo', product: '2026 Toyota Camry SE', terms: ['36 months', '$2,999 due at signing', '10,000 mi/yr', 'Tier 1+ credit through Toyota Financial Services'], exp: '2026-11-30', cta: 'Puget Sound Toyota, I-5 exit 128', phone: '206-555-0118', url: 'pugetsoundtoyota.example' },
    auto: { vehicle: '2026 Toyota Camry SE', body: 'Sedan', deal: 'Lease', monthly: 309, due: 2999, term: 36, apr: null, cashOff: null },
    transcript: 'Lease a brand new 2026 Camry SE for three oh nine a month, thirty-six months, twenty-nine ninety-nine due at signing. Puget Sound Toyota, I-5 exit one twenty-eight. Ends November thirtieth.', keywords: ['three oh nine a month', 'twenty-nine ninety-nine due at signing', 'November thirtieth'] },
  { id: 'ECS-OUTBACK-60', advertiser: 'Emerald City Subaru', category: 'Auto Dealer', market: 'Seattle', n: 6, length: 60, weight: 5, firstSeen: 'Oct 29',
    offer: { headline: 'Lease a 2026 Outback Premium for $339/mo', offerType: 'Lease', price: '$339/mo', product: '2026 Subaru Outback Premium', terms: ['36 months', '$3,295 due at signing', '10,000 mi/yr', 'Or 2.9% APR for 60 months'], exp: '2026-11-30', cta: 'Emerald City Subaru on Aurora Ave', phone: '206-555-0164', url: 'emeraldcitysubaru.example' },
    auto: { vehicle: '2026 Subaru Outback Premium', body: 'SUV', deal: 'Lease', monthly: 339, due: 3295, term: 36, apr: 2.9, cashOff: null },
    transcript: 'Lease a 2026 Outback Premium for three thirty-nine a month with thirty-two ninety-five due at signing, or get two point nine percent APR for sixty months.', keywords: ['three thirty-nine a month', 'thirty-two ninety-five due at signing', 'two point nine percent APR'] },
  { id: 'CSF-F150-60', advertiser: 'Cascade Ford', category: 'Auto Dealer', market: 'Seattle', n: 8, length: 60, weight: 6, firstSeen: 'Nov 5', isNew: true,
    offer: { headline: '$9,000 off a 2026 F-150 XLT, or 0% APR for 60 months', offerType: 'Discount / financing', price: '$9,000 off MSRP', product: '2026 Ford F-150 XLT', terms: ['0% APR in lieu of discount', '+$1,000 trade assist', 'Select in-stock units', 'With approved Ford Credit'], exp: '2026-12-01', cta: 'Cascade Ford in Tacoma', phone: '253-555-0170', url: 'cascadeford.example' },
    auto: { vehicle: '2026 Ford F-150 XLT', body: 'Truck', deal: 'Cash off / 0% APR', monthly: null, due: null, term: 60, apr: 0, cashOff: 9000 },
    transcript: 'Take nine thousand off a new F-150 XLT, or get zero percent APR for sixty months, plus a thousand dollar trade assist. Cascade Ford in Tacoma.', keywords: ['nine thousand off', 'zero percent APR for sixty months', 'thousand dollar trade assist'] },
  { id: 'RNH-CRV-30', advertiser: 'Rainier Honda', category: 'Auto Dealer', market: 'Seattle', n: 5, length: 30, weight: 4, firstSeen: 'Oct 31',
    offer: { headline: 'Lease a 2026 CR-V Hybrid for $359/mo', offerType: 'Lease', price: '$359/mo', product: '2026 Honda CR-V Hybrid Sport', terms: ['36 months', '$3,999 due at signing', '10,000 mi/yr'], exp: '2026-11-30', cta: 'Rainier Honda, Renton', phone: '425-555-0122', url: 'rainierhonda.example' },
    auto: { vehicle: '2026 Honda CR-V Hybrid Sport', body: 'SUV', deal: 'Lease', monthly: 359, due: 3999, term: 36, apr: null, cashOff: null },
    transcript: 'CR-V Hybrid Sport, three fifty-nine a month, thirty-six months, thirty-nine ninety-nine due at signing. Rainier Honda in Renton.', keywords: ['three fifty-nine a month', 'thirty-nine ninety-nine due at signing'] },
  { id: 'NWK-SPORTAGE-30', advertiser: 'Northgate Kia', category: 'Auto Dealer', market: 'Seattle', n: 4, length: 30, weight: 4, firstSeen: 'Nov 2',
    offer: { headline: 'Lease a 2026 Sportage LX for $269/mo', offerType: 'Lease', price: '$269/mo', product: '2026 Kia Sportage LX', terms: ['36 months', '$2,499 due at signing', '10,000 mi/yr'], exp: '2026-11-30', cta: 'Northgate Kia', phone: '206-555-0131', url: 'northgatekia.example' },
    auto: { vehicle: '2026 Kia Sportage LX', body: 'SUV', deal: 'Lease', monthly: 269, due: 2499, term: 36, apr: null, cashOff: null },
    transcript: 'Sportage LX for two sixty-nine a month, twenty-four ninety-nine due at signing. Northgate Kia.', keywords: ['two sixty-nine a month', 'twenty-four ninety-nine due at signing'] },
  { id: 'SDC-EQXEV-30', advertiser: 'Sound Chevrolet', category: 'Auto Dealer', market: 'Seattle', n: 4, length: 30, weight: 3, firstSeen: 'Oct 30',
    offer: { headline: 'Lease a 2026 Equinox EV for $279/mo', offerType: 'Lease', price: '$279/mo', product: '2026 Chevrolet Equinox EV LT', terms: ['24 months', '$3,999 due at signing', '10,000 mi/yr', 'Through GM Financial'], exp: '2026-11-30', cta: 'Sound Chevrolet, Lynnwood', phone: '425-555-0140', url: 'soundchevy.example' },
    auto: { vehicle: '2026 Chevrolet Equinox EV LT', body: 'EV', deal: 'Lease', monthly: 279, due: 3999, term: 24, apr: null, cashOff: null },
    transcript: 'Drive electric. Equinox EV for two seventy-nine a month, twenty-four months, thirty-nine ninety-nine due at signing.', keywords: ['two seventy-nine a month', 'twenty-four months'] },
  { id: 'HRL-FREE-60', advertiser: 'Harbor & Reyes Injury Law', category: 'Legal', market: 'Seattle', n: 9, length: 60, weight: 5, firstSeen: 'Aug 18',
    offer: { headline: 'Free case review, no fee unless we win', offerType: 'Free consultation', price: 'Free', product: 'Personal injury representation', terms: ['Contingency fee', 'Available 24/7', 'Hablamos español'], exp: null, cta: 'Call 206-555-0142', phone: '206-555-0142', url: 'harborreyes.example' },
    transcript: 'Hurt in a crash? Call Harbor and Reyes for a free case review. You pay nothing unless we win. Hablamos español.', keywords: ['free case review', 'nothing unless we win', 'Hablamos español'] },
  { id: 'KBA-TRUCK-30', advertiser: 'Kessler Brandt Accident Attorneys', category: 'Legal', market: 'Seattle', n: 5, length: 30, weight: 3, firstSeen: 'Nov 4', isNew: true,
    offer: { headline: 'Truck accident? Free consultation, available tonight', offerType: 'Free consultation', price: 'Free', product: 'Truck accident cases', terms: ['No fee unless we recover', 'Evening and weekend appointments'], exp: null, cta: 'Call 425-555-0188', phone: '425-555-0188', url: 'kesslerbrandt.example' },
    transcript: 'Hit by a semi? Kessler Brandt takes on the trucking companies. Free consultation tonight. No fee unless we recover.', keywords: ['Free consultation tonight', 'No fee unless we recover'] },
  { id: 'RLR-ROOF-30', advertiser: 'Ridgeline Roofing', category: 'Home Services', market: 'Seattle', n: 5, length: 30, weight: 4, firstSeen: 'Oct 22',
    offer: { headline: '$1,500 off a full roof replacement + free moss treatment', offerType: 'Discount', price: '$1,500 off', product: 'Roof replacement', terms: ['Full replacements only', 'Free moss treatment with any roof', '12 months same-as-cash financing'], promoCode: 'RAIN1500', exp: '2026-11-30', cta: 'Book a free inspection', phone: '206-555-0109', url: 'ridgelineroofing.example' },
    transcript: 'Before the next atmospheric river, get fifteen hundred off a full roof replacement plus free moss treatment. Use code RAIN1500.', keywords: ['fifteen hundred off', 'free moss treatment', 'RAIN1500'] },
  { id: 'EHP-HEAT-60', advertiser: 'Evergreen Heat Pumps', category: 'Home Services', market: 'Seattle', n: 6, length: 60, weight: 4, firstSeen: 'Oct 15',
    offer: { headline: '$2,500 off a heat pump install + up to $4,000 in rebates', offerType: 'Discount + rebate', price: '$2,500 off', product: 'Ducted heat pump system', terms: ['Rebates depend on utility and income', '0% for 18 months with approved credit'], exp: '2026-11-15', cta: 'Free in-home estimate', phone: '425-555-0177', url: 'evergreenheatpumps.example' },
    transcript: 'Switch to a heat pump and save twenty-five hundred on install, plus up to four thousand in utility rebates. Zero percent for eighteen months.', keywords: ['twenty-five hundred on install', 'up to four thousand in utility rebates', 'Zero percent for eighteen months'] },
  { id: 'DSP-DRAIN49-15', advertiser: 'Drip Stop Plumbing', category: 'Home Services', market: 'Seattle', n: 4, length: 15, weight: 3, firstSeen: 'Nov 1',
    offer: { headline: '$49 drain cleaning', offerType: 'Service price', price: '$49', product: 'Drain cleaning', terms: ['Main line excluded', 'Same-day service'], promoCode: 'DRAIN49', exp: '2026-11-21', cta: 'Call or book online', phone: '206-555-0150', url: 'dripstop.example' },
    transcript: 'Slow drain? Drip Stop Plumbing, forty-nine dollar drain cleaning, same day. Code DRAIN49.', keywords: ['forty-nine dollar drain cleaning', 'DRAIN49'] },
  { id: 'SCU-AUTO-30', advertiser: 'Salish Credit Union', category: 'Financial', market: 'Seattle', n: 5, length: 30, weight: 3, firstSeen: 'Oct 25',
    offer: { headline: 'Auto loans from 4.99% APR, up to 72 months', offerType: 'Rate', price: '4.99% APR', product: 'New and used auto loans', terms: ['Rates as low as, with approved credit', 'Membership required'], exp: '2026-12-31', cta: 'Apply at salishcu.example', url: 'salishcu.example' },
    transcript: 'Auto loans from four ninety-nine APR for up to seventy-two months. Salish Credit Union. Rates as low as, with approved credit.', keywords: ['four ninety-nine APR', 'seventy-two months'] },
  { id: 'BBC-LIVE-KISW', advertiser: 'Ballard Brewing Co.', category: 'Restaurant', stations: ['KISW'], length: 60, type: 'Live Read', weight: 2, firstSeen: 'Nov 6', isNew: true,
    offer: { headline: '$5 pints during every Seahawks game', offerType: 'Price', price: '$5 pints', product: 'House beers', terms: ['Game days only', 'Mention the code'], promoCode: 'KISW5', exp: '2026-12-28', cta: 'Ballard Brewing taproom', phone: '206-555-0127', url: 'ballardbrewing.example' },
    transcript: '(Host live read) I was at Ballard Brewing last night. Five dollar pints every Seahawks game, just say KISW5 at the bar.', keywords: ['Five dollar pints', 'KISW5'] },
  { id: 'CUC-FLU-30', advertiser: 'Cascade Urgent Care', category: 'Healthcare', market: 'Seattle', n: 4, length: 30, weight: 3, firstSeen: 'Oct 15',
    offer: { headline: '$0 flu shots with most insurance, walk-ins welcome', offerType: 'Free service', price: '$0 with insurance', product: 'Flu shot', terms: ['Most insurance accepted', 'Open 8am to 8pm, 7 days', '9 Puget Sound clinics'], exp: null, cta: 'Walk in or check in online', phone: '206-555-0155', url: 'cascadeurgentcare.example' },
    transcript: 'Get your flu shot for zero dollars with most insurance. Walk-ins welcome, eight to eight, seven days.', keywords: ['zero dollars with most insurance', 'Walk-ins welcome'] },
  { id: 'SHM-BF40-30', advertiser: 'Sleep Harbor Mattress', category: 'Retail', market: 'Seattle', n: 4, length: 30, weight: 3, firstSeen: 'Nov 5', isNew: true,
    offer: { headline: 'Early Black Friday: 40% off all mattresses', offerType: 'Sale event', price: '40% off', product: 'Mattresses', terms: ['Excludes clearance', 'Free delivery over $999'], exp: '2026-11-30', cta: '12 Puget Sound stores', url: 'sleepharbor.example' },
    transcript: 'Early Black Friday at Sleep Harbor. Forty percent off every mattress plus free delivery over nine ninety-nine.', keywords: ['Forty percent off every mattress', 'free delivery'] },

  // ---- Portland
  { id: 'WVT-RAV4-60', advertiser: 'Willamette Valley Toyota', category: 'Auto Dealer', market: 'Portland', n: 6, length: 60, weight: 5, firstSeen: 'Oct 28',
    offer: { headline: 'Lease a 2026 RAV4 LE for $319/mo', offerType: 'Lease', price: '$319/mo', product: '2026 Toyota RAV4 LE', terms: ['36 months', '$3,499 due at signing', '10,000 mi/yr'], exp: '2026-11-30', cta: 'Willamette Valley Toyota, Tigard', phone: '503-555-0119', url: 'wvtoyota.example' },
    auto: { vehicle: '2026 Toyota RAV4 LE', body: 'SUV', deal: 'Lease', monthly: 319, due: 3499, term: 36, apr: null, cashOff: null },
    transcript: 'RAV4 LE for three nineteen a month, thirty-four ninety-nine due at signing. Willamette Valley Toyota in Tigard.', keywords: ['three nineteen a month', 'thirty-four ninety-nine due at signing'] },
  { id: 'RCH-TUCSON-30', advertiser: 'Rose City Hyundai', category: 'Auto Dealer', market: 'Portland', n: 5, length: 30, weight: 4, firstSeen: 'Nov 4', isNew: true,
    offer: { headline: '$0 down, $289/mo on a 2026 Tucson SEL', offerType: 'Lease', price: '$289/mo', product: '2026 Hyundai Tucson SEL', terms: ['36 months', '$0 down, first payment at signing', '10,000 mi/yr'], exp: '2026-11-30', cta: 'Rose City Hyundai', phone: '503-555-0143', url: 'rosecityhyundai.example' },
    auto: { vehicle: '2026 Hyundai Tucson SEL', body: 'SUV', deal: 'Lease', monthly: 289, due: 289, term: 36, apr: null, cashOff: null },
    transcript: 'Zero down, two eighty-nine a month on a Tucson SEL. Rose City Hyundai.', keywords: ['Zero down', 'two eighty-nine a month'] },
  { id: 'BTL-FREE-60', advertiser: 'Bridgetown Injury Law', category: 'Legal', market: 'Portland', n: 7, length: 60, weight: 4, firstSeen: 'Sep 9',
    offer: { headline: 'Free case review, no fee unless we win', offerType: 'Free consultation', price: 'Free', product: 'Personal injury', terms: ['Contingency fee', 'Oregon and Washington'], exp: null, cta: 'Call 503-555-0146', phone: '503-555-0146', url: 'bridgetownlaw.example' },
    transcript: 'Injured? Bridgetown Injury Law. Free case review, and no fee unless we win.', keywords: ['Free case review', 'no fee unless we win'] },
  { id: 'SHC-TUNE89-30', advertiser: 'Stumptown Heating & Cooling', category: 'Home Services', market: 'Portland', n: 5, length: 30, weight: 3, firstSeen: 'Oct 30',
    offer: { headline: '$89 furnace tune-up', offerType: 'Service price', price: '$89', product: 'Furnace tune-up', terms: ['Includes safety check', 'Book by Nov 22'], promoCode: 'PDX89', exp: '2026-11-22', cta: 'Book online', phone: '503-555-0191', url: 'stumptownhvac.example' },
    transcript: 'Furnace tune-up for eighty-nine bucks. Code PDX89, book by November twenty-second.', keywords: ['eighty-nine bucks', 'PDX89'] },

  // ---- Spokane
  { id: 'IEC-SILV-60', advertiser: 'Inland Empire Chevrolet', category: 'Auto Dealer', market: 'Spokane', n: 6, length: 60, weight: 4, firstSeen: 'Oct 30',
    offer: { headline: 'Employee pricing on 2026 Silverado + $2,000 bonus cash', offerType: 'Employee pricing', price: 'Employee price + $2,000', product: '2026 Chevrolet Silverado 1500', terms: ['Bonus cash on select trims', 'Excludes ZR2 and High Country'], exp: '2027-01-02', cta: 'Inland Empire Chevrolet, Spokane Valley', phone: '509-555-0133', url: 'iechevy.example' },
    auto: { vehicle: '2026 Chevrolet Silverado 1500', body: 'Truck', deal: 'Employee pricing', monthly: null, due: null, term: null, apr: null, cashOff: 2000 },
    transcript: 'Employee pricing for everyone on a new Silverado, plus two thousand bonus cash. Inland Empire Chevrolet.', keywords: ['Employee pricing for everyone', 'two thousand bonus cash'] },
  { id: 'LCR-ROOF-30', advertiser: 'Lilac City Roofing', category: 'Home Services', market: 'Spokane', n: 4, length: 30, weight: 3, firstSeen: 'Oct 18',
    offer: { headline: 'Free roof inspection + $1,000 off replacement', offerType: 'Discount', price: '$1,000 off', product: 'Roof replacement', terms: ['Replacements over $9,000', 'Snow-load inspection included'], exp: '2026-11-30', cta: 'Call for a free inspection', phone: '509-555-0108', url: 'lilaccityroofing.example' },
    transcript: 'Before the snow, get a free roof inspection and a thousand off a replacement. Lilac City Roofing.', keywords: ['free roof inspection', 'thousand off'] },

  // ---- Boise
  { id: 'TVF-MAV-30', advertiser: 'Treasure Valley Ford', category: 'Auto Dealer', market: 'Boise', n: 6, length: 30, weight: 4, firstSeen: 'Nov 1',
    offer: { headline: 'Lease a 2026 Maverick XLT for $279/mo', offerType: 'Lease', price: '$279/mo', product: '2026 Ford Maverick XLT Hybrid', terms: ['36 months', '$2,999 due at signing', '10,500 mi/yr'], exp: '2026-11-30', cta: 'Treasure Valley Ford, Meridian', phone: '208-555-0170', url: 'tvford.example' },
    auto: { vehicle: '2026 Ford Maverick XLT Hybrid', body: 'Truck', deal: 'Lease', monthly: 279, due: 2999, term: 36, apr: null, cashOff: null },
    transcript: 'Maverick XLT Hybrid for two seventy-nine a month, twenty-nine ninety-nine due. Treasure Valley Ford in Meridian.', keywords: ['two seventy-nine a month', 'twenty-nine ninety-nine due'] },
  { id: 'SRL-FREE-60', advertiser: 'Snake River Law Group', category: 'Legal', market: 'Boise', n: 6, length: 60, weight: 3, firstSeen: 'Sep 22',
    offer: { headline: 'Free consultation for injury and wrongful death', offerType: 'Free consultation', price: 'Free', product: 'Personal injury', terms: ['Contingency fee', 'Idaho licensed'], exp: null, cta: 'Call 208-555-0142', phone: '208-555-0142', url: 'snakeriverlaw.example' },
    transcript: 'Snake River Law Group. Free consultation for injury and wrongful death cases.', keywords: ['Free consultation'] },
  { id: 'FHV-TUNE79-30', advertiser: 'Foothills HVAC', category: 'Home Services', market: 'Boise', n: 5, length: 30, weight: 3, firstSeen: 'Nov 4', isNew: true,
    offer: { headline: '$79 furnace tune-up', offerType: 'Service price', price: '$79', product: 'Furnace tune-up', terms: ['21-point inspection', 'No overtime charges'], promoCode: 'BOISE79', exp: '2026-11-20', cta: 'Book online', phone: '208-555-0191', url: 'foothillshvac.example' },
    transcript: 'Seventy-nine dollar furnace tune-up from Foothills HVAC, code BOISE79.', keywords: ['Seventy-nine dollar furnace tune-up', 'BOISE79'] },

  // ---- Nashville
  { id: 'HVT-CAMRY299-60', advertiser: 'Harpeth Valley Toyota', category: 'Auto Dealer', stations: ['WSIX-FM', 'WKDF', 'WJXA', 'WCJK'], length: 60, weight: 5, firstSeen: 'Nov 3',
    offer: { headline: 'Lease a 2026 Camry SE for $299/mo', offerType: 'Lease', price: '$299/mo', product: '2026 Toyota Camry SE', terms: ['36 months', '$2,999 due at signing', '10,000 mi/yr'], exp: '2026-11-30', cta: 'Exit 65 off I-65', phone: '615-555-0118', url: 'harpethvalleytoyota.example' },
    auto: { vehicle: '2026 Toyota Camry SE', body: 'Sedan', deal: 'Lease', monthly: 299, due: 2999, term: 36, apr: null, cashOff: null },
    transcript: 'Drive home a 2026 Camry SE for two ninety-nine a month, twenty-nine ninety-nine due at signing. Harpeth Valley Toyota.', keywords: ['two ninety-nine a month', 'twenty-nine ninety-nine due at signing'] },
  { id: 'RBF-F150-60', advertiser: 'Riverbend Ford', category: 'Auto Dealer', stations: ['WKDF', 'WNRQ', 'WSIX-FM', 'WSM-FM'], length: 60, weight: 4, firstSeen: 'Nov 5', isNew: true,
    offer: { headline: '$8,500 off a 2026 F-150 XLT, or 0% APR for 60 months', offerType: 'Discount / financing', price: '$8,500 off MSRP', product: '2026 Ford F-150 XLT', terms: ['0% APR in lieu of discount', '+$1,000 trade assist'], exp: '2026-12-01', cta: 'Gallatin Pike', phone: '615-555-0170', url: 'riverbendford.example' },
    auto: { vehicle: '2026 Ford F-150 XLT', body: 'Truck', deal: 'Cash off / 0% APR', monthly: null, due: null, term: 60, apr: 0, cashOff: 8500 },
    transcript: 'Take eighty-five hundred off a new F-150 XLT, or zero percent APR for sixty months. Riverbend Ford.', keywords: ['eighty-five hundred off', 'zero percent APR for sixty months'] },
  { id: 'FPC-EQUINOX-30', advertiser: 'Five Points Chevrolet', category: 'Auto Dealer', stations: ['WRVW', 'WJXA', 'WUBT'], length: 30, weight: 3, firstSeen: 'Oct 31',
    offer: { headline: '$0 down, $289/mo on a 2026 Equinox LT', offerType: 'Lease', price: '$289/mo', product: '2026 Chevrolet Equinox LT', terms: ['24 months', '$0 down, first payment at signing'], exp: '2026-11-30', cta: 'East Nashville', phone: '615-555-0133', url: 'fivepointschevy.example' },
    auto: { vehicle: '2026 Chevrolet Equinox LT', body: 'SUV', deal: 'Lease', monthly: 289, due: 289, term: 24, apr: null, cashOff: null },
    transcript: 'Zero down, two eighty-nine a month on an Equinox LT. Five Points Chevrolet.', keywords: ['Zero down', 'two eighty-nine a month'] },
  { id: 'HCL-FREE-60', advertiser: 'Hale & Crowder Injury Law', category: 'Legal', stations: ['WSIX-FM', 'WNRQ', 'WKDF', 'WJXA', 'WWTN'], length: 60, weight: 4, firstSeen: 'Aug 18',
    offer: { headline: 'Free case review, no fee unless we win', offerType: 'Free consultation', price: 'Free', product: 'Personal injury', terms: ['Contingency fee', 'Available 24/7'], exp: null, cta: 'Call 615-555-0142', phone: '615-555-0142', url: 'halecrowderlaw.example' },
    transcript: 'Hurt in a wreck? Call Hale and Crowder for a free case review. You pay nothing unless we win.', keywords: ['free case review', 'nothing unless we win'] },
  { id: 'ACA-TUNE79-30', advertiser: 'Ace Comfort Air', category: 'Home Services', stations: ['WNRQ', 'WJXA', 'WKDF'], length: 30, weight: 3, firstSeen: 'Nov 4', isNew: true,
    offer: { headline: '$79 furnace tune-up + $1,000 off a new system', offerType: 'Service price + discount', price: '$79', product: 'Furnace tune-up / HVAC install', terms: ['$1,000 off installs over $8,000', '18 months 0% financing'], promoCode: 'WARM79', exp: '2026-11-20', cta: 'Book online', phone: '615-555-0191', url: 'acecomfortair.example' },
    transcript: 'Seventy-nine dollar tune-up, or a thousand off a new system. Code WARM79 by November twentieth.', keywords: ['Seventy-nine dollar tune-up', 'WARM79'] },
];

// ---- TV creatives (Seattle). `onScreen` = text supers read by OCR from the video frames.
// `notSpoken` = terms that appear ONLY on screen, never in the voiceover. That is where the catch hides.
const byId = Object.fromEntries(RAW_CREATIVES.map((c) => [c.id, c]));
const tvVersion = (id, extra) => ({ ...byId[id], id: `${id.replace(/-\d+$/, '')}-TV30`, media: 'TV', length: 30, n: undefined, ...extra });
const RAW_TV_CREATIVES = [
  tvVersion('PST-CAMRY309-60', { tvN: 4, weight: 6, firstSeen: 'Nov 3',
    visuals: 'Camry SE on the lot, price card, GM as spokesperson',
    onScreen: ['$309/mo, 36-month lease', '$2,999 due at signing', 'Tier 1+ credit through Toyota Financial Services', 'Offer ends 11/30/26'],
    notSpoken: ['$650 acquisition fee not included', '$0.25/mile over 10,000 mi/yr', 'Excludes tax, title, license and dealer fees'] }),
  tvVersion('CSF-F150-60', { tvN: 5, weight: 6, isNew: true,
    visuals: 'F-150 off-road footage, $9,000 OFF graphic, Tacoma storefront',
    onScreen: ['$9,000 off MSRP on 2026 F-150 XLT', 'Or 0% APR for 60 months', '+$1,000 trade assist'],
    notSpoken: ['Discount = $2,500 dealer discount + $6,500 Ford rebate', '0% APR = $16.67/mo per $1,000 financed', 'Must take delivery from dealer stock by 12/1/26'] }),
  tvVersion('ECS-OUTBACK-60', { tvN: 3, weight: 4,
    visuals: 'Outback on a mountain road, dog in the back seat',
    onScreen: ['$339/mo, 36 months', '$3,295 due at signing', 'Or 2.9% APR for 60 months'],
    notSpoken: ['2.9% APR = $17.92/mo per $1,000 financed', 'Not all buyers will qualify'] }),
  tvVersion('HRL-FREE-60', { tvN: 6, weight: 5,
    visuals: 'Attorneys in office, crash footage, phone number full screen',
    onScreen: ['Free case review', 'No fee unless we win', '206-555-0142'],
    notSpoken: ['Attorney advertising', 'Past results do not guarantee future outcomes', 'Client may be responsible for case costs'] }),
  tvVersion('KBA-TRUCK-30', { tvN: 4, weight: 3,
    visuals: 'Semi-truck footage, attorney walking toward camera',
    onScreen: ['Free consultation tonight', '425-555-0188'],
    notSpoken: ['Attorney advertising', 'Case costs may apply'] }),
  tvVersion('RLR-ROOF-30', { tvN: 3, weight: 3,
    visuals: 'Crew on a mossy roof, before/after',
    onScreen: ['$1,500 off full roof replacement', 'Free moss treatment', 'Code RAIN1500'],
    notSpoken: ['Minimum 20 squares', 'Financing with approved credit'] }),
  tvVersion('SHM-BF40-30', { tvN: 4, weight: 3,
    visuals: 'Mattress showroom, 40% OFF banner',
    onScreen: ['40% off all mattresses', 'Free delivery over $999'],
    notSpoken: ['Off MSRP', 'Excludes Tempur-Pedic and clearance'] }),
  { id: 'SSD-NEWPT-TV30', advertiser: 'Summit Smiles Dental', category: 'Healthcare', market: 'Seattle', media: 'TV', tvN: 4, length: 30, weight: 3, firstSeen: 'Oct 26',
    offer: { headline: '$59 new-patient exam, X-rays and cleaning', offerType: 'Service price', price: '$59', product: 'New-patient visit', terms: ['New patients only', '14 Puget Sound offices'], exp: '2026-12-31', cta: 'Book online', phone: '206-555-0163', url: 'summitsmiles.example' },
    visuals: 'Smiling families, office interiors, $59 graphic',
    onScreen: ['$59 new-patient exam, X-rays and cleaning', 'Evenings and Saturdays'],
    notSpoken: ['Not valid with insurance', 'Excludes deep cleaning'],
    transcript: 'New patients at Summit Smiles get an exam, X-rays and cleaning for fifty-nine dollars. Evenings and Saturdays available.', keywords: ['fifty-nine dollars'] },
  { id: 'LLX-RX350-TV30', advertiser: 'Lakeside Lexus', category: 'Auto Dealer', market: 'Seattle', media: 'TV', tvN: 4, length: 30, weight: 4, firstSeen: 'Nov 2',
    offer: { headline: 'Lease a 2026 RX 350 for $599/mo', offerType: 'Lease', price: '$599/mo', product: '2026 Lexus RX 350', terms: ['36 months', '$4,999 due at signing', '10,000 mi/yr'], exp: '2026-11-30', cta: 'Lakeside Lexus, Bellevue', phone: '425-555-0115', url: 'lakesidelexus.example' },
    auto: { vehicle: '2026 Lexus RX 350', body: 'SUV', deal: 'Lease', monthly: 599, due: 4999, term: 36, apr: null, cashOff: null },
    visuals: 'RX 350 on a lakeside road at dusk, showroom',
    onScreen: ['$599/mo, 36 months', '$4,999 due at signing', 'Through Lexus Financial Services'],
    notSpoken: ['$795 acquisition fee', 'Excludes taxes and dealer fees', 'Well-qualified lessees only'],
    transcript: 'The 2026 RX 350. Lease for five ninety-nine a month at Lakeside Lexus in Bellevue.', keywords: ['five ninety-nine a month'] },
  { id: 'PKB-CAB25-TV30', advertiser: 'Pacific Kitchen & Bath', category: 'Home Services', market: 'Seattle', media: 'TV', tvN: 3, length: 30, weight: 3, firstSeen: 'Oct 29',
    offer: { headline: 'Free design consult + 25% off cabinets', offerType: 'Percent off', price: '25% off', product: 'Kitchen and bath remodels', terms: ['Full remodels only', '0% for 24 months with approved credit'], exp: '2026-11-30', cta: 'Book a free design visit', phone: '206-555-0186', url: 'pacifickb.example' },
    visuals: 'Before/after kitchen remodel, designer with client',
    onScreen: ['25% off cabinets', 'Free in-home design consult', '0% for 24 months'],
    notSpoken: ['Minimum project $15,000', 'Discount off list price', 'Financing subject to credit approval'],
    transcript: 'Get a free design consultation and twenty-five percent off cabinets on your new kitchen. Pacific Kitchen and Bath.', keywords: ['twenty-five percent off cabinets', 'free design consultation'] },
  tvVersion('BK-WHOP7-30', { weight: 6, visuals: 'Whopper close-ups, app screen', onScreen: ['2 Whoppers for $7', 'BK app only'], notSpoken: ['Price and participation may vary', 'Taxes extra', 'Delivery fees apply'] }),
  tvVersion('MCD-FRIFRY-15', { weight: 4, length: 15, visuals: 'Fries close-up, app screen', onScreen: ['Free medium fries Fridays'], notSpoken: ['$1 minimum purchase', 'Once per day', 'Excludes delivery'] }),
  tvVersion('GEICO-15PCT-15', { weight: 6, visuals: 'Gecko character', onScreen: ['15 minutes could save you 15% or more'], notSpoken: ['Savings vary', 'Not available in all states'] }),
  tvVersion('TMO-4LINES-30', { weight: 4, visuals: 'Family with phones, price card', onScreen: ['4 lines $25/line/mo with AutoPay'], notSpoken: ['$35 connection charge per line', 'Taxes and fees extra', 'Video at SD quality'] }),
  tvVersion('HD-BF40-30', { weight: 4, visuals: 'Appliance showroom, orange price tags', onScreen: ['Up to 40% off select appliances', 'Through 12/3'], notSpoken: ['Select appliances $396+', 'Delivery fees may apply'] }),
];
RAW_CREATIVES.push(...RAW_TV_CREATIVES);

export const CREATIVES = RAW_CREATIVES.map((c) => {
  const local = !!(c.market || c.stations);
  let pool;
  if (c.media === 'TV') {
    const r = mulberry32(hash(c.id));
    pool = c.tvN ? [...TV_STATIONS].sort(() => r() - 0.5).slice(0, c.tvN) : TV_STATIONS;
  } else if (c.stations) pool = c.stations.map((id) => STATION_BY_ID[id]).filter(Boolean);
  else if (c.market) {
    const inMarket = STATIONS.filter((s) => s.market === c.market && s.band === 'FM');
    const r = mulberry32(hash(c.id));
    pool = [...inMarket].sort(() => r() - 0.5).slice(0, c.n);
  } else pool = STATIONS.filter((s) => s.media === 'Radio');
  const market = c.market || (c.stations ? STATION_BY_ID[c.stations[0]].market : null);
  return {
    type: 'Produced',
    media: 'Radio',
    onScreen: [],
    notSpoken: [],
    parent: local ? 'Local business (fictional)' : c.parent,
    ...c,
    market,
    scope: local ? 'Local' : 'National',
    pool,
    offer: { promoCode: null, phone: null, ...c.offer, promoCode: c.offer.promoCode || null, expires: c.offer.exp ? fmtDate(c.offer.exp) : null },
  };
});

// Offer changes between an advertiser's previous creative and the current one.
export const OFFER_CHANGES = [
  { date: 'Nov 5', advertiser: 'Cascade Ford', market: 'Seattle', product: '2026 F-150 XLT', from: '$7,500 off MSRP', to: '$9,000 off MSRP' },
  { date: 'Nov 4', advertiser: 'Rose City Hyundai', market: 'Portland', product: 'Tucson SEL lease', from: '$1,999 down, $279/mo', to: '$0 down, $289/mo' },
  { date: 'Nov 3', advertiser: 'Puget Sound Toyota', market: 'Seattle', product: 'Camry SE lease', from: '$329/mo', to: '$309/mo' },
  { date: 'Nov 3', advertiser: 'Harpeth Valley Toyota', market: 'Nashville', product: 'Camry SE lease', from: '$319/mo', to: '$299/mo' },
  { date: 'Nov 1', advertiser: 'Drip Stop Plumbing', market: 'Seattle', product: 'Drain cleaning', from: '$69', to: '$49' },
];

// 8 weekly snapshots of tracked offers, oldest first (week ending dates).
export const WEEKS = ['Sep 18', 'Sep 25', 'Oct 2', 'Oct 9', 'Oct 16', 'Oct 23', 'Oct 30', 'Nov 6'];
export const PRICE_HISTORY = [
  { advertiser: 'Puget Sound Toyota', market: 'Seattle', product: 'Camry SE lease', unit: '/mo', lowerIsBetter: true, values: [349, 349, 339, 339, 329, 329, 329, 309] },
  { advertiser: 'Emerald City Subaru', market: 'Seattle', product: 'Outback Premium lease', unit: '/mo', lowerIsBetter: true, values: [359, 359, 359, 349, 349, 339, 339, 339] },
  { advertiser: 'Cascade Ford', market: 'Seattle', product: 'F-150 XLT discount', unit: ' off', lowerIsBetter: false, values: [5000, 5000, 6000, 6000, 6500, 7500, 7500, 9000] },
  { advertiser: 'Rainier Honda', market: 'Seattle', product: 'CR-V Hybrid lease', unit: '/mo', lowerIsBetter: true, values: [369, 369, 369, 369, 359, 359, 359, 359] },
  { advertiser: 'Willamette Valley Toyota', market: 'Portland', product: 'RAV4 LE lease', unit: '/mo', lowerIsBetter: true, values: [339, 339, 329, 329, 329, 319, 319, 319] },
  { advertiser: 'Harpeth Valley Toyota', market: 'Nashville', product: 'Camry SE lease', unit: '/mo', lowerIsBetter: true, values: [339, 329, 329, 319, 319, 319, 319, 299] },
];

// ---------------------------------------------------------------- simulation

export function daypartFor(date) {
  const h = date.getHours();
  if (h >= 6 && h < 10) return { name: 'AM Drive', factor: 1.2 };
  if (h >= 10 && h < 15) return { name: 'Midday', factor: 1.0 };
  if (h >= 15 && h < 19) return { name: 'PM Drive', factor: 1.15 };
  if (h >= 19) return { name: 'Evening', factor: 0.7 };
  return { name: 'Overnight', factor: 0.4 };
}

export const TV_DAYPARTS = ['Early Morning', 'Daytime', 'Early News', 'Prime Access', 'Prime', 'Late News', 'Late Night'];
const TV_PROGRAM = {
  'Early Morning': 'Morning news', Daytime: 'Daytime talk and games', 'Early News': 'Local news, 4 to 6:30 PM',
  'Prime Access': 'Game show / entertainment magazine', Prime: 'Network prime time', 'Late News': '11 PM local news', 'Late Night': 'Late-night talk',
};
export function tvDaypartFor(date) {
  const h = date.getHours();
  if (h >= 5 && h < 9) return { name: 'Early Morning', factor: 0.7 };
  if (h >= 9 && h < 16) return { name: 'Daytime', factor: 0.45 };
  if (h >= 16 && h < 19) return { name: 'Early News', factor: 1.0 };
  if (h >= 19 && h < 20) return { name: 'Prime Access', factor: 0.9 };
  if (h >= 20 && h < 23) return { name: 'Prime', factor: 1.7 };
  if (h >= 23) return { name: 'Late News', factor: 1.0 };
  return { name: 'Late Night', factor: 0.3 };
}

const LEN_FACTOR = { 15: 0.45, 30: 0.7, 60: 1 };
const RADIO_CREATIVES = () => CREATIVES.filter((c) => c.media === 'Radio');
const TV_CREATIVES = () => CREATIVES.filter((c) => c.media === 'TV');
let radioCache; let tvCache;

function weightedPick(rng, items, w) {
  const total = items.reduce((a, x) => a + w(x), 0);
  let r = rng() * total;
  for (const x of items) {
    r -= w(x);
    if (r <= 0) return x;
  }
  return items[items.length - 1];
}

let seq = 0;
export function makeDetection(rng, ts, media = 'Radio') {
  radioCache = radioCache || RADIO_CREATIVES();
  tvCache = tvCache || TV_CREATIVES();
  const c = weightedPick(rng, media === 'TV' ? tvCache : radioCache, (x) => x.weight);
  const s = weightedPick(rng, c.pool, (x) => x.weight);
  const dp = media === 'TV' ? tvDaypartFor(new Date(ts)) : daypartFor(new Date(ts));
  const podSize = 4 + Math.floor(rng() * 4);
  seq += 1;
  return {
    id: `${c.id}-${s.id}-${ts}-${seq}`,
    ts,
    creative: c,
    station: s,
    daypart: dp.name,
    program: media === 'TV' ? TV_PROGRAM[dp.name] : null,
    pod: `Break ${1 + Math.floor(rng() * 4)} · slot ${1 + Math.floor(rng() * podSize)}/${podSize}`,
    confidence: Number((94 + rng() * 5.8).toFixed(1)),
    estCost: Math.round((s.rate60 * LEN_FACTOR[c.length] * dp.factor) / 5) * 5,
    newCreative: !!c.isNew,
  };
}

// About 3 hours of history so the app opens in a realistic working state.
export function seedDetections(now = Date.now(), hours = 3, count = 3600, tvCount = 650) {
  const rng = mulberry32(20261106);
  const span = hours * 3600 * 1000;
  const list = [];
  for (let i = 0; i < count; i++) list.push(makeDetection(rng, now - Math.floor(rng() * span)));
  for (let i = 0; i < tvCount; i++) list.push(makeDetection(rng, now - Math.floor(rng() * span), 'TV'));
  return list.sort((a, b) => b.ts - a.ts);
}

// ---------------------------------------------------------------- trends (simulated 7-day)

const HOUR_PROFILE = [0.15, 0.1, 0.08, 0.08, 0.12, 0.4, 0.9, 1.0, 0.95, 0.8, 0.7, 0.75, 0.8, 0.7, 0.7, 0.85, 0.95, 0.9, 0.7, 0.5, 0.4, 0.35, 0.3, 0.2];
const DAY_FACTOR = [1, 1, 1, 1.05, 1.1, 0.85, 0.6];
export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const TV_HOUR_PROFILE = [0.3, 0.2, 0.1, 0.1, 0.15, 0.5, 0.75, 0.8, 0.7, 0.45, 0.45, 0.5, 0.55, 0.5, 0.5, 0.6, 0.85, 1.0, 0.95, 0.9, 1.0, 1.0, 0.95, 0.8];

export function heatGrid(market, category, media = 'Both') {
  const inScope = (s) => (market === 'All' || s.market === market);
  const radioBase = media === 'TV' ? 0 : STATIONS.filter((s) => s.media === 'Radio' && inScope(s)).reduce((a, s) => a + s.weight, 0) * 11;
  const tvBase = media === 'Radio' ? 0 : TV_STATIONS.filter(inScope).reduce((a, s) => a + s.weight, 0) * 28;
  const catF = category === 'All' ? 1 : 0.14;
  const rng = mulberry32(hash(`${market}|${category}|${media}`));
  return DAYS.map((_, d) => HOUR_PROFILE.map((hp, h) => {
    const mix = (radioBase * hp + tvBase * TV_HOUR_PROFILE[h]) * catF;
    let f = DAY_FACTOR[d];
    if (category === 'Auto Dealer' && d >= 3 && d <= 5) f *= 1.4;
    if (category === 'Legal') f *= d < 5 && h >= 9 && h < 17 ? 1.3 : 0.7;
    if (category === 'Home Services' && h >= 5 && h < 9) f *= 1.4;
    if (category === 'QSR' && ((h >= 11 && h < 13) || (h >= 16 && h < 18))) f *= 1.5;
    return Math.round(mix * f * (0.88 + rng() * 0.24));
  }));
}

export function weekOverWeek(advertisers) {
  return advertisers.map((name) => {
    const r = mulberry32(hash(`wow|${name}`));
    const last = Math.round(40 + r() * 360);
    const change = 0.55 + r() * 1.25;
    return { name, last, now: Math.round(last * change) };
  });
}

// ---------------------------------------------------------------- export

const num = (v) => (v == null ? '' : v);
export const EXPORT_COLUMNS = [
  ['Detected At', (d) => new Date(d.ts).toISOString()],
  ['Local Time', (d) => new Date(d.ts).toLocaleString('en-US')],
  ['Media', (d) => d.station.media],
  ['Market', (d) => d.station.market],
  ['Station', (d) => d.station.call],
  ['Band / Network', (d) => d.station.network || d.station.band],
  ['Daypart', (d) => d.daypart],
  ['Program', (d) => d.program || ''],
  ['Advertiser', (d) => d.creative.advertiser],
  ['Parent Company', (d) => d.creative.parent],
  ['Category', (d) => d.creative.category],
  ['Scope', (d) => d.creative.scope],
  ['Ad Type', (d) => d.creative.type],
  ['Length (sec)', (d) => d.creative.length],
  ['Offer Headline', (d) => d.creative.offer.headline],
  ['Offer Type', (d) => d.creative.offer.offerType],
  ['Price / Value', (d) => d.creative.offer.price || ''],
  ['Product / Vehicle', (d) => d.creative.offer.product || ''],
  ['Deal Type', (d) => d.creative.auto?.deal || ''],
  ['Monthly Payment', (d) => num(d.creative.auto?.monthly)],
  ['Due at Signing', (d) => num(d.creative.auto?.due)],
  ['Term (months)', (d) => num(d.creative.auto?.term)],
  ['APR %', (d) => num(d.creative.auto?.apr)],
  ['Cash Off', (d) => num(d.creative.auto?.cashOff)],
  ['Terms & Conditions', (d) => d.creative.offer.terms.join('; ')],
  ['On-Screen Text (TV)', (d) => d.creative.onScreen.join('; ')],
  ['Fine Print Not Spoken (TV)', (d) => d.creative.notSpoken.join('; ')],
  ['Promo Code', (d) => d.creative.offer.promoCode || ''],
  ['Offer Expires', (d) => d.creative.offer.expires || 'Not stated'],
  ['Call to Action', (d) => d.creative.offer.cta],
  ['Phone', (d) => d.creative.offer.phone || ''],
  ['Website', (d) => d.creative.offer.url || ''],
  ['Creative ID', (d) => d.creative.id],
  ['Creative First Seen', (d) => d.creative.firstSeen],
  ['New Creative', (d) => (d.newCreative ? 'Yes' : 'No')],
  ['Break Position', (d) => d.pod],
  ['Match Confidence %', (d) => d.confidence],
  ['Est. Cost (USD)', (d) => d.estCost],
  ['Transcript', (d) => d.creative.transcript],
];

export function toTSV(rows) {
  const clean = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
  const head = EXPORT_COLUMNS.map((c) => c[0]).join('\t');
  return [head, ...rows.map((r) => EXPORT_COLUMNS.map((c) => clean(c[1](r))).join('\t'))].join('\n');
}

export function toCSV(rows) {
  const q = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = EXPORT_COLUMNS.map((c) => q(c[0])).join(',');
  return [head, ...rows.map((r) => EXPORT_COLUMNS.map((c) => q(c[1](r))).join(','))].join('\n');
}
