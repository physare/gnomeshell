// One-click shell slicing for GnomeShell.
//
// The shell is cut into layers (like the slabs of a plaster mother mold), and
// each layer is kept whole or split in two by a cut square to the layers. The
// layer positions and each layer's split are picked together by dynamic
// programming, to keep the overhang low with as few pieces as possible, and no
// piece smaller than a set share of the shell. It is also tried on each half of
// the first cut, and the best layout, scored by the app's own overhang check,
// wins.
//
// Overhang of any region (layers i..j, one side of a split) for any pull
// direction comes from 2D prefix sums, so one plan takes well under a second.
import * as THREE from "three";
import { evaluate, polyVerts, cutNormal, angles, canonical } from "./tree.js";

const V3 = THREE.Vector3;

// Points through the shell (the box minus the latex), on a grid in the box's frame.
export function shellVoxels(tri, verts, T0, target = 120000) {
  const F = T0.frame, lo = T0.boxLo, hi = T0.boxHi;
  const vol = (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]);
  const h = Math.cbrt(vol / target);
  const nx = Math.max(1, Math.round((hi[0] - lo[0]) / h)), ny = Math.max(1, Math.round((hi[1] - lo[1]) / h)), nz = Math.max(1, Math.round((hi[2] - lo[2]) / h));
  const hx = (hi[0] - lo[0]) / nx, hy = (hi[1] - lo[1]) / ny, hz = (hi[2] - lo[2]) / nz;
  // where the latex surface crosses each upright column, to tell inside from out
  const cols = Array.from({ length: nx * ny }, () => []);
  const fx = (i) => verts[i] * F.ex.x + verts[i + 1] * F.ex.y + verts[i + 2] * F.ex.z;
  const fy = (i) => verts[i] * F.ey.x + verts[i + 1] * F.ey.y + verts[i + 2] * F.ey.z;
  for (let t = 0; t < tri.n; t++) {
    const a = t * 9, b = a + 3, c = a + 6;
    const ax = fx(a), ay = fy(a), bx = fx(b), by = fy(b), cx = fx(c), cy = fy(c);
    const az = verts[a + 2], bz = verts[b + 2], cz = verts[c + 2];
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-12) continue;
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - lo[0]) / hx - 0.5)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - lo[0]) / hx - 0.5));
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - lo[1]) / hy - 0.5)), j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - lo[1]) / hy - 0.5));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const px = lo[0] + (i + 0.5) * hx, py = lo[1] + (j + 0.5) * hy;
      const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den, l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den, l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      cols[i * ny + j].push(l1 * az + l2 * bz + l3 * cz);
    }
  }
  const pts = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const zs = cols[i * ny + j].sort((p, q) => p - q);
    let k = 0;
    const x = lo[0] + (i + 0.5) * hx, y = lo[1] + (j + 0.5) * hy;
    for (let l = 0; l < nz; l++) {
      const z = lo[2] + (l + 0.5) * hz;
      while (k < zs.length && zs[k] < z) k++;
      if (k % 2 === 0) pts.push(F.ex.x * x + F.ey.x * y, F.ex.y * x + F.ey.y * y, z);
    }
  }
  return { pts: Float32Array.from(pts), cell: hx * hy * hz };
}

function perp(s, az) {
  const a = Math.abs(s.z) < 0.9 ? new V3(0, 0, 1) : new V3(1, 0, 0);
  const u = a.clone().cross(s).normalize(), v = s.clone().cross(u);
  const r = az * Math.PI / 180;
  return u.multiplyScalar(Math.cos(r)).addScaledVector(v, Math.sin(r));
}

