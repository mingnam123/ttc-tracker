// Street-level traffic estimate from the speed of the buses and streetcars themselves.
//
// Links: every stop-to-stop stretch of every route pattern (cut from public/data/route/*.json). Links of different routes that run
// along the same street are merged, so each street stretch collects samples from all routes using it.
// Samples: each time a vehicle reports a new position, speed = distance / time since its previous report. Samples taken within 30 m
// of a stop (dwelling) or near a terminal are ignored, so the speed reflects traffic, not boarding.
// Verdict: current speed (exponentially decaying average, ~10 min half-life) against that stretch's own "usual free-flow" speed
// (85th percentile of everything observed there so far, kept on disk). Until a stretch has enough history it falls back to fixed
// thresholds and is flagged as provisional.
import fs from 'node:fs';
import path from 'node:path';

const BINS = 20, BIN_KMH = 5;                // speed histogram: 0-5, 5-10 ... 95-100 km/h
const HALF_LIFE_S = 600, FRESH_S = 20 * 60;  // current-speed memory and how old a sample may be to count
const MIN_BASE = 40;                         // samples needed before the stretch's own free-flow speed is trusted
const DWELL_M = 30, TERM_M = 150;
const kmOf = (a, b) => { const kx = 111.32 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180); return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110.57); };
const metres = (a, b) => kmOf(a, b) * 1000;
const bearing = (a, b) => (Math.atan2((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI + 360) % 360;
const angDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

function distToLine(p, line) {                     // metres from p to a polyline
  let best = Infinity;
  const kx = 111320 * Math.cos(p[1] * Math.PI / 180), ky = 111320;
  for (let i = 1; i < line.length; i++) {
    const ax = (line[i - 1][0] - p[0]) * kx, ay = (line[i - 1][1] - p[1]) * ky, bx = (line[i][0] - p[0]) * kx, by = (line[i][1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy); if (d < best) best = d;
  }
  return best;
}
function slice(line, cum, k0, k1) {                // the part of a polyline between two distances along it (km)
  const at = d => { let i = 1; while (i < cum.length - 1 && cum[i] < d) i++; const u = cum[i] === cum[i - 1] ? 0 : Math.max(0, Math.min(1, (d - cum[i - 1]) / (cum[i] - cum[i - 1]))); return [i, [line[i - 1][0] + u * (line[i][0] - line[i - 1][0]), line[i - 1][1] + u * (line[i][1] - line[i - 1][1])]]; };
  const [i0, p0] = at(k0), [i1, p1] = at(k1);
  return [p0, ...line.slice(i0, i1), p1];
}

export class Traffic {
  constructor(dataDir, stateFile) {
    this.dir = dataDir; this.stateFile = stateFile;
    this.links = [];          // {id, coords, mid, brg, lenM, hist[], n, ewma, w, last, term}
    this.byRoute = new Map(); // "AGENCY:k" -> [link,...] (deduplicated)
    this.prev = new Map();    // vehicle id -> {lon, lat, ts}
    this.load();
  }

  load() {
    let routes = {};
    try { routes = JSON.parse(fs.readFileSync(path.join(this.dir, 'routes.json'), 'utf8')); } catch { return; }
    const fileKey = (a, k) => `${a}_${k}`.replace(/[^a-z0-9._-]/gi, '_');   // same naming as the per-route files
    this.routeKey = new Map(Object.entries(routes).map(([id, r]) => [id, fileKey(r.a, r.k)]));
    const saved = (() => { try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return {}; } })();
    const grid = new Map();                          // merge links on the same street: ~30 m cells + travel direction
    const cell = (p, b) => `${Math.round(p[0] * 3000)}|${Math.round(p[1] * 4000)}|${Math.round(b / 45) % 8}`;
    let files = [];
    try { files = fs.readdirSync(path.join(this.dir, 'route')).filter(f => f.endsWith('.json')); } catch { return; }
    for (const f of files) {
      let j; try { j = JSON.parse(fs.readFileSync(path.join(this.dir, 'route', f), 'utf8')); } catch { continue; }
      const rk = f.replace(/\.json$/, '');                      // "YRT_52"
      for (const pr of j.profiles ?? []) {
        const line = j.features[pr.f]?.geometry?.coordinates; if (!line || line.length < 2) continue;
        const cum = [0]; for (let q = 1; q < line.length; q++) cum.push(cum[q - 1] + kmOf(line[q - 1], line[q]));
        const st = pr.stops;
        for (let i = 0; i + 1 < st.length; i++) {
          if (st[i + 1][1] - st[i][1] < 0.08) continue;
          const coords = slice(line, cum, st[i][1], st[i + 1][1]); if (coords.length < 2) continue;
          const a = coords[0], b = coords[coords.length - 1], mid = coords[Math.floor(coords.length / 2)];
          const brg = bearing(a, b), term = i === 0 || i === st.length - 2;
          let L = null;
          for (let dx = -1; dx <= 1 && !L; dx++) for (let dy = -1; dy <= 1 && !L; dy++) for (let db = -1; db <= 1 && !L; db++) {
            const c = grid.get(`${Math.round(mid[0] * 3000) + dx}|${Math.round(mid[1] * 4000) + dy}|${(Math.round(brg / 45) % 8 + db + 8) % 8}`);
            if (c) L = c.find(l => metres(l.mid, mid) < 30 && angDiff(l.brg, brg) < 30 && Math.abs(l.lenM - (st[i + 1][1] - st[i][1]) * 1000) < 120) ?? null;
          }
          if (!L) {
            L = { id: this.links.length, coords, mid, brg, lenM: (st[i + 1][1] - st[i][1]) * 1000, term, ...this.fresh(saved[this.links.length], coords) };
            this.links.push(L);
            const k = cell(mid, brg); (grid.get(k) ?? grid.set(k, []).get(k)).push(L);
          } else if (!term) L.term = false;
          const arr = this.byRoute.get(rk) ?? this.byRoute.set(rk, []).get(rk);
          if (!arr.includes(L)) arr.push(L);
        }
      }
    }
    // saved histograms are only valid for the same link layout
    if (saved._n !== undefined && saved._n !== this.links.length) for (const l of this.links) { l.hist = new Array(BINS).fill(0); l.hn = 0; }
    this.layoutN = this.links.length;
  }
  fresh(s) { return { hist: s?.h ?? new Array(BINS).fill(0), hn: s?.hn ?? 0, ewma: null, w: 0, last: 0, nNow: 0 }; }

  save() {
    try {
      const o = { _n: this.links.length };
      this.links.forEach(l => { if (l.hn) o[l.id] = { h: l.hist.map(x => Math.round(x * 10) / 10), hn: l.hn }; });
      fs.writeFileSync(this.stateFile, JSON.stringify(o));
    } catch (e) { console.error('[traffic] could not save state:', e.message); }
  }

  // Feed one polling round of vehicles ({id, route, lon, lat, ts}).
  observe(vehicles) {
    if (!this.links.length) return 0;
    let used = 0;
    for (const v of vehicles) {
      const p = [v.lon, v.lat], pv = this.prev.get(v.id);
      if (!v.ts) continue;
      this.prev.set(v.id, { p, ts: v.ts });
      if (!pv || v.ts <= pv.ts) continue;
      const dt = v.ts - pv.ts, d = metres(pv.p, p);
      if (dt < 5 || dt > 60) continue;
      const kmh = d / dt * 3.6; if (kmh > 90) continue;
      const cand = this.byRoute.get(this.routeKey.get(v.route)) ?? []; if (!cand.length) continue;
      const brg = d > 15 ? bearing(pv.p, p) : null, m = [(p[0] + pv.p[0]) / 2, (p[1] + pv.p[1]) / 2];
      let best = null, bd = 35;
      for (const l of cand) {
        if (metres(l.mid, m) > l.lenM + 60) continue;
        if (brg != null && angDiff(brg, l.brg) > 60) continue;
        const dd = distToLine(m, l.coords); if (dd < bd) { bd = dd; best = l; }
      }
      if (!best) continue;
      const a = best.coords[0], b = best.coords[best.coords.length - 1];
      if (metres(m, a) < DWELL_M || metres(m, b) < DWELL_M) continue;       // dwelling at a stop
      if (best.term && kmh < 3 && (metres(m, a) < TERM_M || metres(m, b) < TERM_M)) continue; // layover
      this.add(best, kmh, v.ts); used++;
    }
    return used;
  }
  add(l, kmh, ts) {
    const bin = Math.min(BINS - 1, Math.floor(kmh / BIN_KMH));
    l.hist[bin]++; l.hn++;
    if (l.hn > 5000) { l.hist = l.hist.map(x => x / 2); l.hn /= 2; }          // keep the history adaptive
    const dt = l.last ? Math.max(0, ts - l.last) : 0, decay = Math.pow(0.5, dt / HALF_LIFE_S);
    l.ewma = l.w ? (l.ewma * l.w * decay + kmh) / (l.w * decay + 1) : kmh;
    l.w = l.w * decay + 1; l.last = Math.max(l.last, ts);
  }
  baseline(l) {                                    // 85th percentile of observed speeds, or null without enough history
    if (l.hn < MIN_BASE) return null;
    const tot = l.hist.reduce((x, y) => x + y, 0); let acc = 0;
    for (let i = 0; i < BINS; i++) { acc += l.hist[i]; if (acc >= tot * 0.85) return (i + 0.5) * BIN_KMH; }
    return null;
  }
  status(l, now) {
    if (!l.w || now - l.last > FRESH_S) return null;
    const base = this.baseline(l), v = l.ewma;
    if (base) { const r = v / Math.max(base, 8); return { level: r >= 0.7 ? 'smooth' : r >= 0.45 ? 'slow' : 'heavy', ratio: r, base, v, prov: false }; }
    return { level: v >= 20 ? 'smooth' : v >= 10 ? 'slow' : 'heavy', ratio: null, base: null, v, prov: true };
  }

  geojson(now = Math.floor(Date.now() / 1000)) {
    const features = [];
    for (const l of this.links) {
      const s = this.status(l, now); if (!s) continue;
      features.push({ type: 'Feature', properties: { l: s.level, v: Math.round(s.v), u: s.base ? Math.round(s.base) : null, p: s.prov ? 1 : 0, n: Math.round(l.w * 10) / 10 },
        geometry: { type: 'LineString', coordinates: l.coords.map(c => [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5]) } });
    }
    return { type: 'FeatureCollection', features };
  }
}
