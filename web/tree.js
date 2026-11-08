// Cut tree geometry for GnomeShell.
// A cut splits either the whole shell (parent null) or one piece (parent = piece id).
// Each piece is the box cut down to the kept side of its planes, so it is a
// convex block; we keep it as a list of polygon faces.
import * as THREE from "three";

const V3 = THREE.Vector3;
export const rad = (d) => d * Math.PI / 180;
export const deg = (r) => r * 180 / Math.PI;

// ------------------------------------------------------------ normals
// Upright cuts: turn 0-180, tilt up to 45. Level cuts: n points up, leaning
// by tilt toward the turn direction. Both forms are "canonical", so the two
// sides of a cut keep the same names (p = normal side, n = other side).
export function cutNormal(c) {
  const a = rad(c.az), t = rad(c.tilt);
  if (c.kind === "level") return new V3(Math.sin(t) * Math.cos(a), Math.sin(t) * Math.sin(a), Math.cos(t));
  return new V3(Math.cos(t) * Math.cos(a), Math.cos(t) * Math.sin(a), Math.sin(t));
}
export function canonical(n) {
  n = n.clone().normalize();
  ["x", "y", "z"].forEach((k) => { if (Math.abs(n[k]) < 1e-7) n[k] = 0; });
  if (Math.abs(n.z) > Math.SQRT1_2) return n.z > 0 ? n : n.negate();
  if (n.y < -1e-9 || (Math.abs(n.y) <= 1e-9 && n.x < 0)) n.negate();
  return n;
}
export function angles(nIn) {
  const n = canonical(nIn);
  const r10 = (x) => Math.round(x * 10) / 10 || 0; // also turns -0 into 0
  if (Math.abs(n.z) > Math.SQRT1_2) {
    let t = r10(deg(Math.acos(Math.min(1, n.z)))), az = Math.hypot(n.x, n.y) < 1e-6 ? 0 : r10(deg(Math.atan2(n.y, n.x)));
    if (az < 0) { az += 180; t = -t; }
    if (az >= 180) { az -= 180; t = -t; }
    return { kind: "level", az, tilt: t };
  }
  let az = r10(deg(Math.atan2(n.y, n.x)));
  if (az >= 180) az -= 180;
  if (az < 0) az += 180;
  return { kind: "upright", az, tilt: r10(deg(Math.asin(Math.max(-1, Math.min(1, n.z))))) };
}

// ------------------------------------------------------------ polytopes
function clipPolygon(pts, n, d, capPts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const da = n.dot(a) - d, db = n.dot(b) - d;
    if (da >= 0) { out.push(a); if (da < 1e-7) capPts.push(a); }
    if ((da >= 0) !== (db >= 0)) { const p = a.clone().lerp(b, da / (da - db)); out.push(p); capPts.push(p); }
  }
  return out;
}
function dedupe(pts, eps = 1e-4) {
  const out = [];
  for (const p of pts) if (!out.some((q) => q.distanceToSquared(p) < eps * eps)) out.push(p);
  return out;
}
function basis(n) {
  const u = Math.abs(n.z) < 0.9 ? new V3(0, 0, 1).cross(n).normalize() : new V3(1, 0, 0).cross(n).normalize();
  return [u, n.clone().cross(u)];
}
function orderLoop(pts, n) {
  if (pts.length < 3) return pts;
  const c = pts.reduce((s, p) => s.add(p), new V3()).multiplyScalar(1 / pts.length);
  const [u, v] = basis(n);
  return pts.map((p) => ({ p, a: Math.atan2(p.clone().sub(c).dot(v), p.clone().sub(c).dot(u)) })).sort((x, y) => x.a - y.a).map((x) => x.p);
}
export function clipPolytope(poly, n, d, tag) {
  const faces = [], capPts = [];
  for (const f of poly.faces) {
    const q = clipPolygon(f.pts, n, d, capPts);
    if (q.length >= 3) faces.push({ pts: q, tag: f.tag });
  }
  const cap = orderLoop(dedupe(capPts), n);
  if (cap.length >= 3) faces.push({ pts: cap, tag });
  return { faces, cap: cap.length >= 3 ? cap : null };
}
export function polyVerts(poly) {
  return dedupe(poly.faces.flatMap((f) => f.pts), 1e-3);
}
export function polyArea(pts) {
  if (pts.length < 3) return 0;
  const s = new V3();
  for (let i = 1; i < pts.length - 1; i++) s.add(pts[i].clone().sub(pts[0]).cross(pts[i + 1].clone().sub(pts[0])));
  return s.length() / 2;
}
function boxPolytope(F, lo, hi) {
  const P = (x, y, z) => F.ex.clone().multiplyScalar(x).add(F.ey.clone().multiplyScalar(y)).add(F.ez.clone().multiplyScalar(z));
  const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
  const c = [P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0), P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)];
  const f = (...i) => ({ pts: i.map((k) => c[k].clone()), tag: null });
  return { faces: [f(0, 3, 2, 1), f(4, 5, 6, 7), f(0, 1, 5, 4), f(2, 3, 7, 6), f(1, 2, 6, 5), f(3, 0, 4, 7)] };
}

