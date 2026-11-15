// GO "Service at a Glance" -> the same vehicle objects the GTFS-RT feeds produce. Used when GO's vehicle-position feed is not
// available for the API key: this endpoint lists every in-service train with latitude/longitude, heading, delay and consist length.
import { pfx } from './agencies.js';

// "2026-10-28 18:03:20" is Toronto local time -> epoch seconds
export function torontoEpoch(s) {
  const m = /(\d+)-(\d+)-(\d+)[ T](\d+):(\d+):(\d+)/.exec(s ?? '');
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(asUtc));
  const g = t => +parts.find(p => p.type === t).value;
  const offset = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - asUtc;   // negative: Toronto is behind UTC
  return Math.round((asUtc - offset) / 1000);
}

// kind: 'train' or 'bus'. Both endpoints list in-service trips with the same fields (Latitude, Longitude, Course, DelaySeconds, ...).
export function glanceVehicles(agencyId, json, kind) {
  const trips = json?.Trips?.Trip ?? json?.trips?.trip ?? [];
  return (Array.isArray(trips) ? trips : [trips]).filter(t => t && t.Latitude != null && t.Longitude != null && Number.isFinite(Number(t.Latitude)) && Number.isFinite(Number(t.Longitude))).map(t => ({
    agency: agencyId,
    id: pfx(agencyId, (kind === 'bus' ? 'B' : 'T') + String(t.TripNumber).trim()),
    type: kind,
    model: kind === 'bus' ? `GO Transit bus${t.BusType ? ' · ' + t.BusType : ''}` : `GO Transit train${t.Cars ? ' · ' + t.Cars + ' cars' : ''}`,
    route: pfx(agencyId, String(t.LineCode ?? t.RouteNumber ?? '').trim()),
    trip: null,
    lat: Number(t.Latitude), lon: Number(t.Longitude),
    bearing: t.IsInMotion || Number(t.Course) > 0 ? Number(t.Course) : null,   // a stopped vehicle may report course 0: keep its last heading instead
    speed: t.IsInMotion === false ? 0 : null,                                   // otherwise worked out from consecutive positions (see server.js)
    speedEst: true,
    occ: null,
    ts: torontoEpoch(t.ModifiedDate),
    delay: Number.isFinite(Number(t.DelaySeconds)) ? Number(t.DelaySeconds) : null,
    dest: String(t.Display ?? '').replace(/^\s*[\w ]+?\s*-\s*/, '') || null,
    atStation: t.AtStationCode || null,
  }));
}
export const glanceTrains = (agencyId, json) => glanceVehicles(agencyId, json, 'train');
