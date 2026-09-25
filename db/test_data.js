'use strict';

/**
 * K.R.1.S test data: two fictional vessels, SN Star and SN Sky, from
 * 1 January 2023 up to the moment it is generated.
 *
 * NOTHING HERE IS REAL. Company names start with TEST, emails use the
 * reserved .example domain, IMO numbers are in the 1000000 range (valid check
 * digit, a range never issued to a ship), every vessel row has is_test = true,
 * and carbon prices are illustrative, not market data.
 *
 * How the numbers are made to agree:
 *   1. A voyage timeline is simulated per vessel with a seeded PRNG: passages
 *      at a speed over a route distance, port stays with waiting and cargo time.
 *   2. Departure, noon and arrival reports are cut from that timeline; distance
 *      is speed x hours, the position is that distance along the route's sea
 *      lane (waypoints, never over land), main-engine power follows the cube
 *      of speed, and fuel
 *      per consumer and fuel type follows from power, SFOC and where the ship
 *      is (ECA, EU/UK berth, gas or liquid mode).
 *   3. Everything that depends on the result (FuelEU pooling, allowance
 *      surrenders and allocations, invoice amounts, figures quoted in emails)
 *      is inserted by SQL that reads the schema's views, so it matches them
 *      by construction.
 *
 *   const { buildSql } = require('./test_data');
 *   buildSql({ until: new Date() })   ->  one idempotent SQL script
 *
 * The script first removes earlier test rows (vessels with is_test, TEST-
 * companies, their trades, invoices and emails), then inserts. Run it as the
 * database owner (postgres), after db/001_schema.sql.
 */

const START = Date.UTC(2023, 0, 1);
const H = 3600000;
const D = 24 * H;

// Must match kris.fuel_types (db/001_schema.sql); used only to write the
// CO2 column of the daily report the way a vessel's own system would.
const CF = { HSFO: 3.114, VLSFO: 3.151, MGO: 3.206, MDO: 3.206, LNG: 2.750 };
const LCV = { HSFO: 40500, VLSFO: 41000, MGO: 42700, MDO: 42700, LNG: 49100 };

// ---------------------------------------------------------------------------
// Reference rows
// ---------------------------------------------------------------------------

const COMPANIES = [
  ['TEST-NWO', 'TEST Northwind Owners Ltd', ['owner'], 'MH', 'northwind-owners.example'],
  ['TEST-AOT', 'TEST Aurelia Tankers AS', ['owner'], 'NO', 'aurelia-tankers.example'],
  ['TEST-HLM', 'TEST Harbourline Ship Management Pte Ltd', ['manager', 'customer'], 'SG', 'harbourline.example'],
  ['TEST-MCH', 'TEST Meridian Chartering A/S', ['charterer'], 'DK', 'meridian-chartering.example'],
  ['TEST-ATE', 'TEST Atlas Energy Trading SA', ['charterer'], 'CH', 'atlas-energy.example'],
  ['TEST-ACB', 'TEST Alpine Carbon Brokers AG', ['counterparty'], 'CH', 'alpine-carbon.example'],
  ['TEST-NCM', 'TEST Nordic Carbon Markets AB', ['counterparty'], 'SE', 'nordic-carbon.example'],
  ['TEST-VER', 'TEST Verification Services BV', ['verifier'], 'NL', 'verification.example'],
  ['TEST-BRS', 'TEST Bunkers Rotterdam BV', ['supplier'], 'NL', 'bunkers-rotterdam.example'],
  ['TEST-GLS', 'TEST Gulf LNG Supply LLC', ['supplier'], 'US', 'gulf-lng.example'],
  ['TEST-SBS', 'TEST Santos Bunker Services Ltda', ['supplier'], 'BR', 'santos-bunkers.example'],
];

// Real ports (their UN/LOCODEs are public reference data), approximate positions.
const PORTS = [
  ['BRSSZ', 'Santos', 'BR', 'Brazil', 'OTHER', false, -23.96, -46.30],
  ['NLRTM', 'Rotterdam', 'NL', 'Netherlands', 'EEA', true, 51.95, 4.14],
  ['PLGDN', 'Gdansk', 'PL', 'Poland', 'EEA', true, 54.40, 18.66],
  ['MACAS', 'Casablanca', 'MA', 'Morocco', 'OTHER', false, 33.61, -7.61],
  ['ZARCB', 'Richards Bay', 'ZA', 'South Africa', 'OTHER', false, -28.80, 32.08],
  ['GBIMM', 'Immingham', 'GB', 'United Kingdom', 'UK', true, 53.63, -0.19],
  ['GBTEE', 'Teesport', 'GB', 'United Kingdom', 'UK', true, 54.61, -1.16],
  ['USCRP', 'Corpus Christi', 'US', 'United States', 'OTHER', true, 27.81, -97.40],
  ['NOMON', 'Mongstad', 'NO', 'Norway', 'EEA', true, 60.81, 5.03],
  ['DEWVN', 'Wilhelmshaven', 'DE', 'Germany', 'EEA', true, 53.52, 8.15],
  ['CASJB', 'Saint John', 'CA', 'Canada', 'OTHER', true, 45.26, -66.06],
];

// Sea-lane waypoints [lat, lon] between the ports of each route: positions
// are interpolated along them, so a vessel on the map is never over land.
const WP = {
  SANTOS_ROTTERDAM: [[-24.3, -45.6], [-23.3, -41.5], [-18.5, -37.8], [-13.0, -37.5], [-7.5, -34.3], [-3.0, -32.0], [3.0, -28.5],
    [12.0, -24.5], [20.0, -21.5], [28.5, -19.0], [36.0, -11.2], [42.8, -9.9], [48.0, -6.0], [49.6, -3.0], [50.4, -0.5], [51.05, 1.6], [51.7, 2.9]],
  ROTTERDAM_GDANSK: [[52.1, 3.9], [53.3, 4.3], [54.2, 6.0], [55.5, 7.2], [56.8, 7.6], [57.6, 9.4], [57.85, 10.8], [57.3, 11.4], [56.3, 12.1],
    [55.6, 12.75], [55.25, 13.2], [54.85, 14.4], [54.9, 16.3], [54.7, 19.0]],
  GDANSK_CASABLANCA: [[54.7, 19.0], [54.9, 16.3], [54.85, 14.4], [55.25, 13.2], [55.6, 12.75], [56.3, 12.1], [57.3, 11.4], [57.85, 10.8],
    [57.6, 9.4], [56.8, 7.6], [55.5, 7.2], [54.2, 6.0], [53.3, 4.3], [52.3, 3.0], [51.05, 1.6], [50.4, -0.5], [49.6, -3.0], [48.0, -6.0],
    [42.8, -9.9], [37.5, -10.2], [35.0, -8.6], [33.8, -7.8]],
  CASABLANCA_RICHARDS: [[33.8, -7.9], [31.0, -11.0], [27.0, -14.5], [24.0, -17.0], [18.0, -18.5], [12.0, -18.5], [5.0, -15.0], [-2.0, -8.0],
    [-10.0, -2.0], [-20.0, 5.0], [-28.0, 11.5], [-33.5, 16.5], [-35.3, 19.5], [-35.0, 22.5], [-34.4, 26.5], [-33.2, 28.4], [-31.2, 30.6], [-29.4, 31.9]],
  RICHARDS_IMMINGHAM: [[-29.4, 31.9], [-31.2, 30.6], [-33.2, 28.4], [-34.4, 26.5], [-35.0, 22.5], [-35.3, 19.5], [-33.5, 16.5], [-28.0, 11.5],
    [-20.0, 5.0], [-10.0, -2.0], [-2.0, -8.0], [5.0, -15.0], [12.0, -18.5], [18.0, -18.5], [24.0, -17.0], [27.0, -14.5], [31.0, -11.0],
    [36.0, -11.2], [42.8, -9.9], [48.0, -6.0], [49.6, -3.0], [50.4, -0.5], [51.05, 1.6], [52.0, 2.3], [53.1, 1.9], [53.55, 0.4]],
  IMMINGHAM_TEESPORT: [[53.58, 0.4], [53.9, 0.4], [54.3, -0.2], [54.62, -1.0]],
  TEESPORT_SANTOS: [[54.62, -0.9], [54.0, 0.6], [53.1, 1.9], [52.0, 2.3], [51.05, 1.6], [50.4, -0.5], [49.6, -3.0], [48.0, -6.0], [42.8, -9.9],
    [36.0, -11.2], [28.5, -19.0], [20.0, -21.5], [12.0, -24.5], [3.0, -28.5], [-3.0, -32.0], [-7.5, -34.3], [-13.0, -37.5], [-18.5, -37.8],
    [-23.3, -41.5], [-24.3, -45.6]],
  CORPUS_ROTTERDAM: [[27.6, -96.9], [26.8, -94.0], [25.6, -89.0], [24.2, -84.5], [24.3, -82.0], [25.0, -80.1], [27.0, -79.8], [30.5, -79.3],
    [34.5, -74.5], [38.5, -62.0], [42.5, -48.0], [46.5, -30.0], [48.8, -12.0], [49.4, -5.5], [50.2, -1.0], [51.05, 1.6], [51.7, 2.9]],
  ROTTERDAM_MONGSTAD: [[52.1, 3.9], [53.5, 3.8], [56.0, 4.0], [58.5, 4.3], [60.3, 4.4], [60.75, 4.6]],
  MONGSTAD_WILHELMSHAVEN: [[60.75, 4.6], [59.0, 4.6], [57.0, 5.8], [55.2, 6.8], [54.1, 7.6], [53.95, 7.95]],
  WILHELMSHAVEN_CORPUS: [[53.95, 7.95], [53.9, 6.5], [53.4, 4.3], [52.3, 3.0], [51.05, 1.6], [50.2, -1.0], [49.4, -5.5], [48.8, -12.0],
    [46.5, -30.0], [42.5, -48.0], [38.5, -62.0], [34.5, -74.5], [30.5, -79.3], [27.0, -79.8], [25.0, -80.1], [24.3, -82.0], [24.2, -84.5],
    [25.6, -89.0], [26.8, -94.0], [27.6, -96.9]],
  CORPUS_SAINTJOHN: [[27.6, -96.9], [26.8, -94.0], [25.6, -89.0], [24.2, -84.5], [24.3, -82.0], [25.0, -80.1], [27.0, -79.8], [30.5, -79.3],
    [34.5, -74.5], [38.5, -71.5], [41.5, -67.8], [43.8, -66.6], [44.9, -66.2]],
};
WP.SAINTJOHN_CORPUS = WP.CORPUS_SAINTJOHN.slice().reverse();

// ---------------------------------------------------------------------------
// The two vessels and the trades they run
// ---------------------------------------------------------------------------