export function polyNormal(pts) {
  const s = new V3();
  for (let i = 1; i < pts.length - 1; i++) s.add(pts[i].clone().sub(pts[0]).cross(pts[i + 1].clone().sub(pts[0])));
  const l = s.length();
  return l > 1e-9 ? s.divideScalar(l) : null;
}
// volume of a convex polytope (faces in any winding)
export function polyVolume(poly) {
  const vs = polyVerts(poly);
  if (vs.length < 4) return 0;
  const c = vs.reduce((s, v) => s.add(v), new V3()).multiplyScalar(1 / vs.length);
  let vol = 0;
  for (const f of poly.faces) {
    const p = f.pts;
    for (let i = 1; i < p.length - 1; i++) vol += Math.abs(p[0].clone().sub(c).dot(p[i].clone().sub(c).cross(p[i + 1].clone().sub(c)))) / 6;
  }
  return vol;
}
// which side of plane {n, d} a polytope is on: "p", "n" or "both"
export function sideOf(poly, pl) {
  let mn = Infinity, mx = -Infinity;
  for (const v of polyVerts(poly)) { const t = pl.n.dot(v) - pl.d; mn = Math.min(mn, t); mx = Math.max(mx, t); }
  return mx <= 0.5 ? "n" : mn >= -0.5 ? "p" : "both";
}
// "0.3p.7n" -> Map {3: "p", 7: "n"}
export const tokens = (id) => new Map(String(id).split(".").slice(1).map((t) => [+t.slice(0, -1), t.slice(-1)]));