// The best layers square to s (and each layer's split) for the faces and shell
// points picked by o.faceMask / o.voxMask (all when absent).
// o: {tol, minFrac, lambda, step, splitTurns, splitBins, sphere, wt}
export function layerPlan(tri, vox, boxVerts, s, o) { return layerTables(tri, vox, boxVerts, s, o)(o.lambda); }
// The tables behind layerPlan, built once; returns plan(lambda).
// o.wt: area each face stands for (a sample of the faces on a big scan), else its own.
export function layerTables(tri, vox, boxVerts, s, o) {
  const tol = o.tol, total = tri.total, minVox = o.minFrac * vox.pts.length / 3;
  const fm = o.faceMask, vm = o.voxMask;
  const range = (n) => { let a = Infinity, b = -Infinity; for (const v of boxVerts) { const t = n.dot(v); a = Math.min(a, t); b = Math.max(b, t); } return [a, b]; };
  const [sa, sb] = range(s);
  const N = Math.max(4, Math.min(o.maxBins || 48, Math.round((sb - sa) / (o.step || 4))));
  const gs = (sb - sa) / N;
  const M = o.splitTurns || 12, Q = o.splitBins || 16;
  const ns = [], nr = [];
  for (let m = 0; m < M; m++) { const n = perp(s, m * 180 / M); ns.push(n); nr.push(range(n)); }
  // pull directions: straight up, flat sideways every 5°, square to the layers
  // every 7.5°, and spread over the sphere. Never down: pieces lift or slide off.
  const D = [];
  const add = (d) => { if (d.z >= -1e-6) D.push(d); };
  add(new V3(0, 0, 1));
  for (let a = 0; a < 360; a += 5) add(new V3(Math.cos(a * Math.PI / 180), Math.sin(a * Math.PI / 180), 0));
  for (let a = 0; a < 360; a += 7.5) add(perp(s, a));
  const NF = o.sphere || 300;
  for (let i = 0; i < NF; i++) {
    const z = 1 - 2 * (i + 0.5) / NF, r = Math.sqrt(1 - z * z), a = (i + 0.5) * Math.PI * (3 - Math.sqrt(5));
    add(new V3(r * Math.cos(a), r * Math.sin(a), z));
  }
  const K = D.length;
  // which layer bin, and which bin along each split normal, each face is in
  const sBin = new Int16Array(tri.n), qBin = new Int16Array(tri.n * M);
  for (let f = 0; f < tri.n; f++) {
    const x = tri.cen[f * 3], y = tri.cen[f * 3 + 1], z = tri.cen[f * 3 + 2];
    sBin[f] = Math.max(0, Math.min(N - 1, Math.floor((s.x * x + s.y * y + s.z * z - sa) / gs)));
    for (let m = 0; m < M; m++) { const n = ns[m], r = nr[m]; qBin[f * M + m] = Math.max(0, Math.min(Q - 1, Math.floor((n.x * x + n.y * y + n.z * z - r[0]) / (r[1] - r[0]) * Q))); }
  }
  // G[m][k]: prefix sums over (layer bin, split bin) of the area that catches when pulled along D[k]
  const W = (N + 1) * (Q + 1);
  const G = new Float64Array(M * K * W);
  const bad = new Uint8Array(K);
  const wt = o.wt;
  for (let f = 0; f < tri.n; f++) {
    if (fm && !fm[f]) continue;
    const ar = wt ? wt[f] : tri.area[f];
    if (!ar) continue;
    const nx = tri.nor[f * 3], ny = tri.nor[f * 3 + 1], nz = tri.nor[f * 3 + 2];
    let any = false;
    for (let k = 0; k < K; k++) { const d = D[k]; bad[k] = nx * d.x + ny * d.y + nz * d.z < -tol ? 1 : 0; any = any || bad[k]; }
    if (!any) continue;
    const sb1 = sBin[f] + 1;
    for (let m = 0; m < M; m++) {
      const cell = sb1 * (Q + 1) + qBin[f * M + m] + 1, base = m * K * W;
      for (let k = 0; k < K; k++) if (bad[k]) G[base + k * W + cell] += ar;
    }
  }
  const V = new Float64Array(M * W);
  const P = vox.pts;
  for (let p = 0, pi = 0; p < P.length; p += 3, pi++) {
    if (vm && !vm[pi]) continue;
    const x = P[p], y = P[p + 1], z = P[p + 2];
    const sb1 = Math.max(0, Math.min(N - 1, Math.floor((s.x * x + s.y * y + s.z * z - sa) / gs))) + 1;
    for (let m = 0; m < M; m++) {
      const n = ns[m], r = nr[m];
      const q = Math.max(0, Math.min(Q - 1, Math.floor((n.x * x + n.y * y + n.z * z - r[0]) / (r[1] - r[0]) * Q)));
      V[m * W + sb1 * (Q + 1) + q + 1] += 1;
    }
  }
  const pref = (A, off) => {
    for (let i = 1; i <= N; i++) for (let q = 1; q <= Q; q++) {
      const c = off + i * (Q + 1) + q;
      A[c] += A[c - 1] + A[c - (Q + 1)] - A[c - (Q + 1) - 1];
    }
  };
  for (let m = 0; m < M; m++) { pref(V, m * W); for (let k = 0; k < K; k++) pref(G, (m * K + k) * W); }
  const rect = (A, off, i, j, q0, q1) => A[off + j * (Q + 1) + q1] - A[off + i * (Q + 1) + q1] - A[off + j * (Q + 1) + q0] + A[off + i * (Q + 1) + q0];
  // a half that doesn't lean into the other half can come off first
  const free = ns.map((n) => [D.map((d) => d.dot(n) >= -0.05), D.map((d) => d.dot(n) <= 0.05)]);
  // each layer's best (whole or split) doesn't depend on the piece cost, only which wins does
  const memo = new Map();
  const options = (i, j) => {
    const key = i * (N + 1) + j;
    if (memo.has(key)) return memo.get(key);
    let whole = null, split = null;
    const vol = rect(V, 0, i, j, 0, Q);
    if (vol >= minVox) {
      let ov = Infinity;
      for (let k = 0; k < K; k++) { const v = rect(G, k * W, i, j, 0, Q); if (v < ov) ov = v; }
      whole = { over: ov, pieces: 1 };
    }
    for (let m = 0; m < M; m++) for (let q = 1; q < Q; q++) {
      if (rect(V, m * W, i, j, q, Q) < minVox || rect(V, m * W, i, j, 0, q) < minVox) continue;
      let op = Infinity, on = Infinity, opF = Infinity, onF = Infinity;
      const ok = free[m];
      for (let k = 0; k < K; k++) {
        const off = (m * K + k) * W;
        const a = rect(G, off, i, j, q, Q), b = rect(G, off, i, j, 0, q);
        if (a < op) op = a;
        if (b < on) on = b;
        if (ok[0][k] && a < opF) opF = a;
        if (ok[1][k] && b < onF) onF = b;
      }
      const ov = Math.min(opF + on, op + onF);
      if (!split || ov < split.over) split = { over: ov, pieces: 2, m, q };
    }
    const r = { whole, split };
    memo.set(key, r);
    return r;
  };
  return (lambda) => plan(lambda);
  function plan(lambda) {
  const lam = lambda * total;
  const empty = (i, j) => rect(V, 0, i, j, 0, Q) < 0.5 && rect(G, 0, i, j, 0, Q) === 0;
  function layer(i, j) {
    const { whole, split } = options(i, j);
    let best = { cost: Infinity };
    if (whole) best = { cost: whole.over + lam, ...whole };
    if (split && split.over + 2 * lam < best.cost) best = { cost: split.over + 2 * lam, ...split };
    return best;
  }
  // the region may not fill the whole range along s (one half of the first cut): skip empty ends
  let i0 = 0, i1 = N;
  while (i0 < N - 1 && empty(i0, i0 + 1)) i0++;
  while (i1 > i0 + 1 && empty(i1 - 1, i1)) i1--;
  const f = new Float64Array(N + 1).fill(Infinity), from = new Int32Array(N + 1).fill(-1), pick = new Array(N + 1);
  f[i0] = 0;
  for (let j = i0 + 1; j <= i1; j++) for (let i = i0; i < j; i++) {
    if (!Number.isFinite(f[i])) continue;
    const L = layer(i, j);
    if (f[i] + L.cost < f[j]) { f[j] = f[i] + L.cost; from[j] = i; pick[j] = L; }
  }
  if (!Number.isFinite(f[i1])) return null;
  const layers = [];
  // plain numbers only, so a plan doesn't keep the tables alive
  for (let j = i1; j > i0; j = from[j]) {
    const L = pick[j];
    layers.unshift({ i: from[j], j, over: L.over, pieces: L.pieces, lo: sa + from[j] * gs, hi: sa + j * gs,
      split: L.pieces === 2 ? { n: ns[L.m].clone(), d: nr[L.m][0] + (nr[L.m][1] - nr[L.m][0]) * L.q / Q } : null });
  }
  return { s: s.clone(), layers, cost: f[i1], over: layers.reduce((t, l) => t + l.over, 0), pieces: layers.reduce((t, l) => t + l.pieces, 0) };
  }
}

