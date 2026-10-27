import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { parseYrtAlerts } from './yrt-alerts.js';
import { Traffic } from './traffic.js';
import { AGENCIES, pfx, vehicleType, vehicleModel } from './agencies.js';

const POLL_MS = 15000;
const traffic = new Traffic(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'data'), path.join(path.dirname(fileURLToPath(import.meta.url)), 'traffic-state.json'));
setInterval(() => traffic.save(), 5 * 60000); process.on('SIGINT', () => { traffic.save(); process.exit(0); }); process.on('SIGTERM', () => { traffic.save(); process.exit(0); });
const PORT = process.env.PORT || 3000;
const here = path.dirname(fileURLToPath(import.meta.url));
const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

// Each agency has its own state and its own polling loops, so one slow or broken feed never blocks another.
const state = Object.fromEntries(AGENCIES.map(a => [a.id, {
  vehicles: [], delays: new Map(), alerts: [], updated: null, error: a.vehicles ? null : 'no real-time URL configured',
}]));

// GTFS-RT arrives as protobuf from TTC and YRT. GO's API can answer with JSON instead, so the body is sniffed: JSON is
// converted (snake_case or camelCase keys both work), anything else that is not protobuf is reported with its first characters.
const camel = k => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const camelKeys = o => Array.isArray(o) ? o.map(camelKeys) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [camel(k), camelKeys(v)])) : o;
async function getFeed(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { accept: 'application/x-protobuf, application/octet-stream;q=0.9, */*;q=0.5' } });
  const buf = new Uint8Array(await res.arrayBuffer());
  const ct = res.headers.get('content-type'), plain = n => Buffer.from(buf.slice(0, n)).toString('utf8').replace(/[^\x20-\x7e]+/g, ' ').trim();
  const where = url.split('?')[0];                                              // never log the query string: it can hold an API key
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${where}${buf.length ? ' - ' + plain(200) : ''}`);
  const head = String.fromCharCode(buf[0] ?? 0);
  if (head === '{' || head === '[') {                                           // JSON instead of protobuf
    const j = JSON.parse(Buffer.from(buf).toString('utf8'));
    return FeedMessage.fromObject(camelKeys(j.Entity || j.entity ? j : j.feed ?? j));
  }
  if (head === '<') throw new Error(`not protobuf (${ct}) from ${where}: ${plain(160)}`);   // XML / HTML error page
  try { return FeedMessage.decode(buf); }
  catch (e) { throw new Error(`${e.message} (${buf.length} bytes, ${ct}, starts ${Buffer.from(buf.slice(0, 12)).toString('hex')}) from ${where}`); }
}

// Optional: failure or slowness just means no delay colours for that agency.
async function pollDelays(a) {
  if (!a.trips) return;
  try {
    const feed = await getFeed(a.trips);
    const next = new Map();
    for (const e of feed.entity) {
      const tu = e.tripUpdate;
      const id = pfx(a.id, tu?.trip?.tripId);
      if (!id) continue;
      const st = tu.stopTimeUpdate?.[0];
      const ev = st?.arrival ?? st?.departure;
      if (ev && Object.hasOwn(ev, 'delay')) next.set(id, Number(ev.delay));
      else if (Object.hasOwn(tu, 'delay')) next.set(id, Number(tu.delay));
    }
    state[a.id].delays = next;
  } catch (err) {
    console.error(`[${a.id}] trip updates failed:`, err.message);
  }
}

// Service alerts (route changes, detours...). Optional, like delays: a failure only means no alert banners.
const text = ts => {
  const t = ts?.translation ?? [];
  return (t.find(x => /^en/i.test(x.language ?? '')) ?? t[0])?.text ?? '';
};
const EFFECT = { 1: 'No service', 2: 'Reduced service', 3: 'Significant delays', 4: 'Detour', 5: 'Additional service',
                 6: 'Modified service', 7: 'Other effect', 8: 'Unknown effect', 9: 'Stop moved', 10: 'No effect', 11: 'Accessibility issue' };
const CAUSE = { 1: 'Unknown', 2: 'Other', 3: 'Technical problem', 4: 'Strike', 5: 'Demonstration', 6: 'Accident', 7: 'Holiday',
                8: 'Weather', 9: 'Maintenance', 10: 'Construction', 11: 'Police activity', 12: 'Medical emergency' };
async function pollAlerts(a) {
  if (!a.alerts && a.alertsPage) {                       // scraped HTML page (YRT)
    try {
      const r = await fetch(a.alertsPage, { headers: { 'user-agent': 'Mozilla/5.0 (ttc-tracker)', accept: 'text/html' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      state[a.id].alerts = parseYrtAlerts(await r.text(), a.alertsPage);
      console.log(`[${a.id}] ${state[a.id].alerts.length} alerts (scraped)`);
    } catch (err) { console.error(`[${a.id}] alerts page failed:`, err.message); }
    return;
  }
  if (!a.alerts) return;
  try {
    const feed = await getFeed(a.alerts);
    const alerts = [];
    for (const e of feed.entity) {
      const al = e.alert;
      if (!al) continue;
      const routes = [...new Set((al.informedEntity ?? []).map(x => pfx(a.id, x.routeId)).filter(Boolean))];
      const per = (al.activePeriod ?? []).map(p => [Number(p.start) || null, Number(p.end) || null]);
      alerts.push({
        id: pfx(a.id, e.id), agency: a.id, routes,
        header: text(al.headerText), description: text(al.descriptionText), url: text(al.url) || null,
        effect: EFFECT[al.effect] ?? null, cause: al.cause && al.cause !== 1 ? CAUSE[al.cause] ?? null : null,
        periods: per,
      });
    }
    state[a.id].alerts = alerts;
    console.log(`[${a.id}] ${alerts.length} alerts`);
  } catch (err) {
    console.error(`[${a.id}] alerts failed:`, err.message);
  }
}

async function pollVehicles(a) {
  if (!a.vehicles) return;
  const st = state[a.id];
  try {
    let feed, lastErr;
    for (const u of [].concat(a.vehicles)) { try { feed = await getFeed(u); break; } catch (e) { lastErr = e; } }   // first URL that works
    if (!feed) throw lastErr;
    const vehicles = [];
    for (const e of feed.entity) {
      const v = e.vehicle;
      if (!v?.position) continue;
      vehicles.push({
        agency: a.id,
        id: pfx(a.id, v.vehicle?.id || v.vehicle?.label || e.id),
        type: vehicleType(a.id, v.vehicle?.id) ?? vehicleType(a.id, v.vehicle?.label), // 'streetcar' | 'bus' | null, from the fleet number
        model: vehicleModel(a.id, v.vehicle?.id) ?? vehicleModel(a.id, v.vehicle?.label),
        route: pfx(a.id, v.trip?.routeId),
        trip: pfx(a.id, v.trip?.tripId),
        lat: v.position.latitude,
        lon: v.position.longitude,
        bearing: Object.hasOwn(v.position, 'bearing') ? v.position.bearing : null,
        speed: Object.hasOwn(v.position, 'speed') ? v.position.speed : null,
        occ: Object.hasOwn(v, 'occupancyStatus') ? v.occupancyStatus : null,
        ts: Number(v.timestamp) || null,
      });
    }
    st.vehicles = vehicles; st.updated = Date.now(); st.error = null;
    const used = traffic.observe(vehicles);
    const n = { streetcar: 0, bus: 0, unknown: 0 };
    for (const v of vehicles) n[v.type ?? 'unknown']++;
    console.log(`[${a.id}] polled ${vehicles.length} vehicles (${n.streetcar} streetcars, ${n.bus} buses, ${n.unknown} unknown type), ${st.delays.size} delay records`);
  } catch (err) {
    st.error = err.message; // keep this agency's last good vehicles
    console.error(`[${a.id}] vehicle poll failed:`, err.message);
  }
}

for (const a of AGENCIES) {
  pollVehicles(a); pollDelays(a); pollAlerts(a);
  setInterval(() => pollVehicles(a), POLL_MS);
  setInterval(() => pollDelays(a), POLL_MS);
  setInterval(() => pollAlerts(a), 60000);
}

const app = express();
app.use(express.static(path.join(here, 'public')));
app.get('/api/vehicles', (_req, res) => {
  const vehicles = [], agencies = {};
  let updated = null;
  for (const a of AGENCIES) {
    const st = state[a.id];
    for (const v of st.vehicles) vehicles.push({ ...v, delay: v.trip && st.delays.has(v.trip) ? st.delays.get(v.trip) : null });
    agencies[a.id] = { count: st.vehicles.length, updated: st.updated, error: st.error };
    if (st.updated && (!updated || st.updated > updated)) updated = st.updated;
  }
  const errors = Object.entries(agencies).filter(([, s]) => s.error).map(([k, s]) => `${k}: ${s.error}`);
  res.json({ updated, vehicles, agencies, error: errors.length ? errors.join(' | ') : null });
});
app.get('/api/traffic', (_req, res) => res.json(traffic.geojson()));
app.get('/api/alerts', (_req, res) => res.json({ alerts: AGENCIES.flatMap(a => state[a.id].alerts) }));
app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
