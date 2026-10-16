// Builds public/data/{routes.json,shapes.geojson,stops.geojson} and one small public/data/route/<AGENCY>_<route>.json per route
// (the stopping patterns of that route, in direction of travel) from every agency's static GTFS.
// All route ids are prefixed ("TTC:504", "YRT:52"); every shape and stop carries an agency tag "a".
//
// Usage: npm run build-data                         downloads each agency's static GTFS
//        node build-data.js TTC=ttc.zip YRT=yrt.zip use zips you already downloaded (any subset)
//        node build-data.js --allow-partial         write whatever succeeded even if one agency fails
import fs from 'node:fs';
import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';
import { parse as parseStream } from 'csv-parse';
import { Readable } from 'node:stream';
import { AGENCIES, pfx } from './agencies.js';

const args = process.argv.slice(2);
const allowPartial = args.includes('--allow-partial');
const local = Object.fromEntries(args.filter(a => a.includes('=')).map(a => a.split(/=(.*)/s).slice(0, 2)));
const r5 = n => Math.round(Number(n) * 1e5) / 1e5;
const hex = c => (/^#?[0-9a-f]{6}$/i.test(String(c ?? '').trim()) ? '#' + String(c).trim().replace('#', '').toLowerCase() : null); // GTFS route_color -> '#rrggbb' or null
const norm = s => String(s).toLowerCase().replace(/^0+(?=\d)/, ''); // "001" -> "1"

async function loadZip(a) {
  if (local[a.id]) return new AdmZip(local[a.id]);
  let url = a.staticZip;
  if (!url && a.staticCkan) {
    const pkg = await (await fetch(a.staticCkan, { signal: AbortSignal.timeout(60000) })).json();
    const res = pkg.result.resources.find(r => /zip/i.test(r.format) || /\.zip/i.test(r.url));
    if (!res) throw new Error('No zip resource found on the dataset page');
    url = res.url;
  }
  console.log(`[${a.id}] downloading ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return new AdmZip(Buffer.from(await res.arrayBuffer()));
}

// stop_times.txt is huge (millions of rows for TTC), so it is streamed row by row instead of parsed in one go.
async function eachRow(zip, name, fn) {
  const buf = zip.readFile(name);
  if (!buf) return false;
  const parser = Readable.from([buf]).pipe(parseStream({ columns: true, skip_empty_lines: true, bom: true, relax_column_count: true }));
  for await (const r of parser) fn(r);
  return true;
}
const secs = t => { const m = /^\s*(\d+):(\d+):(\d+)/.exec(t ?? ''); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null; };
const km = (a, b) => { // equirectangular distance in km (accurate enough at city scale)
  const kx = 111.32 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180), ky = 110.57;
  return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * ky);
};
// distance along `line` (km) of the point nearest to `p`, searching forward from segment `from` so loops don't confuse the order
function along(line, cum, p, from) {
  let best = Infinity, bd = 0, bi = from;
  for (let i = from; i < line.length - 1; i++) {
    const A = line[i], B = line[i + 1], dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
    const u = L2 ? Math.max(0, Math.min(1, ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L2)) : 0;
    const q = [A[0] + u * dx, A[1] + u * dy], d = km(p, q);
    if (d < best) { best = d; bd = cum[i] + u * (cum[i + 1] - cum[i]); bi = i; }
  }
  return [bd, bi];
}

async function build(a) {
  const zip = await loadZip(a);
  const rows = (name, optional) => {
    const buf = zip.readFile(name);
    if (!buf) { if (optional) { console.warn(`[${a.id}] ${name} not in zip - skipping`); return []; } throw new Error(`${name} missing from the zip`); }
    return parse(buf.toString('utf8'), { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true });
  };

  const routes = {};
  for (const r of rows('routes.txt'))
    routes[pfx(a.id, r.route_id)] = { a: a.id, s: r.route_short_name || r.route_id, k: norm(r.route_short_name || r.route_id), l: r.route_long_name || '', t: String(r.route_type),
      c: hex(r.route_color), x: hex(r.route_text_color) };

  // Trips per shape, per route + direction. The most-used shape of each direction goes in the overview map;
  // every shape used by >= 15% as many trips as that (up to 3 per direction) goes in the route's own file.
  const counts = {}, heads = {}, tripShape = new Map();
  const tripMeta = new Map(); // trip_id -> "routeKey\tdirection\theadsign", for the per-stop route/direction table
  for (const t of rows('trips.txt')) {
    tripMeta.set(t.trip_id, `${routes[pfx(a.id, t.route_id)]?.k ?? norm(t.route_id)}\t${t.direction_id ?? ''}\t${t.trip_headsign ?? ''}`);
    if (!t.shape_id) continue;
    const k = `${t.route_id}|${t.direction_id ?? 0}`;
    (counts[k] ??= {})[t.shape_id] = (counts[k][t.shape_id] || 0) + 1;
    tripShape.set(t.trip_id, t.shape_id);
    if (t.trip_headsign) ((heads[t.shape_id] ??= {})[t.trip_headsign] = (heads[t.shape_id][t.trip_headsign] || 0) + 1);
  }
  const wanted = new Map();  // raw shape_id -> raw route_id (overview: best per direction)
  const patterns = new Map(); // raw shape_id -> {route, dir, n}
  for (const [k, shapes] of Object.entries(counts)) {
    const [route, dir] = k.split('|');
    const ranked = Object.entries(shapes).sort((x, y) => y[1] - x[1]);
    wanted.set(ranked[0][0], route);
    ranked.filter(([, n], i) => i === 0 || (i < 3 && n >= ranked[0][1] * 0.15))
      .forEach(([sid, n]) => patterns.set(sid, { route, dir: Number(dir), n }));
  }

  const pts = {};
  for (const p of rows('shapes.txt', true)) {
    if (!wanted.has(p.shape_id) && !patterns.has(p.shape_id)) continue;
    (pts[p.shape_id] ??= []).push([Number(p.shape_pt_sequence), r5(p.shape_pt_lon), r5(p.shape_pt_lat)]);
  }
  const ordered = Object.fromEntries(Object.entries(pts).map(([sid, arr]) => [sid, arr.sort((x, y) => x[0] - y[0]).map(q => [q[1], q[2]])]));
  const lines = Object.entries(pts).filter(([sid]) => wanted.has(sid)).map(([sid, arr]) => {
    const id = pfx(a.id, wanted.get(sid));
    return {
      type: 'Feature',
      properties: { id, a: a.id, s: routes[id]?.s ?? wanted.get(sid), k: routes[id]?.k ?? norm(wanted.get(sid)), t: routes[id]?.t ?? '3' },
      geometry: { type: 'LineString', coordinates: arr.sort((x, y) => x[0] - y[0]).map(q => [q[1], q[2]]) },
    };
  });

  const rawStops = rows('stops.txt').filter(s => s.stop_lat && s.stop_lon);
  const stopXY = new Map(rawStops.map(s => [s.stop_id, { n: s.stop_name, p: [Number(s.stop_lon), Number(s.stop_lat)] }]));
  const stops = rawStops.map(s => ({
    type: 'Feature',
    properties: { n: s.stop_name, a: a.id, k: `${a.id}:${s.stop_id}`, ...(s.stop_code ? { c: s.stop_code } : {}) },
    geometry: { type: 'Point', coordinates: [r5(s.stop_lon), r5(s.stop_lat)] },
  }));
  // Scheduled run-time profile of each pattern: mean elapsed minutes at every stop (over all its trips) and mean total
  // run time by hour of departure. Rows are grouped by trip in GTFS feeds; a trip that reappears later is skipped.
  const acc = new Map(); // shape_id -> {seq, sum, n, hours}
  const done = new Set();
  let cur = null, curRows = [];
  const flush = () => {
    if (!cur || !curRows.length) return;
    const sid = tripShape.get(cur);
    if (patterns.has(sid)) {
      const t = curRows.map(r => [r.stop_id, secs(r.arrival_time) ?? secs(r.departure_time), secs(r.departure_time) ?? secs(r.arrival_time)]);
      const t0 = t[0][2];
      if (t0 != null && t.every(x => x[1] != null)) {
        let g = acc.get(sid);
        if (!g) acc.set(sid, g = { seq: t.map(x => x[0]), sum: t.map(() => 0), n: 0, hours: {} });
        if (g.seq.length === t.length && g.seq.every((x, i) => x === t[i][0])) {
          t.forEach((x, i) => { g.sum[i] += (x[1] - t0) / 60; });
          const h = Math.floor(t0 / 3600) % 24, h0 = (g.hours[h] ??= [0, 0]);
          h0[0] += (t[t.length - 1][1] - t0) / 60; h0[1]++; g.n++;
        }
      }
    }
    done.add(cur);
  };
  // Which routes / directions serve each stop, and the compass direction buses leave it in (bearing to the next stop of the trip).
  const stopRoutes = new Map(); // stop_id -> Map(tripMeta -> bearing | null)
  let pTrip = null, pStop = null, pMeta = null;
  const haveTimes = await eachRow(zip, 'stop_times.txt', r => {
    const meta = tripMeta.get(r.trip_id);
    if (meta) {
      let m = stopRoutes.get(r.stop_id); if (!m) stopRoutes.set(r.stop_id, m = new Map());
      if (!m.has(meta)) m.set(meta, null);
      if (pTrip === r.trip_id && pMeta) {
        const pm = stopRoutes.get(pStop), A = stopXY.get(pStop)?.p, B = stopXY.get(r.stop_id)?.p;
        if (pm && pm.get(pMeta) == null && A && B && km(A, B) > 0.01)
          pm.set(pMeta, (Math.atan2((B[0] - A[0]) * Math.cos(A[1] * Math.PI / 180), B[1] - A[1]) * 180 / Math.PI + 360) % 360);
      }
    }
    pTrip = r.trip_id; pStop = r.stop_id; pMeta = meta;
    if (r.trip_id !== cur) { flush(); cur = r.trip_id; curRows = []; if (done.has(cur)) { cur = null; return; } }
    curRows.push(r);
  });
  flush();
  if (!haveTimes) console.warn(`[${a.id}] stop_times.txt not in zip - no run-time profiles`);

  // one file per route short name (a short name can span several route_ids, e.g. branches)
  const perRoute = {}, profileOf = new Map(); // profileOf: shape_id -> [file, index of its profile]
  for (const [sid, pat] of patterns) {
    if (!ordered[sid]) continue;
    const id = pfx(a.id, pat.route), k = routes[id]?.k ?? norm(pat.route);
    const h = Object.entries(heads[sid] ?? {}).sort((x, y) => y[1] - x[1])[0]?.[0] ?? '';
    const file = (perRoute[k] ??= { features: [], profiles: [], trips: {} });
    file.features.push({ type: 'Feature', properties: { dir: pat.dir, n: pat.n, h },
      geometry: { type: 'LineString', coordinates: ordered[sid] } });
    const g = acc.get(sid);
    if (g) {
      const line = ordered[sid], cum = [0];
      for (let q = 1; q < line.length; q++) cum.push(cum[q - 1] + km(line[q - 1], line[q]));
      let seg = 0;
      const st = g.seq.map((stopId, q) => {
        const s0 = stopXY.get(stopId);
        const [d, bi] = s0 ? along(line, cum, s0.p, seg) : [q ? null : 0, seg];
        seg = bi;
        return [s0?.n ?? stopId, d == null ? null : Math.round(d * 100) / 100, Math.round(g.sum[q] / g.n * 10) / 10];
      }).filter(x => x[1] != null);
      if (st.length >= 2) profileOf.set(sid, [file, file.profiles.length]);
      if (st.length >= 2) file.profiles.push({
        f: file.features.length - 1, dir: pat.dir, h, trips: g.n, len: Math.round(cum[cum.length - 1] * 100) / 100,
        stops: st, hours: Object.entries(g.hours).map(([hh, v]) => [Number(hh), Math.round(v[0] / v[1] * 10) / 10, v[1]]).sort((x, y) => x[0] - y[0]),
      });
    }
  }
  // trip_id -> profile index, so a live vehicle's trip says exactly which pattern it is running
  for (const [tid, sid] of tripShape) { const pr = profileOf.get(sid); if (pr) pr[0].trips[tid] = pr[1]; }
  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'], stopInfo = {};
  for (const [sid, m] of stopRoutes) {
    const list = [...m].map(([meta, b]) => { const [k, d, h] = meta.split('\t'); return [k, h, d === '' ? null : Number(d), b == null ? null : COMPASS[Math.round(b / 45) % 8]]; })
      .sort((x, y) => (parseInt(x[0]) || 1e9) - (parseInt(y[0]) || 1e9) || x[0].localeCompare(y[0]) || (x[2] ?? 0) - (y[2] ?? 0));
    stopInfo[`${a.id}:${sid}`] = list;
  }
  console.log(`[${a.id}] routes: ${Object.keys(routes).length}, lines: ${lines.length}, route files: ${Object.keys(perRoute).length}, stops: ${stops.length}`);
  return { routes, lines, stops, perRoute, stopInfo };
}

const all = { routes: {}, lines: [], stops: [], files: {}, stopInfo: {} }, failed = [];
for (const a of AGENCIES) {
  try {
    const d = await build(a);
    Object.assign(all.routes, d.routes); all.lines.push(...d.lines); all.stops.push(...d.stops); Object.assign(all.stopInfo, d.stopInfo);
    for (const [k, f] of Object.entries(d.perRoute)) all.files[`${a.id}_${k.replace(/[^a-z0-9._-]/gi, '_')}`] = f;
  } catch (err) {
    failed.push(a.id);
    console.error(`[${a.id}] FAILED: ${err.message}`);
    console.error(`[${a.id}] tip: download its static GTFS zip yourself and run: node build-data.js ${a.id}=path/to/file.zip`);
  }
}
if (failed.length && !allowPartial) {
  console.error(`\nNothing written (failed: ${failed.join(', ')}). Fix it, or use --allow-partial to write the rest.`);
  process.exit(1);
}
fs.mkdirSync('public/data', { recursive: true });
const out = (f, o) => fs.writeFileSync(`public/data/${f}`, JSON.stringify(o));
fs.rmSync('public/data/route', { recursive: true, force: true });
fs.mkdirSync('public/data/route', { recursive: true });
for (const [name, f] of Object.entries(all.files))
  fs.writeFileSync(`public/data/route/${name}.json`, JSON.stringify({ type: 'FeatureCollection', features: f.features, profiles: f.profiles, trips: f.trips }));
out('routes.json', all.routes);
out('shapes.geojson', { type: 'FeatureCollection', features: all.lines });
out('stops.geojson', { type: 'FeatureCollection', features: all.stops });
out('stopinfo.json', all.stopInfo);   // "AGENCY:stop_id" -> [[route, headsign, direction_id, leaves-towards compass], ...]; loaded on the first stop click
console.log(`written: ${Object.keys(all.routes).length} routes, ${all.lines.length} lines, ${Object.keys(all.files).length} route files, ${all.stops.length} stops`);