// Add a plan's cuts to `cuts`, inside block `parent` (null: the whole shell).
// mk(parent, normal) makes a cut; placeAt(cuts, cut, point) puts it through point.
export function addPlanCuts(cuts, plan, parent, ctx) {
  const s = plan.s, inside = (id) => parent == null || id === parent || id.startsWith(parent + ".");
  const T0 = evaluate(cuts, ctx.tri, ctx.verts, ctx.opts);
  const host = parent == null ? null : T0.cells.find((C) => C.id === parent);
  const c0 = host ? host.centroid : ctx.centre;
  for (const l of plan.layers.slice(1)) {
    const d = l.lo;
    ctx.placeAt(cuts, ctx.mk(parent, s), c0.clone().addScaledVector(s, d - s.dot(c0)));
  }
  const T = evaluate(cuts, ctx.tri, ctx.verts, ctx.opts);
  for (const l of plan.layers) {
    if (l.pieces !== 2) continue;
    const lo = l.lo, hi = l.hi;
    const L = T.cells.find((C) => { if (!inside(C.id)) return false; const t = s.dot(C.centroid); return t > lo && t < hi; });
    if (!L) continue;
    const sp = l.split;
    const pt = L.centroid.clone().addScaledVector(sp.n, sp.d - sp.n.dot(L.centroid));
    ctx.placeAt(cuts, ctx.mk(L.id === "0" ? null : L.id, sp.n), pt);
  }
  return cuts;
}