// ------------------------------------------------------------ the tree
// tri: {n, cen, nor, area}; verts: Float32Array of latex vertex positions.
// opts: {wall, trim, pour, flare}
// A cut's parent is null (every piece it crosses), a piece id, or a list of
// piece ids (a piece made of joined blocks). Ids are paths like "0.3p.7n";
// one that no longer matches the tree exactly is read as "the part of the
// shell on those sides of those cuts".
export function evaluate(cuts, tri, verts, opts, upto = cuts.length) {
  const n0 = cuts.length ? cutNormal(cuts[0]) : new V3(0, 1, 0);
  const ez = new V3(0, 0, 1);
  let ey = new V3(n0.x, n0.y, 0);
  ey = ey.length() > 1e-3 ? ey.normalize() : new V3(0, 1, 0);
  const ex = ey.clone().cross(ez).normalize();
  const F = { ex, ey, ez };
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < verts.length; i += 3) {
    const x = verts[i] * ex.x + verts[i + 1] * ex.y, y = verts[i] * ey.x + verts[i + 1] * ey.y, z = verts[i + 2];
    if (x < lo[0]) lo[0] = x; if (x > hi[0]) hi[0] = x;
    if (y < lo[1]) lo[1] = y; if (y > hi[1]) hi[1] = y;
    if (z < lo[2]) lo[2] = z; if (z > hi[2]) hi[2] = z;
  }
  const flare = opts.pour * Math.tan(rad(opts.flare || 0));
  const bLo = [lo[0] - opts.wall - flare, lo[1] - opts.wall - flare, lo[2] - opts.pour + opts.trim];
  const bHi = [hi[0] + opts.wall + flare, hi[1] + opts.wall + flare, hi[2] + opts.wall];
  const boxPoly = boxPolytope(F, bLo, bHi);
  const all = new Int32Array(tri.n); for (let i = 0; i < tri.n; i++) all[i] = i;
  const root = { id: "0", hs: [], poly: boxPoly, faces: all, split: null };
  const nodes = new Map([["0", root]]);
  const planes = new Map(); // cut id -> {n, d}
  let leaves = [root];
  const leafDesc = (node) => node.split ? [...leafDesc(nodes.get(node.split.p)), ...leafDesc(nodes.get(node.split.n))] : [node];
  const resolveIn = (node, toks) => {
    if (!node) return [];
    if (!toks.length) return leafDesc(node);
    const [c, s] = toks[0];
    if (node.split) {
      if (node.split.cut === c) return resolveIn(nodes.get(node.split[s]), toks.slice(1));
      return [...resolveIn(nodes.get(node.split.p), toks), ...resolveIn(nodes.get(node.split.n), toks)];
    }
    const pl = planes.get(c);
    if (!pl) return [];
    return sideOf(node.poly, pl) === s ? resolveIn(node, toks.slice(1)) : [];
  };
  // the current blocks inside a piece id
  const resolve = (id) => {
    const t = String(id).split(".");
    if (t[0] !== "0") return [];
    return resolveIn(root, t.slice(1).map((k) => [+k.slice(0, -1), k.slice(-1)]));
  };
  const info = [];
  for (let ci = 0; ci < Math.min(upto, cuts.length); ci++) {
    const c = cuts[ci];
    const n = cutNormal(c);
    let targets, scopeHs = [], depth = 0;
    if (c.parent == null) targets = leaves.slice();
    else {
      const ids = Array.isArray(c.parent) ? c.parent : [c.parent];
      const seen = new Set(); targets = [];
      for (const id of ids) for (const L of resolve(id)) if (!seen.has(L)) { seen.add(L); targets.push(L); }
      if (!targets.length) { info.push({ valid: false, cutId: c.id }); continue; }
      const keyOf = (h) => h.cut + h.side;
      scopeHs = targets[0].hs.filter((h) => targets.every((L) => L.hs.some((k) => keyOf(k) === keyOf(h))));
      depth = Math.max(...ids.map((id) => String(id).split(".").length - 1));
    }
    const vs = c.parent == null ? polyVerts(boxPoly) : targets.flatMap((L) => polyVerts(L.poly));
    let rlo = Infinity, rhi = -Infinity;
    const cen = new V3();
    for (const v of vs) { const t = n.dot(v); rlo = Math.min(rlo, t); rhi = Math.max(rhi, t); cen.add(v); }
    cen.multiplyScalar(1 / Math.max(1, vs.length));
    const d = rlo + Math.min(0.99, Math.max(0.01, c.pos)) * (rhi - rlo);
    const point = cen.clone().sub(n.clone().multiplyScalar(cen.dot(n) - d));
    const made = [];
    for (const L of targets) {
      let mn = Infinity, mx = -Infinity;
      for (const v of polyVerts(L.poly)) { const t = n.dot(v) - d; mn = Math.min(mn, t); mx = Math.max(mx, t); }
      if (mx <= 0.5 || mn >= -0.5) continue; // this cut doesn't reach that piece
      const P = clipPolytope(L.poly, n, d, { cut: c.id, side: "p" });
      const N = clipPolytope(L.poly, n.clone().negate(), -d, { cut: c.id, side: "n" });
      const fp = [], fn = [];
      for (const f of L.faces) (tri.cen[f * 3] * n.x + tri.cen[f * 3 + 1] * n.y + tri.cen[f * 3 + 2] * n.z - d >= 0 ? fp : fn).push(f);
      const plane = { n: n.clone(), d, cut: c.id, point: n.clone().multiplyScalar(d) };
      const kp = { id: `${L.id}.${c.id}p`, hs: [...L.hs, { ...plane, side: "p" }], poly: P, faces: Int32Array.from(fp), split: null };
      const kn = { id: `${L.id}.${c.id}n`, hs: [...L.hs, { n: n.clone().negate(), d: -d, cut: c.id, side: "n", point: plane.point.clone() }], poly: N, faces: Int32Array.from(fn), split: null };
      L.split = { cut: c.id, p: kp.id, n: kn.id };
      nodes.set(kp.id, kp); nodes.set(kn.id, kn);
      leaves.splice(leaves.indexOf(L), 1, kp, kn);
      made.push(kp.id, kn.id);
    }
    planes.set(c.id, { n: n.clone(), d });
    info.push({ valid: true, cutId: c.id, n, d, point, range: [rlo, rhi], scopeVerts: vs, scopeHs, depth, made, targets: targets.map((L) => L.id) });
  }
  leaves.forEach((L, i) => {
    L.num = i + 1;
    const vs = polyVerts(L.poly);
    L.centroid = vs.reduce((s, v) => s.add(v), new V3()).multiplyScalar(1 / Math.max(1, vs.length));
    L.natural = L.hs.reduce((s, h) => s.add(h.n), new V3());
    L.volume = polyVolume(L.poly);
  });
  const cellOf = new Int16Array(tri.n).fill(-1);
  leaves.forEach((L, i) => { for (const f of L.faces) cellOf[f] = i; });
  return { frame: F, boxLo: bLo, boxHi: bHi, boxPoly, cells: leaves, info, cellOf, planes, resolve };
}

