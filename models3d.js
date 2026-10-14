// Procedural 3D models of the TTC / YRT fleet, built from real vehicle dimensions with three.js (r128).
//
//   VehicleModels.specFor({ model, kind })  -> spec (family, length, width, height, sections, axles, roof gear, livery)
//   VehicleModels.build(THREE, spec)        -> { body, accent, spec }  two BufferGeometries in metres
//                                              x = right of travel, y = forward, z = up, origin = footprint centre
//
// `body` carries per-vertex colours (livery, glass, wheels, lights) with the shading BAKED IN, so it renders with a plain
// MeshBasicMaterial({ vertexColors: true }). `accent` is a thin outline on the ground plus a roof stripe, also with baked
// shading; give it a material whose colour is the data colour (delay / crowding / type).
//
// Dimensions are the manufacturers' nominal figures rounded to what is visible at map scale (they are not CAD-accurate):
//   Nova Bus LFS 12.2 x 2.6 x 3.3 m, LFS Artic 18.3 m, New Flyer XDE40/XE40 12.2 m, XDE60 18.3 m, Orion VII 12.2 m,
//   Flexity Outlook 30 m x 2.54 m, CLRV 15.4 m, ALRV 23.2 m, Arboc SOI 21 cutaway ~7 m.
(function (root) {
  'use strict';

  const C = {
    white: '#f2f2ef', roof: '#e4e5e2', red: '#da291c', darkRed: '#a81d14', skirt: '#2a2c30', glass: '#161d26', door: '#232a33',
    light: '#fff3c4', tail: '#c4161c', amber: '#ffb000', gear: '#b6babf', gearDark: '#7d8288', tyre: '#16171a', hub: '#9aa0a6',
    black: '#111214', bellows: '#1c1e22', grey: '#8a8f98',
  };

  // ---- fleet families -------------------------------------------------------------------------------------------------
  // sections are listed rear -> front. frontAxle / axles are y positions (m) from the vehicle centre.
  // Figures marked (src) come from Wikipedia / Transit Toronto spec tables (Nova LFS, New Flyer Xcelsior, Orion VII, Flexity Outlook, CLRV);
  // axle positions are derived from the published wheelbases with typical overhangs. `top` = roof-equipment height by propulsion.
  const FAMILIES = {
    nova:     { kind: 'bus', name: 'Nova Bus LFS',        L: 12.19, W: 2.59, H: 3.0,  top: { diesel: 3.15, hybrid: 3.25, electric: 3.45 }, rake: 0.85,   // (src) 40 ft, 102 in wide, wheelbase 6.20 m, 3.15 m diesel / 3.25 m hybrid
                sections: [12.19], axles: [-2.6, 3.6] },
    novaArtic:{ kind: 'bus', name: 'Nova Bus LFS Artic',  L: 18.9,  W: 2.59, H: 3.0,  top: { diesel: 3.15, hybrid: 3.25, electric: 3.45 }, rake: 0.85,   // (src) 62 ft, wheelbases 6.20 + 6.43 m
                sections: [8.0, 9.9], gap: 1.0, axles: [-5.68, 0.75, 6.95] },
    orion:    { kind: 'bus', name: 'Orion VII',           L: 12.6,  W: 2.59, H: 3.05, top: { diesel: 3.25, hybrid: 3.35, electric: 3.35 }, rake: 0.55,   // (src) 40 ft NG, 3.23-3.38 m tall, wheelbase 7.26 m
                sections: [12.6], axles: [-3.26, 4.0] },
    nf:       { kind: 'bus', name: 'New Flyer Xcelsior',  L: 12.5,  W: 2.59, H: 3.1,  top: { diesel: 3.2, hybrid: 3.38, electric: 3.38 }, rake: 0.75,     // (src) 41 ft over bumpers, 3.38 m, wheelbase 7.21 m
                sections: [12.5], axles: [-3.36, 3.85] },
    nfArtic:  { kind: 'bus', name: 'New Flyer XDE60',     L: 18.5,  W: 2.59, H: 3.1,  top: { diesel: 3.2, hybrid: 3.38, electric: 3.38 }, rake: 0.75,     // (src) 60 ft 10 in, wheelbases 5.82 + 7.44 m
                sections: [8.4, 9.1], gap: 1.0, axles: [-6.41, 1.03, 6.85] },
    vanhool:  { kind: 'bus', name: 'Van Hool A330',      L: 12.0,  W: 2.55, H: 3.0,  top: { diesel: 3.25 }, rake: 0.55, sections: [12.0], axles: [-2.9, 3.9] },
    ezrider:  { kind: 'bus', name: 'ElDorado E-Z Rider II', L: 10.4, W: 2.5, H: 3.0,  top: { diesel: 3.2 }, rake: 0.8, sections: [10.4], axles: [-2.0, 3.6] },
    proterra: { kind: 'bus', name: 'Proterra BE40',       L: 12.2,  W: 2.6,  H: 3.1,  top: { electric: 3.3 }, rake: 1.0,  sections: [12.2], axles: [-2.5, 3.6] },
    byd:      { kind: 'bus', name: 'BYD K9M',             L: 12.2,  W: 2.55, H: 3.15, top: { electric: 3.3 }, rake: 0.7,  sections: [12.2], axles: [-2.7, 3.5] },
    cutaway:  { kind: 'bus', name: 'Arboc SOI 21',        L: 7.0,   W: 2.4,  H: 2.95, rake: 1.5,  sections: [7.0],  axles: [-1.5, 2.3], cutaway: true },
    // Flexity Outlook (src): 30.2 m, 2.54 m, 3.84 m with the pantograph folded, 5 sections, 4 double doors on the right side only,
    // three powered bogies (Bo'+Bo'+Bo'), two blue accessibility "bullseye" lights on the nose, large electronic destination sign.
    flexity:  { kind: 'streetcar', name: 'Flexity Outlook', L: 30.2, W: 2.54, H: 3.4, rake: 1.1, sections: [5.64, 5.64, 5.64, 5.64, 5.64], gap: 0.5,
                trucks: [-12.28, 0, 12.28], pantoSection: 1, pantoTop: 3.84, doorSecs: [4, 3, 2, 1], bull: '#2b8cff', screen: true },
    // CLRV (src): 15.23 m, 2.54 m, 3.63 m, floor 1.125 m (four steps), front bi-fold door + two double-leaf doors at the rear, trolley pole,
    // crimson red body, two green bullseye lights in the upper front corners.
    clrv:     { kind: 'streetcar', name: 'CLRV',            L: 15.23, W: 2.54, H: 3.45, rake: 0.4, sections: [15.23], trucks: [-5.2, 5.2], pole: true, poleY: -2.0,
                zb: 0.62, winZ0: 1.45, doorZ0: 0.6, doorList: [{ y: 5.9, len: 1.0 }, { y: -1.7, len: 1.5 }, { y: -5.5, len: 1.5 }], bull: '#2ecc71', tramRed: '#b3122a' },
    // ALRV: two CLRV-style bodies, a big roof box (air intake) on each, trolley pole.
    alrv:     { kind: 'streetcar', name: 'ALRV',            L: 23.2, W: 2.54, H: 3.45, rake: 0.4, sections: [11.2, 11.2], gap: 0.8, trucks: [-8.2, 0, 8.2], pole: true, poleY: -1.0,
                zb: 0.62, winZ0: 1.45, doorZ0: 0.6, doorList: [{ y: 9.9, len: 1.0 }, { y: 4.2, len: 1.5 }, { y: -4.0, len: 1.5 }, { y: -9.2, len: 1.5 }], bull: '#2ecc71', tramRed: '#b3122a', bigBox: true },
  };

  // Choose the family from the roster string ("Nova Bus LFS · Hybrid · 12 m · 2023") and the vehicle kind.
  function specFor(v) {
    const m = String(v.model || ''), kind = v.kind || (/Streetcar|Flexity|CLRV|ALRV/i.test(m) ? 'streetcar' : 'bus');
    const len = Number((/(\d+(?:\.\d+)?)\s*m\b/.exec(m) || [])[1]) || 0;
    const prop = /Electric/i.test(m) ? 'electric' : /Hybrid/i.test(m) ? 'hybrid' : /Diesel/i.test(m) ? 'diesel' : /Gasoline/i.test(m) ? 'gas' : /Streetcar/i.test(m) ? 'electric' : 'diesel';
    let f;
    if (kind === 'streetcar') f = /ALRV/i.test(m) ? 'alrv' : /CLRV/i.test(m) ? 'clrv' : 'flexity';
    else if (/ProMaster|Arboc/i.test(m)) f = 'cutaway';
    else if (/Van Hool/i.test(m)) f = 'vanhool';
    else if (/E-Z Rider|ElDorado/i.test(m)) f = 'ezrider';
    else if (/Artic/i.test(m)) f = 'novaArtic';
    else if (/XDE60/i.test(m) || (/New Flyer/i.test(m) && len >= 17)) f = 'nfArtic';
    else if (/New Flyer|XDE|XE40/i.test(m)) f = 'nf';
    else if (/Orion/i.test(m)) f = 'orion';
    else if (/Proterra|BE40/i.test(m)) f = 'proterra';
    else if (/BYD|K9/i.test(m)) f = 'byd';
    else f = len >= 17 ? 'novaArtic' : 'nova'; // Nova LFS / LFSe+ and anything unknown (e.g. YRT)
    const brand = v.agency === 'YRT' ? '#1d63b8' : null; // YRT: blue lower body (approximate livery); TTC keeps red
    return { family: f, prop, brand, ...FAMILIES[f], key: `${f}|${prop}|${brand ? 'yrt' : 'ttc'}` };
  }

  // ---- geometry collector with baked flat shading ---------------------------------------------------------------------
  const KEY = [-0.40, 0.25, 0.88], FILL = [0.55, -0.35, 0.30]; // light directions in model space (key from above/front-left)
  const norm3 = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const K = norm3(KEY), F = norm3(FILL);

  class Mesher {
    constructor(T) { this.T = T; this.pos = []; this.col = []; this.tmp = new T.Color(); }
    // geo: any BufferGeometry; m: Matrix4 placing it in model space; colour: css colour or fn(centroid, normal) -> css colour
    add(geo, m, colour) {
      let g = geo.clone(); g.applyMatrix4(m); if (g.index) g = g.toNonIndexed();
      const p = g.attributes.position.array;
      for (let i = 0; i < p.length; i += 9) {
        const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
        const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
        const n = norm3([uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]);
        const cen = { x: (p[i] + p[i + 3] + p[i + 6]) / 3, y: (p[i + 1] + p[i + 4] + p[i + 7]) / 3, z: (p[i + 2] + p[i + 5] + p[i + 8]) / 3 };
        this.tmp.set(typeof colour === 'function' ? colour(cen, { x: n[0], y: n[1], z: n[2] }) : colour);
        const shade = Math.min(1.08, 0.56 + 0.46 * Math.max(0, n[0] * K[0] + n[1] * K[1] + n[2] * K[2]) + 0.16 * Math.max(0, n[0] * F[0] + n[1] * F[1] + n[2] * F[2]));
        for (let k = 0; k < 3; k++) {
          this.pos.push(p[i + 3 * k], p[i + 3 * k + 1], p[i + 3 * k + 2]);
          this.col.push(Math.min(1, this.tmp.r * shade), Math.min(1, this.tmp.g * shade), Math.min(1, this.tmp.b * shade));
        }
      }
      g.dispose();
    }
    geometry() {
      const g = new this.T.BufferGeometry();
      g.setAttribute('position', new this.T.Float32BufferAttribute(this.pos, 3));
      g.setAttribute('color', new this.T.Float32BufferAttribute(this.col, 3));
      return g;
    }
  }

  function build(T, S) {
    const M = new Mesher(T), A = new Mesher(T);
    const mat = new T.Matrix4(), q = new T.Quaternion(), ONE = new T.Vector3(1, 1, 1);
    const place = (x, y, z) => mat.makeTranslation(x, y, z).clone();
    // axis-aligned box centred at (cx,cy,cz)
    const box = (mesher, cx, cy, cz, sx, sy, sz, colour) => mesher.add(new T.BoxGeometry(sx, sy, sz), place(cx, cy, cz), colour);
    // box tilted about the x axis (top leans backwards by `ang`) – raked windscreens
    const tiltBox = (cx, cy, cz, sx, sy, sz, ang, colour) => {
      const m = new T.Matrix4().compose(new T.Vector3(cx, cy, cz), q.setFromAxisAngle(new T.Vector3(1, 0, 0), ang), ONE);
      M.add(new T.BoxGeometry(sx, sy, sz), m, colour);
    };
    // thin bar between two points
    const strut = (mesher, p0, p1, th, colour) => {
      const d = new T.Vector3(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]), len = d.length();
      const m = new T.Matrix4().compose(new T.Vector3((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2),
        q.setFromUnitVectors(new T.Vector3(0, 0, 1), d.normalize()), ONE);
      mesher.add(new T.BoxGeometry(th, th, len), m, colour);
    };
    // wheel: axis along x
    const wheel = (x, y, z, r, w) => {
      const m = new T.Matrix4().makeTranslation(x, y, z).multiply(new T.Matrix4().makeRotationZ(Math.PI / 2));
      M.add(new T.CylinderGeometry(r, r, w, 16), m, C.tyre);
      const side = Math.sign(x) || 1;
      const mh = new T.Matrix4().makeTranslation(x + side * (w / 2 + 0.005), y, z).multiply(new T.Matrix4().makeRotationZ(Math.PI / 2));
      M.add(new T.CylinderGeometry(r * 0.52, r * 0.52, 0.02, 12), mh, C.hub);
    };

    const { L, W, H, kind } = S, tram = kind === 'streetcar';
    const zb = S.zb ?? (tram ? 0.42 : 0.30), bev = 0.07, gap = S.gap || 0;
    const sections = []; let y = -L / 2;
    S.sections.forEach((len, i) => { sections.push({ i, y0: y, y1: y + len }); y += len + gap; });
    const last = sections.length - 1, yFront = L / 2, yRear = -L / 2;

    // ---- livery -------------------------------------------------------------------------------------------------------
    // TTC livery from reference photos: red roof and valance, thin white stripe along the window tops, white lower body with a red band
    // that rises toward the rear, black skirts; front face white with a red band, black bumper and a wide black destination sign.
    const busLivery = (p, n) => {
      if (p.z < zb + 0.14) return C.skirt;
      if (n.y > 0.4) {                                                                // front face
        if (p.z < 0.62) return C.skirt;
        if (p.z < 1.0 || p.z > 2.45) return (S.brand || C.red);
        return C.white;
      }
      if (n.z > 0.5) return (S.brand || C.red);                                                    // red roof
      if (Math.abs(n.x) > 0.5) {
        const t = Math.max(0, Math.min(1, (yFront - p.y) / L));
        if (p.z < 0.80 + 0.5 * t * t) return (S.brand || C.red);                                   // lower red band, rising to the rear
        if (p.z > 2.42) return (S.brand || C.red);                                                 // roof valance
        if (p.z > 2.30) return C.white;                                               // white stripe above the windows
        return C.white;
      }
      return p.z < 1.0 ? (S.brand || C.red) : C.white;                                             // rear face
    };
    const tramLivery = (p, n) => {
      if (p.z < zb + 0.2) return C.skirt;
      if (n.z > 0.5 && p.z > H - 0.45) return C.roof;                                 // white roof
      if (p.z > H - 0.35) return C.white;
      return S.tramRed || C.red;
    };
    const livery = tram ? tramLivery : busLivery;

    // ---- body: one bevelled extrusion per section ---------------------------------------------------------------------
    function bodySection(s) {
      const isFront = s.i === last, isRear = s.i === 0, b = bev;
      const y0 = s.y0 + b, y1 = s.y1 - b, z0 = zb + b, z1 = H - b;
      const rake = S.rake, sh = new T.Shape();
      const rearRound = S.cutaway ? 0.25 : 0.4;
      // profile in (y, z); drawn counter-clockwise starting at the rear-bottom corner
      sh.moveTo(y0 + (isRear ? 0.35 : 0), z0);
      sh.lineTo(y1 - (isFront ? 0.3 : 0), z0);
      if (isFront) {
        sh.lineTo(y1, z0 + 0.3);                                 // bumper corner
        if (S.cutaway) {                                        // cutaway van: bonnet then windscreen
          sh.lineTo(y1, 1.0); sh.lineTo(y1 - 0.9, 1.25); sh.lineTo(y1 - rake, z1 - 0.3); sh.lineTo(y1 - rake - 0.35, z1);
        } else {
          sh.lineTo(y1, tram ? 0.85 : 1.05);
          sh.lineTo(y1 - rake, z1 - 0.38);                       // windscreen rake
          sh.lineTo(y1 - rake - 0.32, z1);                       // roof-front corner
        }
      } else { sh.lineTo(y1, z0 + 0.0); sh.lineTo(y1, z1); }
      sh.lineTo(y0 + (isRear ? rearRound : 0), z1);
      if (isRear) { sh.lineTo(y0, z1 - 0.35); sh.lineTo(y0, z0 + 0.3); } else { sh.lineTo(y0, z0); }
      sh.closePath();
      const depth = W - 2 * b;
      const g = new T.ExtrudeGeometry(sh, { depth, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: 2, curveSegments: 1 });
      // shape (x=y_long, y=z_up, z=lateral) -> model (x=lateral, y=long, z=up), centred across the width
      const m = new T.Matrix4().set(0, 0, 1, -depth / 2, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1);
      M.add(g, m, livery);
    }
    sections.forEach(bodySection);

    // ---- articulation bellows -----------------------------------------------------------------------------------------
    for (let i = 0; i < last; i++) {
      const a = sections[i], b2 = sections[i + 1], cy = (a.y1 + b2.y0) / 2, gl = b2.y0 - a.y1;
      box(M, 0, cy, (zb + 0.1 + H - 0.2) / 2, W - 0.22, gl + 0.04, H - 0.3 - zb, C.bellows);
      box(M, 0, cy, H - 0.04, W - 0.5, gl + 0.04, 0.1, C.gearDark);              // turntable cover on the roof
    }

    // ---- side windows + doors -----------------------------------------------------------------------------------------
    const doors = []; // {y, len, sec}
    if (tram) {
      if (S.doorList) for (const d of S.doorList) doors.push({ y: d.y, len: d.len });
      else for (const k of S.doorSecs) { const s = sections[k]; doors.push({ y: (s.y0 + s.y1) / 2 + (k === last ? -0.3 : 0), len: 1.5, sec: s }); }
    } else {
      const sf = sections[last], sr = sections[0];
      doors.push({ y: sf.y1 - 1.5, len: 1.1, sec: sf });                                  // front door (right side)
      if (sections.length === 1) doors.push({ y: sr.y0 + (S.cutaway ? 3.2 : 4.4), len: 1.25, sec: sr });
      else { doors.push({ y: sf.y0 + 1.7, len: 1.25, sec: sf }); doors.push({ y: sr.y0 + 3.6, len: 1.25, sec: sr }); }
    }
    const wz0 = S.winZ0 ?? (tram ? 0.98 : 0.96), wz1 = tram ? 2.58 : 2.30, wh = wz1 - wz0, wzc = (wz0 + wz1) / 2;
    for (const s of sections) {
      const from = s.y0 + (s.i === 0 ? 0.7 : 0.35), to = s.y1 - (s.i === last ? (tram ? 1.0 : 0.5) : 0.35);
      const pane = tram ? 1.55 : 1.15, pill = tram ? 0.14 : 0.13;
      for (let yy = from; yy + 0.3 < to; yy += pane + pill) {
        const len = Math.min(pane, to - yy), cy = yy + len / 2;
        for (const side of [-1, 1]) {
          if (side === 1 && doors.some(d => Math.abs(d.y - cy) < d.len / 2 + len / 2 + 0.02)) continue;   // door replaces the pane
          box(M, side * (W / 2 + 0.004), cy, wzc, 0.03, len, wh, C.glass);
        }
      }
    }
    for (const d of doors) {                                                                // right-hand doors (dark glass leaves + frame)
      const dz0 = S.doorZ0 ?? 0.42;
      box(M, W / 2 + 0.006, d.y, (dz0 + (tram ? 2.55 : 2.3)) / 2, 0.035, d.len, (tram ? 2.55 : 2.3) - dz0, C.door);
      box(M, W / 2 + 0.012, d.y, (tram ? 2.55 : 2.3) - 0.05, 0.02, d.len + 0.06, 0.07, C.gearDark);
      box(M, W / 2 + 0.012, d.y, dz0 + 0.02, 0.02, d.len + 0.06, 0.07, C.gearDark);
      box(M, W / 2 + 0.014, d.y, (dz0 + (tram ? 2.55 : 2.3)) / 2, 0.02, 0.03, (tram ? 2.55 : 2.3) - dz0, C.black);  // centre seam
    }

    // ---- front: windscreen, destination sign, lights, mirrors ---------------------------------------------------------
    const rk = S.rake, zA = S.cutaway ? 1.25 : tram ? 0.85 : 1.05, zB = H - 0.38, ang = Math.atan2(rk, zB - zA);
    tiltBox(0, yFront - rk / 2 + 0.035, (zA + zB) / 2, W - 0.5, 0.05, Math.hypot(rk, zB - zA) * 0.82, ang, C.glass);   // windscreen follows the rake
    if (!tram) box(M, 0, yFront - rk - 0.16, H - 0.30, W - 0.35, 0.06, 0.5, C.black);          // black LED sign housing (bus)
    box(M, 0, yFront - rk - 0.18, H - 0.30, S.screen ? W - 0.6 : (tram ? W - 0.9 : W - 1.0), 0.06, S.screen ? 0.42 : (tram ? 0.30 : 0.26), C.amber);   // destination sign (Flexity: large electronic display)
    if (S.bull) for (const side of [-1, 1]) box(M, side * (W / 2 - 0.28), yFront - rk - 0.17, H - 0.62, 0.2, 0.06, 0.2, S.bull);   // accessibility "bullseye" lights
    for (const side of [-1, 1]) {
      box(M, side * (W / 2 - 0.32), yFront + 0.01, tram ? 0.70 : 0.62, 0.34, 0.05, 0.16, C.light);   // headlamps
      box(M, side * (W / 2 - 0.2), yRear - 0.01, 0.95, 0.12, 0.05, 0.42, C.tail);                   // tail lamps
      strut(M, [side * (W / 2 - 0.05), yFront - 0.55, 1.75], [side * (W / 2 + 0.2), yFront - 0.5, 1.8], 0.05, C.black); // mirror arm
      box(M, side * (W / 2 + 0.24), yFront - 0.5, 1.82, 0.09, 0.2, 0.42, C.black);                // mirror
    }
    box(M, 0, yRear - 0.012, (1.45 + 2.2) / 2, W - 0.9, 0.04, 0.75, C.glass);                   // rear window

    // ---- running gear ---------------------------------------------------------------------------------------------------
    if (tram) {
      for (const ty of S.trucks) {
        box(M, 0, ty, 0.26, W - 0.7, 3.0, 0.34, C.black);
        for (const dy of [-1.0, 1.0]) for (const side of [-1, 1]) wheel(side * (W / 2 - 0.5), ty + dy, 0.33, 0.33, 0.14);
      }
    } else {
      S.axles.forEach((ay, i) => {
        const dual = i === S.axles.length - 1 && !S.cutaway;
        for (const side of [-1, 1]) {
          box(M, side * (W / 2 + 0.006), ay, 0.78, 0.03, 1.32, 0.82, C.black);              // wheel-arch
          wheel(side * (W / 2 - (dual ? 0.28 : 0.15)), ay, 0.5, 0.5, dual ? 0.5 : 0.3);
        }
      });
    }

    // ---- roof equipment -------------------------------------------------------------------------------------------------
    const roofBox = (cy, len, wid, hgt, col) => { box(M, 0, cy, H + hgt / 2 - 0.04, wid, len, hgt, col); };
    const topH = def => Math.max(0.14, (S.top && S.top[S.prop] != null ? S.top[S.prop] - H : def));
    if (!tram) {
      for (const s of sections) {
        const rearEnd = s.y0 + 2.0, centre = (s.y0 + s.y1) / 2;
        if (S.prop === 'electric') { roofBox(centre - 0.4, Math.min(5.4, s.y1 - s.y0 - 2.4), 1.75, topH(0.34), C.gear); roofBox(s.y1 - 1.6, 1.2, 1.4, Math.min(0.2, topH(0.2)), C.gearDark); }
        else if (S.prop === 'hybrid') { roofBox(rearEnd + 0.4, 2.8, 1.45, topH(0.30), C.gear); roofBox(rearEnd + 2.4, 1.1, 1.2, Math.min(0.2, topH(0.2)), C.gearDark); }
        else if (!S.cutaway || s.i === 0) { roofBox(rearEnd + 0.2, 1.9, 1.3, topH(0.22), C.gear); }
      }
    } else {
      for (const s of sections) {
        const cy = (s.y0 + s.y1) / 2;
        if (S.bigBox) roofBox(cy - 1.0, 3.6, 1.5, 0.45, C.gear);                                // ALRV: large air-intake box on each section
        else if (!S.pole) roofBox(cy - (s.i === S.pantoSection ? 1.8 : 0), Math.min(2.0, s.y1 - s.y0 - 1.5), 1.5, 0.28, C.gear);
      }
      if (S.pole) {                                                                              // trolley pole: base on the roof, pole trailing backwards to the wire
        const py = S.poleY, zr = H - 0.04;
        box(M, 0, py, zr + 0.1, 0.9, 0.9, 0.16, C.gearDark);
        strut(M, [0, py + 0.2, zr + 0.2], [0, py - 4.3, zr + 2.3], 0.09, C.black);
        box(M, 0, py - 4.45, zr + 2.42, 0.16, 0.34, 0.14, C.black);                              // trolley head
      } else {
        const ps = sections[Math.min(S.pantoSection, last)], py = (ps.y0 + ps.y1) / 2 + 0.9, zr = H - 0.04;
        const f = S.pantoTop ? (S.pantoTop - zr - 0.05) / 1.2 : 1;                                // scale the diamond to the published 3.84 m
        box(M, 0, py, zr + 0.06, 1.1, 1.6, 0.1, C.gearDark);                                      // insulator base
        for (const s of [-1, 1]) {
          strut(M, [s * 0.35, py - 0.7, zr + 0.1], [s * 0.3, py - 0.05, zr + 0.65 * f], 0.07, C.black);
          strut(M, [s * 0.35, py + 0.7, zr + 0.1], [s * 0.3, py + 0.05, zr + 0.65 * f], 0.07, C.black);
          strut(M, [s * 0.3, py - 0.05, zr + 0.65 * f], [s * 0.25, py, zr + 1.2 * f], 0.06, C.black);
        }
        box(M, 0, py, zr + 1.2 * f + 0.05, 1.9, 0.5, 0.07, C.black);                              // collector head
      }
    }

    // ---- accent (data colour): outline on the ground + roof stripe ---------------------------------------------------
    const m0 = 0.22, ox = W / 2 + m0, oy = L / 2 + m0, th = 0.2;
    box(A, -ox, 0, 0.03, th, 2 * oy, 0.05, '#fff'); box(A, ox, 0, 0.03, th, 2 * oy, 0.05, '#fff');
    box(A, 0, -oy, 0.03, 2 * ox, th, 0.05, '#fff'); box(A, 0, oy, 0.03, 2 * ox, th, 0.05, '#fff');
    box(A, 0, yFront - 1.7, H + 0.015, 0.7, 1.6, 0.04, '#fff');                             // roof patch near the front, clear of the equipment

    return { body: M.geometry(), accent: A.geometry(), spec: S };
  }

  root.VehicleModels = { FAMILIES, specFor, build };
})(typeof window !== 'undefined' ? window : globalThis);