// Layouts to try: layers through the whole shell along each of the box's axes
// (and the first cut's), and the first cut with each half layered its own best
// way, at a few piece costs. ctx: {tri, verts, opts, bins, first, mk, placeAt,
// centre, tol, minFrac, frame}. Returns [{name, cuts}].
export function candidates(ctx, vox, lambdas = [0.0015, 0.004, 0.01]) {
  const F = ctx.frame;
  const T0 = evaluate([ctx.first], ctx.tri, ctx.verts, ctx.opts);
  const boxVerts = polyVerts(T0.boxPoly);
  const dirs = { "across": F.ex.clone(), "front to back": F.ey.clone(), "level": F.ez.clone() };
  const n1 = cutNormal(ctx.first);
  if (Math.abs(n1.dot(F.ey)) < 0.999 && Math.abs(n1.z) < 0.999) dirs["along the first cut"] = n1.clone();
  const out = [];
  const o = { tol: ctx.tol, minFrac: ctx.minFrac, wt: ctx.wt };
  // layers through the whole shell
  for (const [name, s] of Object.entries(dirs)) {
    const plan = layerTables(ctx.tri, vox, boxVerts, s, o);
    for (const lambda of lambdas) {
      const P = plan(lambda);
      if (P) out.push({ name: `layers ${name}`, lambda, est: P.cost, build: () => addPlanCuts([], P, null, ctx) });
    }
  }
  // the first cut, then each half layered its own way
  const halves = T0.cells.map((C) => {
    const fm = new Uint8Array(ctx.tri.n);
    for (const f of C.faces) fm[f] = 1;
    const vm = new Uint8Array(vox.pts.length / 3);
    for (let p = 0, pi = 0; p < vox.pts.length; p += 3, pi++) {
      const x = vox.pts[p], y = vox.pts[p + 1], z = vox.pts[p + 2];
      vm[pi] = C.hs.every((h) => h.n.x * x + h.n.y * y + h.n.z * z - h.d >= 0) ? 1 : 0;
    }
    // the best plan at each piece cost, over every direction
    const best = lambdas.map(() => null);
    for (const s of Object.values(dirs)) {
      const t = layerTables(ctx.tri, vox, boxVerts, s, { ...o, faceMask: fm, voxMask: vm });
      lambdas.forEach((lambda, li) => { const P = t(lambda); if (P && (!best[li] || P.cost < best[li].cost)) best[li] = P; });
    }
    return { id: C.id, best };
  });
  for (const [li, lambda] of lambdas.entries()) {
    const plans = halves.map((h) => ({ id: h.id, plan: h.best[li] }));
    if (!plans.every((h) => h.plan)) continue;
    out.push({
      name: "first cut, then each half in layers", lambda, est: plans.reduce((t, h) => t + h.plan.cost, 0),
      build: () => {
        const cuts = [{ ...ctx.first }];
        // the halves' ids once the first cut is in
        const T1 = evaluate(cuts, ctx.tri, ctx.verts, ctx.opts);
        plans.forEach((h, i) => {
          const C = T1.cells.find((L) => L.id === h.id) || T1.cells[i];
          addPlanCuts(cuts, h.plan, C.id, ctx);
        });
        return cuts;
      },
    });
  }
  return out;
}