// The face two blocks share, if they touch: {cut, pts, dir from a into b}.
function sharedFace(A, B) {
  for (const fa of A.poly.faces) {
    if (!fa.tag) continue;
    if (!B.poly.faces.some((f) => f.tag && f.tag.cut === fa.tag.cut && f.tag.side !== fa.tag.side)) continue;
    let pts = fa.pts;
    for (const h of B.hs) {
      if (h.cut === fa.tag.cut) continue;
      pts = clipPolygon(pts, h.n, h.d - 1e-6, []);
      if (pts.length < 3) break;
    }
    if (pts.length >= 3 && polyArea(pts) > 1) {
      const ha = A.hs.find((h) => h.cut === fa.tag.cut);
      return { cut: fa.tag.cut, pts, dir: ha.n.clone().negate() };
    }
  }
  return null;
}

// Pieces: blocks joined across the lines you deleted. joins = [[idA, idB]]:
// the line between those two blocks is gone. Blocks inside them that were cut
// later stay joined only where they sit on the same side of those later cuts.
export function group(T, joins) {
  const C = T.cells;
  const cellAdj = [];
  for (let a = 0; a < C.length; a++) for (let b = a + 1; b < C.length; b++) {
    const f = sharedFace(C[a], C[b]);
    if (f) cellAdj.push({ a, b, ...f });
  }
  const up = C.map((_, i) => i);
  const find = (i) => { while (up[i] !== i) i = up[i] = up[up[i]]; return i; };
  const index = new Map(C.map((L, i) => [L, i]));
  const sideIn = (cell, c, toks) => toks.get(c) ?? (T.planes.get(c) ? sideOf(cell.poly, T.planes.get(c)) : "both");
  // a cut laid right along a deleted line brings that line back
  const inScope = (inf, id) => inf.targets.some((t) => id === t || id.startsWith(t + "."));
  const separates = (ca, cb, base) => T.info.some((inf) => {
    if (!inf.valid || base.has(inf.cutId)) return false;
    const pl = T.planes.get(inf.cutId), sa = sideOf(ca.poly, pl), sb = sideOf(cb.poly, pl);
    return sa !== "both" && sb !== "both" && sa !== sb && (inScope(inf, ca.id) || inScope(inf, cb.id));
  });
  for (const [A, B] of joins) {
    const sa = new Set(T.resolve(A).map((L) => index.get(L))), sb = new Set(T.resolve(B).map((L) => index.get(L)));
    if (!sa.size || !sb.size) continue;
    const base = new Set([...tokens(A).keys(), ...tokens(B).keys()]);
    for (const e of cellAdj) {
      let a = e.a, b = e.b;
      if (sa.has(b) && sb.has(a)) [a, b] = [b, a];
      else if (!(sa.has(a) && sb.has(b))) continue;
      const ta = tokens(C[a].id), tb = tokens(C[b].id);
      let ok = true;
      for (const [c, s] of ta) if (!base.has(c) && sideIn(C[b], c, tb) !== s) { ok = false; break; }
      if (ok) for (const [c, s] of tb) if (!base.has(c) && !ta.has(c) && sideIn(C[a], c, ta) !== s) { ok = false; break; }
      if (ok && separates(C[a], C[b], base)) ok = false;
      if (ok) up[find(a)] = find(b);
    }
  }
  const byRoot = new Map();
  C.forEach((_, i) => { const r = find(i); if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(i); });
  const pieces = [...byRoot.values()].sort((x, y) => x[0] - y[0]).map((cells) => {
    let n = 0; cells.forEach((i) => { n += C[i].faces.length; });
    const faces = new Int32Array(n); let k = 0;
    cells.forEach((i) => { faces.set(C[i].faces, k); k += C[i].faces.length; });
    let vol = 0; const centroid = new V3();
    cells.forEach((i) => { const v = Math.max(C[i].volume, 1e-6); centroid.addScaledVector(C[i].centroid, v); vol += v; });
    centroid.multiplyScalar(1 / vol);
    return { id: C[cells[0]].id, cells, faces, centroid, volume: vol };
  });
  const pieceOfCell = new Int16Array(C.length);
  pieces.forEach((P, pi) => { P.num = pi + 1; P.cells.forEach((i) => { pieceOfCell[i] = pi; }); });

  // lines between different pieces, one per cut per pair of pieces
  const segMap = new Map(), inner = [];
  for (const e of cellAdj) {
    const pa = pieceOfCell[e.a], pb = pieceOfCell[e.b];
    if (pa === pb) { inner.push(e); continue; }
    const flip = pa > pb;
    const lo = flip ? pb : pa, hi = flip ? pa : pb;
    const key = `${e.cut}|${pieces[lo].id}|${pieces[hi].id}`;
    let s = segMap.get(key);
    if (!s) { s = { key, cut: e.cut, pa: lo, pb: hi, polys: [], pairs: [], dir: flip ? e.dir.clone().negate() : e.dir.clone(), area: 0 }; segMap.set(key, s); }
    s.polys.push(e.pts); s.pairs.push(flip ? [C[e.b].id, C[e.a].id] : [C[e.a].id, C[e.b].id]); s.area += polyArea(e.pts);
  }
  const segs = [...segMap.values()];
  const adj = pieces.map(() => []);
  for (const s of segs) {
    adj[s.pa].push({ j: s.pb, dir: s.dir });
    adj[s.pb].push({ j: s.pa, dir: s.dir.clone().negate() });
  }
  // the natural way out of a piece is away from its neighbours
  pieces.forEach((P, pi) => {
    const seen = new Set(); P.natural = new V3();
    for (const s of segs) {
      if (s.pa !== pi && s.pb !== pi) continue;
      const k = s.cut + (s.pa === pi ? "a" : "b");
      if (seen.has(k)) continue; seen.add(k);
      P.natural.addScaledVector(s.dir, s.pa === pi ? -1 : 1);
    }
  });
  const pieceOf = new Int16Array(T.cellOf.length);
  for (let i = 0; i < pieceOf.length; i++) pieceOf[i] = T.cellOf[i] >= 0 ? pieceOfCell[T.cellOf[i]] : -1;
  const segCount = new Map(), innerCount = new Map();
  for (const s of segs) segCount.set(s.cut, (segCount.get(s.cut) || 0) + 1);
  for (const e of inner) innerCount.set(e.cut, (innerCount.get(e.cut) || 0) + 1);
  Object.assign(T, { pieces, pieceOfCell, pieceOf, segs, inner, adj, cellAdj, segCount, innerCount });
  return T;
}