// ecaFrom / ecaTo: miles of the passage inside an emission control area,
// counted from the departure port / towards the arrival port.
const TV01 = {
  id: '1000019', name: 'SN Star', code: 'SNSTAR', kind: 'bulk', department: 'Emission',
  ship_type: 'bulk_carrier', vessel_type: 'Ultramax bulk carrier (geared, 4 x 30 t cranes)', flag: 'Marshall Islands',
  owner: 'TEST-NWO', manager: 'TEST-HLM', charterer: 'TEST-MCH', customer: 'TEST-HLM',
  gt: 36420, nt: 21390, dwt: 63520, capacity: 79600, capUnit: 'm3',
  me: 'MAN B&W 6S50ME-C8.2 (IMO Tier II)', cyl: 6, mcr: 8300, rpm: 117, aux: '3 x 680 kW diesel generators',
  scrubber: 'open_loop', dual: false, built: 2016, builder: 'TEST Shipyard Co. (fictional)', klass: 'TEST Classification Society (fictional)',
  design: 14.5, ref: 13.5,
  fuels: [['HSFO', 'main'], ['MGO', 'eca'], ['VLSFO', 'port']],
  seed: 101, offset: 5,
  seaMargin: 1.36,  // hull fouling: the power penalty behind its D rating (see its SEEMP Part III revision)
  ladenSpeed: [11.6, 12.4], ballastSpeed: [12.0, 12.8],
  sfoc: 178, aeSfoc: 215, aeSeaKw: 430, aeWaitKw: 380, aePortKw: 820,
  boilerSea: 0.25, boilerWait: 0.9, boilerPort: 1.3,
  wait: { laden: [1.0, 4.5], ballast: [1.5, 5.0] }, cargoRate: 11500, loadDays: [2.5, 4.0],
  route: [
    { from: 'BRSSZ', to: 'NLRTM', nm: 5300, wp: WP.SANTOS_ROTTERDAM, ecaTo: 330, cargo: 'Soybeans', qty: 60500 },
    { from: 'NLRTM', to: 'PLGDN', nm: 690, wp: WP.ROTTERDAM_GDANSK, ecaFrom: 690 },
    { from: 'PLGDN', to: 'MACAS', nm: 2050, wp: WP.GDANSK_CASABLANCA, ecaFrom: 880, cargo: 'Wheat', qty: 55200 },
    { from: 'MACAS', to: 'ZARCB', nm: 5100, wp: WP.CASABLANCA_RICHARDS },
    { from: 'ZARCB', to: 'GBIMM', nm: 6900, wp: WP.RICHARDS_IMMINGHAM, ecaTo: 420, cargo: 'Steam coal', qty: 61000, partDischarge: 37000 },
    { from: 'GBIMM', to: 'GBTEE', nm: 125, wp: WP.IMMINGHAM_TEESPORT, ecaFrom: 125, cargo: 'Steam coal (remaining part cargo)', qty: 24000 },
    { from: 'GBTEE', to: 'BRSSZ', nm: 5250, wp: WP.TEESPORT_SANTOS, ecaFrom: 380 },
  ],
  bunkerPorts: { NLRTM: ['HSFO', 'MGO'], BRSSZ: ['VLSFO'] },
  offhire: [{ year: 2024, nth: 4, days: 0.6, reason: 'Crew medical deviation' },
            { year: 2025, nth: 6, days: 1.6, reason: 'Main engine repairs (exhaust valve)' }],
};

const TV02 = {
  id: '1000021', name: 'SN Sky', code: 'SNSKY', kind: 'tanker', department: 'Emission',
  ship_type: 'tanker', vessel_type: 'Aframax crude oil tanker, LNG dual-fuel', flag: 'Malta',
  owner: 'TEST-AOT', manager: 'TEST-HLM', charterer: 'TEST-ATE', customer: 'TEST-HLM',
  gt: 63910, nt: 34480, dwt: 114650, capacity: 125400, capUnit: 'm3',
  me: 'WinGD 6X62DF-2.1 (dual-fuel, low-pressure Otto)', cyl: 6, mcr: 13560, rpm: 103, aux: '3 x 1,110 kW dual-fuel generators',
  scrubber: 'none', dual: true, built: 2022, builder: 'TEST Heavy Industries (fictional)', klass: 'TEST Classification Society (fictional)',
  design: 15.0, ref: 14.0,
  fuels: [['LNG', 'main'], ['MGO', 'pilot'], ['VLSFO', 'backup']],
  seed: 202, offset: 0,
  ladenSpeed: [12.8, 13.6], ballastSpeed: [13.2, 14.0],
  gasBsec: 7300, liquidSfoc: 172, aeBsec: 8500, aeSeaKw: 760, aeWaitKw: 650, aePortKw: 980,
  boilerHeating: 3.2, boilerWait: 1.8, boilerDischarge: 33, boilerLoad: 2.4,
  wait: { laden: [0.4, 1.6], ballast: [0.3, 1.4] }, dischargeDays: [1.3, 1.8], loadDays: [1.1, 1.5],
  liquidModeEvery: 7,   // one voyage in N runs on VLSFO (no LNG at the last bunker call)
  route: [
    { from: 'USCRP', to: 'NLRTM', nm: 5050, wp: WP.CORPUS_ROTTERDAM, ecaFrom: 200, ecaTo: 330, cargo: 'WTI crude oil', qty: 98500 },
    { from: 'NLRTM', to: 'NOMON', nm: 540, wp: WP.ROTTERDAM_MONGSTAD, ecaFrom: 540 },
    { from: 'NOMON', to: 'DEWVN', nm: 470, wp: WP.MONGSTAD_WILHELMSHAVEN, ecaFrom: 470, cargo: 'North Sea crude oil', qty: 97200 },
    { from: 'DEWVN', to: 'USCRP', nm: 5200, wp: WP.WILHELMSHAVEN_CORPUS, ecaFrom: 360, ecaTo: 200 },
    { from: 'USCRP', to: 'CASJB', nm: 2350, wp: WP.CORPUS_SAINTJOHN, ecaFrom: 200, ecaTo: 200, cargo: 'WTI crude oil', qty: 99100 },
    { from: 'CASJB', to: 'USCRP', nm: 2350, wp: WP.SAINTJOHN_CORPUS, ecaFrom: 200, ecaTo: 200 },
  ],
  bunkerPorts: { NLRTM: ['LNG', 'VLSFO', 'MGO'], USCRP: ['VLSFO', 'MGO'] },
  offhire: [{ year: 2026, nth: 3, days: 0.9, reason: 'Underwater hull inspection and cleaning' }],
};

const PORT_BY = Object.fromEntries(PORTS.map((p) => [p[0], { locode: p[0], region: p[4], eca: p[5] }]));

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (rnd, [lo, hi]) => lo + (hi - lo) * rnd();
const r3 = (x) => Math.round(x * 1000) / 1000;
const r1 = (x) => Math.round(x * 10) / 10;
const iso = (ms) => new Date(ms).toISOString();
const ymd = (ms) => iso(ms).slice(0, 10);

// --- positions ---------------------------------------------------------------

const PORT_POS = Object.fromEntries(PORTS.map((p) => [p[0], [p[6], p[7]]]));
const rad = (d) => d * Math.PI / 180;

function gcNm(a, b) {
  const [p1, p2] = [rad(a[0]), rad(b[0])];
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(h));
}

