import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const VEHICLES_FEED = 'https://bustime.ttc.ca/gtfsrt/vehicles';
const TRIPS_FEED = 'https://bustime.ttc.ca/gtfsrt/trips';
const POLL_MS = 15000;
const PORT = process.env.PORT || 3000;
const here = path.dirname(fileURLToPath(import.meta.url));
const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

let snapshot = { updated: null, vehicles: [] };

async function getFeed(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
}

// trip_id -> delay in seconds (from the next predicted stop). Optional: failure just means no delay colours.
async function getDelays() {
  const delays = new Map();
  try {
    const feed = await getFeed(TRIPS_FEED);
    for (const e of feed.entity) {
      const tu = e.tripUpdate;
      const id = tu?.trip?.tripId;
      if (!id) continue;
      const st = tu.stopTimeUpdate?.[0];
      const ev = st?.arrival ?? st?.departure;
      if (ev && Object.hasOwn(ev, 'delay')) delays.set(id, Number(ev.delay));
      else if (Object.hasOwn(tu, 'delay')) delays.set(id, Number(tu.delay));
    }
  } catch (err) {
    console.error('trip updates failed:', err.message);
  }
  return delays;
}

async function poll() {
  try {
    const [feed, delays] = await Promise.all([getFeed(VEHICLES_FEED), getDelays()]);
    const vehicles = [];
    for (const e of feed.entity) {
      const v = e.vehicle;
      if (!v?.position) continue;
      const trip = v.trip?.tripId || null;
      vehicles.push({
        id: v.vehicle?.id || e.id,
        route: v.trip?.routeId || null,
        trip,
        lat: v.position.latitude,
        lon: v.position.longitude,
        bearing: v.position.bearing ?? 0,
        speed: v.position.speed ?? null,
        occ: Object.hasOwn(v, 'occupancyStatus') ? v.occupancyStatus : null,
        delay: trip && delays.has(trip) ? delays.get(trip) : null,
        ts: Number(v.timestamp) || null,
      });
    }
    snapshot = { updated: Date.now(), vehicles };
    console.log(`polled ${vehicles.length} vehicles, ${delays.size} delay records`);
  } catch (err) {
    console.error('poll failed:', err.message); // keep serving last good snapshot
  }
}

poll();
setInterval(poll, POLL_MS);

const app = express();
app.use(express.static(path.join(here, 'public')));
app.get('/api/vehicles', (_req, res) => res.json(snapshot));
app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