// ------------------------------------------------------------ pieces for the engine
// A block as a map cut id -> side. Two blocks that differ only in the side
// of one cut join into one convex block (sides a block doesn't list come from
// where it sits).
function cellPoly(T, m) {
  let poly = T.boxPoly;
  for (const [c, s] of m) {
    const pl = T.planes.get(c); if (!pl) continue;
    poly = s === "p" ? clipPolytope(poly, pl.n, pl.d, { cut: c, side: "p" }) : clipPolytope(poly, pl.n.clone().negate(), -pl.d, { cut: c, side: "n" });
  }
  return poly;
}
export function simplifyCells(T, maps) {
  const list = maps.map((m) => ({ m: new Map(m), poly: null }));
  const side = (x, c) => x.m.get(c) ?? sideOf(x.poly || (x.poly = cellPoly(T, x.m)), T.planes.get(c));
  for (let guard = 0; guard < 200; guard++) {
    let done = true;
    search: for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const A = list[i], B = list[j];
      const keys = new Set([...A.m.keys(), ...B.m.keys()]);
      let diff = null, ok = true;
      for (const c of keys) {
        const sa = side(A, c), sb = side(B, c);
        if (sa === "both" || sb === "both") { ok = false; break; }
        if (sa !== sb) { if (diff !== null) { ok = false; break; } diff = c; }
      }
      if (!ok || diff === null) continue;
      const M = new Map();
      for (const c of keys) if (c !== diff) M.set(c, side(A, c));
      list.splice(j, 1); list[i] = { m: M, poly: null };
      done = false; break search;
    }
    if (done) break;
  }
  return list.map((x) => x.m);
}
const hsOf = (T, m, grow) => [...m].filter(([c]) => T.planes.get(c)).map(([c, s]) => {
  const pl = T.planes.get(c), n = s === "p" ? pl.n.clone() : pl.n.clone().negate();
  const point = pl.n.clone().multiplyScalar(pl.d);
  if (grow && grow.has(c)) point.addScaledVector(n, -grow.get(c));
  return [point.toArray(), n.toArray()];
});
// what the engine needs to cut a piece: one convex block, or for an L or T
// shaped piece, the block around it and the notches other pieces sit in
export function pieceSpec(T, P, grow = 0.05) {
  const C = T.cells;
  const maps = simplifyCells(T, P.cells.map((i) => new Map(C[i].hs.map((h) => [h.cut, h.side]))));
  const cells = maps.map((m) => hsOf(T, m));
  if (maps.length === 1) return { hs: cells[0] };
  // the hull: every side all of the piece's blocks sit on
  const polys = maps.map((m) => cellPoly(T, m));
  const hull = new Map();
  for (const c of new Set(maps.flatMap((m) => [...m.keys()]))) {
    const sides = maps.map((m, i) => m.get(c) ?? sideOf(polys[i], T.planes.get(c)));
    if (sides[0] !== "both" && sides.every((s) => s === sides[0])) hull.set(c, sides[0]);
  }
  const mine = new Set(P.cells);
  let notches = [];
  C.forEach((q, i) => {
    if (mine.has(i)) return;
    const m = new Map(q.hs.map((h) => [h.cut, h.side]));
    for (const [c, s] of hull) { if (m.has(c) && m.get(c) !== s) return; m.set(c, s); }
    const poly = cellPoly(T, m);
    if (polyVolume(poly) < 1) return;
    notches.push(m);
  });
  notches = simplifyCells(T, notches).map((m) => ({ m, poly: cellPoly(T, m) }));
  const mineCells = P.cells.map((i) => C[i]);
  const touches = (f, other) => {
    // does face f (on cut f.tag.cut) touch block `other` across that plane?
    if (!other.poly.faces.some((g) => g.tag && g.tag.cut === f.tag.cut && g.tag.side !== f.tag.side)) return false;
    let pts = f.pts;
    for (const h of other.hs) { if (h.cut === f.tag.cut) continue; pts = clipPolygon(pts, h.n, h.d - 1e-6, []); if (pts.length < 3) return false; }
    return polyArea(pts) > 1;
  };
  const asBlock = (x) => ({ poly: x.poly, hs: [...x.m].map(([c, s]) => { const pl = T.planes.get(c); return s === "p" ? { n: pl.n, d: pl.d, cut: c, side: s } : { n: pl.n.clone().negate(), d: -pl.d, cut: c, side: s }; }) });
  const blocks = notches.map(asBlock);
  // grow each notch a hair past every face that doesn't touch this piece, so
  // no two faces in the boolean sit exactly on top of each other
  const specs = notches.map((x, k) => {
    const g = new Map();
    for (const f of x.poly.faces) if (f.tag && !mineCells.some((r) => touches(f, r))) g.set(f.tag.cut, grow);
    return { k, hs: hsOf(T, x.m, g) };
  });
  // notches that touch each other are joined first
  const up = notches.map((_, i) => i);
  const find = (i) => { while (up[i] !== i) i = up[i] = up[up[i]]; return i; };
  for (let a = 0; a < notches.length; a++) for (let b = a + 1; b < notches.length; b++)
    if (blocks[a].poly.faces.some((f) => f.tag && touches(f, blocks[b]))) up[find(a)] = find(b);
  const groups = new Map();
  specs.forEach((s) => { const r = find(s.k); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(s.hs); });
  return { cells, hull: hsOf(T, hull), notches: [...groups.values()] };
}