function bearing(a, b) {
  const [p1, p2, dl] = [rad(a[0]), rad(b[0]), rad(b[1] - a[1])];
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.round(Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

/** The route as a polyline with cumulative miles, port to port. */
function lane(leg) {
  const pts = [PORT_POS[leg.from], ...(leg.wp || []), PORT_POS[leg.to]];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + gcNm(pts[i - 1], pts[i]));
  return { pts, cum, length: cum[cum.length - 1] };
}

/** The point `frac` of the way along a lane, and the course there. */
function along(l, frac) {
  const at = Math.max(0, Math.min(1, frac)) * l.length;
  let i = 1;
  while (i < l.cum.length - 1 && l.cum[i] < at) i++;
  const seg = l.cum[i] - l.cum[i - 1] || 1;
  const f = (at - l.cum[i - 1]) / seg;
  const a = l.pts[i - 1]; const b = l.pts[i];
  return { lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f, course: bearing(a, b) };
}

const r5 = (x) => Math.round(x * 1e5) / 1e5;

/** Voyages and port stays from START until `until`. */
function timeline(spec, until) {
  const rnd = prng(spec.seed);
  const out = [];
  const seqByYear = {};
  let t = START + 6 * H + rnd() * 12 * H;
  for (let i = spec.offset; t < until; i++) {
    const leg = spec.route[i % spec.route.length];
    const laden = !!leg.cargo;
    const year = new Date(t).getUTCFullYear();
    seqByYear[year] = (seqByYear[year] || 0) + 1;
    const seq = String(seqByYear[year]).padStart(2, '0');
    const speed = between(rnd, laden ? spec.ladenSpeed : spec.ballastSpeed);
    const arrival = t + (leg.nm / speed) * H;
    const waitDays = between(rnd, laden ? spec.wait.laden : spec.wait.ballast);
    // Destination of a laden leg is a discharge port; of a ballast leg, a load port.
    let cargoDays;
    if (spec.cargoRate) cargoDays = laden ? (leg.partDischarge || leg.qty) / spec.cargoRate + 0.4 : between(rnd, spec.loadDays);
    else cargoDays = between(rnd, laden ? spec.dischargeDays : spec.loadDays);
    const berthed = arrival + waitDays * D;
    let departure = berthed + cargoDays * D;
    const off = (spec.offhire || []).find((o) => o.year === year && o.nth === seqByYear[year]);
    if (off) departure += off.days * D;
    out.push({
      ref: `${spec.code}-${year}-${seq}`, no: `V${String(year).slice(2)}${seq}`,
      leg, laden, speed, depart: t, arrival, berthed, departure,
      liquid: spec.liquidModeEvery ? (out.length % spec.liquidModeEvery === spec.liquidModeEvery - 1) : false,
      offhire: off ? { start: berthed + cargoDays * D, days: off.days, reason: off.reason } : null,
    });
    t = departure;
  }
  return out;
}

/** Fuel for one report period. Returns { [fuel]: { me, ae, boiler } } in tonnes. */
function burn(spec, v, mode, hours, ctx) {
  const f = {};
  const add = (code, key, t) => { if (t <= 0) return; f[code] = f[code] || { me: 0, ae: 0, boiler: 0 }; f[code][key] += t; };
  const portRegion = PORT_BY[v.leg.to].region;
  if (spec.kind === 'bulk') {
    if (mode === 'sea') {
      const fuel = ctx.eca ? 'MGO' : 'HSFO';
      add(fuel, 'me', ctx.powerKw * hours * spec.sfoc / 1e6);
      add(fuel, 'ae', spec.aeSeaKw * hours * spec.aeSfoc / 1e6);
      add(fuel, 'boiler', spec.boilerSea * hours / 24);
    } else {
      const fuel = portRegion === 'OTHER' ? 'VLSFO' : 'MGO';   // 0.10% S at berth in EU and UK ports
      add(fuel, 'ae', (ctx.waitH * spec.aeWaitKw + ctx.alongH * spec.aePortKw) * spec.aeSfoc / 1e6);
      add(fuel, 'boiler', (ctx.waitH * spec.boilerWait + ctx.alongH * spec.boilerPort) / 24);
    }
    return f;
  }
  // SN Sky: LNG dual-fuel. Gas mode burns LNG with 1% of the energy as MGO pilot.
  const gas = !v.liquid;
  const liquid = ctx.eca || portRegion !== 'OTHER' ? 'MGO' : 'VLSFO';
  const gasEnergy = (kwh, bsec) => kwh * bsec / 1000;   // MJ
  if (mode === 'sea') {
    const meKwh = ctx.powerKw * hours;
    if (gas) {
      const mj = gasEnergy(meKwh, spec.gasBsec);
      add('LNG', 'me', 0.99 * mj / LCV.LNG); add('MGO', 'me', 0.01 * mj / LCV.MGO);
      const ae = gasEnergy(spec.aeSeaKw * hours, spec.aeBsec);
      add('LNG', 'ae', 0.99 * ae / LCV.LNG); add('MGO', 'ae', 0.01 * ae / LCV.MGO);
    } else {
      add(liquid, 'me', meKwh * spec.liquidSfoc / 1e6);
      add(liquid, 'ae', spec.aeSeaKw * hours * 205 / 1e6);
    }
    if (v.laden) add(ctx.eca ? 'MGO' : 'VLSFO', 'boiler', spec.boilerHeating * hours / 24);   // cargo heating
  } else {
    const aeKwh = ctx.waitH * spec.aeWaitKw + ctx.alongH * spec.aePortKw;
    const ae = gasEnergy(aeKwh, spec.aeBsec);
    add('LNG', 'ae', 0.99 * ae / LCV.LNG); add('MGO', 'ae', 0.01 * ae / LCV.MGO);
    const boilerAlong = v.laden ? spec.boilerDischarge : spec.boilerLoad;   // cargo pump turbines when discharging
    add(portRegion === 'OTHER' ? 'VLSFO' : 'MGO', 'boiler', (ctx.waitH * spec.boilerWait + ctx.alongH * boilerAlong) / 24);
  }
  return f;
}

/** Departure, noon and arrival reports cut from the timeline. */
function reports(spec, voyages, until) {
  const rnd = prng(spec.seed * 7 + 1);
  const out = [];
  let prev = null;   // previous report time
  const push = (v, form, at, mode, hours, sea) => {
    const ctx = sea || {};
    let powerKw = null; let rpm = null; let distance = 0; let speed = 0;
    if (mode === 'sea') {
      distance = sea.distance; speed = distance / hours;
      const load = v.laden ? 0.75 : 0.64;
      powerKw = Math.min(0.92 * spec.mcr, spec.mcr * load * Math.pow(speed / spec.ref, 3) * sea.weather * (spec.seaMargin || 1));
      rpm = spec.rpm * Math.cbrt(powerKw / spec.mcr);
      ctx.powerKw = powerKw;
    }
    const fuels = burn(spec, v, mode, hours, ctx);
    const rows = Object.entries(fuels).map(([code, x]) => ({ code, me: r3(x.me), ae: r3(x.ae), boiler: r3(x.boiler) }))
      .filter((x) => x.me + x.ae + x.boiler > 0);
    const sum = (k) => r3(rows.reduce((n, x) => n + x[k], 0));
    const total = r3(sum('me') + sum('ae') + sum('boiler'));
    // Where the report was made: along the lane at sea, at the berth or the
    // anchorage (a few miles out on the approach) in port.
    const l = lane(v.leg);
    const pos = mode === 'sea' ? along(l, ctx.milesFromStart / v.leg.nm)
      : at < v.berthed ? along(l, 1 - Math.min(0.5, 6 / l.length)) : { lat: PORT_POS[v.leg.to][0], lon: PORT_POS[v.leg.to][1], course: null };
    out.push({
      imo: spec.id, name: spec.name, form, at, voyage: v.ref, mode, hours: r1(hours),
      lat: r5(pos.lat), lon: r5(pos.lon), course: mode === 'sea' ? pos.course : null,
      wind: mode === 'sea' ? Math.max(1, Math.min(8, Math.round(3 + (sea.weather - 1) * 40))) : null,
      hoursUnderway: mode === 'sea' ? r1(hours) : 0,
      distance: r1(distance), speed: mode === 'sea' ? Math.round(speed * 100) / 100 : 0,
      power: powerKw == null ? null : Math.round(powerKw), rpm: rpm == null ? null : r1(rpm),
      me: sum('me'), ae: sum('ae'), boiler: sum('boiler'), total,
      co2: r3(rows.reduce((n, x) => n + (x.me + x.ae + x.boiler) * CF[x.code], 0)),
      fuels: rows,
    });
    prev = at;
  };

  for (const v of voyages) {
    // --- passage: departure report closes the previous port stay ---------------
    if (prev !== null && v.depart <= until) {
      const pv = voyages[voyages.indexOf(v) - 1];
      portPeriod(pv, 'departure', v.depart);
    } else if (prev === null) {
      prev = v.depart;
    }
    if (v.depart > until) break;
    const end = Math.min(v.arrival, until);
    const cuts = [];
    for (let n = Math.floor(v.depart / D) * D + 12 * H; n < end; n += D) if (n > v.depart) cuts.push(n);
    const final = v.arrival <= until;
    if (final) cuts.push(v.arrival);
    // Spread the passage distance over the periods with a little weather noise,
    // scaled so the miles add up to the route distance exactly.
    const periods = cuts.map((c, k) => (c - (k ? cuts[k - 1] : v.depart)) / H);
    const noise = periods.map(() => 1 + (rnd() - 0.5) * 0.08);
    const totalH = (v.arrival - v.depart) / H;
    const shareOfPassage = periods.reduce((n, h) => n + h, 0) / totalH;
    const weighted = periods.map((h, k) => h * noise[k]);
    const wsum = weighted.reduce((n, x) => n + x, 0);
    let fromStart = 0;
    cuts.forEach((c, k) => {
      const miles = v.leg.nm * shareOfPassage * weighted[k] / wsum;
      const mid = fromStart + miles / 2;
      const eca = (v.leg.ecaFrom && mid <= v.leg.ecaFrom) || (v.leg.ecaTo && v.leg.nm - mid <= v.leg.ecaTo);
      push(v, final && k === cuts.length - 1 ? 'arrival' : 'noon', c, 'sea', periods[k],
        { distance: miles, eca: !!eca, weather: 1 + (rnd() - 0.4) * 0.12, milesFromStart: fromStart + miles });
      fromStart += miles;
    });
    if (!final) break;
    // --- port stay: noon reports until the next departure (or until now) -------
    const stayEnd = Math.min(v.departure, until);
    for (let n = Math.floor(v.arrival / D) * D + 12 * H; n < stayEnd; n += D) {
      if (n > v.arrival) portPeriod(v, 'noon', n);
    }
    if (v.departure > until) break;
  }
  return out;

  function portPeriod(v, form, at) {
    const from = prev; const hours = (at - from) / H;
    const waitH = Math.max(0, (Math.min(at, v.berthed) - from) / H);
    let alongH = Math.max(0, hours - waitH);
    // Off-hire time alongside draws only hotel load.
    if (v.offhire) {
      const oStart = v.offhire.start; const oEnd = oStart + v.offhire.days * D;
      const overlap = Math.max(0, (Math.min(at, oEnd) - Math.max(from, oStart)) / H);
      alongH -= overlap * 0.5;
    }
    push(v, form, at, 'port', hours, { waitH, alongH: Math.max(0, alongH) });
  }
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return `ARRAY[${v.map(lit).join(', ')}]::text[]`;
  return `'${String(v).replace(/'/g, "''")}'`;
}
const tuple = (vals) => `(${vals.map(lit).join(', ')})`;
const RULE = '-- ' + '='.repeat(76);
const banner = (title, ...lines) => [RULE, `--  ${title}`, ...lines.map((l) => `--  ${l}`.trimEnd()), RULE].join('\n');

function valuesInsert(head, rows, select, chunk = 250) {
  const out = [];
  for (let i = 0; i < rows.length; i += chunk) {
    out.push(`${head}\n${select.replace('%VALUES%', rows.slice(i, i + chunk).map(tuple).join(',\n'))};`);
  }
  return out;
}

const tx = (blocks) => ['BEGIN;\nSET LOCAL search_path = kris;', ...blocks, 'COMMIT;'].join('\n\n');

/** The test data as one SQL script. */
function buildSql(opts = {}) {
  const { head, guard, body, positions, checks } = seed(opts);
  return [head, guard, tx([...body, positions]), checks].join('\n\n');
}

/**
 * The same data cut into scripts of at most about maxChars each, for editors
 * that cap a query's size (Supabase's SQL Editor). Each part is one
 * transaction, to run in order; the last holds only the current positions,
 * so it can be edited and re-run on its own.
 */
function buildParts(opts = {}, maxChars = 250000) {
  const { head, guard, body, positions, checks } = seed(opts);
  const groups = [[]];
  let size = 0;
  for (const b of body) {
    if (size + b.length > maxChars && groups[groups.length - 1].length) { groups.push([]); size = 0; }
    groups[groups.length - 1].push(b);
    size += b.length + 2;
  }
  groups.push([positions]);
  const n = groups.length;
  return groups.map((g, i) => [
    i === 0 ? `${head}\n\n${guard}` : '',
    `-- K.R.1.S TEST DATA — PART ${i + 1} OF ${n}. Run the parts in order${i ? `, after part ${i} has finished` : ''}.`,
    tx(g),
    i === n - 1 ? checks : '',
  ].filter(Boolean).join('\n\n'));
}

function seed(opts) {
  const until = (opts.until ? new Date(opts.until) : new Date()).getTime();
  const ships = [TV01, TV02];
  const sim = ships.map((s) => {
    const voyages = timeline(s, until);
    return { spec: s, voyages, reports: reports(s, voyages, until) };
  });
  const untilDate = ymd(until);
  const sql = [];
  let note = '';   // a section banner, written with the statement that follows it
  const section = (...a) => { note += banner(...a) + '\n'; };
  const add = (...stmts) => { for (const s of stmts) { sql.push(note + s); note = ''; } };

  // Where each vessel is at `until`: its latest report, the one the map shows.
  const portName = Object.fromEntries(PORTS.map((p) => [p[0], p[1]]));
  const now = sim.map(({ spec, voyages, reports: rs }) => {
    const r = rs[rs.length - 1];
    const v = voyages.find((x) => x.ref === r.voyage);
    const port = portName[v.leg.to];
    const where = r.form === 'departure' ? `departing ${port}`
      : r.mode === 'sea' ? `at sea, ${portName[v.leg.from]} to ${port}`
      : r.at < v.berthed ? `at anchor off ${port}` : `alongside at ${port}`;
    return { spec, r, where };
  });
  const pad = (s, n) => String(s).padEnd(n);

  const head = `-- ============================================================================
--  K.R.1.S TEST DATA — SN Star and SN Sky
--
--  Generated ${iso(Date.now())} by db/test_data.js, with data from
--  1 January 2023 up to ${iso(until)}.
--  As the database owner (postgres):
--    1. Run db/001_schema.sql — also on a database set up earlier: it is safe to
--       re-run, keeps the data, and adds any table, column or view added since
--       (section 0 below stops, before changing anything, if one is missing).
--    2. Supabase SQL Editor: it limits a query's size, so the data comes in
--       parts: run db/002_test_data_part1.sql, part2, ... in order, each after
--       the previous one has finished.
--       Or, from a terminal, both steps at once: node db/setup.js
--  Safe to re-run: the earlier test rows are deleted first.
--
--  THE VESSELS — fictional. IMO numbers are in the 1000000 range (valid check
--  digit, never issued to a ship), companies start with TEST, email addresses
--  use the reserved .example domain.
${now.map(({ spec: s }) => `--    ${pad(s.name, 8)} IMO ${s.id}  ${s.vessel_type}, ${s.dwt} DWT, built ${s.built}
--                          trades ${[...new Set(s.route.map((l) => portName[l.from]))].join(' - ')}`).join('\n')}
--
--  WHERE THEY ARE NOW — what the map shows (latest report of each vessel)
${now.map(({ spec: s, r, where }) => `--    ${pad(s.name, 8)} ${pad(where, 40)} lat ${r.lat}, lon ${r.lon}`).join('\n')}
--    To move a vessel on the map, edit section 15 "CURRENT POSITIONS" (the last
--    part) and run it again; it can be re-run on its own at any time.
--
--  SECTIONS
--     0  schema check (stops before any change if a table or column is missing)
--     1  earlier test data removed
--     2  companies: owners, manager/customer, charterers, carbon brokers,
--        verifier, bunker suppliers
--     3  ports: UN/LOCODE, region (EEA / UK / OTHER), ECA, latitude/longitude
--     4  vessels: IMO, particulars, tonnage, engines, owner/manager/charterer
--     5  sea distances between ports (distance to go and ETA)
--     6  voyages   7  port calls   8  off-hire
--     9  daily reports: position, course, speed, power, fuel, CO2
--    10  fuel burned per report and fuel type   11  bunker deliveries (BDNs)
--    12  fuel types per vessel, with the fuel on board when the data starts
--    13  EUA / UKA prices (illustrative, not market data)
--    14  CII corrections, FuelEU pool, allowance trades, allocations,
--        surrenders, invoices, compliance filings, emails
--    15  CURRENT POSITIONS: where the map shows each vessel (edit here)
--
--  NOT INSERTED BECAUSE IT IS COMPUTED: CO2 per voyage and year, AER, CII and
--  its rating, FuelEU balance and penalty, ETS allowances owed, voyage days,
--  distance to go, ETA, fuel on board. Those are views (db/001_schema.sql) over
--  the rows below, so they always agree with them. Queries to look at them
--  are at the end (the last part).
-- ============================================================================`;

  section('1. Remove earlier test data (children first where there is no cascade)');
  add(`DELETE FROM kris.communications WHERE customer_id LIKE 'TEST-%' OR vessel_id IN (SELECT id FROM kris.vessels WHERE is_test);
DELETE FROM kris.invoices WHERE customer_id LIKE 'TEST-%';
DELETE FROM kris.carbon_allocations WHERE vessel_id IN (SELECT id FROM kris.vessels WHERE is_test);
DELETE FROM kris.carbon_trades WHERE customer_id LIKE 'TEST-%';
DELETE FROM kris.geoform_reports WHERE imo IN (SELECT id FROM kris.vessels WHERE is_test);
DELETE FROM kris.veson_offhire WHERE imo IN (SELECT id FROM kris.vessels WHERE is_test);
DELETE FROM kris.vessels WHERE is_test;
DELETE FROM kris.fueleu_pools WHERE id LIKE 'TEST-%';
DELETE FROM kris.carbon_prices WHERE source LIKE 'TEST%';
DELETE FROM kris.companies WHERE id LIKE 'TEST-%';`);

  section('2. Companies — every party the vessels deal with (fictional, prefixed TEST)',
    'roles: owner, manager, charterer, customer (who K.R.1.S reports to), counterparty',
    '(carbon broker), verifier, supplier (bunkers). One company can have several roles.');
  add(...valuesInsert('INSERT INTO kris.companies (id, name, roles, country_code, email_domain, is_test)',
    COMPANIES.map((c) => [...c, true]), 'VALUES %VALUES%'));
  section('3. Ports — real UN/LOCODEs, approximate positions',
    'region decides regulation: EEA = EU MRV / EU ETS / FuelEU, UK = UK ETS, OTHER = neither.',
    'in_eca = inside an emission control area (0.10% sulphur). latitude/longitude are the',
    'berth a vessel alongside is shown at. Upserted, so a port that already exists is updated.');
  add(...valuesInsert('INSERT INTO kris.ports (locode, name, country_code, country, region, in_eca, latitude, longitude)',
    PORTS, `VALUES %VALUES%
ON CONFLICT (locode) DO UPDATE SET name = EXCLUDED.name, country = EXCLUDED.country, region = EXCLUDED.region,
  in_eca = EXCLUDED.in_eca, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude`));

  section('4. Vessels — id is the IMO number (every other table keys on it)',
    'ship_type picks the CII reference line (kris.cii_ship_types); deadweight_t is the CII',
    'capacity. department is what access control scopes on. is_test marks them as test rows.');
  add(...valuesInsert(`INSERT INTO kris.vessels (id, imo, name, department, vessel_code, ship_type, vessel_type, flag,
  owner_id, manager_id, charterer_id, customer_id, gross_tonnage, net_tonnage, deadweight_t, cargo_capacity, cargo_capacity_unit,
  main_engine, main_engine_cylinders, main_engine_mcr_kw, main_engine_rpm, aux_engines, scrubber, dual_fuel,
  year_built, builder, class_society, design_speed_kn, reference_speed_kn, is_test)`,
  ships.map((s) => [s.id, s.id, s.name, s.department, s.code, s.ship_type, s.vessel_type, s.flag,
    s.owner, s.manager, s.charterer, s.customer, s.gt, s.nt, s.dwt, s.capacity, s.capUnit,
    s.me, s.cyl, s.mcr, s.rpm, s.aux, s.scrubber, s.dual, s.built, s.builder, s.klass, s.design, s.ref, true]),
  'VALUES %VALUES%'));
  section('5. Sea distances (nm) on the usual route: distance to go and ETA come from these');
  add(...valuesInsert('INSERT INTO kris.route_distances (from_port, to_port, nm)',
    ships.flatMap((s) => s.route.map((l) => [l.from, l.to, l.nm])),
    'VALUES %VALUES%\nON CONFLICT (from_port, to_port) DO UPDATE SET nm = EXCLUDED.nm'));

  // --- voyages and port calls ---------------------------------------------------
  const voyRows = []; const callRows = []; const offRows = [];
  for (const { spec, voyages } of sim) {
    for (const v of voyages) {
      if (v.depart > until) continue;
      voyRows.push([spec.id, v.no, v.ref, v.leg.from, v.leg.to, iso(v.depart), v.laden ? 'laden' : 'ballast',
        v.leg.cargo || null, v.leg.qty || null, spec.charterer]);
      if (v.arrival <= until) {
        callRows.push([v.ref, v.leg.to, v.laden ? 'discharge' : 'load', iso(v.arrival),
          v.berthed <= until ? iso(v.berthed) : null, v.departure <= until ? iso(v.departure) : null,
          r1(3 + (v.leg.nm % 9))]);
      }
      if (v.offhire && v.offhire.start <= until) {
        const end = v.offhire.start + v.offhire.days * D;
        offRows.push([spec.id, spec.name, v.no, iso(v.offhire.start), iso(end), ymd(v.offhire.start),
          r1(v.offhire.days * 24), r3(v.offhire.days), v.offhire.reason]);
      }
    }
  }
  section('6. Voyages — one passage plus the stay at its destination',
    'A voyage starts when the vessel leaves from_port and ends when it leaves to_port, which',
    'is when the next one starts. laden legs carry cargo_qty_t (used for EEOI), ballast legs none.',
    'voyage_ref (e.g. SNSTAR-2026-05) is how the rows below find their voyage.');
  add(...valuesInsert('INSERT INTO kris.voyages (vessel_id, voyage_no, voyage_ref, from_port, to_port, departure_at, leg_type, cargo, cargo_qty_t, charterer_id)',
    voyRows, `SELECT d.vessel_id, d.voyage_no, d.voyage_ref, d.from_port, d.to_port, d.departure_at::timestamptz, d.leg_type, d.cargo, d.qty::numeric, d.charterer
  FROM (VALUES %VALUES%) AS d(vessel_id, voyage_no, voyage_ref, from_port, to_port, departure_at, leg_type, cargo, qty, charterer)`));
  section('7. Port calls — arrival (end of passage), berthed (after waiting at anchor), departure',
    'departure_at NULL = still in port; berthed_at NULL = still at anchor. The voyage status',
    '(underway / in_port / completed) is derived from these.');
  add(...valuesInsert('INSERT INTO kris.port_calls (voyage_id, locode, purpose, arrival_at, berthed_at, departure_at, distance_in_port_nm)',
    callRows, `SELECT v.id, d.locode, d.purpose, d.arrival_at::timestamptz, d.berthed_at::timestamptz, d.departure_at::timestamptz, d.nm
  FROM (VALUES %VALUES%) AS d(voyage_ref, locode, purpose, arrival_at, berthed_at, departure_at, nm)
  JOIN kris.voyages v ON v.voyage_ref = d.voyage_ref`));
  if (offRows.length) {
    section('8. Off-hire events (Veson), tied to a voyage by voyage_no; subtracted from net voyage days');
    add(...valuesInsert('INSERT INTO kris.veson_offhire (imo, vessel_name, voyage_no, start_time, end_time, start_date, offhire_hours, offhire_days, reason)',
      offRows, `SELECT d.imo, d.name, d.voyage_no, d.s::timestamptz, d.e::timestamptz, d.sd::date, d.h, d.dd, d.reason
  FROM (VALUES %VALUES%) AS d(imo, name, voyage_no, s, e, sd, h, dd, reason)`));
  }

  // --- reports and the fuel ledger ----------------------------------------------
  const repRows = []; const fuelRows = [];
  for (const { reports: rs } of sim) {
    for (const r of rs) {
      repRows.push([r.imo, r.name, r.form, iso(r.at), ymd(r.at), r.power, r.total, r.me, r.ae, r.boiler,
        r.distance, r.speed, r.rpm, r.co2, r.mode, r.hoursUnderway, r.lat, r.lon, r.course, r.wind, r.voyage]);
      for (const f of r.fuels) fuelRows.push([r.imo, iso(r.at), r.form, f.code, f.me, f.ae, f.boiler]);
    }
  }
  section('9. Daily reports (kris.geoform_reports): departure, noon (12:00 UTC) and arrival reports',
    'Each covers the time since the previous report. At sea: position along the sea lane, course,',
    'distance, speed, main-engine power and rpm, wind. In port: position of the anchorage or berth.',
    'fuel_consumed_mt = me + ae + boiler and equals the fuel-by-type rows in section 10;',
    'co2_mt = fuel x emission factor. CII, AER, FuelEU and ETS are all computed from these rows.');
  add(...valuesInsert(`INSERT INTO kris.geoform_reports (imo, vessel_name, form_type, report_time, report_date, shaft_power_kw, fuel_consumed_mt,
  me_fuel_mt, ae_fuel_mt, boiler_fuel_mt, distance_nm, speed_kn, me_rpm, co2_mt, mode, hours_underway,
  latitude, longitude, course_deg, wind_force_bft, voyage_id)`, repRows,
  `SELECT d.imo, d.name, d.form, d.at::timestamptz, d.day::date, d.power, d.total, d.me, d.ae, d.boiler, d.distance, d.speed, d.rpm, d.co2, d.mode, d.hours,
          d.lat, d.lon, d.course::smallint, d.wind::smallint, v.id
  FROM (VALUES %VALUES%) AS d(imo, name, form, at, day, power, total, me, ae, boiler, distance, speed, rpm, co2, mode, hours, lat, lon, course, wind, voyage_ref)
  JOIN kris.voyages v ON v.voyage_ref = d.voyage_ref`));

  section('10. Fuel burned per report, by fuel type and consumer (main engine, auxiliaries, boiler)',
    'The emissions ledger: CO2, CO2e, energy and EU/UK scope are computed per row by kris.fuel_emissions.');
  add(...valuesInsert('INSERT INTO kris.fuel_consumption (report_id, fuel_code, me_t, ae_t, boiler_t)', fuelRows,
    `SELECT r.id, d.fuel, d.me, d.ae, d.boiler
  FROM (VALUES %VALUES%) AS d(imo, at, form, fuel, me, ae, boiler)
  JOIN kris.geoform_reports r ON r.imo = d.imo AND r.report_time = d.at::timestamptz AND r.form_type = d.form`, 600));

  // --- bunker deliveries: what was burned since the previous delivery of that fuel,
  //     delivered at the vessel's usual bunker ports -------------------------------
  const bdnRows = [];
  for (const { spec, voyages, reports: rs } of sim) {
    const burned = {}; let k = 0;
    for (const v of voyages) {
      if (v.arrival > until) break;
      while (k < rs.length && rs[k].at <= v.berthed) {
        for (const f of rs[k].fuels) burned[f.code] = (burned[f.code] || 0) + f.me + f.ae + f.boiler;
        k++;
      }
      const fuels = spec.bunkerPorts[v.leg.to];
      if (!fuels || v.berthed > until) continue;
      fuels.forEach((code, n) => {
        const qty = Math.ceil((burned[code] || 0) / 5) * 5;
        if (qty < 50) return;
        const at = v.berthed + (10 + n * 3) * H;
        if (at > until) return;
        burned[code] = 0;
        const no = `BDN-TEST-${spec.code}-${ymd(at).replace(/-/g, '')}-${code}`;
        const supplier = v.leg.to === 'NLRTM' ? 'TEST-BRS' : v.leg.to === 'USCRP' ? 'TEST-GLS' : 'TEST-SBS';
        const density = { HSFO: 986.4, VLSFO: 941.2, MGO: 853.8, LNG: 448.5 }[code];
        const sulphur = { HSFO: 2.61, VLSFO: 0.47, MGO: 0.07, LNG: 0.0 }[code];
        bdnRows.push({ no, vessel: spec.id, voyage: v.ref, port: v.leg.to, at, code, qty, sulphur, density, supplier });
      });
    }
  }
  // Status by age: verified once checked; the most recent are still being processed.
  bdnRows.sort((a, b) => a.at - b.at);
  const recent = bdnRows.filter((b) => b.at > until - 60 * D);
  const requested = recent[recent.length - 1];
  const disputedIdx = bdnRows.findIndex((b) => b.vessel === TV01.id && new Date(b.at).getUTCFullYear() === 2025 && b.code === 'HSFO');
  section('11. Bunker deliveries (BDNs) — what was burned since the last delivery of that fuel',
    'status: verified (checked), received (recent), requested (note still missing), disputed.');
  add(...valuesInsert('INSERT INTO kris.bunker_deliveries (bdn_no, vessel_id, voyage_id, locode, delivered_at, fuel_code, quantity_t, sulphur_pct, density_kg_m3, supplier_id, status, received_at, verified_at)',
    bdnRows.map((b, i) => {
      const status = b === requested ? 'requested' : i === disputedIdx ? 'disputed' : recent.includes(b) ? 'received' : 'verified';
      const received = status === 'requested' ? null : iso(b.at + 20 * H);
      const verified = status === 'verified' ? iso(b.at + 6 * D) : null;
      return [b.no, b.vessel, b.voyage, b.port, iso(b.at), b.code, b.qty, b.sulphur, b.density, b.supplier, status, received, verified];
    }),
    `SELECT d.no, d.vessel, v.id, d.port, d.at::timestamptz, d.code, d.qty, d.s, d.dens, d.supplier, d.status, d.rec::timestamptz, d.ver::timestamptz
  FROM (VALUES %VALUES%) AS d(no, vessel, voyage_ref, port, at, code, qty, s, dens, supplier, status, rec, ver)
  JOIN kris.voyages v ON v.voyage_ref = d.voyage_ref`));

  // --- fuel types, with the opening quantity on board that keeps every
  //     vessel's remaining fuel above a reserve through the whole period -------
  const onBoard = [];
  for (const { spec, reports: rs } of sim) {
    for (const [code, usage] of spec.fuels) {
      const events = rs.map((r) => ({ at: r.at, d: -r.fuels.filter((f) => f.code === code).reduce((n, f) => n + f.me + f.ae + f.boiler, 0) }))
        .concat(bdnRows.filter((b) => b.vessel === spec.id && b.code === code).map((b) => ({ at: b.at, d: b.qty })))
        .sort((a, b) => a.at - b.at);
      let bal = 0; let low = 0;
      for (const e of events) { bal += e.d; low = Math.min(low, bal); }
      const reserve = code === 'MGO' ? 60 : 150;
      onBoard.push([spec.id, code, usage, Math.ceil((reserve - low) / 5) * 5, iso(START)]);
    }
  }
  section('12. Fuel types each vessel burns, and what was on board (ROB) when the data starts',
    'Fuel on board now = opening ROB + deliveries - consumption (view kris.fuel_on_board).');
  add(...valuesInsert('INSERT INTO kris.vessel_fuel_types (vessel_id, fuel_code, usage, opening_rob_t, opening_at)', onBoard,
    'SELECT d.v, d.f, d.u, d.rob, d.at::timestamptz FROM (VALUES %VALUES%) AS d(v, f, u, rob, at)'));

  // --- illustrative carbon prices, first business day of each month ---------------
  const prices = [];
  const pr = prng(77);
  for (let y = 2024; y <= 2026; y++) {
    for (let m = 0; m < 12; m++) {
      const day = Date.UTC(y, m, 2);
      if (day > until) break;
      const t = (y - 2024) * 12 + m;
      prices.push(['EUA', ymd(day), Math.round((64 + 6 * Math.sin(t / 4) + t * 0.35 + (pr() - 0.5) * 4) * 100) / 100, 'EUR', 'TEST data (illustrative, not market prices)']);
      prices.push(['UKA', ymd(day), Math.round((38 + 5 * Math.sin(t / 5 + 1) + t * 0.2 + (pr() - 0.5) * 3) * 100) / 100, 'GBP', 'TEST data (illustrative, not market prices)']);
    }
  }
  section('13. Carbon prices, monthly — illustrative, NOT market data',
    'EUA in EUR (EU ETS), UKA in GBP (UK ETS). Exposure is priced at the latest row.');
  add(...valuesInsert('INSERT INTO kris.carbon_prices (instrument, price_date, price, currency, source)', prices, 'VALUES %VALUES%'));

  section('14. Compliance and commercial records',
    'Quantities and amounts here are read from the views (CII, FuelEU, ETS obligations), so every',
    'figure matches what K.R.1.S reports: CII corrections, FuelEU pooling and banking, allowance',
    'trades, allocations and surrenders, invoices, filings (IMO DCS, EU MRV, FuelEU, CII, SEEMP,',
    'UK ETS) and emails.');
  add(derived(untilDate));

  const positions = `${banner('15. CURRENT POSITIONS — edit here to move a vessel on the map',
    'The map and "where is ..." answers read kris.vessel_positions: each vessel\'s LATEST report.',
    'The values below are where it already is: running this unchanged changes nothing. It can be',
    're-run on its own at any time, once the rest of the data is loaded.',
    'Change lat/lon (decimal degrees: north and east positive) and course (0-359, NULL in port).',
    'Keep a vessel at sea on water. "at sea / at anchor / alongside", the voyage, distance to go',
    'and ETA come from the voyage and port-call rows, not from these coordinates.')}
UPDATE kris.geoform_reports r
   SET latitude = p.lat, longitude = p.lon, course_deg = p.course
  FROM (VALUES
${now.map(({ spec: s, r, where }, i) => `    (${lit(s.id)}, ${r.lat}, ${r.lon}, ${lit(r.course)}::smallint)${i < now.length - 1 ? ',' : ' '}   -- ${s.name}: ${where}`).join('\n')}
  ) AS p(imo, lat, lon, course)
 WHERE r.imo = p.imo
   AND r.report_time = (SELECT max(x.report_time) FROM kris.geoform_reports x WHERE x.imo = p.imo AND x.latitude IS NOT NULL);`;

  const checks = `${banner('CHECKS — what the application will show (run after the script)')}
-- SELECT vessel_name, situation, latitude, longitude, voyage_no, from_port_name, to_port_name, distance_to_go_nm, eta FROM kris.vessel_positions;
-- SELECT * FROM kris.vessel_particulars;
-- SELECT vessel_name, voyage_no, from_port_name, to_port_name, status, departure_at, arrival_at, distance_nm, fuel_t, co2_t FROM kris.voyage_summary ORDER BY departure_at DESC LIMIT 10;
-- SELECT vessel_name, year, distance_nm, co2_t, aer, attained_cii, required_cii, rating, status FROM kris.cii_annual ORDER BY vessel_name, year;
-- SELECT vessel_name, year, fuel_t, hsfo_t, vlsfo_t, mgo_t, lng_t, co2_t, eu_co2_t FROM kris.annual_operations ORDER BY vessel_name, year;
-- SELECT vessel_name, year, ghg_intensity, target_intensity, compliance_balance_t, final_balance_t, penalty_eur, status FROM kris.fueleu_period WHERE period = 'YEAR';
-- SELECT vessel_name, scheme, year, emissions_in_scope_t, allowances_required, allowances_surrendered, status FROM kris.ets_obligations ORDER BY vessel_name, scheme, year;
-- SELECT vessel_name, fuel_code, rob_t FROM kris.fuel_on_board;`;

  // Every table and column this script writes, every relation it reads, and
  // the views the map needs: checked before anything is deleted or inserted.
  const need = new Map();
  const want = (rel, col = null) => need.set(col ? `${rel}.${col}` : rel, [rel, col]);
  ['kris.vessel_positions', 'kris.fuel_on_board'].forEach((rel) => want(rel));
  for (const b of [...sql, positions]) {
    for (const [, rel, cols] of b.matchAll(/INSERT INTO (kris\.\w+) \(([^)]*)\)/g)) {
      want(rel);
      for (const c of cols.split(',')) want(rel, c.trim());
    }
    for (const [, rel] of b.matchAll(/(?:FROM|JOIN|UPDATE) (kris\.\w+)/g)) want(rel);
  }
  const guard = `${banner('0. Schema check — stops here, before anything is changed, if this database',
    'was set up from an older db/001_schema.sql and lacks a table or column used below.',
    'Fix: run db/001_schema.sql (safe to re-run: it keeps your data and adds what is missing).')}
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(n.rel || COALESCE('.' || n.col, ''), ', ' ORDER BY n.rel, n.col) INTO missing
    FROM (VALUES
${[...need.values()].map(([rel, col]) => `      (${lit(rel)}, ${lit(col)})`).join(',\n')}
    ) AS n(rel, col)
   WHERE (n.col IS NULL AND to_regclass(n.rel) IS NULL)
      OR (n.col IS NOT NULL AND to_regclass(n.rel) IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = split_part(n.rel, '.', 1) AND c.table_name = split_part(n.rel, '.', 2)
               AND c.column_name = n.col));
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'This database was set up from an older db/001_schema.sql. Missing: %. Run db/001_schema.sql first (safe to re-run, it keeps your data), then this script.', missing;
  END IF;
END $$;`;
  return { head, guard, body: sql, positions, checks };
}