// share of the shell each piece holds, from the shell points
export function pieceShares(T, vox) {
  const P = vox.pts, cnt = new Float64Array(T.pieces.length), pieceOfCell = new Int32Array(T.cells.length).fill(-1);
  T.pieces.forEach((Pc, k) => Pc.cells.forEach((ci) => { pieceOfCell[ci] = k; }));
  const hs = T.cells.map((C) => C.hs.map((h) => [h.n.x, h.n.y, h.n.z, h.d]));
  for (let p = 0; p < P.length; p += 3) {
    const x = P[p], y = P[p + 1], z = P[p + 2];
    for (let ci = 0; ci < hs.length; ci++) {
      let ok = true;
      for (const h of hs[ci]) if (h[0] * x + h[1] * y + h[2] * z - h[3] < 0) { ok = false; break; }
      if (ok) { cnt[pieceOfCell[ci]]++; break; }
    }
  }
  const n = P.length / 3;
  return Array.from(cnt, (c) => c / n);
}

// ---------------------------------------------------------------- split the worst piece
// Directions a piece may come off: straight up, flat every 5°, and spread over
// the upper half of the sphere. Never down.
function pullDirs(nSphere = 200) {
  const D = [new V3(0, 0, 1)];
  for (let a = 0; a < 360; a += 5) D.push(new V3(Math.cos(a * Math.PI / 180), Math.sin(a * Math.PI / 180), 0));
  for (let i = 0; i < nSphere; i++) {
    const z = 1 - (i + 0.5) / nSphere, r = Math.sqrt(1 - z * z), a = (i + 0.5) * Math.PI * (3 - Math.sqrt(5));
    D.push(new V3(r * Math.cos(a), r * Math.sin(a), z));
  }
  return D;
}
// On a big scan, a sample of the faces (picked along the running total of
// area, so big faces count as often as their size), each standing for the
// same share of the area. null when the scan is small enough to use them all.
function faceSample(tri, target = 30000) {
  if (tri.n <= target * 1.2) return null;
  const step = tri.total / target, wt = new Float64Array(tri.n);
  let acc = 0, next = step / 2;
  for (let f = 0; f < tri.n; f++) {
    acc += tri.area[f];
    while (acc >= next) { wt[f] += step; next += step; }
  }
  return wt;
}
// which of D each face catches on, one bit each
function catchBits(tri, D, tol, wt) {
  const K = D.length, W = Math.ceil(K / 32), bits = new Uint32Array(tri.n * W);
  const dx = Float64Array.from(D, (d) => d.x), dy = Float64Array.from(D, (d) => d.y), dz = Float64Array.from(D, (d) => d.z);
  for (let f = 0; f < tri.n; f++) {
    if (wt && !wt[f]) continue;
    const nx = tri.nor[f * 3], ny = tri.nor[f * 3 + 1], nz = tri.nor[f * 3 + 2], fb = f * W;
    for (let k = 0; k < K; k++) if (nx * dx[k] + ny * dy[k] + nz * dz[k] < -tol) bits[fb + (k >> 5)] |= 1 << (k & 31);
  }
  return { D, K, W, bits };
}
// Planes a piece may be split by: upright every 15° from the box's front,
// tipped either way by up to 30° (or the steepest cut allowed), and level.
function splitNormals(F, maxTilt) {
  const out = [], a0 = Math.atan2(F.ey.y, F.ey.x), t = Math.min(30, maxTilt ?? 30);
  const tilts = t >= 5 ? [0, -t, t] : [0];
  for (let j = 0; j < 12; j++) {
    const a = a0 + j * Math.PI / 12;
    for (const tt of tilts) { const r = tt * Math.PI / 180; out.push(new V3(Math.cos(a) * Math.cos(r), Math.sin(a) * Math.cos(r), Math.sin(r))); }
  }
  out.push(new V3(0, 0, 1));
  return out;
}
// The best plane from `normals` to split a piece in two: each half pulled its
// own best way, and one of them able to come off without leaning into the other.
// Both halves keep at least minVox shell points. Returns {best, whole}.
function bestSplit(tri, cb, faces, pts, verts, normals, minVox, Q = 20) {
  const { D, K, W, bits, wt } = cb;
  if (wt) faces = Int32Array.from(faces).filter((f) => wt[f] > 0);
  const area = wt || tri.area;
  const G = new Float64Array(Q * K), Vq = new Float64Array(Q), low = new Float64Array(K), tot = new Float64Array(K);
  for (const f of faces) {
    const a = area[f], fb = f * W;
    for (let w = 0; w < W; w++) { let word = bits[fb + w]; while (word) { const t = word & -word; tot[(w << 5) + 31 - Math.clz32(t)] += a; word ^= t; } }
  }
  let whole = Infinity;
  for (let k = 0; k < K; k++) if (tot[k] < whole) whole = tot[k];
  const vt = pts.length / 3;
  let best = null;
  for (const n of normals) {
    let lo = Infinity, hi = -Infinity;
    for (const v of verts) { const t = n.dot(v); if (t < lo) lo = t; if (t > hi) hi = t; }
    if (!(hi - lo > 1e-6)) continue;
    const sc = Q / (hi - lo), bin = (t) => Math.max(0, Math.min(Q - 1, Math.floor((t - lo) * sc)));
    G.fill(0); Vq.fill(0);
    for (const f of faces) {
      const base = bin(tri.cen[f * 3] * n.x + tri.cen[f * 3 + 1] * n.y + tri.cen[f * 3 + 2] * n.z) * K, a = area[f], fb = f * W;
      for (let w = 0; w < W; w++) { let word = bits[fb + w]; while (word) { const t = word & -word; G[base + (w << 5) + 31 - Math.clz32(t)] += a; word ^= t; } }
    }
    for (let p = 0; p < pts.length; p += 3) Vq[bin(n.x * pts[p] + n.y * pts[p + 1] + n.z * pts[p + 2])]++;
    const fp = D.map((d) => d.dot(n) >= -0.05), fn = D.map((d) => d.dot(n) <= 0.05);
    low.fill(0);
    let vlo = 0;
    for (let q = 1; q < Q; q++) {
      for (let k = 0; k < K; k++) low[k] += G[(q - 1) * K + k];
      vlo += Vq[q - 1];
      if (vlo < minVox || vt - vlo < minVox) continue;
      let op = Infinity, on = Infinity, opF = Infinity, onF = Infinity;
      for (let k = 0; k < K; k++) {
        const b = low[k], a = tot[k] - b;
        if (a < op) op = a;
        if (b < on) on = b;
        if (fp[k] && a < opF) opF = a;
        if (fn[k] && b < onF) onF = b;
      }
      const cost = Math.min(opF + on, op + onF);
      if (!best || cost < best.cost) best = { n, d: lo + (hi - lo) * q / Q, cost };
    }
  }
  return { best, whole };
}
function pointsIn(P, cells) {
  const hs = cells.map((C) => C.hs.map((h) => [h.n.x, h.n.y, h.n.z, h.d]));
  const out = [];
  for (let p = 0; p < P.length; p += 3) {
    const x = P[p], y = P[p + 1], z = P[p + 2];
    for (const H of hs) {
      let ok = true;
      for (const h of H) if (h[0] * x + h[1] * y + h[2] * z - h[3] < 0) { ok = false; break; }
      if (ok) { out.push(x, y, z); break; }
    }
  }
  return Float32Array.from(out);
}
// Put cut c through point, as a fraction of the range it can slide over. False if it cuts nothing.
export function placeAt(ctx, cuts, c, point) {
  cuts.push(c);
  const i = cuts.length - 1;
  const inf = evaluate(cuts, ctx.tri, ctx.verts, ctx.opts, i + 1).info[i];
  if (!inf || !inf.valid) { cuts.pop(); return false; }
  const t = cutNormal(c).dot(point);
  c.pos = Math.max(0.01, Math.min(0.99, (t - inf.range[0]) / (inf.range[1] - inf.range[0] || 1)));
  return true;
}
// From a starting layout, keep splitting the piece with the most overhang the
// best way, while a split takes off at least 0.2% of the latex. Returns each
// layout on the way: [{cuts, T}].
export async function splitWorst(ctx, start, cb, vox) {
  const total = ctx.tri.total, cuts = start.cuts.map((c) => ({ ...c })), joins = start.joins || [];
  const out = [], stuck = new Set();
  for (;;) {
    const T = ctx.compute(cuts, joins);
    out.push({ cuts: cuts.map((c) => ({ ...c })), T });
    if (T.pieces.length >= ctx.maxPieces) break;
    const order = T.pieces.map((_, i) => i).sort((a, b) => T.badBy[b] - T.badBy[a]);
    let split = false;
    for (const i of order) {
      if (T.badBy[i] < 0.002 * total) break;
      const P = T.pieces[i], cells = P.cells.map((ci) => T.cells[ci]), key = cells.map((L) => L.id).join();
      if (stuck.has(key)) continue;
      const pts = pointsIn(vox.pts, cells), verts = cells.flatMap((L) => polyVerts(L.poly));
      const { best, whole } = bestSplit(ctx.tri, cb, P.faces, pts, verts, ctx.normals, ctx.minVox);
      if (!best || whole - best.cost < 0.002 * total) { stuck.add(key); continue; }
      const parent = cells.length === 1 ? cells[0].id : cells.map((L) => L.id);
      const c0 = cells[0].centroid;
      if (!ctx.placeAt(cuts, ctx.mk(parent, best.n), c0.clone().addScaledVector(best.n, best.d - best.n.dot(c0)))) { stuck.add(key); continue; }
      split = true; break;
    }
    if (!split) break;
    await ctx.say?.(`Splitting the piece with the most overhang · ${cuts.length + 1} pieces`);
  }
  return out;
}