// Edges to draw for a set of faces: drops the seams between faces that lie
// flat against each other, so joined blocks read as one piece.
export function outline(faces) {
  const E = [];
  for (const pts of faces) {
    const n = polyNormal(pts); if (!n) continue;
    const off = n.dot(pts[0]);
    for (let i = 0; i < pts.length; i++) E.push({ a: pts[i], b: pts[(i + 1) % pts.length], n, off });
  }
  const out = [];
  for (const e of E) {
    const dir = e.b.clone().sub(e.a), len = dir.length();
    if (len < 1e-4) continue;
    dir.divideScalar(len);
    let keep = [[0, len]];
    for (const f of E) {
      if (f === e) continue;
      const dn = f.n.dot(e.n);
      if (Math.abs(Math.abs(dn) - 1) > 1e-4 || Math.abs(f.off * Math.sign(dn) - e.off) > 0.02) continue;
      const fa = f.a.clone().sub(e.a), fb = f.b.clone().sub(e.a);
      if (fa.clone().cross(dir).length() > 0.02 || fb.clone().cross(dir).length() > 0.02) continue;
      let t0 = fa.dot(dir), t1 = fb.dot(dir); if (t0 > t1) [t0, t1] = [t1, t0];
      const next = [];
      for (const [s, t] of keep) {
        if (t1 <= s + 1e-3 || t0 >= t - 1e-3) { next.push([s, t]); continue; }
        if (t0 > s) next.push([s, t0]);
        if (t1 < t) next.push([t1, t]);
      }
      keep = next;
      if (!keep.length) break;
    }
    for (const [s, t] of keep) if (t - s > 1e-3) out.push(e.a.clone().addScaledVector(dir, s), e.a.clone().addScaledVector(dir, t));
  }
  return out;
}