/**
 * Everything decided from the derived figures: flexibility, allowances,
 * trades, invoices, filings and emails. Pure SQL over the views, so each
 * amount is read from the same numbers K.R.1.S will report.
 */
function derived(until) {
  const U = `DATE '${until}'`;
  return `
-- CII correction entry: ${TV02.name}'s cargo-heating boiler fuel at sea.
INSERT INTO kris.cii_adjustments (vessel_id, year, co2_deduction_t, reason, reference)
SELECT vessel_id, EXTRACT(YEAR FROM report_time)::int, round(SUM(boiler_t * cf_co2), 3),
       'Cargo heating boiler fuel (test example of a correction entry)', 'MEPC.355(78)'
  FROM kris.fuel_emissions
 WHERE vessel_id = '1000021' AND mode = 'sea' AND boiler_t > 0 AND report_time < DATE '2026-01-01'
 GROUP BY 1, 2;

-- FuelEU 2025: ${TV01.name}'s deficit is covered by pooling with ${TV02.name}'s
-- surplus; ${TV02.name} banks half of what is left.
INSERT INTO kris.fueleu_pools (id, year, name, manager_id, verifier_id, status, registered_at)
VALUES ('TEST-POOL-2025', 2025, 'TEST Harbourline FuelEU pool 2025', 'TEST-HLM', 'TEST-VER', 'verified', '2026-04-14 10:00+00');

WITH cb AS (SELECT vessel_id, compliance_balance_g AS g FROM kris.fueleu_period WHERE year = 2025 AND period = 'YEAR'),
     need AS (SELECT ceil(GREATEST(-(SELECT g FROM cb WHERE vessel_id = '1000019'), 0) / 1e6) * 1e6 AS g)
INSERT INTO kris.fueleu_flexibility (vessel_id, year, pool_id, pool_transfer_g, banked_out_g)
SELECT '1000019', 2025, 'TEST-POOL-2025', need.g, 0 FROM need
UNION ALL
SELECT '1000021', 2025, 'TEST-POOL-2025', -need.g, GREATEST(0, floor(((SELECT g FROM cb WHERE vessel_id = '1000021') - need.g) / 2e6) * 1e6) FROM need;

-- Allowance trades: EUAs bought for the 2024 and 2025 obligations, a sale of
-- the 2024 surplus, a cancelled order and UKAs for UK ETS 2026.
WITH req AS (SELECT vessel_id, scheme, year, allowances_required AS n FROM kris.ets_obligations),
     tot AS (SELECT scheme, year, SUM(n) AS n FROM req GROUP BY 1, 2),
     px  AS (SELECT instrument, price_date, price FROM kris.carbon_prices)
INSERT INTO kris.carbon_trades (trade_ref, trade_date, instrument, side, quantity, price, currency, counterparty_id, customer_id, status, settled_at)
SELECT t.ref, t.d, t.instr, t.side, t.qty, t.price, t.cur, t.cp, 'TEST-HLM', t.status, t.settled
  FROM (
    SELECT 'TRD-TEST-2025-0001' AS ref, DATE '2025-03-14' AS d, 'EUA' AS instr, 'buy' AS side,
           (ceil((SELECT n FROM tot WHERE scheme = 'EU_ETS' AND year = 2024) / 500.0) * 500 + 500)::int AS qty,
           (SELECT price FROM px WHERE instrument = 'EUA' AND price_date <= DATE '2025-03-14' ORDER BY price_date DESC LIMIT 1) + 0.42 AS price,
           'EUR' AS cur, 'TEST-ACB' AS cp, 'settled' AS status, DATE '2025-03-18' AS settled
    UNION ALL
    SELECT 'TRD-TEST-2025-0002', DATE '2025-10-02', 'EUA', 'sell', 500,
           (SELECT price FROM px WHERE instrument = 'EUA' AND price_date <= DATE '2025-10-02' ORDER BY price_date DESC LIMIT 1) - 0.18,
           'EUR', 'TEST-NCM', 'settled', DATE '2025-10-06'
    UNION ALL
    SELECT 'TRD-TEST-2026-0003', DATE '2026-02-10', 'EUA', 'buy',
           (ceil((SELECT n FROM req WHERE vessel_id = '1000021' AND scheme = 'EU_ETS' AND year = 2025) / 100.0) * 100
            + ceil((SELECT n FROM req WHERE vessel_id = '1000019' AND scheme = 'EU_ETS' AND year = 2025) * 0.6 / 100.0) * 100)::int,
           (SELECT price FROM px WHERE instrument = 'EUA' AND price_date <= DATE '2026-02-10' ORDER BY price_date DESC LIMIT 1) + 0.35,
           'EUR', 'TEST-NCM', 'settled', DATE '2026-02-13'
    UNION ALL
    SELECT 'TRD-TEST-2026-0004', DATE '2026-05-06', 'EUA', 'buy', 3000,
           (SELECT price FROM px WHERE instrument = 'EUA' AND price_date <= DATE '2026-05-06' ORDER BY price_date DESC LIMIT 1) + 0.25,
           'EUR', 'TEST-ACB', 'cancelled', NULL
    UNION ALL
    SELECT 'TRD-TEST-2026-0005', DATE '2026-09-16', 'EUA', 'buy',
           (ceil((SELECT n FROM req WHERE vessel_id = '1000019' AND scheme = 'EU_ETS' AND year = 2025) * 0.25 / 100.0) * 100)::int,
           (SELECT price FROM px WHERE instrument = 'EUA' AND price_date <= DATE '2026-09-16' ORDER BY price_date DESC LIMIT 1) + 0.30,
           'EUR', 'TEST-ACB', 'executed', NULL
    UNION ALL
    SELECT 'TRD-TEST-2026-0006', DATE '2026-08-20', 'UKA', 'buy', 500,
           (SELECT price FROM px WHERE instrument = 'UKA' AND price_date <= DATE '2026-08-20' ORDER BY price_date DESC LIMIT 1) + 0.20,
           'GBP', 'TEST-ACB', 'settled', DATE '2026-08-24'
  ) t
 WHERE t.d <= ${U};

-- Allocations of those trades to each vessel's obligation.
WITH req AS (SELECT vessel_id, scheme, year, allowances_required AS n FROM kris.ets_obligations),
     trd AS (SELECT id, trade_ref FROM kris.carbon_trades WHERE trade_ref LIKE 'TRD-TEST-%')
INSERT INTO kris.carbon_allocations (allocation_ref, trade_id, vessel_id, scheme, obligation_year, quantity, requested_at, confirmed_at, confirmed_by, transferred_at)
SELECT a.ref, trd.id, a.vessel, a.scheme, a.yr, a.qty, a.req, a.conf, a.by, a.xfer
  FROM (
    SELECT 'ALC-TEST-2025-0001' AS ref, 'TRD-TEST-2025-0001' AS trade, '1000019' AS vessel, 'EU_ETS' AS scheme, 2024 AS yr,
           (SELECT n FROM req WHERE vessel_id = '1000019' AND scheme = 'EU_ETS' AND year = 2024) AS qty,
           TIMESTAMPTZ '2025-03-17 09:00+00' AS req, TIMESTAMPTZ '2025-03-20 14:30+00' AS conf, 'ops@harbourline.example' AS by, TIMESTAMPTZ '2025-04-02 08:00+00' AS xfer
    UNION ALL
    SELECT 'ALC-TEST-2025-0002', 'TRD-TEST-2025-0001', '1000021', 'EU_ETS', 2024,
           (SELECT n FROM req WHERE vessel_id = '1000021' AND scheme = 'EU_ETS' AND year = 2024),
           '2025-03-17 09:05+00', '2025-03-20 14:32+00', 'ops@harbourline.example', '2025-04-02 08:05+00'
    UNION ALL
    SELECT 'ALC-TEST-2026-0003', 'TRD-TEST-2026-0003', '1000021', 'EU_ETS', 2025,
           (SELECT n FROM req WHERE vessel_id = '1000021' AND scheme = 'EU_ETS' AND year = 2025),
           '2026-02-12 10:00+00', '2026-02-16 11:10+00', 'ops@harbourline.example', '2026-03-02 09:00+00'
    UNION ALL
    SELECT 'ALC-TEST-2026-0004', 'TRD-TEST-2026-0003', '1000019', 'EU_ETS', 2025,
           ceil((SELECT n FROM req WHERE vessel_id = '1000019' AND scheme = 'EU_ETS' AND year = 2025) * 0.6 / 100.0)::int * 100,
           '2026-02-12 10:04+00', '2026-02-16 11:14+00', 'ops@harbourline.example', '2026-03-02 09:04+00'
    UNION ALL
    SELECT 'ALC-TEST-2026-0005', 'TRD-TEST-2026-0005', '1000019', 'EU_ETS', 2025,
           ceil((SELECT n FROM req WHERE vessel_id = '1000019' AND scheme = 'EU_ETS' AND year = 2025) * 0.25 / 100.0)::int * 100,
           '2026-09-17 08:30+00', NULL, NULL, NULL
    UNION ALL
    SELECT 'ALC-TEST-2026-0006', 'TRD-TEST-2026-0006', '1000019', 'UK_ETS', 2026,
           LEAST(500, GREATEST(50, ceil(COALESCE((SELECT n FROM req WHERE vessel_id = '1000019' AND scheme = 'UK_ETS' AND year = 2026), 0) / 50.0)::int * 50)),
           '2026-09-05 12:00+00', '2026-09-08 16:20+00', 'carbon@harbourline.example', NULL
  ) a
  JOIN trd ON trd.trade_ref = a.trade
 WHERE a.req::date <= ${U} AND a.qty > 0;

-- Surrenders: 2024 by both vessels; 2025 by ${TV02.name} (${TV01.name} is still short).
INSERT INTO kris.allowance_surrenders (vessel_id, scheme, obligation_year, quantity, surrendered_at, registry_ref)
SELECT o.vessel_id, o.scheme, o.year, o.allowances_required, s.at, s.ref
  FROM kris.ets_obligations o
  JOIN (VALUES ('1000019', 2024, TIMESTAMPTZ '2025-09-12 10:00+00', 'UR-TEST-2025-0912-01'),
               ('1000021', 2024, TIMESTAMPTZ '2025-09-12 10:05+00', 'UR-TEST-2025-0912-02'),
               ('1000021', 2025, TIMESTAMPTZ '2026-09-10 09:30+00', 'UR-TEST-2026-0910-01')) AS s(vessel, yr, at, ref)
    ON s.vessel = o.vessel_id AND s.yr = o.year AND o.scheme = 'EU_ETS'
 WHERE s.at::date <= ${U};

-- Invoices to the customer. Recharge amounts are the allocated quantity at the trade price.
INSERT INTO kris.invoices (invoice_no, customer_id, vessel_id, invoice_type, issue_date, due_date, amount, currency, trade_id, allocation_id, state, paid_at, description)
SELECT i.no, 'TEST-HLM', i.vessel, i.type, i.issued, i.due, COALESCE(i.amount, round(a.quantity * t.price, 2)), i.cur, a.trade_id, a.id, i.state, i.paid, i.descr
  FROM (
    SELECT 'INV-TEST-2025-0001' AS no, '1000019' AS vessel, 'carbon_recharge' AS type, DATE '2025-04-05' AS issued, DATE '2025-05-05' AS due,
           NULL::numeric AS amount, 'EUR' AS cur, 'ALC-TEST-2025-0001' AS alloc, 'paid' AS state, DATE '2025-04-28' AS paid,
           'EU ETS 2024 allowances allocated to ${TV01.name}' AS descr
    UNION ALL SELECT 'INV-TEST-2025-0002', '1000021', 'carbon_recharge', DATE '2025-04-05', DATE '2025-05-05', NULL, 'EUR', 'ALC-TEST-2025-0002', 'paid', DATE '2025-04-30',
           'EU ETS 2024 allowances allocated to ${TV02.name}'
    UNION ALL SELECT 'INV-TEST-2026-0003', '1000021', 'carbon_recharge', DATE '2026-03-05', DATE '2026-04-04', NULL, 'EUR', 'ALC-TEST-2026-0003', 'paid', DATE '2026-03-30',
           'EU ETS 2025 allowances allocated to ${TV02.name}'
    UNION ALL SELECT 'INV-TEST-2026-0004', '1000019', 'fueleu_pooling', DATE '2026-05-04', DATE '2026-06-03',
           round((SELECT pool_transfer_g FROM kris.fueleu_flexibility WHERE vessel_id = '1000019' AND year = 2025) / 1e6 * 185, 2),
           'EUR', NULL, 'paid', DATE '2026-06-11', 'FuelEU 2025 pool contribution received from ${TV02.name} at EUR 185 per tCO2e'
    UNION ALL SELECT 'INV-TEST-2026-0005', '1000019', 'carbon_recharge', DATE '2026-06-25', DATE '2026-07-25', NULL, 'EUR', 'ALC-TEST-2026-0004', 'issued', NULL,
           'EU ETS 2025 allowances allocated to ${TV01.name} (first tranche)'
    UNION ALL SELECT 'INV-TEST-2026-0006', '1000019', 'verification_fee', ${U} - 12, ${U} + 18, 4850, 'EUR', NULL, 'issued', NULL,
           'EU MRV 2025 emissions report verification'
    UNION ALL SELECT 'INV-TEST-2026-0007', '1000021', 'service_fee', DATE '2026-09-01', DATE '2026-10-01', 2400, 'EUR', NULL, 'issued', NULL,
           'Compliance monitoring service, Q3 2026'
    UNION ALL SELECT 'INV-TEST-2026-0008', '1000019', 'carbon_recharge', ${U} - 1, ${U} + 29, NULL, 'GBP', 'ALC-TEST-2026-0006', 'draft', NULL,
           'UK ETS 2026 allowances allocated to ${TV01.name}'
  ) i
  LEFT JOIN kris.carbon_allocations a ON a.allocation_ref = i.alloc
  LEFT JOIN kris.carbon_trades t ON t.id = a.trade_id
 WHERE i.issued <= ${U} AND (i.alloc IS NULL OR a.id IS NOT NULL);

-- Filings: IMO DCS, EU MRV, FuelEU, CII and the SEEMP parts, plus the UK ETS monitoring plan.
INSERT INTO kris.compliance_filings (vessel_id, regime, period_year, document, submission_status, verification_status, due_date,
                                     submitted_at, verified_at, approved_at, next_review_at, verifier_id, reference, notes)
SELECT f.vessel, f.regime, f.yr, f.doc, f.sub, f.ver, f.due, f.submitted, f.verified, f.approved, f.review, f.verifier, f.ref, f.notes
  FROM (VALUES
    ('1000019', 'IMO_DCS', 2023, 'DCS annual report and Statement of Compliance', 'accepted', 'verified', DATE '2024-03-31', TIMESTAMPTZ '2024-02-20 09:00+00', TIMESTAMPTZ '2024-04-18 12:00+00', NULL::date, NULL::date, 'TEST-VER', 'SOC-TEST-TV01-2023', NULL),
    ('1000019', 'IMO_DCS', 2024, 'DCS annual report and Statement of Compliance', 'accepted', 'verified', DATE '2025-03-31', '2025-02-24 09:00+00', '2025-04-22 12:00+00', NULL, NULL, 'TEST-VER', 'SOC-TEST-TV01-2024', NULL),
    ('1000019', 'IMO_DCS', 2025, 'DCS annual report and Statement of Compliance', 'accepted', 'verified', DATE '2026-03-31', '2026-02-26 09:00+00', '2026-04-20 12:00+00', NULL, NULL, 'TEST-VER', 'SOC-TEST-TV01-2025', 'CII rating D for the third year running: corrective action plan required'),
    ('1000021', 'IMO_DCS', 2023, 'DCS annual report and Statement of Compliance', 'accepted', 'verified', DATE '2024-03-31', '2024-02-15 09:00+00', '2024-04-10 12:00+00', NULL, NULL, 'TEST-VER', 'SOC-TEST-TV02-2023', NULL),
    ('1000021', 'IMO_DCS', 2024, 'DCS annual report and Statement of Compliance', 'accepted', 'verified', DATE '2025-03-31', '2025-02-18 09:00+00', '2025-04-14 12:00+00', NULL, NULL, 'TEST-VER', 'SOC-TEST-TV02-2024', NULL),
    ('1000021', 'IMO_DCS', 2025, 'DCS annual report and Statement of Compliance', 'accepted', 'verified', DATE '2026-03-31', '2026-02-19 09:00+00', '2026-04-09 12:00+00', NULL, NULL, 'TEST-VER', 'SOC-TEST-TV02-2025', NULL),
    ('1000019', 'EU_MRV', 2024, 'Verified emissions report', 'accepted', 'verified', DATE '2025-03-31', '2025-03-10 09:00+00', '2025-03-27 12:00+00', NULL, NULL, 'TEST-VER', 'MRV-TEST-TV01-2024', NULL),
    ('1000019', 'EU_MRV', 2025, 'Verified emissions report', 'submitted', 'in_review', DATE '2026-03-31', '2026-03-24 09:00+00', NULL, NULL, NULL, 'TEST-VER', 'MRV-TEST-TV01-2025', 'Verifier query open on a disputed HSFO bunker delivery note (density)'),
    ('1000021', 'EU_MRV', 2024, 'Verified emissions report', 'accepted', 'verified', DATE '2025-03-31', '2025-03-05 09:00+00', '2025-03-21 12:00+00', NULL, NULL, 'TEST-VER', 'MRV-TEST-TV02-2024', NULL),
    ('1000021', 'EU_MRV', 2025, 'Verified emissions report', 'accepted', 'verified', DATE '2026-03-31', '2026-03-03 09:00+00', '2026-03-19 12:00+00', NULL, NULL, 'TEST-VER', 'MRV-TEST-TV02-2025', NULL),
    ('1000019', 'FUELEU', 2025, 'FuelEU report and FuelEU Document of Compliance', 'accepted', 'verified', DATE '2026-06-30', '2026-01-28 09:00+00', '2026-06-05 12:00+00', NULL, NULL, 'TEST-VER', 'FEU-DOC-TEST-TV01-2025', 'Deficit covered by pool TEST-POOL-2025'),
    ('1000021', 'FUELEU', 2025, 'FuelEU report and FuelEU Document of Compliance', 'accepted', 'verified', DATE '2026-06-30', '2026-01-26 09:00+00', '2026-06-03 12:00+00', NULL, NULL, 'TEST-VER', 'FEU-DOC-TEST-TV02-2025', 'Surplus transferred to pool TEST-POOL-2025, remainder banked'),
    ('1000019', 'CII', 2025, 'Attained CII and rating (Statement of Compliance)', 'accepted', 'verified', DATE '2026-05-31', '2026-02-26 09:00+00', '2026-04-20 12:00+00', NULL, NULL, 'TEST-VER', 'SOC-TEST-TV01-2025', NULL),
    ('1000021', 'CII', 2025, 'Attained CII and rating (Statement of Compliance)', 'accepted', 'verified', DATE '2026-05-31', '2026-02-19 09:00+00', '2026-04-09 12:00+00', NULL, NULL, 'TEST-VER', 'SOC-TEST-TV02-2025', NULL),
    ('1000019', 'SEEMP_I', NULL, 'SEEMP Part I: ship energy efficiency management plan', 'accepted', 'not_required', NULL, '2023-01-05 09:00+00', NULL, DATE '2023-01-05', DATE '2027-01-05', NULL, 'SEEMP-I-TEST-TV01', NULL),
    ('1000019', 'SEEMP_II', NULL, 'SEEMP Part II: ship fuel oil consumption data collection plan', 'accepted', 'verified', NULL, '2022-11-20 09:00+00', '2022-12-10 12:00+00', DATE '2022-12-10', DATE '2026-12-10', 'TEST-VER', 'SEEMP-II-TEST-TV01', 'Confirmation of Compliance issued'),
    ('1000019', 'SEEMP_III', NULL, 'SEEMP Part III: CII implementation plan 2023-2025', 'accepted', 'verified', NULL, '2022-12-15 09:00+00', '2023-01-20 12:00+00', DATE '2023-01-20', DATE '2026-01-01', 'TEST-VER', 'SEEMP-III-TEST-TV01-2023', NULL),
    ('1000019', 'SEEMP_III', 2026, 'SEEMP Part III revision: corrective action plan for D rating', 'in_preparation', 'pending', DATE '2026-10-31', NULL, NULL, NULL, NULL, 'TEST-VER', 'SEEMP-III-TEST-TV01-CAP', 'Measures under review: hull cleaning, propeller polish, weather routing, just-in-time arrival'),
    ('1000021', 'SEEMP_I', NULL, 'SEEMP Part I: ship energy efficiency management plan', 'accepted', 'not_required', NULL, '2022-06-01 09:00+00', NULL, DATE '2022-06-01', DATE '2027-06-01', NULL, 'SEEMP-I-TEST-TV02', NULL),
    ('1000021', 'SEEMP_II', NULL, 'SEEMP Part II: ship fuel oil consumption data collection plan', 'accepted', 'verified', NULL, '2022-05-20 09:00+00', '2022-06-08 12:00+00', DATE '2022-06-08', DATE '2027-06-08', 'TEST-VER', 'SEEMP-II-TEST-TV02', 'Confirmation of Compliance issued'),
    ('1000021', 'SEEMP_III', NULL, 'SEEMP Part III: CII implementation plan 2023-2025', 'accepted', 'verified', NULL, '2022-12-12 09:00+00', '2023-01-16 12:00+00', DATE '2023-01-16', DATE '2026-01-01', 'TEST-VER', 'SEEMP-III-TEST-TV02-2023', NULL),
    ('1000019', 'UK_ETS', 2026, 'UK ETS maritime emissions monitoring plan', 'accepted', 'verified', DATE '2026-06-30', '2026-05-12 09:00+00', '2026-06-19 12:00+00', DATE '2026-06-19', DATE '2027-06-19', 'TEST-VER', 'UKETS-MP-TEST-TV01', NULL)
  ) AS f(vessel, regime, yr, doc, sub, ver, due, submitted, verified, approved, review, verifier, ref, notes)
 WHERE COALESCE(f.submitted::date, f.due, ${U}) <= ${U} OR f.sub IN ('not_started', 'in_preparation');

-- Emails. Figures quoted in a body are read from the tables they describe.
INSERT INTO kris.communications (message_id, thread_id, direction, sent_at, from_address, to_addresses, subject, body, category, priority, status,
                                 vessel_id, customer_id, voyage_id, bdn_id, invoice_id, trade_id, allocation_id, filing_id, attachments)
SELECT m.mid, m.thread, m.dir, m.at, m.sender, m.rcpt, m.subject, m.body, m.cat, m.prio, m.status,
       m.vessel, 'TEST-HLM', m.voyage_id, m.bdn_id, m.invoice_id, m.trade_id, m.allocation_id, m.filing_id, m.att::jsonb
  FROM (
    -- 1. BDN request for the delivery still missing its note
    SELECT '<bdn-req-1@harbourline.example>' AS mid, 'T-BDN-1' AS thread, 'outbound' AS dir, b.delivered_at + INTERVAL '2 days' AS at,
           'bunkers@harbourline.example' AS sender, ARRAY['operations@' || s.email_domain] AS rcpt,
           format('BDN copy requested: %s, %s, %s', vs.name, b.fuel_code, b.bdn_no) AS subject,
           format(E'Hello,\\n\\nPlease send the signed bunker delivery note and the sealed sample receipt for %s t of %s delivered to %s at %s on %s (our ref %s).\\nWe need it for the monthly fuel reconciliation.\\n\\nRegards,\\nBunker desk, TEST Harbourline',
                  b.quantity_t, b.fuel_code, vs.name, p.name, to_char(b.delivered_at, 'DD Mon YYYY'), b.bdn_no) AS body,
           'bdn_request' AS cat, 'normal' AS prio, 'awaiting_reply' AS status,
           b.vessel_id AS vessel, b.voyage_id, b.id AS bdn_id, NULL::bigint AS invoice_id, NULL::bigint AS trade_id, NULL::bigint AS allocation_id, NULL::bigint AS filing_id,
           '[]' AS att
      FROM kris.bunker_deliveries b JOIN kris.vessels vs ON vs.id = b.vessel_id JOIN kris.companies s ON s.id = b.supplier_id JOIN kris.ports p ON p.locode = b.locode
     WHERE b.status = 'requested' AND vs.is_test
    UNION ALL
    -- 2. BDN received for ${TV02.name}'s latest LNG delivery
    SELECT '<bdn-rcv-1@gulf-lng.example>', 'T-BDN-2', 'inbound', b.received_at,
           'operations@' || s.email_domain, ARRAY['bunkers@harbourline.example'],
           format('BDN %s: %s %s t delivered to %s', b.bdn_no, b.fuel_code, b.quantity_t, vs.name),
           format(E'Dear team,\\n\\nAttached is BDN %s for %s t of %s delivered to %s at %s on %s. Density %s kg/m3, sulphur %s%%.\\n\\nBest regards,\\n%s',
                  b.bdn_no, b.quantity_t, b.fuel_code, vs.name, p.name, to_char(b.delivered_at, 'DD Mon YYYY'), b.density_kg_m3, b.sulphur_pct, s.name),
           'bdn_received', 'normal', 'resolved', b.vessel_id, b.voyage_id, b.id, NULL, NULL, NULL, NULL,
           jsonb_build_array(jsonb_build_object('name', b.bdn_no || '.pdf', 'type', 'application/pdf', 'bytes', 184320))::text
      FROM (SELECT * FROM kris.bunker_deliveries WHERE vessel_id = '1000021' AND fuel_code = 'LNG' AND received_at IS NOT NULL ORDER BY delivered_at DESC LIMIT 1) b
      JOIN kris.vessels vs ON vs.id = b.vessel_id JOIN kris.companies s ON s.id = b.supplier_id JOIN kris.ports p ON p.locode = b.locode
    UNION ALL
    -- 3. Latest report from ${TV01.name}'s master
    SELECT '<report-sn-star@vessel.harbourline.example>', 'T-RPT-1', 'inbound', r.report_time + INTERVAL '40 minutes',
           'master.sn-star@vessel.harbourline.example', ARRAY['operations@harbourline.example'],
           format('%s %s report %s, voyage %s', vs.name, initcap(r.form_type), to_char(r.report_time, 'DD Mon YYYY HH24:MI "UTC"'), v.voyage_no),
           format(E'%s report, voyage %s %s to %s.\\nPosition %s %s, course %s, wind Bf %s.\\nLast %s h: %s nm at %s kn average.\\nME %s t, AE %s t, boiler %s t (total %s t), CO2 %s t.\\n\\nMaster, %s',
                  initcap(r.form_type), v.voyage_no, v.from_port, v.to_port, r.latitude, r.longitude, r.course_deg, r.wind_force_bft,
                  round(r.hours_underway::numeric, 1), round(r.distance_nm::numeric, 1), round(r.speed_kn::numeric, 1),
                  r.me_fuel_mt, r.ae_fuel_mt, r.boiler_fuel_mt, r.fuel_consumed_mt, r.co2_mt, vs.name),
           'vessel_report', 'low', 'resolved', r.imo, r.voyage_id, NULL, NULL, NULL, NULL, NULL, '[]'
      FROM (SELECT * FROM kris.geoform_reports WHERE imo = '1000019' AND mode = 'sea' ORDER BY report_time DESC LIMIT 1) r
      JOIN kris.vessels vs ON vs.id = r.imo JOIN kris.voyages v ON v.id = r.voyage_id
    UNION ALL
    -- 4. Allocation request for ${TV01.name}'s second 2025 tranche
    SELECT '<alloc-req-1@harbourline.example>', 'T-ALC-1', 'inbound', a.requested_at,
           'fleet.finance@harbourline.example', ARRAY['carbon@harbourline.example'],
           format('Allocation request: %s EUAs to %s for EU ETS %s', a.quantity, vs.name, a.obligation_year),
           format(E'Hi carbon desk,\\n\\nPlease allocate %s EUAs from trade %s to %s for its EU ETS %s obligation (our ref %s). The surrender deadline is %s.\\n\\nThanks,\\nFleet finance',
                  a.quantity, t.trade_ref, vs.name, a.obligation_year, a.allocation_ref, to_char(y.surrender_deadline, 'DD Mon YYYY')),
           'allocation_request', 'high', 'open', a.vessel_id, NULL, NULL, NULL, t.id, a.id, NULL, '[]'
      FROM kris.carbon_allocations a JOIN kris.carbon_trades t ON t.id = a.trade_id JOIN kris.vessels vs ON vs.id = a.vessel_id
      JOIN kris.ets_years y ON y.scheme = a.scheme AND y.year = a.obligation_year
     WHERE a.allocation_ref = 'ALC-TEST-2026-0005'
    UNION ALL
    -- 5. Allocation confirmation for the UKAs
    SELECT '<alloc-conf-1@harbourline.example>', 'T-ALC-2', 'outbound', a.confirmed_at,
           'carbon@harbourline.example', ARRAY['fleet.finance@harbourline.example'],
           format('Confirmed: %s %s allocated to %s (%s)', a.quantity, t.instrument, vs.name, a.allocation_ref),
           format(E'Confirmed. %s %s from trade %s (%s at %s %s) are allocated to %s for UK ETS %s. Registry transfer to follow.\\n\\nCarbon desk',
                  a.quantity, t.instrument, t.trade_ref, t.quantity, t.price, t.currency, vs.name, a.obligation_year),
           'allocation_confirmation', 'normal', 'resolved', a.vessel_id, NULL, NULL, NULL, t.id, a.id, NULL, '[]'
      FROM kris.carbon_allocations a JOIN kris.carbon_trades t ON t.id = a.trade_id JOIN kris.vessels vs ON vs.id = a.vessel_id
     WHERE a.allocation_ref = 'ALC-TEST-2026-0006' AND a.confirmed_at IS NOT NULL
    UNION ALL
    -- 6. Customer query about a voyage's consumption
    SELECT '<cust-q-1@meridian-chartering.example>', 'T-CUST-1', 'inbound', ((${U} - 3 + TIME '08:15') AT TIME ZONE 'UTC'),
           'performance@meridian-chartering.example', ARRAY['operations@harbourline.example'],
           format('%s voyage %s: consumption question', vs.vessel_name, vs.voyage_no),
           format(E'Hello,\\n\\nOn voyage %s (%s to %s) %s burned %s t over %s days at sea. Can you explain the port consumption of %s t at %s? Waiting time at anchorage?\\n\\nRegards,\\nPerformance team, TEST Meridian Chartering',
                  vs.voyage_no, vs.from_port_name, vs.to_port_name, vs.vessel_name, vs.fuel_at_sea_t, vs.sea_days, vs.fuel_in_port_t, vs.to_port_name),
           'customer_query', 'normal', 'open', vs.vessel_id, vs.voyage_id, NULL, NULL, NULL, NULL, NULL, '[]'
      FROM (SELECT * FROM kris.voyage_summary WHERE vessel_id = '1000019' AND status = 'completed' ORDER BY departure_at DESC LIMIT 1) vs
    UNION ALL
    -- 7. FuelEU query
    SELECT '<fueleu-q-1@harbourline.example>', 'T-FEU-1', 'inbound', ((${U} - 9 + TIME '10:00') AT TIME ZONE 'UTC'),
           'technical@harbourline.example', ARRAY['compliance@harbourline.example'],
           format('FuelEU %s position for %s', f.year, f.vessel_name),
           format(E'Team,\\n\\n%s shows a FuelEU balance of %s tCO2e for %s so far (GHG intensity %s against a target of %s gCO2e/MJ). Do we plan to pool with %s again, as in 2025?\\n\\nTechnical',
                  f.vessel_name, f.compliance_balance_t, f.year, f.ghg_intensity, f.target_intensity, (SELECT name FROM kris.vessels WHERE id = '1000021')),
           'fueleu_query', 'normal', 'awaiting_reply', f.vessel_id, NULL, NULL, NULL, NULL, NULL, NULL, '[]'
      FROM kris.fueleu_period f WHERE f.vessel_id = '1000019' AND f.period = 'YEAR' AND f.year = EXTRACT(YEAR FROM ${U})::int
    UNION ALL
    -- 8. EU MRV verifier query on the disputed BDN
    SELECT '<mrv-q-1@verification.example>', 'T-MRV-1', 'inbound', TIMESTAMPTZ '2026-04-02 13:20+00',
           'mrv@verification.example', ARRAY['compliance@harbourline.example'],
           format('EU MRV %s: query on %s for %s', c.period_year, b.bdn_no, vs.name),
           format(E'Dear compliance team,\\n\\nWhile verifying the %s EU MRV emissions report for %s (ref %s) we found that BDN %s states a density of %s kg/m3, which does not match the supplier''s sample analysis. Please provide the lab report or a corrected BDN before we can complete verification.\\n\\nTEST Verification Services',
                  c.period_year, vs.name, c.reference, b.bdn_no, b.density_kg_m3),
           'eu_mrv_query', 'high', 'awaiting_reply', c.vessel_id, NULL, b.id, NULL, NULL, NULL, c.id, '[]'
      FROM kris.compliance_filings c JOIN kris.vessels vs ON vs.id = c.vessel_id
      JOIN kris.bunker_deliveries b ON b.vessel_id = c.vessel_id AND b.status = 'disputed'
     WHERE c.vessel_id = '1000019' AND c.regime = 'EU_MRV' AND c.period_year = 2025
    UNION ALL
    -- 9. IMO DCS Statement of Compliance
    SELECT '<dcs-1@verification.example>', 'T-DCS-1', 'inbound', c.verified_at,
           'dcs@verification.example', ARRAY['compliance@harbourline.example'],
           format('IMO DCS %s: Statement of Compliance issued for %s', c.period_year, vs.name),
           format(E'The %s IMO DCS data for %s has been verified and Statement of Compliance %s issued. Reported: %s t of fuel, %s nm, %s hours underway, attained CII %s (rating %s).',
                  c.period_year, vs.name, c.reference, ao.fuel_t, ao.distance_nm, ao.hours_underway, ci.attained_cii, ci.rating),
           'imo_dcs_query', 'normal', 'resolved', c.vessel_id, NULL, NULL, NULL, NULL, NULL, c.id,
           jsonb_build_array(jsonb_build_object('name', c.reference || '.pdf', 'type', 'application/pdf', 'bytes', 96256))::text
      FROM kris.compliance_filings c JOIN kris.vessels vs ON vs.id = c.vessel_id
      JOIN kris.annual_operations ao ON ao.vessel_id = c.vessel_id AND ao.year = c.period_year
      JOIN kris.cii_annual ci ON ci.vessel_id = c.vessel_id AND ci.year = c.period_year
     WHERE c.vessel_id = '1000021' AND c.regime = 'IMO_DCS' AND c.period_year = 2025
    UNION ALL
    -- 10. UK ETS question about the domestic leg
    SELECT '<uka-q-1@harbourline.example>', 'T-UKA-1', 'inbound', ((${U} - 6 + TIME '09:40') AT TIME ZONE 'UTC'),
           'fleet.finance@harbourline.example', ARRAY['carbon@harbourline.example'],
           format('UK ETS: does %s voyage %s (%s to %s) count?', vs.vessel_name, vs.voyage_no, vs.from_port_name, vs.to_port_name),
           format(E'Hi,\\n\\n%s ran %s to %s (voyage %s, %s nm). As a UK domestic voyage after 1 July 2026 it should fall under UK ETS. How many UKAs do we need for 2026 so far, and is the allocation enough?\\n\\nFleet finance',
                  vs.vessel_name, vs.from_port_name, vs.to_port_name, vs.voyage_no, vs.distance_nm),
           'uka_query', 'normal', 'open', vs.vessel_id, vs.voyage_id, NULL, NULL, NULL, NULL, NULL, '[]'
      FROM (SELECT * FROM kris.voyage_summary WHERE vessel_id = '1000019' AND from_port = 'GBIMM' AND to_port = 'GBTEE'
              AND departure_at >= DATE '2026-07-01' ORDER BY departure_at DESC LIMIT 1) vs
    UNION ALL
    -- 11. Invoice query on the overdue recharge
    SELECT '<inv-q-1@harbourline.example>', 'T-INV-1', 'outbound', ((${U} - 2 + TIME '11:05') AT TIME ZONE 'UTC'),
           'accounts@harbourline.example', ARRAY['fleet.finance@harbourline.example'],
           format('Payment reminder: %s (%s %s), due %s', i.invoice_no, i.currency, i.amount, to_char(i.due_date, 'DD Mon YYYY')),
           format(E'Hello,\\n\\nInvoice %s for %s %s (%s) was due on %s and is still open. Could you confirm the payment date?\\n\\nAccounts',
                  i.invoice_no, i.currency, i.amount, i.description, to_char(i.due_date, 'DD Mon YYYY')),
           'invoice_query', 'high', 'awaiting_reply', i.vessel_id, NULL, NULL, i.id, i.trade_id, i.allocation_id, NULL, '[]'
      FROM kris.invoices i WHERE i.invoice_no = 'INV-TEST-2026-0005'
    UNION ALL
    -- 12. Trade confirmation from the broker
    SELECT '<trade-conf-1@alpine-carbon.example>', 'T-TRD-1', 'inbound', (t.trade_date + TIME '16:45') AT TIME ZONE 'UTC',
           'desk@alpine-carbon.example', ARRAY['carbon@harbourline.example'],
           format('Trade confirmation %s: %s %s %s at %s %s', t.trade_ref, initcap(t.side), t.quantity, t.instrument, t.price, t.currency),
           format(E'We confirm: %s %s %s at %s %s, trade date %s, status %s. Settlement DVP to your registry account.\\n\\nTEST Alpine Carbon Brokers',
                  initcap(t.side), t.quantity, t.instrument, t.price, t.currency, to_char(t.trade_date, 'DD Mon YYYY'), t.status),
           'carbon_trading', 'normal', 'resolved', a.vessel_id, NULL, NULL, NULL, t.id, a.id, NULL,
           jsonb_build_array(jsonb_build_object('name', t.trade_ref || '-confirmation.pdf', 'type', 'application/pdf', 'bytes', 51200))::text
      FROM kris.carbon_trades t JOIN kris.carbon_allocations a ON a.trade_id = t.id
     WHERE t.trade_ref = 'TRD-TEST-2026-0005'
  ) m
 WHERE m.at <= ${U} + 1;
`;
}

module.exports = { buildSql, buildParts };