// ---------------------------------------------------------------- one click
// Every way above, each scored by the app's own overhang check, best first.
// ctx: {tri, verts, opts, tol, first, centre, minFrac, maxPieces, maxTilt,
//       penalty (overhang % one more piece must save), compute(cuts, joins) → T,
//       nextId(), say(text) (async)}
function prepare(ctx) {
  const T0 = evaluate([ctx.first], ctx.tri, ctx.verts, ctx.opts), F = T0.frame;
  const vox = shellVoxels(ctx.tri, ctx.verts, T0);
  const wt = faceSample(ctx.tri);
  const cb = { ...catchBits(ctx.tri, pullDirs(), ctx.tol, wt), wt };
  // a level cut first in the list leans 0.1° toward the box's front, so the box keeps its turn
  const mk = (parent, n) => {
    if (parent == null && Math.abs(n.z) > 0.999) n = n.clone().addScaledVector(F.ey, 0.00175).normalize();
    return { id: ctx.nextId(), parent, ...angles(canonical(n)), pos: 0.5, auto: true };
  };
  const env = { ...ctx, wt, frame: F, mk, placeAt: (cuts, c, pt) => placeAt(ctx, cuts, c, pt), normals: splitNormals(F, ctx.maxTilt), minVox: ctx.minFrac * vox.pts.length / 3 };
  return { env, vox, cb };
}
// "Suggest more cuts": from the layout as it is, split the worst piece again and
// again. Returns each layout on the way, with its overhang %, the layout as it is first.
export async function suggestMore(ctx, start) {
  await ctx.say?.("Mapping the shell");
  const { env, vox, cb } = prepare(ctx);
  const total = ctx.tri.total;
  return (await splitWorst(env, start, cb, vox)).map((st) => ({ cuts: st.cuts, pieces: st.T.pieces.length, over: 100 * st.T.bad / total, locked: st.T.locked.length }));
}
export async function sliceShell(ctx) {
  const total = ctx.tri.total;
  await ctx.say?.("Mapping the shell");
  const { env, vox, cb } = prepare(ctx);
  const layouts = [];
  await ctx.say?.("Splitting the piece with the most overhang");
  for (const st of await splitWorst(env, { cuts: [ctx.first] }, cb, vox)) layouts.push({ how: "worst", cuts: st.cuts, T: st.T });
  await ctx.say?.("Trying layers");
  for (const c of candidates(env, vox)) {
    try { const cuts = c.build(); if (cuts.length) layouts.push({ how: c.name, cuts }); } catch (e) { /* a plan that doesn't place */ }
  }
  await ctx.say?.(`Checking ${layouts.length} layouts`);
  const seen = new Map();
  for (const L of layouts) {
    const T = L.T || ctx.compute(L.cuts, []);
    const shares = pieceShares(T, vox);
    const r = { how: L.how, cuts: L.cuts, pieces: T.pieces.length, over: 100 * T.bad / total, locked: T.locked.length, minShare: Math.min(...shares) };
    r.ok = !r.locked && r.minShare >= ctx.minFrac - 0.005 && r.pieces <= ctx.maxPieces;
    r.score = r.over + ctx.penalty * r.pieces + (r.ok ? 0 : 1000);
    const k = `${r.pieces}|${r.over.toFixed(2)}`;
    if (!seen.has(k) || seen.get(k).score > r.score) seen.set(k, r);
  }
  return [...seen.values()].sort((a, b) => a.score - b.score);
}