// Order pieces come off: a piece is free once nothing it would push into is left.
export function removalOrder(T, adj, pulls) {
  const left = new Set(T.pieces.map((_, i) => i));
  const order = new Array(T.pieces.length).fill(0);
  let step = 1;
  while (left.size) {
    const free = [...left].filter((i) => !adj[i].some((e) => left.has(e.j) && pulls[i].dot(e.dir) > 0.05));
    if (!free.length) break;
    free.forEach((i) => { order[i] = step; left.delete(i); });
    step++;
  }
  return { order, locked: [...left] };
}

// ------------------------------------------------------------ pull search
// Face normals binned on a 4 degree grid; a few hundred candidate pulls on the
// upper half of the sphere. Then a fine search right around the winner.
const NT = 45, NP = 90;
export function binFaces(tri) {
  const bins = new Uint16Array(tri.n);
  for (let i = 0; i < tri.n; i++) {
    const z = Math.max(-1, Math.min(1, tri.nor[i * 3 + 2]));
    const th = Math.acos(z), ph = Math.atan2(tri.nor[i * 3 + 1], tri.nor[i * 3]);
    const it = Math.min(NT - 1, Math.floor(th / Math.PI * NT)), ip = Math.min(NP - 1, Math.floor((ph + Math.PI) / (2 * Math.PI) * NP));
    bins[i] = it * NP + ip;
  }
  return bins;
}
let SEARCH = null;
function searchTables(tol) {
  if (SEARCH && SEARCH.tol === tol) return SEARCH;
  const dirs = [];
  const K = 600;
  for (let i = 0; i < K; i++) {
    const z = 1 - (i + 0.5) / K, r = Math.sqrt(1 - z * z), a = (i + 0.5) * Math.PI * (3 - Math.sqrt(5));
    dirs.push(new V3(r * Math.cos(a), r * Math.sin(a), z));
  }
  for (let a = 0; a < 360; a += 5) dirs.push(new V3(Math.cos(rad(a)), Math.sin(rad(a)), 0));
  const B = NT * NP, bd = new Float32Array(B * 3);
  for (let it = 0; it < NT; it++) for (let ip = 0; ip < NP; ip++) {
    const th = (it + 0.5) / NT * Math.PI, ph = (ip + 0.5) / NP * 2 * Math.PI - Math.PI, b = it * NP + ip;
    bd[b * 3] = Math.sin(th) * Math.cos(ph); bd[b * 3 + 1] = Math.sin(th) * Math.sin(ph); bd[b * 3 + 2] = Math.cos(th);
  }
  const M = new Uint8Array(dirs.length * B); // [k][b]
  dirs.forEach((d, k) => { for (let b = 0; b < B; b++) M[k * B + b] = bd[b * 3] * d.x + bd[b * 3 + 1] * d.y + bd[b * 3 + 2] * d.z < -tol ? 1 : 0; });
  SEARCH = { tol, dirs, M, B };
  return SEARCH;
}
export function overhangExact(tri, faces, d, tol) {
  let bad = 0;
  for (const f of faces) if (tri.nor[f * 3] * d.x + tri.nor[f * 3 + 1] * d.y + tri.nor[f * 3 + 2] * d.z < -tol) bad += tri.area[f];
  return bad;
}
// seams: unit vectors from this piece into its neighbours. Prefer pulls that
// don't drive into any neighbour, so pieces come off in any order, unless
// that costs real overhang.
export function bestPull(tri, bins, faces, natural, seams, tol) {
  const { dirs, M, B } = searchTables(tol);
  const w = new Float64Array(B); let tot = 0;
  for (const f of faces) { w[bins[f]] += tri.area[f]; tot += tri.area[f]; }
  const nz = []; for (let b = 0; b < B; b++) if (w[b] > 0) nz.push(b);
  const g = natural.clone(); g.z = Math.max(0, g.z);
  const hasG = g.length() > 1e-9; if (hasG) g.normalize();
  let best = [Infinity, null, 0], bestFree = [Infinity, null, 0];
  for (let k = 0; k < dirs.length; k++) {
    let over = 0; const row = k * B;
    for (const b of nz) if (M[row + b]) over += w[b];
    const d = dirs[k];
    const score = over + (hasG ? 0.03 * tot * (1 - d.dot(g)) : 0);
    if (score < best[0]) best = [score, d, over];
    if (score < bestFree[0] && !seams.some((s) => d.dot(s) > 0.05)) bestFree = [score, d, over];
  }
  let pick = bestFree[1] && bestFree[2] - best[2] <= 0.02 * tot ? bestFree : best;
  if (!pick[1]) return { dir: hasG ? g : new V3(0, 0, 1), over: 0 };
  // fine search around it, exact
  const d0 = pick[1];
  const az0 = Math.atan2(d0.y, d0.x), el0 = Math.asin(Math.min(1, d0.z));
  const free = pick === bestFree;
  let fin = { dir: d0.clone(), over: overhangExact(tri, faces, d0, tol) };
  let fs = fin.over + (hasG ? 0.03 * tot * (1 - d0.dot(g)) : 0);
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    if (!i && !j) continue;
    const el = Math.max(0, el0 + rad(3 * j)), az = az0 + rad(3 * i);
    const d = new V3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el));
    if (free && seams.some((s) => d.dot(s) > 0.05)) continue;
    const o = overhangExact(tri, faces, d, tol), sc = o + (hasG ? 0.03 * tot * (1 - d.dot(g)) : 0);
    if (sc < fs) { fs = sc; fin = { dir: d, over: o }; }
  }
  return fin;
}
