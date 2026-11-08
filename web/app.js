import * as THREE from "three";
import { STLLoader } from "./vendor/STLLoader.js";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { TransformControls } from "./vendor/TransformControls.js";
import { cutNormal, canonical, angles, evaluate, group, removalOrder, binFaces, bestPull, rad, deg, outline, polyNormal, pieceSpec, tokens, clipPolytope, polyVerts } from "./tree.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const APP_VERSION = "0.10.1"; // must match the engine's; an older engine left running is the usual reason it doesn't
const OLD_ENGINE = "This window is talking to an older copy of GnomeShell that's still running in the background, so some buttons won't work. " +
  "Close this window and start GnomeShell again. If this message comes back, open Task Manager, end blender.exe, then start GnomeShell.";
const api = async (path, body, raw) => {
  const opts = body === undefined ? {} : {
    method: "POST",
    body: raw ? body : JSON.stringify(body),
    headers: raw ? { "X-Filename": encodeURIComponent(raw) } : { "Content-Type": "application/json" },
  };
  // a change to the scan itself goes on the Ctrl+Z list (with the layout as it was), once it's shown
  if (path === "/api/prep" && body && !["undo", "redo", "save"].includes(body.op)) H.scanMark = "SCAN" + snapshot();
  let r;
  try { r = await fetch(path, opts); } catch (e) {
    throw new Error("Can't reach GnomeShell's engine, so nothing was done. Close this window and start GnomeShell again.");
  }
  const j = await r.json().catch(() => ({ error: "No answer from the engine." }));
  if (r.status === 404 && (j.error === "unknown" || j.error === "old_engine")) { engineWarn("old", OLD_ENGINE); throw new Error(OLD_ENGINE); }
  if (!r.ok || j.error) { if (path === "/api/prep") H.scanMark = null; throw new Error(j.error || r.statusText); }
  return j;
};
const V3 = THREE.Vector3;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const f1 = (v) => String(Math.round(v * 10) / 10);
const wrap180 = (v) => ((v % 180) + 180) % 180;
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

// ------------------------------------------------------------ state
const S = {
  step: "load",
  scan: null,          // info from the engine
  cuts: [],            // {id, parent, kind, az, tilt, pos, auto}; parent: null, a piece id, or a list of them
  nextId: 1,
  joins: [],           // [[blockA, blockB]]: lines you deleted
  pulls: {},           // piece id -> [x, y, z] you set by dragging its arrow
  settings: {},
  build: null,
  show: "shell",
  T: null,             // the evaluated cuts and pieces
  splitN: 2,           // how many parts the split buttons make
  active: null,        // cut id being edited (its card is open, the view handle sits on it)
  selCuts: new Set(),  // cut ids
  selSegs: new Set(),  // line keys
  selPieces: new Set(),// piece ids
  mode: "pieces",      // what a click picks in the view
  hover: null,
};
const COL = {
  latex: new THREE.Color("#d9a35a"), bad: new THREE.Color("#e5674a"), ghost: new THREE.Color("#8a9096"),
  slice: new THREE.Color("#e3a33c"), plane: new THREE.Color("#e3a33c"), pick: new THREE.Color("#fff1d6"),
  plan: new THREE.Color("#ff4fd8"),
};
const PIECE_COLORS = ["#5fa497", "#5a8cc4", "#957dcb", "#cc7f9c", "#84ab58", "#4fb3c9", "#8592a1", "#b9735a", "#a3a04e", "#b072b5"];
const pieceColor = (i) => PIECE_COLORS[i % PIECE_COLORS.length];
const ordinal = (n) => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
let shiftDown = false;
addEventListener("keydown", (e) => { if (e.key === "Shift") shiftDown = true; });
addEventListener("keyup", (e) => { if (e.key === "Shift") shiftDown = false; });
addEventListener("blur", () => { shiftDown = false; });

// ------------------------------------------------------------ 3D view
const canvas = $("#gl");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 1, 20000);
camera.up.set(0, 0, 1);
const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f44, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(300, -400, 600); scene.add(sun);
const fill = new THREE.DirectionalLight(0xffffff, 0.6); fill.position.set(-400, 300, 200); scene.add(fill);
const grid = new THREE.GridHelper(400, 40, 0x3a4045, 0x2a2f33); grid.rotation.x = Math.PI / 2; scene.add(grid);

const groups = { latex: new THREE.Group(), planes: new THREE.Group(), regions: new THREE.Group(), arrows: new THREE.Group(), pour: new THREE.Group(), pieces: new THREE.Group(), slices: new THREE.Group(), slicePlan: new THREE.Group(), insert: new THREE.Group(), sizer: new THREE.Group(), base: new THREE.Group(), printer: new THREE.Group(), spout: new THREE.Group(), seam: new THREE.Group() };
Object.values(groups).forEach((g) => scene.add(g));
const handle = new THREE.Object3D(); scene.add(handle);
// The open cut gets both at once: an arrow along its normal slides it, two
// rings turn and tilt it. The arrow reaches past the rings so they don't overlap.
const gizmoT = new TransformControls(camera, canvas), gizmoR = new TransformControls(camera, canvas);
const gizmos = [gizmoT, gizmoR];
gizmoT.setMode("translate"); gizmoT.showX = gizmoT.showY = false; gizmoT.setSize(1.2);
gizmoR.setMode("rotate"); gizmoR.showZ = false; gizmoR.setSize(0.75);
for (const g of gizmos) {
  g.setSpace("local");
  scene.add(g.getHelper ? g.getHelper() : g);
  g.addEventListener("mouseDown", () => mark(null));
  g.addEventListener("dragging-changed", (e) => { orbit.enabled = !e.value; if (!e.value) { renderCuts(); refresh(); } });
  g.addEventListener("objectChange", () => onHandleMove(g.mode));
}
const gizmoHot = () => gizmos.some((g) => g.dragging || g.axis);
const attachHandle = () => gizmos.forEach((g) => { if (g.object !== handle) g.attach(handle); });
const detachHandle = () => gizmos.forEach((g) => g.detach());
// where the arrow and a ring cross, only the arrow takes the drag
canvas.addEventListener("pointerdown", (e) => {
  if (!gizmoT.object) return;
  if (e.button === 0 && (insHandleAt(e) || sizerAt(e))) { gizmos.forEach((g) => (g.enabled = false)); return; } // the insert's and the sizer's handles win
  gizmos.forEach((g) => { g.enabled = true; g.pointerHover(g._getPointer(e)); });
  if (gizmoT.axis) gizmoR.enabled = false; else if (gizmoR.axis) gizmoT.enabled = false;
}, true);
addEventListener("pointerup", () => setTimeout(() => gizmos.forEach((g) => (g.enabled = true))), true);

let latexMesh = null, latexTri = null, latexBins = null;
const latexPos = () => latexMesh.geometry.attributes.position.array;
const loader = new STLLoader();

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(r.height, 1); camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas.parentElement);
// piece numbers in the view, kept over the middle of each piece
const labelBox = $("#labels");
let labels = [];
function drawLabels(T) {
  labelBox.innerHTML = ""; labels = [];
  if (S.step !== "cut" || !$("#tPieces").checked || !S.cuts.length) return;
  T.pieces.forEach((P, i) => {
    const el = document.createElement("button");
    el.type = "button"; el.className = "plabel" + (S.selPieces.has(P.id) ? " sel" : "");
    el.style.setProperty("--c", pieceColor(i)); el.textContent = i + 1;
    el.title = `Piece ${i + 1}: click to pick it, Shift-click to add it, right-click for options`;
    el.onclick = (e) => selectPiece(P.id, e.shiftKey);
    el.oncontextmenu = (e) => { e.preventDefault(); if (!S.selPieces.has(P.id)) selectPiece(P.id, false); pieceMenu(e.clientX, e.clientY, P.id); };
    labelBox.appendChild(el); labels.push({ el, at: P.centroid.clone() });
  });
  placeLabels();
}
const _lp = new V3();
function placeLabels() {
  if (!labels.length) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  for (const L of labels) {
    _lp.copy(L.at).project(camera);
    const off = _lp.z > 1 || Math.abs(_lp.x) > 1.05 || Math.abs(_lp.y) > 1.05;
    L.el.style.display = off ? "none" : "";
    if (!off) L.el.style.transform = `translate(${((_lp.x + 1) / 2 * w).toFixed(1)}px, ${((1 - _lp.y) / 2 * h).toFixed(1)}px) translate(-50%, -50%)`;
  }
}
(function loop() { orbit.update(); renderer.render(scene, camera); placeLabels(); requestAnimationFrame(loop); })();

const center = () => new V3(...(S.scan?.center || [0, 0, 0]));
const size = () => Math.max(...(S.scan?.dims || [200, 200, 200]));
function viewFrom(dir) {
  const c = center(); const d = size() * 2.6;
  const v = { front: [0, -1, 0.12], side: [1, 0, 0.12], top: [0, -0.02, 1], fit: [0.8, -1, 0.55] }[dir];
  camera.position.copy(c).add(new V3(...v).normalize().multiplyScalar(d));
  orbit.target.copy(c); orbit.update();
}
$$("#viewTools [data-view]").forEach((b) => b.onclick = () => viewFrom(b.dataset.view));

async function loadSTL(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  return loader.parse(buf);
}

// ------------------------------------------------------------ latex triangles
function prepTriangles(geo) {
  const p = geo.attributes.position.array; const n = p.length / 9;
  const cen = new Float32Array(n * 3), nor = new Float32Array(n * 3), area = new Float32Array(n);
  let mx = 0, my = 0, mz = 0, at = 0;
  const a = new V3(), b = new V3(), c = new V3(), x = new V3();
  for (let i = 0; i < n; i++) {
    a.fromArray(p, i * 9); b.fromArray(p, i * 9 + 3); c.fromArray(p, i * 9 + 6);
    x.subVectors(b, a).cross(c.clone().sub(a)); const l = x.length();
    area[i] = l / 2; if (l > 0) x.divideScalar(l);
    nor.set([x.x, x.y, x.z], i * 3);
    const cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3, cz = (a.z + b.z + c.z) / 3;
    cen.set([cx, cy, cz], i * 3); mx += cx * area[i]; my += cy * area[i]; mz += cz * area[i]; at += area[i];
  }
  mx /= at; my /= at; mz /= at;
  let s = 0; for (let i = 0; i < n; i++) s += area[i] * ((cen[i * 3] - mx) * nor[i * 3] + (cen[i * 3 + 1] - my) * nor[i * 3 + 1] + (cen[i * 3 + 2] - mz) * nor[i * 3 + 2]);
  if (s < 0) for (let i = 0; i < nor.length; i++) nor[i] = -nor[i];
  return { n, cen, nor, area, total: at };
}

// ------------------------------------------------------------ undo / redo
const H = { undo: [], redo: [], key: null, t: 0 };
const snapshot = () => JSON.stringify({ cuts: S.cuts, nextId: S.nextId, joins: S.joins, pulls: S.pulls, active: S.active, insert: S.insert });
// call before changing the layout; a run of changes with the same key (one
// slider drag) is one step back
// the overhang right now, so the readout in the view can show what a change did
const curPct = () => (S.T && latexTri && S.cuts.length ? 100 * S.T.bad / latexTri.total : null);
function mark(key) {
  const now = performance.now();
  if (key && key === H.key && now - H.t < 1200) { H.t = now; return; }
  H.basePct = curPct();
  H.undo.push(snapshot()); if (H.undo.length > 200) H.undo.shift();
  H.redo = []; H.key = key; H.t = now; undoButtons();
}
function restore(str) {
  const o = JSON.parse(str);
  S.cuts = o.cuts; S.nextId = o.nextId; S.joins = o.joins; S.pulls = o.pulls; S.active = o.active;
  if (o.insert) { S.insert = { ...insDefaults(), ...o.insert }; insFill(); }
  S.selCuts.clear(); S.selSegs.clear(); S.selPieces.clear();
  if (S.active != null) S.selCuts.add(S.active);
  renderCuts(); refresh(); undoButtons();
}
function undo() { if (!H.undo.length) return; if (H.undo.at(-1).startsWith("SCAN")) return scanStep("undo"); H.basePct = curPct(); H.redo.push(snapshot()); restore(H.undo.pop()); H.key = null; }
function redo() { if (!H.redo.length) return; if (H.redo.at(-1).startsWith("SCAN")) return scanStep("redo"); H.basePct = curPct(); H.undo.push(snapshot()); restore(H.redo.pop()); H.key = null; }
// size, turn, base, spout, trim and the rest change the scan in the engine, which keeps the old ones
function scanStep(dir) {
  const from = dir === "undo" ? H.undo : H.redo, to = dir === "undo" ? H.redo : H.undo;
  const entry = from.pop();
  withBusy(dir === "undo" ? "Undoing the scan change" : "Redoing the scan change", async () => {
    let info;
    try { info = await api("/api/prep", { op: dir }); } catch (e) { from.push(entry); undoButtons(); throw e; }
    to.push("SCAN" + snapshot());
    await showScan(info, true);
    restore(entry.slice(4)); H.key = null; H.scanMark = null; undoButtons(); drawSizer();
  });
}
// called once the changed scan is on screen
function scanMarked() {
  if (!H.scanMark) return;
  H.undo.push(H.scanMark); H.scanMark = null; if (H.undo.length > 200) H.undo.shift();
  H.redo = H.redo.filter((x) => !x.startsWith("SCAN")); H.key = null; undoButtons();
}
function resetHistory() { H.undo = []; H.redo = []; H.key = null; H.basePct = null; undoButtons(); }
function undoButtons() { $("#undo").disabled = !H.undo.length; $("#redo").disabled = !H.redo.length; }
$("#undo").onclick = undo; $("#redo").onclick = redo;

// ------------------------------------------------------------ cuts
const tol = () => Math.sin(rad(+S.settings.draft_deg || 2));
const opts = () => ({ wall: +S.settings.wall_mm || 6.35, trim: +S.settings.bottom_trim_mm || 0, pour: +S.settings.pour_extend_mm || 0, flare: +S.settings.pour_flare_deg || 0 });
const cutIndex = (id) => S.cuts.findIndex((c) => c.id === id);
const cutById = (id) => S.cuts.find((c) => c.id === id);
const infoOf = (id) => { const i = cutIndex(id); return i >= 0 && S.T ? S.T.info[i] : null; };
const tiltMax = (c) => (c.kind === "level" ? 30 : 45);
function newCut(parent, n, pos) {
  const c = { id: S.nextId++, parent, ...angles(n), pos, auto: false };
  S.cuts.push(c); return c;
}
// where a suggested plane sits, as a fraction across the part it splits
function placeFromPoint(c, point) {
  const i = cutIndex(c.id);
  const T = evaluate(S.cuts, latexTri, latexPos(), opts(), i + 1);
  const inf = T.info[i];
  if (!inf || !inf.valid) return;
  const t = cutNormal(c).dot(point);
  c.pos = clamp((t - inf.range[0]) / (inf.range[1] - inf.range[0] || 1), 0.01, 0.99);
}
function cutFromSuggestion(sg, keepId) {
  const n = canonical(new V3(...sg.normal));
  const c = { id: keepId ?? S.nextId++, parent: null, ...angles(n), pos: 0.5, auto: true };
  return { c, point: new V3(...sg.point) };
}
const parentIds = (c) => (c.parent == null ? [] : Array.isArray(c.parent) ? c.parent : [c.parent]);
// keep every cut where it is (same plane) after cuts before it changed
function refit(planeOf) {
  for (let j = 0; j < S.cuts.length; j++) {
    const d = planeOf.get(S.cuts[j].id); if (d == null) continue;
    const inf = evaluate(S.cuts, latexTri, latexPos(), opts(), j + 1).info[j];
    if (inf && inf.valid) S.cuts[j].pos = clamp((d - inf.range[0]) / (inf.range[1] - inf.range[0] || 1), 0.01, 0.99);
  }
}
// cascade: also remove cuts that only split pieces this cut made.
// Without it, those cuts stay put and spread into the joined space.
function removeCut(i, { cascade = true } = {}) {
  const planeOf = new Map(S.cuts.map((c, k) => [c.id, S.T && S.T.info[k] && S.T.info[k].valid ? S.T.info[k].d : null]));
  const drop = new Set([S.cuts[i].id]);
  let grew = cascade;
  while (grew) {
    grew = false;
    for (const c of S.cuts) {
      if (drop.has(c.id)) continue;
      if (parentIds(c).some((p) => [...tokens(p).keys()].some((t) => drop.has(t)))) { drop.add(c.id); grew = true; }
    }
  }
  S.cuts = S.cuts.filter((c) => !drop.has(c.id));
  const strip = (pid) => String(pid).split(".").filter((t, k) => k === 0 || !drop.has(+t.slice(0, -1))).join(".");
  for (const c of S.cuts) if (c.parent != null) c.parent = Array.isArray(c.parent) ? [...new Set(c.parent.map(strip))] : strip(c.parent);
  const seen = new Set();
  S.joins = S.joins.map(([a, b]) => [strip(a), strip(b)]).filter(([a, b]) => {
    const k = [a, b].sort().join("|");
    if (a === b || a.startsWith(b + ".") || b.startsWith(a + ".") || seen.has(k)) return false;
    seen.add(k); return true;
  });
  refit(planeOf);
  drop.forEach((id) => S.selCuts.delete(id));
  if (drop.has(S.active)) S.active = null;
  return drop.size - 1;
}
function deleteCuts(ids) {
  ids = ids.filter((id) => cutIndex(id) >= 0);
  if (!ids.length) return;
  mark(null);
  let extra = 0;
  for (const id of ids) { const i = cutIndex(id); if (i >= 0) extra += removeCut(i); }
  S.selSegs.clear();
  renderCuts(); refresh();
  toast(`Removed ${ids.length > 1 ? ids.length + " cuts" : "the cut"}${extra ? `, and ${extra} cut${extra > 1 ? "s" : ""} inside ${ids.length > 1 ? "them" : "it"}` : ""}. Ctrl+Z brings ${ids.length + extra > 1 ? "them" : "it"} back.`, true);
}

// ------------------------------------------------------------ evaluate + score
let pullCache = {};
const digest = (v) => v.x.toFixed(2) + v.y.toFixed(2) + v.z.toFixed(2);
// the cuts, pieces, pulls and overhang, without drawing anything
function compute() {
  const T = evaluate(S.cuts, latexTri, latexPos(), opts());
  group(T, S.joins);
  T.pull = T.pieces.map((P, i) => {
    if (S.pulls[P.id]) return new V3(...S.pulls[P.id]).normalize();
    const key = P.cells.map((ci) => { const L = T.cells[ci]; return `${L.id}:${L.faces.length}:${L.hs.map((h) => h.d.toFixed(2) + h.n.x.toFixed(3) + h.n.y.toFixed(3)).join()}`; }).join("/") +
      `|${T.adj[i].map((e) => digest(e.dir)).join()}|${tol()}`;
    if (!pullCache[key]) pullCache[key] = bestPull(latexTri, latexBins, P.faces, P.natural, T.adj[i].map((e) => e.dir), tol()).dir;
    return pullCache[key].clone();
  });
  if (Object.keys(pullCache).length > 600) pullCache = {};
  const tr = latexTri, t = tol(), np = T.pieces.length;
  const badBy = new Float64Array(np), areaBy = new Float64Array(np);
  T.badTri = new Uint8Array(tr.n);
  for (let i = 0; i < tr.n; i++) {
    const k = T.pieceOf[i];
    if (k < 0) continue;
    const d = T.pull[k];
    areaBy[k] += tr.area[i];
    if (tr.nor[i * 3] * d.x + tr.nor[i * 3 + 1] * d.y + tr.nor[i * 3 + 2] * d.z < -t) { badBy[k] += tr.area[i]; T.badTri[i] = 1; }
  }
  T.badBy = badBy; T.areaBy = areaBy;
  T.bad = badBy.reduce((a, b) => a + b, 0);
  const { order, locked } = removalOrder(T, T.adj, T.pull);
  T.order = order; T.locked = locked;
  T.cost = T.bad + locked.length * 0.05 * tr.total;
  return T;
}
function refresh(o = {}) {
  if (!latexMesh || !latexTri) return;
  const T = compute();
  S.T = T;
  // forget picks that no longer exist
  const segKeys = new Set(T.segs.map((s) => s.key)), pieceIds = new Set(T.pieces.map((P) => P.id)), cutIds = new Set(S.cuts.map((c) => c.id));
  [...S.selSegs].forEach((k) => { if (!segKeys.has(k)) S.selSegs.delete(k); });
  [...S.selPieces].forEach((k) => { if (!pieceIds.has(k)) S.selPieces.delete(k); });
  [...S.selCuts].forEach((k) => { if (!cutIds.has(k)) S.selCuts.delete(k); });
  if (S.active != null && !cutIds.has(S.active)) S.active = null;
  paint(T);
  meter(T);
  drawScene(T, o.keepHandle);
  drawSlicePlan(T);
  drawInsert(T);
  renderPieces(T);
  cutTags(T);
  estimate();
  applyInsView();
}
let rafT = null;
function refreshSoon(o) { if (rafT) return; rafT = requestAnimationFrame(() => { rafT = null; refresh(o); }); }

function paint(T) {
  const colors = latexMesh.geometry.attributes.color.array;
  const show = $("#tOver").checked && S.cuts.length && !insViewOn();
  const base = insViewOn() ? COL.ghost : COL.latex;
  for (let i = 0; i < latexTri.n; i++) {
    const col = show && T.badTri[i] ? COL.bad : base;
    colors[i * 9] = colors[i * 9 + 3] = colors[i * 9 + 6] = col.r;
    colors[i * 9 + 1] = colors[i * 9 + 4] = colors[i * 9 + 7] = col.g;
    colors[i * 9 + 2] = colors[i * 9 + 5] = colors[i * 9 + 8] = col.b;
  }
  latexMesh.geometry.attributes.color.needsUpdate = true;
}
function meter(T) {
  drawLabels(T); autosaveSoon();
  const bad = T.bad, badBy = T.badBy;
  const pct = S.cuts.length ? (100 * bad / latexTri.total) : null;
  const m = $("#meter");
  $("#overPct").textContent = pct === null ? "–" : pct.toFixed(1) + "%";
  $("#overBar").style.width = pct === null ? "0" : Math.min(100, pct * 4) + "%";
  m.classList.toggle("warn", pct !== null && pct >= 2);
  // the same number in the corner of the view, with what the last change did to it
  $("#hudPct").textContent = pct === null ? "–" : pct.toFixed(1) + "%";
  $("#hud").classList.toggle("warn", pct !== null && pct >= 2);
  const base = H.basePct, dEl = $("#hudDelta");
  if (pct !== null && base != null && Math.abs(pct - base) >= 0.05) {
    const down = pct < base;
    dEl.textContent = `${down ? "▼" : "▲"} ${Math.abs(pct - base).toFixed(1)} from ${base.toFixed(1)}%`;
    dEl.className = "hud-d mono " + (down ? "better" : "worse");
  } else { dEl.textContent = ""; dEl.className = "hud-d mono"; }
  $("#hudSub").textContent = !S.cuts.length ? "Add a cut to see it" :
    `${T.pieces.length} pieces${T.locked.length ? ` · ${T.locked.length} stuck` : ""}`;
  let worst = -1; badBy.forEach((b, i) => { if (worst < 0 || b > badBy[worst]) worst = i; });
  const where = worst >= 0 && badBy[worst] > 0.25 * bad && T.pieces.length > 1 ? ` Most of it is on piece ${worst + 1}.` : "";
  $("#overNote").textContent = pct === null ? "Add a cut to see what would catch." :
    pct < 0.5 ? "Every piece pulls straight off." :
    pct < 2 ? "A few small spots. Latex will flex past these." + where :
    pct < 10 ? "Red areas face the wrong way for their piece." + where + " Split that piece, drag its arrow, or optimize a cut." :
    "A lot would catch." + where + " Try Suggest more cuts, or split the worst piece.";
  const w = $("#lockWarn");
  if (T.locked.length) {
    w.hidden = false;
    w.textContent = `Pieces ${T.locked.map((i) => i + 1).join(", ")} hold each other in: each would push into another as it comes off. Drag one of their arrows so it pulls away from its neighbours.`;
  } else w.hidden = true;
}

// ------------------------------------------------------------ drawing
function fanGeometry(polys) {
  const pos = [];
  for (const pts of polys) for (let i = 1; i < pts.length - 1; i++) pos.push(...pts[0].toArray(), ...pts[i].toArray(), ...pts[i + 1].toArray());
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); return g;
}
function lineGeometry(pts) {
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pts.flatMap((p) => p.toArray()), 3)); return g;
}
const dispose = (g) => g.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
const meshes = { segs: new Map(), pieces: new Map() };
// the outside faces of a piece, each wound to face out
function pieceFaces(T, pi) {
  const out = [];
  for (const ci of T.pieces[pi].cells) {
    const L = T.cells[ci];
    for (const f of L.poly.faces) {
      if (f.tag || f.pts.length < 3) continue;
      const n = polyNormal(f.pts); if (!n) continue;
      const c = f.pts.reduce((s, p) => s.add(p), new V3()).multiplyScalar(1 / f.pts.length);
      out.push(n.dot(c.sub(L.centroid)) >= 0 ? f.pts : [...f.pts].reverse());
    }
  }
  for (const s of T.segs) {
    if (s.pa !== pi && s.pb !== pi) continue;
    const away = s.pa === pi ? s.dir : s.dir.clone().negate();
    for (const pts of s.polys) { const n = polyNormal(pts); if (n) out.push(n.dot(away) >= 0 ? pts : [...pts].reverse()); }
  }
  return out;
}
function drawScene(T, keepHandle) {
  // lines between pieces (the cut planes, only where they still cut)
  dispose(groups.planes); groups.planes.clear(); meshes.segs.clear();
  T.segs.forEach((s) => {
    const m = new THREE.Mesh(fanGeometry(s.polys), new THREE.MeshBasicMaterial({ color: COL.plane, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false }));
    const e = new THREE.LineSegments(lineGeometry(outline(s.polys)), new THREE.LineBasicMaterial({ color: COL.plane, transparent: true, opacity: 0.55 }));
    m.userData.seg = s.key; groups.planes.add(m, e);
    meshes.segs.set(s.key, { m, e, cut: s.cut });
  });
  groups.planes.visible = S.step === "cut" && $("#tPlanes").checked;
  const inf = infoOf(S.active), c = cutById(S.active);
  if (inf && inf.valid && c && S.step === "cut" && $("#tPlanes").checked && (T.segCount.get(c.id) || !T.innerCount.get(c.id))) {
    if (!keepHandle) placeHandle(inf, c);
    attachHandle();
  } else detachHandle();

  // pieces: their blocks and pull arrows
  dispose(groups.regions); groups.regions.clear(); meshes.pieces.clear();
  dispose(groups.arrows); groups.arrows.clear();
  const L = size() * 0.2;
  T.pieces.forEach((P, i) => {
    const col = new THREE.Color(pieceColor(i));
    const faces = pieceFaces(T, i);
    const m = new THREE.Mesh(fanGeometry(faces), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.04, side: THREE.DoubleSide, depthWrite: false }));
    const pick = new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({ side: THREE.FrontSide, visible: false }));
    pick.userData.piece = P.id;
    const e = new THREE.LineSegments(lineGeometry(outline(faces)), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.4 }));
    groups.regions.add(m, pick, e);
    meshes.pieces.set(P.id, { m, e, pick });
    if (!S.cuts.length) return;
    // drawn on top of everything so an arrow inside the latex still shows
    const dir = T.pull[i], sel = S.selPieces.has(P.id);
    const mat = new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: sel ? 1 : 0.85 });
    const a = new THREE.Group();
    const r = L * (sel ? 0.035 : 0.025);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r, r, L * 0.8, 10), mat); shaft.position.y = L * 0.4;
    const head = new THREE.Mesh(new THREE.ConeGeometry(r * 3, L * 0.22, 16), mat); head.position.y = L * 0.86;
    a.add(shaft, head);
    a.position.copy(P.centroid); a.quaternion.setFromUnitVectors(new V3(0, 1, 0), dir);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(L * (sel ? 0.1 : 0.08), 16, 12), mat);
    tip.position.copy(P.centroid).addScaledVector(dir, L);
    tip.userData = { tip: true, piece: P.id, origin: P.centroid.clone(), len: L };
    const base = new THREE.Mesh(new THREE.SphereGeometry(r * 1.6, 10, 8), mat); base.position.copy(P.centroid);
    [a, tip, base].forEach((o) => o.traverse((k) => { k.renderOrder = 10; }));
    groups.arrows.add(a, tip, base);
  });
  const on = S.step === "cut" && $("#tPieces").checked;
  groups.regions.visible = on; groups.arrows.visible = on;
  highlight();
}
// ------------------------------------------------------------ test slices
// Where each piece's test slice is cut. The engine cuts it exactly here, for
// a full build and for test slices on their own, so what the view shows is
// what prints. Upright: across the main seam through the top of the latex,
// or through the middle of a piece that line misses. Level: partway up each
// piece, stepped clear of the bungee channels.
function contourStyle() { return S.settings?.shell_style === "CONTOUR"; }
function slicePlans(T) {
  if (!T || !S.cuts.length || !T.pieces.length || !latexMesh) return [];
  const t = +S.settings.test_slice_mm || 0.4;
  const level = S.settings.test_slice_style === "HORIZONTAL";
  const n = level ? new V3(0, 0, 1) : T.frame.ex.clone();
  let top = null;
  if (!level) {
    const pos = latexPos(); let zi = 2;
    for (let i = 5; i < pos.length; i += 3) if (pos[i] > pos[zi]) zi = i;
    top = new V3(pos[zi - 2], pos[zi - 1], pos[zi]);
  }
  // channel heights, placed as the engine places them
  const nh = Math.max(0, Math.round(+S.settings.holes_per_corner || 0)), r = (+S.settings.hole_d_mm || 0) / 2;
  const z0 = T.boxLo[2], z1 = T.boxHi[2], g = (+S.settings.pair_gap_mm || 10) / 2;
  let chz = contourStyle() ? [] : [...Array(nh)].map((_, i) => z0 + (z1 - z0) * (i + 0.5) / nh);
  if (S.settings.channel_pairs) chz = chz.flatMap((z) => [z - g, z + g]);
  return T.pieces.map((P) => {
    const vs = P.cells.flatMap((ci) => polyVerts(T.cells[ci].poly));
    let mn = Infinity, mx = -Infinity; const c = new V3();
    for (const v of vs) { const d = n.dot(v); mn = Math.min(mn, d); mx = Math.max(mx, d); c.add(v); }
    c.multiplyScalar(1 / Math.max(1, vs.length));
    const on = (d) => c.clone().addScaledVector(n, d - n.dot(c));
    if (level) {
      let z = mn + (mx - mn) * (+S.settings.test_slice_at || 0.5) - t / 2;
      for (let k = 0; k < 20; k++) { if (chz.every((cz) => Math.abs(z + t / 2 - cz) > r + 2)) break; z += 2 * r + 2; }
      return { normal: n, d: z + t / 2, point: on(z + t / 2), why: `${Math.round(z - mn)} mm up the piece` };
    }
    const d0 = n.dot(top), mid = (mn + mx) / 2;
    if (mx < d0 - t / 2 || mn > d0 + t / 2) return { normal: n, d: mid, point: on(mid), why: "middle of the piece", middle: true };
    return { normal: n, d: d0, point: top.clone(), alt: on(mid), why: "top of the latex" };
  });
}
const planJSON = (pl) => pl && { point: pl.point.toArray(), normal: pl.normal.toArray(), alt: pl.alt ? pl.alt.toArray() : null, why: pl.why };
// the line a plane draws across the latex, as flat segment pairs
const sectionCache = new Map();
function latexSection(n, d) {
  const key = `${latexMesh.uuid}|${d.toFixed(3)}|${n.x.toFixed(5)},${n.y.toFixed(5)},${n.z.toFixed(5)}`;
  if (sectionCache.has(key)) return sectionCache.get(key);
  const pos = latexPos(), out = [];
  const sd = (i) => n.x * pos[i] + n.y * pos[i + 1] + n.z * pos[i + 2] - d;
  for (let i = 0; i < pos.length; i += 9) {
    const s = [sd(i), sd(i + 3), sd(i + 6)];
    if ((s[0] > 0) === (s[1] > 0) && (s[1] > 0) === (s[2] > 0)) continue;
    const pts = [];
    for (let e = 0; e < 3; e++) {
      const a = e, b = (e + 1) % 3;
      if ((s[a] > 0) === (s[b] > 0)) continue;
      const f = s[a] / (s[a] - s[b]), ia = i + a * 3, ib = i + b * 3;
      pts.push(pos[ia] + (pos[ib] - pos[ia]) * f, pos[ia + 1] + (pos[ib + 1] - pos[ia + 1]) * f, pos[ia + 2] + (pos[ib + 2] - pos[ia + 2]) * f);
    }
    if (pts.length === 6) out.push(...pts);
  }
  if (sectionCache.size > 12) sectionCache.clear();
  sectionCache.set(key, out);
  return out;
}
function drawSlicePlan(T) {
  dispose(groups.slicePlan); groups.slicePlan.clear();
  const plans = slicePlans(T);
  T.slicePlans = plans;
  groups.slicePlan.visible = S.step === "cut" && $("#tSlices").checked;
  $("#legSlice").hidden = !plans.length || !$("#tSlices").checked;
  sliceNote(plans);
  if (!plans.length) return;
  const w = Math.max(1.2, size() * 0.01);
  // pieces sliced in the same plane share one sheet and one line
  const byPlane = new Map();
  plans.forEach((pl, i) => {
    const k = `${pl.d.toFixed(3)}|${pl.normal.toArray().map((x) => x.toFixed(4)).join()}`;
    if (!byPlane.has(k)) byPlane.set(k, []);
    byPlane.get(k).push(i);
  });
  for (const idx of byPlane.values()) {
    const { normal: n, d } = plans[idx[0]];
    const cells = idx.flatMap((i) => T.pieces[i].cells.map((ci) => T.cells[ci]));
    // the sheet: each block cut through where the slice goes
    const polys = cells.map((L) => clipPolytope(L.poly, n, d, null).cap).filter(Boolean);
    const sheet = new THREE.Mesh(fanGeometry(polys), new THREE.MeshBasicMaterial({ color: COL.plan, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
    const edge = new THREE.LineSegments(lineGeometry(outline(polys)), new THREE.LineBasicMaterial({ color: COL.plan, transparent: true, opacity: 0.8 }));
    // where it meets the latex: a narrow band, so it reads from any side
    const seg = latexSection(n, d), pos = [];
    const inside = (x, y, z) => cells.some((L) => L.hs.every((h) => h.n.x * x + h.n.y * y + h.n.z * z - h.d >= -0.01));
    const a = new V3(), b = new V3(), s = new V3(), u = new V3(), v = new V3();
    const quad = (p, q, o) => pos.push(
      p.x - o.x, p.y - o.y, p.z - o.z, q.x - o.x, q.y - o.y, q.z - o.z, q.x + o.x, q.y + o.y, q.z + o.z,
      p.x - o.x, p.y - o.y, p.z - o.z, q.x + o.x, q.y + o.y, q.z + o.z, p.x + o.x, p.y + o.y, p.z + o.z);
    for (let i = 0; i < seg.length; i += 6) {
      a.set(seg[i], seg[i + 1], seg[i + 2]); b.set(seg[i + 3], seg[i + 4], seg[i + 5]);
      if (!inside((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)) continue;
      s.subVectors(b, a); if (s.lengthSq() < 1e-12) continue;
      u.copy(n).multiplyScalar(w / 2);
      v.crossVectors(n, s).normalize().multiplyScalar(w / 2);
      quad(a, b, u); quad(a, b, v);
    }
    const gl = new THREE.BufferGeometry(); gl.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    // pulled toward the camera a little so it wins over the latex it lies on
    const line = new THREE.Mesh(gl, new THREE.MeshBasicMaterial({ color: COL.plan, side: THREE.DoubleSide, transparent: true, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }));
    const ids = idx.map((i) => T.pieces[i].id);
    sheet.userData = { pieces: ids, part: "sheet" }; edge.userData = { pieces: ids, part: "edge" }; line.userData = { pieces: ids, part: "line" };
    groups.slicePlan.add(sheet, edge, line);
  }
  highlight();
}
function sliceNote(plans) {
  const el = $("#sliceNote");
  if (!plans.length) { el.textContent = "Add a cut to see where the test slices go."; return; }
  const t = +S.settings.test_slice_mm || 0.4;
  if (S.settings.test_slice_style === "HORIZONTAL") {
    el.textContent = `Shown in pink in the view. Each piece gets a level ${t} mm slice partway up, clear of the bungee channels.`;
    return;
  }
  const mid = plans.map((p, i) => (p.middle ? i + 1 : 0)).filter(Boolean);
  el.textContent = `Shown in pink in the view: one upright ${t} mm slice across the main seam, through the top of the latex.` +
    (mid.length ? ` ${mid.length === 1 ? "Piece" : "Pieces"} ${mid.join(", ")} ${mid.length === 1 ? "isn't" : "aren't"} on that line, so ${mid.length === 1 ? "its slice goes" : "theirs go"} through the middle instead.` : "");
}

// selection and hover colours, without rebuilding anything
function highlight() {
  const activeCut = S.active;
  for (const [key, o] of meshes.segs) {
    const picked = S.selSegs.has(key), hov = S.hover && S.hover.kind === "seg" && S.hover.key === key;
    const ofCut = o.cut === activeCut || S.selCuts.has(o.cut);
    o.m.material.color.copy(picked ? COL.pick : COL.plane);
    o.m.material.opacity = picked ? 0.42 : hov ? 0.34 : ofCut ? 0.28 : 0.13;
    o.e.material.color.copy(picked ? COL.pick : COL.plane);
    o.e.material.opacity = picked || hov ? 1 : ofCut ? 0.95 : 0.55;
  }
  const anyPiece = S.selPieces.size > 0;
  for (const [id, o] of meshes.pieces) {
    const sel = S.selPieces.has(id), hov = S.hover && S.hover.kind === "piece" && S.hover.key === id;
    o.m.material.opacity = sel ? 0.16 : hov ? 0.1 : 0.04;
    o.e.material.opacity = sel || hov ? 0.95 : anyPiece ? 0.1 : 0.3;
  }
  if (anyPiece) for (const [key, o] of meshes.segs) {
    if (S.selSegs.has(key) || o.cut === activeCut || S.selCuts.has(o.cut)) continue;
    o.m.material.opacity = 0.05; o.e.material.opacity = 0.2;
  }
  for (const o of groups.slicePlan.children) {
    const on = !anyPiece || (o.userData.pieces || []).some((id) => S.selPieces.has(id));
    o.material.opacity = { sheet: on ? 0.2 : 0.04, edge: on ? 0.8 : 0.15, line: on ? 1 : 0.25 }[o.userData.part] ?? o.material.opacity;
  }
}
// the view handle sits on the cut, in the middle of the lines it still has:
// Z along its normal, X level in its plane
function placeHandle(inf, c) {
  const at = new V3(); let w = 0;
  for (const s of S.T.segs) if (s.cut === c.id) for (const pts of s.polys) {
    const a = pts.length >= 3 ? Math.max(1e-6, pts.slice(1, -1).reduce((sum, p, i) => sum + p.clone().sub(pts[0]).cross(pts[i + 2].clone().sub(pts[0])).length() / 2, 0)) : 0;
    const m = pts.reduce((q, p) => q.add(p), new V3()).multiplyScalar(1 / pts.length);
    at.addScaledVector(m, a); w += a;
  }
  const n = inf.n.clone();
  let x = c.kind === "level" ? new V3(-Math.sin(rad(c.az)), Math.cos(rad(c.az)), 0) : new V3(0, 0, 1).cross(n);
  x.sub(n.clone().multiplyScalar(x.dot(n)));
  if (x.lengthSq() < 1e-9) x = new V3(1, 0, 0).sub(n.clone().multiplyScalar(n.x));
  x.normalize();
  const y = n.clone().cross(x);
  handle.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, n));
  handle.position.copy(w > 0 ? at.multiplyScalar(1 / w) : inf.point);
}
// turn and tilt for a normal, keeping the cut's kind
function anglesFor(kind, nIn, tmax) {
  const n = nIn.clone().normalize();
  let az, t;
  if (kind === "level") {
    if (n.z < 0) n.negate();
    t = deg(Math.acos(Math.min(1, n.z))); az = Math.hypot(n.x, n.y) < 1e-6 ? 0 : deg(Math.atan2(n.y, n.x));
  } else {
    az = deg(Math.atan2(n.y, n.x)); t = deg(Math.asin(clamp(n.z, -1, 1)));
  }
  if (az < 0) { az += 180; t = -t; }
  if (az >= 180) { az -= 180; t = -t; }
  return { az: Math.round(az * 10) / 10, tilt: Math.round(clamp(t, -tmax, tmax) * 10) / 10 };
}
function onHandleMove(mode) {
  const c = cutById(S.active), inf = infoOf(S.active);
  if (!c || !inf || !inf.valid) return;
  if (mode === "translate") {
    const t = handle.position.dot(inf.n);
    let pos = clamp((t - inf.range[0]) / (inf.range[1] - inf.range[0] || 1), 0.01, 0.99);
    if (shiftDown) pos = clamp(Math.round(pos * 20) / 20, 0.01, 0.99);
    c.pos = pos;
  } else {
    const a = anglesFor(c.kind, new V3(0, 0, 1).applyQuaternion(handle.quaternion), tiltMax(c));
    if (shiftDown) { a.az = wrap180(Math.round(a.az / 5) * 5); a.tilt = clamp(Math.round(a.tilt / 5) * 5, -tiltMax(c), tiltMax(c)); }
    c.az = a.az; c.tilt = a.tilt;
    // turn about the handle, so the cut stays where you grabbed it
    const n = cutNormal(c); let lo = Infinity, hi = -Infinity;
    for (const v of inf.scopeVerts) { const t = n.dot(v); lo = Math.min(lo, t); hi = Math.max(hi, t); }
    c.pos = clamp((n.dot(handle.position) - lo) / (hi - lo || 1), 0.01, 0.99);
  }
  c.auto = false; syncCard(c); refresh({ keepHandle: true });
}

// ------------------------------------------------------------ cut cards
function scopeLabel(c) {
  if (c.parent == null) return "whole shell";
  const ids = parentIds(c);
  const last = String(ids[0]).split(".").pop();
  const k = last === "0" ? -1 : cutIndex(+last.slice(0, -1));
  return ids.length > 1 ? "inside a joined piece" : k >= 0 ? `inside cut ${k + 1}` : "one piece";
}
const fieldVal = (c, f) => (f === "pos" ? Math.round(c.pos * 1000) / 10 : c[f]);
const OPT_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/></svg>';
function renderCuts() {
  const box = $("#cuts");
  box.innerHTML = "";
  S.cuts.forEach((c, i) => {
    const depth = c.parent == null ? 0 : Math.max(...parentIds(c).map((p) => String(p).split(".").length - 1));
    const open = c.id === S.active;
    const el = document.createElement("section");
    el.className = "cut" + (open ? " open" : "") + (open || S.selCuts.has(c.id) ? " sel" : "");
    el.dataset.cut = c.id;
    el.style.marginLeft = Math.min(depth, 4) * 14 + "px";
    el.setAttribute("aria-label", `Cut ${i + 1}`);
    const tm = tiltMax(c);
    const kindWord = c.kind === "level" ? "Level" : "Upright";
    const row = (f, label, min, max, unit, title) => `
      <div class="slider" data-f="${f}"><label for="${f}${c.id}">${label}</label>
        <input id="${f}${c.id}" type="range" min="${min}" max="${max}" step="0.1" value="${fieldVal(c, f)}">
        <span class="val"><input type="number" step="any" value="${f1(fieldVal(c, f))}" aria-label="${label} (${unit === "°" ? "degrees" : "percent"})"><span>${unit}</span></span>
        <button type="button" class="opt" data-opt="${f}" title="${title}" aria-label="${title}">${OPT_ICON}</button></div>`;
    el.innerHTML = `
      <div class="cut-head"><span class="strong">Cut ${i + 1}</span><span class="scope">${scopeLabel(c)}</span>${c.auto ? '<span class="tag">auto</span>' : ""}${c.mirrorOf != null && cutById(c.mirrorOf) ? `<span class="tag">mirror of ${cutIndex(c.mirrorOf) + 1}</span>` : ""}<span class="tag part" hidden>part removed</span>
        <button type="button" class="x" aria-label="Remove cut ${i + 1}" title="Remove this cut (Delete)">✕</button></div>
      ${open ? `
      <div class="seg" role="group" aria-label="Cut direction">
        <button type="button" data-kind="upright" class="${c.kind !== "level" ? "on" : ""}">Upright</button>
        <button type="button" data-kind="level" class="${c.kind === "level" ? "on" : ""}">Level</button>
      </div>
      ${row("az", "Turn", 0, 179.9, "°", "Find the turn with the least overhang")}
      ${row("tilt", "Tilt", -tm, tm, "°", "Find the tilt with the least overhang")}
      ${row("pos", "Position", 1, 99, "%", "Find the position with the least overhang")}
      <div class="card-acts"><button type="button" class="btn sm optAll" title="Try turn, tilt and position together (O)">Optimize all three</button>
        <button type="button" class="btn sm mirror" title="Copy this cut to the other side, reflected">Mirror…</button></div>` :
      `<div class="summary mono">${kindWord} · turn ${f1(c.az)}° · tilt ${f1(c.tilt)}° · ${f1(fieldVal(c, "pos"))}%</div>`}`;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("input, button")) return;
      selectCut(c.id, e.shiftKey);
    });
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); if (!S.selCuts.has(c.id)) selectCut(c.id, false); cutMenu(e.clientX, e.clientY); });
    el.querySelector(".x").onclick = (e) => { e.stopPropagation(); deleteCuts([c.id]); };
    if (open) {
      el.querySelectorAll("[data-kind]").forEach((b) => b.onclick = () => {
        if (c.kind === b.dataset.kind) return;
        mark(null); c.kind = b.dataset.kind; c.tilt = 0; c.auto = false; renderCuts(); refresh();
      });
      el.querySelectorAll(".slider").forEach((s) => {
        const f = s.dataset.f, range = s.querySelector("input[type=range]"), num = s.querySelector("input[type=number]");
        // one drag of a slider is one step back, however long it takes
        let sliding = false;
        range.addEventListener("pointerdown", () => { mark(null); sliding = true; });
        range.addEventListener("change", () => { sliding = false; });
        range.addEventListener("input", () => {
          let v = +range.value;
          v = shiftDown ? Math.round(v / 5) * 5 : f === "pos" ? Math.round(v * 2) / 2 : Math.round(v);
          setField(c, f, v, sliding ? false : `slide:${c.id}:${f}`);
        });
        range.addEventListener("keydown", (e) => {
          const k = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
          if (!k) return;
          e.preventDefault();
          setField(c, f, fieldVal(c, f) + k * (e.shiftKey ? 5 : 1), `key:${c.id}:${f}`);
        });
        num.addEventListener("change", () => {
          const v = parseFloat(num.value);
          if (!Number.isFinite(v)) { num.value = f1(fieldVal(c, f)); return; }
          setField(c, f, v, null);
        });
        num.addEventListener("keydown", (e) => { if (e.key === "Enter") num.blur(); if (e.key === "Escape") { num.value = f1(fieldVal(c, f)); num.blur(); } });
      });
      el.querySelectorAll("[data-opt]").forEach((b) => b.onclick = () => optimize(c.id, [b.dataset.opt]));
      el.querySelector(".optAll").onclick = () => optimize(c.id, ["az", "tilt", "pos"]);
      el.querySelector(".mirror").onclick = (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        openMenu(r.left, r.bottom + 4, [
          { label: "Mirror left ↔ right", act: () => mirrorCuts([c.id], "lr") },
          { label: "Mirror front ↔ back", act: () => mirrorCuts([c.id], "fb") },
        ]);
      };
    }
    box.appendChild(el);
  });
  if (S.T) cutTags(S.T);
}
function setField(c, f, v, key) {
  if (key !== false) mark(key);
  if (f === "pos") c.pos = clamp(v / 100, 0.01, 0.99);
  else if (f === "az") c.az = wrap180(v);
  else c.tilt = clamp(v, -tiltMax(c), tiltMax(c));
  c.auto = false; syncCard(c); refreshSoon();
}
// put a cut's numbers back on its card without rebuilding it
function syncCard(c) {
  const el = $(`#cuts [data-cut="${c.id}"]`); if (!el) return;
  el.querySelectorAll(".slider").forEach((s) => {
    const f = s.dataset.f, v = fieldVal(c, f);
    const range = s.querySelector("input[type=range]"), num = s.querySelector("input[type=number]");
    if (document.activeElement !== range) range.value = v;
    if (document.activeElement !== num) num.value = f1(v);
  });
  el.querySelector(".cut-head .tag:not(.part)")?.remove();
}
function cutTags(T) {
  S.cuts.forEach((c) => {
    const el = $(`#cuts [data-cut="${c.id}"] .tag.part`);
    if (!el) return;
    const inner = T.innerCount.get(c.id), live = T.segCount.get(c.id);
    el.hidden = !inner;
    el.textContent = live ? "part removed" : "no lines left";
    el.closest(".cut").classList.toggle("empty", !!inner && !live);
  });
}
function selectCut(id, add) {
  showTab("cuts");
  if (add) {
    if (S.selCuts.has(id)) { S.selCuts.delete(id); if (S.active === id) S.active = [...S.selCuts].pop() ?? null; }
    else { S.selCuts.add(id); S.active = id; }
  } else {
    if (S.active === id && S.selCuts.size === 1 && !S.selSegs.size) return;
    S.selCuts = new Set([id]); S.active = id;
  }
  S.selSegs.clear(); S.selPieces.clear();
  renderCuts(); refresh();
}

$("#addCut").onclick = () => {
  mark(null);
  const first = S.cuts[0];
  const n = first ? cutNormal({ kind: "upright", az: (first.az + 90) % 180, tilt: 0 }) : new V3(0, 1, 0);
  const c = newCut(null, n, 0.5);
  S.active = c.id; S.selCuts = new Set([c.id]); renderCuts(); refresh();
};
$("#bestCut").onclick = () => withBusy("Finding the best first cut", async () => {
  const sg = await api("/api/suggest", { max_tilt: S.settings.max_tilt_deg });
  mark(null);
  const keep = S.cuts[0]?.id;
  const { c, point } = cutFromSuggestion(sg, keep);
  const was = S.cuts[0] && JSON.stringify([S.cuts[0].kind, S.cuts[0].az, S.cuts[0].tilt, +S.cuts[0].pos.toFixed(3)]);
  if (S.cuts.length) { c.parent = S.cuts[0].parent; S.cuts[0] = c; } else S.cuts.push(c);
  placeFromPoint(c, point); c.auto = true;
  S.active = c.id; S.selCuts = new Set([c.id]); renderCuts(); refresh();
  if (was === JSON.stringify([c.kind, c.az, c.tilt, +c.pos.toFixed(3)])) toast(`Cut 1 is already the best first cut (${sg.overhang_pct}% overhang on its own).`, true);
});
$("#autoCuts").onclick = () => withBusy("Looking for more cuts", async () => {
  if (!S.cuts.length) throw new Error("Add a first cut, or use Find best first cut.");
  const T = S.T;
  const keyCells = new Map(T.pieces.map((P) => [P.id, P.cells.map((ci) => T.cells[ci].id)]));
  const res = await api("/api/autosplit", {
    pieces: T.pieces.map((P) => ({ id: P.id, cells: pieceSpec(T, P).cells || [pieceSpec(T, P).hs] })),
    next_id: S.nextId, frame: [T.frame.ex.toArray(), T.frame.ey.toArray()], settings: S.settings,
  });
  if (!res.cuts.length) { toast(`No cut that helps enough. Overhang is ${res.before_pct}%.`, true); return; }
  mark(null);
  // a parent the engine names after a joined piece means all of its blocks
  const mapParent = (par) => {
    let best = null;
    for (const k of keyCells.keys()) if ((par === k || par.startsWith(k + ".")) && (!best || k.length > best.length)) best = k;
    if (!best) return par;
    const cells = keyCells.get(best), rest = par.slice(best.length);
    return cells.length === 1 ? cells[0] + rest : cells.map((x) => x + rest);
  };
  for (const k of res.cuts) {
    const c = { id: k.id, parent: k.parent == null ? null : mapParent(k.parent), ...angles(canonical(new V3(...k.normal))), pos: 0.5, auto: true };
    S.cuts.push(c); S.nextId = Math.max(S.nextId, k.id + 1);
    placeFromPoint(c, new V3(...k.point));
  }
  S.active = S.cuts[S.cuts.length - 1].id; S.selCuts = new Set([S.active]);
  renderCuts(); refresh();
  toast(`Added ${res.cuts.length} cut${res.cuts.length > 1 ? "s" : ""}. Overhang about ${res.before_pct}% → ${res.after_pct}%.`, true);
});
["tOver", "tPlanes", "tPieces"].forEach((id) => $("#" + id).onchange = () => refresh());
$("#tPour").onchange = () => { groups.pour.visible = $("#tPour").checked; };
$("#tSlices").onchange = () => { groups.slicePlan.visible = S.step === "cut" && $("#tSlices").checked; $("#legSlice").hidden = !$("#tSlices").checked || !S.cuts.length; };

// ------------------------------------------------------------ optimize
// Try one setting of a cut across its range, keep the one with the least
// overhang (pieces that would lock each other in count as a lot), then home in.
let optRun = null;
async function optimize(id, fields) {
  if (optRun) return;
  const c = cutById(id); if (!c) return;
  const i = cutIndex(id);
  mark(null);
  const total = latexTri.total;
  const before = compute();
  const was = { az: c.az, tilt: c.tilt, pos: c.pos };
  optRun = { cancel: false };
  const names = { az: "turn", tilt: "tilt", pos: "position" };
  $("#busyTitle").textContent = `Optimizing cut ${i + 1}…`; $("#busySub").textContent = ""; $("#busyCancel").hidden = false; $("#busy").hidden = false;
  try {
    const passes = fields.length > 1 ? 2 : 1;
    for (let p = 0; p < passes && !optRun.cancel; p++) for (const f of fields) {
      if (optRun.cancel) break;
      await lineSearch(c, f, (v, cost) => {
        $("#busySub").textContent = `Trying ${names[f]} ${f === "pos" ? f1(v * 100) + "%" : f1(v) + "°"} · overhang ${(100 * cost / total).toFixed(1)}%`;
      });
    }
  } finally {
    $("#busy").hidden = true; $("#busyCancel").hidden = true;
  }
  const cancelled = optRun.cancel; optRun = null;
  if (cancelled) { Object.assign(c, was); renderCuts(); refresh(); toast("Stopped. The cut is back where it was."); return; }
  c.auto = false;
  renderCuts(); refresh();
  const a = 100 * before.bad / total, b = 100 * S.T.bad / total;
  const dp = Math.abs(a - b) < 0.1 ? 2 : 1;
  const what = fields.length > 1 ? "turn, tilt and position" : names[fields[0]];
  toast(b < a - 0.01 || S.T.locked.length < before.locked.length ? `Cut ${i + 1}: overhang ${a.toFixed(dp)}% → ${b.toFixed(dp)}% (${what}).` :
    `Cut ${i + 1} already had its best ${what}.`, true);
}
async function lineSearch(c, f, say) {
  const total = latexTri.total;
  const tm = Math.min(tiltMax(c), +S.settings.max_tilt_deg || 45);
  const spec = f === "az" ? { lo: 0, hi: 180 - 7.5, step: 7.5, min: 0.5, span: 90, wrap: true } :
    f === "tilt" ? { lo: -tm, hi: tm, step: 5, min: 0.5, span: 2 * tm } : { lo: 0.04, hi: 0.96, step: 0.04, min: 0.004, span: 1 };
  const start = c[f];
  const norm = (v) => (spec.wrap ? wrap180(v) : clamp(v, spec.lo, spec.hi));
  const dist = (v) => (spec.wrap ? Math.min(Math.abs(v - start), 180 - Math.abs(v - start)) : Math.abs(v - start));
  // a small nudge toward where it started, so a flat stretch doesn't move it
  const costAt = (v) => { c[f] = v; const T = compute(); return [T.cost + 0.002 * total * dist(v) / spec.span, T.cost]; };
  // let the screen update now and then, not after every try
  let last = performance.now();
  const breathe = async (v, raw) => {
    if (performance.now() - last < 80) return;
    say(v, raw); await nextFrame(); last = performance.now();
  };
  let best = { v: start, s: costAt(start)[0] };
  for (let v = spec.lo; v <= spec.hi + 1e-9; v += spec.step) {
    const [s, raw] = costAt(norm(v));
    if (s < best.s) best = { v: norm(v), s };
    await breathe(v, raw); if (optRun.cancel) return;
  }
  for (let st = spec.step / 2; st >= spec.min; st /= 2) {
    for (const v of [norm(best.v - st), norm(best.v + st)]) {
      const [s, raw] = costAt(v);
      if (s < best.s) best = { v, s };
      await breathe(v, raw); if (optRun.cancel) return;
    }
  }
  c[f] = f === "pos" ? Math.round(best.v * 1000) / 1000 : Math.round(best.v * 10) / 10;
}
$("#busyCancel").onclick = () => { if (optRun) optRun.cancel = true; };

// ------------------------------------------------------------ pieces
function pullWords(d) {
  const az = (deg(Math.atan2(d.y, d.x)) + 360) % 360, up = deg(Math.asin(clamp(d.z, -1, 1)));
  return up > 80 ? "straight up" : `turn ${Math.round(az)}°, up ${Math.round(up)}°`;
}
// a cut that splits just this piece names its block, or all its blocks if it was joined
const pieceParent = (T, P) => (P.cells.length === 1 ? T.cells[P.cells[0]].id : P.cells.map((ci) => T.cells[ci].id));
const child = (pid, cutId, side) => (Array.isArray(pid) ? pid.map((x) => `${x}.${cutId}${side}`) : `${pid}.${cutId}${side}`);
// Which way a split runs comes from where you're looking: left | right and
// front | back are as seen on screen, snapped to the nearest square direction
// (along or across the first cut, or along or across any upright cut).
const WAYS = { lr: "left | right", fb: "front | back", tb: "top | bottom" };
function splitNormal(way) {
  if (way === "tb") return new V3(0, 0, 1);
  const f = camera.getWorldDirection(new V3()); f.z = 0;
  if (f.lengthSq() < 1e-4) { f.set(0, 1, 0).applyQuaternion(camera.quaternion); f.z = 0; } // looking straight down
  f.normalize();
  const want = way === "fb" ? f : new V3(f.y, -f.x, 0);
  const T = S.T, cands = [T.frame.ex.clone(), T.frame.ey.clone()];
  for (const c of S.cuts) if (c.kind !== "level") {
    const n = cutNormal(c); n.z = 0;
    if (n.lengthSq() > 1e-4) { n.normalize(); cands.push(n, new V3(-n.y, n.x, 0)); }
  }
  let best = cands[0], bd = -1;
  for (const n of cands) { const d = Math.abs(n.dot(want)); if (d > bd + 1e-6) { bd = d; best = n; } }
  return canonical(best);
}
// Split the picked pieces with one shared plane (or a few, for more parts).
// Picking every piece makes it a whole-shell cut.
function splitPieces(ids, way, parts = 2) {
  const T = S.T;
  const Ps = [...new Set(ids)].map((id) => T.pieces.find((l) => l.id === id)).filter(Boolean);
  if (!Ps.length) return;
  mark(null);
  const n = splitNormal(way), k = clamp(Math.round(parts) || 2, 2, 6);
  // Pieces that sit across this direction from each other (the two halves of a
  // left | right cut, split left | right again) each get their own cut through
  // their own middle. Pieces that overlap along it share one plane.
  const span = (P) => {
    let lo = Infinity, hi = -Infinity;
    for (const ci of P.cells) for (const f of T.cells[ci].poly.faces) for (const v of f.pts) { const t = n.dot(v); lo = Math.min(lo, t); hi = Math.max(hi, t); }
    return [lo, hi];
  };
  const bunches = [];
  for (const it of Ps.map((P) => ({ P, r: span(P) })).sort((a, b) => a.r[0] - b.r[0])) {
    const g = bunches.find((g) => Math.min(g.r[1], it.r[1]) - Math.max(g.r[0], it.r[0]) > 0.5 * Math.min(g.r[1] - g.r[0], it.r[1] - it.r[0]));
    if (g) { g.Ps.push(it.P); g.r = [Math.min(g.r[0], it.r[0]), Math.max(g.r[1], it.r[1])]; } else bunches.push({ Ps: [it.P], r: it.r.slice() });
  }
  const all = bunches.length === 1 && Ps.length === T.pieces.length;
  // more than two: take off the two outside parts first, then the middle,
  // so the middle stays one piece you can split differently later
  const go = (pid, k, first) => {
    if (k <= 1) return;
    const c1 = newCut(first && all ? null : pid, n, 1 / k);
    const rest = child(pid, c1.id, "p");
    if (k === 2) return;
    const c2 = newCut(rest, n, (k - 2) / (k - 1));
    go(child(rest, c2.id, "n"), k - 2, false);
  };
  for (const g of bunches) {
    const cells = g.Ps.flatMap((P) => P.cells.map((ci) => T.cells[ci].id));
    go(all ? "0" : cells.length === 1 ? cells[0] : cells, k, true);
  }
  S.active = S.cuts[S.cuts.length - 1].id; S.selCuts = new Set([S.active]); S.selPieces.clear();
  renderCuts(); refresh();
  const what = Ps.length === 1 ? "the piece" : Ps.length === T.pieces.length ? "every piece" : `${Ps.length} pieces`;
  toast(`Split ${what} ${WAYS[way]}${k > 2 ? ` into ${k}` : ""}. Drag the arrow to slide it or a ring to turn it.`, true);
}
const pickedOr = (id) => (S.selPieces.has(id) ? [...S.selPieces] : [id]);

// ------------------------------------------------------------ mirror
// A mirrored cut is the same cut reflected across the middle of the scan,
// left <-> right or front <-> back as you're looking at it. It goes right
// after the cut it mirrors, inside the matching piece on the other side.
function mirrorPlane(way) {
  const f = camera.getWorldDirection(new V3()); f.z = 0;
  if (f.lengthSq() < 1e-4) { f.set(0, 1, 0).applyQuaternion(camera.quaternion); f.z = 0; }
  f.normalize();
  const want = way === "fb" ? f : new V3(f.y, -f.x, 0);
  const cands = [new V3(1, 0, 0), new V3(0, 1, 0), S.T.frame.ex.clone(), S.T.frame.ey.clone()];
  let m = cands[0], bd = -1;
  for (const n of cands) { const d = Math.abs(n.dot(want)); if (d > bd + 1e-6) { bd = d; m = n; } }
  const pos = latexPos(); let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < pos.length; i += 3) { const t = pos[i] * m.x + pos[i + 1] * m.y + pos[i + 2] * m.z; lo = Math.min(lo, t); hi = Math.max(hi, t); }
  return { m: m.normalize(), mid: (lo + hi) / 2 };
}
const inside = (cell, q) => cell.hs.every((h) => h.n.dot(q) - h.d >= -1e-6);
function mirrorCuts(ids, way) {
  if (!S.T) return;
  const { m, mid } = mirrorPlane(way);
  const reflN = (v) => v.clone().sub(m.clone().multiplyScalar(2 * v.dot(m)));
  const reflP = (p) => p.clone().sub(m.clone().multiplyScalar(2 * (p.dot(m) - mid)));
  mark(null);
  const order = [...ids].sort((a, b) => cutIndex(a) - cutIndex(b));
  const made = []; let same = 0;
  for (const id of order) {
    const c = cutById(id); if (!c) continue;
    const i = cutIndex(id);
    const Ti = evaluate(S.cuts, latexTri, latexPos(), opts(), i + 1);
    const inf = Ti.info[i]; if (!inf || !inf.valid) continue;
    const n2 = canonical(reflN(inf.n)), p2 = reflP(inf.point), d2 = n2.dot(p2);
    let parent = null;
    if (c.parent != null) {
      // the pieces it splits, at the time it splits them, mirrored
      const before = evaluate(S.cuts, latexTri, latexPos(), opts(), i);
      const got = new Set();
      for (const tid of inf.targets) {
        const L = before.cells.find((x) => x.id === tid); if (!L) continue;
        const q = reflP(L.centroid);
        const M = before.cells.find((x) => inside(x, q)); if (M) got.add(M.id);
      }
      if (!got.size) continue;
      parent = got.size === 1 ? [...got][0] : [...got];
    }
    // already symmetric: the mirror lands on itself
    const sameParent = JSON.stringify(parent) === JSON.stringify(c.parent ?? null);
    if (sameParent && Math.abs(Math.abs(n2.dot(inf.n)) - 1) < 1e-4 && Math.abs(d2 - Math.sign(n2.dot(inf.n)) * inf.d) < 0.5) { same++; continue; }
    const nc = { id: S.nextId++, parent, ...angles(n2), pos: 0.5, auto: false, mirrorOf: c.id };
    S.cuts.splice(i + 1, 0, nc);
    placeFromPoint(nc, p2);
    made.push(nc.id);
  }
  if (!made.length) { H.undo.pop(); undoButtons(); toast(same ? "That cut is already the same on both sides." : "Couldn't find the matching piece on the other side."); return; }
  S.active = made[made.length - 1]; S.selCuts = new Set(made);
  renderCuts(); refresh();
  toast(`Mirrored ${made.length > 1 ? made.length + " cuts" : "the cut"} ${way === "fb" ? "front ↔ back" : "left ↔ right"}${same ? ` (${same} already matched)` : ""}. Ctrl+Z undoes it.`, true);
}
// the split buttons for the picked pieces (in a piece's card, or under "N pieces picked")
function splitControls(ids) {
  const box = document.createElement("div"); box.className = "split-box";
  const many = ids.length > 1, all = ids.length === S.T.pieces.length;
  box.innerHTML = `
    <div class="row-label">Split ${many ? (all ? "every piece" : `these ${ids.length} pieces`) : "this piece"} <span class="faint">· as you're looking at it</span></div>
    <div class="btn-grid3">
      <button type="button" class="btn" data-way="lr" title="A standing cut seen edge-on, splitting left from right">Left | right</button>
      <button type="button" class="btn" data-way="fb" title="A standing cut facing you, splitting front from back">Front | back</button>
      <button type="button" class="btn" data-way="tb" title="A level cut, splitting top from bottom">Top | bottom</button>
    </div>
    <label class="split-n">Into <input id="splitN" type="number" min="2" max="6" value="${S.splitN}" aria-label="How many parts"> parts${many ? " each" : ""}</label>`;
  const nIn = box.querySelector("#splitN");
  nIn.onchange = nIn.oninput = () => { S.splitN = clamp(+nIn.value || 2, 2, 6); };
  box.querySelectorAll("[data-way]").forEach((b) => b.onclick = () => splitPieces(ids, b.dataset.way, S.splitN));
  return box;
}
// join pieces by removing the lines between them
function mergePieces(ids) {
  const T = S.T;
  const set = new Set(ids.map((id) => T.pieces.findIndex((P) => P.id === id)).filter((i) => i >= 0));
  if (set.size < 2) { toast("Shift-click two or more pieces that touch, then press M or Delete to join them."); return; }
  const segs = T.segs.filter((s) => set.has(s.pa) && set.has(s.pb));
  if (!segs.length) { toast("Those pieces don't touch, so they can't be joined."); return; }
  removeLines(segs, `Joined ${set.size} pieces`);
  const after = new Set(ids.map((id) => S.T.pieces.findIndex((P) => P.cells.some((ci) => S.T.cells[ci].id === id || S.T.cells[ci].id.startsWith(id + ".")))));
  after.delete(-1);
  // keep the joined piece picked
  S.selPieces = new Set([...after].map((i) => S.T.pieces[i].id));
  refresh();
  if (after.size > 1) toast("Some of those pieces don't touch, so they stayed separate.");
}
function deleteSegs(keys) {
  const segs = S.T.segs.filter((s) => keys.has(s.key));
  if (segs.length) removeLines(segs, segs.length > 1 ? `Removed ${segs.length} lines` : "Removed the line");
}
// A cut whose lines are all gone stays in the list (marked "no lines left")
// so the cuts inside it keep their place; remove it with its ✕ if you like.
function removeLines(segs, msg) {
  mark(null);
  const had = new Set(S.cuts.filter((c) => S.T.segCount.get(c.id)).map((c) => c.id));
  for (const s of segs) S.joins.push(s.pairs[0].slice());
  S.selSegs.clear(); S.selPieces.clear();
  renderCuts(); refresh();
  const empty = S.cuts.filter((c) => had.has(c.id) && !S.T.segCount.get(c.id)).length;
  toast(`${msg}${empty ? `. ${empty > 1 ? empty + " cuts have" : "A cut has"} no lines left` : ""}. Ctrl+Z undoes it.`, true);
}
function renderPieces(T) {
  const box = $("#pieces");
  if (!S.cuts.length) { box.innerHTML = '<p class="muted small">Pieces show up once there\'s a cut.</p>'; $("#multiBar").hidden = true; return; }
  const focusId = document.activeElement?.id;
  box.innerHTML = "";
  const many = S.selPieces.size > 1;
  T.pieces.forEach((P, i) => {
    const pct = T.areaBy[i] ? 100 * T.badBy[i] / T.areaBy[i] : 0;
    const sel = S.selPieces.has(P.id);
    const el = document.createElement("div");
    el.className = "piece" + (sel ? " sel" : "");
    const ord = T.order[i];
    el.innerHTML = `
      <button type="button" class="piece-row" aria-expanded="${sel && !many}"><i class="sw" style="background:${pieceColor(i)}"></i>
        <span><span class="strong">Piece ${i + 1}</span> <span class="muted small">${P.cells.length > 1 ? "· joined" : ""}${S.pulls[P.id] ? " · your pull" : ""}</span></span>
        <span class="mono pct ${pct >= 2 ? "bad" : ""}" title="Overhang on this piece">${pct.toFixed(1)}%</span>
        ${ord ? `<span class="chip">off ${ordinal(ord)}</span>` : '<span class="chip lock">stuck</span>'}</button>`;
    const rowBtn = el.querySelector(".piece-row");
    rowBtn.onclick = (e) => selectPiece(P.id, e.shiftKey);
    rowBtn.oncontextmenu = (e) => { e.preventDefault(); if (!S.selPieces.has(P.id)) selectPiece(P.id, false); pieceMenu(e.clientX, e.clientY, P.id); };
    if (sel && !many) {
      const body = document.createElement("div"); body.className = "piece-body";
      body.innerHTML = `
        <div class="pull-line"><span>Pulls off</span><span class="mono">${pullWords(T.pull[i])}</span>
          ${S.pulls[P.id] ? '<button type="button" class="btn sm" data-autopull>Back to auto</button>' : '<span class="muted">auto</span>'}</div>
        <p class="muted small">Drag the tip of this piece's arrow in the view to change how it pulls off. Shift-click more pieces to split them together or join them.</p>`;
      body.prepend(splitControls([P.id]));
      const ap = body.querySelector("[data-autopull]");
      if (ap) ap.onclick = () => { mark(null); delete S.pulls[P.id]; refresh(); };
      el.appendChild(body);
    }
    box.appendChild(el);
  });
  if (focusId === "splitN") $("#splitN")?.focus();
  const mb = $("#multiBar");
  mb.hidden = !many;
  if (many) mb.querySelector("span").textContent = `${S.selPieces.size} pieces picked`;
  const ms = $("#multiSplit"); ms.innerHTML = ""; ms.hidden = !many;
  if (many) { ms.appendChild(splitControls([...S.selPieces])); if (focusId === "splitN") $("#splitN")?.focus(); }
}
$("#mergeBtn").onclick = () => mergePieces([...S.selPieces]);
function selectPiece(id, add) {
  showTab("cuts");
  if (add) { if (S.selPieces.has(id)) S.selPieces.delete(id); else S.selPieces.add(id); }
  else S.selPieces = S.selPieces.has(id) && S.selPieces.size === 1 ? new Set() : new Set([id]);
  S.selSegs.clear();
  refresh();
}
function selectSeg(key, add) {
  showTab("cuts");
  if (add) { if (S.selSegs.has(key)) S.selSegs.delete(key); else S.selSegs.add(key); }
  else S.selSegs = new Set([key]);
  const s = S.T.segs.find((x) => x.key === key);
  if (s && S.selSegs.has(key) && S.active !== s.cut) { S.active = s.cut; S.selCuts = new Set([s.cut]); renderCuts(); }
  S.selPieces.clear();
  refresh();
}
function clearPicks() {
  S.selSegs.clear(); S.selPieces.clear(); S.selCuts.clear(); S.active = null;
  renderCuts(); refresh();
}

// ------------------------------------------------------------ picking in the view
const ray = new THREE.Raycaster();
function setRay(e) {
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
}
function pickAt(e, kind) {
  if (insViewOn()) return null;
  setRay(e);
  if (kind === "seg") {
    if (!$("#tPlanes").checked) return null;
    const hit = ray.intersectObjects([...meshes.segs.values()].map((o) => o.m), false)[0];
    return hit ? { kind: "seg", key: hit.object.userData.seg } : null;
  }
  if (!$("#tPieces").checked) return null;
  const hit = ray.intersectObjects([...meshes.pieces.values()].map((o) => o.pick), false)[0];
  return hit ? { kind: "piece", key: hit.object.userData.piece } : null;
}
const modeKind = () => (S.mode === "lines" ? "seg" : "piece");
function setMode(m) {
  S.mode = m;
  $$("#editTools [data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  $("#hint").textContent = m === "lines" ?
    "Lines: click a line between pieces · Shift-click for more · Delete removes it · double-click picks the whole cut · right-click for options" :
    "Pieces: click a piece · Shift-click for more · right-click for options · drag an arrow tip to change how it pulls off";
  S.hover = null; highlight();
}
let drag = null, down = null, hoverT = null;
canvas.addEventListener("pointerdown", (e) => {
  down = null; closeMenu();
  const sh = e.button === 0 && S.step === "cut" ? sizerAt(e) : null;
  if (sh) { sizerStart(e, sh); e.stopImmediatePropagation(); return; }
  const ih = e.button === 0 && S.step === "cut" ? insHandleAt(e) : null;
  if (ih) { insDragStart(e, ih); e.stopImmediatePropagation(); return; }
  if (S.step !== "cut" || gizmoHot()) return;
  if (e.button === 2) { down = { x: e.clientX, y: e.clientY, button: 2 }; return; }
  if (e.button !== 0) return;
  setRay(e);
  if ($("#tPieces").checked && !insViewOn()) {
    const hit = ray.intersectObjects(groups.arrows.children.filter((o) => o.userData.tip), false)[0];
    if (hit) {
      mark(null);
      drag = hit.object.userData; orbit.enabled = false; canvas.setPointerCapture(e.pointerId);
      S.selPieces = new Set([drag.piece]); return;
    }
  }
  down = { x: e.clientX, y: e.clientY, button: 0 };
}, true);
canvas.addEventListener("pointermove", (e) => {
  if (sizeDrag) { sizerMove(e); return; }
  if (insDrag) { insDragMove(e); return; }
  if (drag) {
    setRay(e);
    const p = new V3();
    if (!ray.ray.intersectSphere(new THREE.Sphere(drag.origin, drag.len), p)) ray.ray.closestPointToPoint(drag.origin, p);
    const d = p.sub(drag.origin);
    if (d.z < 0) d.z = 0;
    if (d.length() < 1e-6) return;
    S.pulls[drag.piece] = d.normalize().toArray();
    refreshSoon();
    return;
  }
  if (e.buttons || S.step !== "cut" || hoverT) return;
  hoverT = requestAnimationFrame(() => {
    hoverT = null;
    if (insHandleAt(e) || sizerAt(e)) { canvas.style.cursor = "grab"; return; }
    const h = gizmoHot() ? null : pickAt(e, modeKind());
    if ((h && h.key) !== (S.hover && S.hover.key)) { S.hover = h; highlight(); canvas.style.cursor = h ? "pointer" : ""; }
  });
});
canvas.addEventListener("pointerleave", () => { if (S.hover) { S.hover = null; highlight(); canvas.style.cursor = ""; } });
canvas.addEventListener("pointerup", (e) => {
  if (sizeDrag) { sizerEnd(e); return; }
  if (insDrag) { insDragEnd(e); return; }
  if (drag) { drag = null; orbit.enabled = true; canvas.releasePointerCapture?.(e.pointerId); refresh(); return; }
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) { down = null; return; }
  const button = down.button; down = null;
  if (button === 2) {
    const h = pickAt(e, modeKind()) || pickAt(e, modeKind() === "seg" ? "piece" : "seg");
    if (!h) return;
    if (h.kind === "seg") { if (!S.selSegs.has(h.key)) selectSeg(h.key, false); lineMenu(e.clientX, e.clientY); }
    else { if (!S.selPieces.has(h.key)) selectPiece(h.key, false); pieceMenu(e.clientX, e.clientY, h.key); }
    return;
  }
  const h = pickAt(e, modeKind());
  if (!h) { if (!e.shiftKey) clearPicks(); return; }
  if (h.kind === "seg") selectSeg(h.key, e.shiftKey); else selectPiece(h.key, e.shiftKey);
});
canvas.addEventListener("dblclick", (e) => {
  if (S.step !== "cut" || S.mode !== "lines") return;
  const h = pickAt(e, "seg"); if (!h) return;
  const s = S.T.segs.find((x) => x.key === h.key); if (!s) return;
  S.selSegs = new Set(S.T.segs.filter((x) => x.cut === s.cut).map((x) => x.key));
  S.active = s.cut; S.selCuts = new Set([s.cut]); renderCuts(); refresh();
});
$$("#editTools [data-mode]").forEach((b) => b.onclick = () => setMode(b.dataset.mode));

// ------------------------------------------------------------ right-click menus
function openMenu(x, y, items) {
  const m = $("#ctx");
  m.innerHTML = "";
  for (const it of items) {
    if (it === "-") { m.appendChild(document.createElement("hr")); continue; }
    const b = document.createElement("button"); b.type = "button"; b.disabled = !!it.disabled;
    b.innerHTML = `<span></span>${it.key ? `<span class="k">${it.key}</span>` : ""}`;
    b.firstChild.textContent = it.label;
    b.onclick = () => { closeMenu(); it.act(); };
    m.appendChild(b);
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x + 2, innerWidth - r.width - 8)) + "px";
  m.style.top = Math.max(8, Math.min(y + 2, innerHeight - r.height - 8)) + "px";
  m.querySelector("button:not(:disabled)")?.focus();
}
function closeMenu() { $("#ctx").hidden = true; }
addEventListener("pointerdown", (e) => { if (!e.target.closest("#ctx")) closeMenu(); }, true);
addEventListener("resize", closeMenu);
// the browser's own menu never shows over ours (on Windows it fires after the
// button comes up, over whatever is under the mouse by then, often our menu);
// text boxes keep it for copy and paste
document.addEventListener("contextmenu", (e) => { if (!e.target.closest("input[type=text], input[type=number], textarea")) e.preventDefault(); });
function cutMenu(x, y) {
  const ids = [...S.selCuts];
  const one = ids.length === 1 ? cutIndex(ids[0]) : -1;
  openMenu(x, y, [
    ...(one >= 0 ? [
      { label: "Optimize turn", act: () => optimize(ids[0], ["az"]) },
      { label: "Optimize tilt", act: () => optimize(ids[0], ["tilt"]) },
      { label: "Optimize position", act: () => optimize(ids[0], ["pos"]) },
      { label: "Optimize all three", key: "O", act: () => optimize(ids[0], ["az", "tilt", "pos"]) },
      "-",
      { label: "Select its lines", act: () => { S.selSegs = new Set(S.T.segs.filter((s) => s.cut === ids[0]).map((s) => s.key)); setMode("lines"); refresh(); } },
    ] : []),
    { label: `Mirror ${ids.length > 1 ? "them" : "it"} left ↔ right`, act: () => mirrorCuts(ids, "lr") },
    { label: `Mirror ${ids.length > 1 ? "them" : "it"} front ↔ back`, act: () => mirrorCuts(ids, "fb") },
    "-",
    { label: ids.length > 1 ? `Delete ${ids.length} cuts` : "Delete cut", key: "Del", act: () => deleteCuts(ids) },
  ]);
}
function lineMenu(x, y) {
  const keys = new Set(S.selSegs), segs = S.T.segs.filter((s) => keys.has(s.key));
  if (!segs.length) return;
  const cuts = [...new Set(segs.map((s) => s.cut))];
  const n = segs.length;
  openMenu(x, y, [
    { label: n > 1 ? `Delete these ${n} lines` : "Delete this line", key: "Del", act: () => deleteSegs(keys) },
    { label: cuts.length > 1 ? `Delete the ${cuts.length} whole cuts` : "Delete the whole cut", act: () => deleteCuts(cuts) },
    "-",
    { label: "Select the whole cut", disabled: cuts.length > 1, act: () => { S.selSegs = new Set(S.T.segs.filter((s) => s.cut === cuts[0]).map((s) => s.key)); refresh(); } },
    { label: "Optimize this cut", key: "O", disabled: cuts.length > 1, act: () => optimize(cuts[0], ["az", "tilt", "pos"]) },
    { label: "Mirror the cut left ↔ right", act: () => mirrorCuts(cuts, "lr") },
    { label: "Mirror the cut front ↔ back", act: () => mirrorCuts(cuts, "fb") },
  ]);
}
function pickAllPieces() {
  S.selPieces = new Set(S.T.pieces.map((P) => P.id)); S.selSegs.clear(); setMode("pieces"); refresh();
}
function pieceMenu(x, y, id) {
  const many = S.selPieces.size > 1;
  const P = S.T.pieces.find((p) => p.id === id);
  const ids = pickedOr(id), what = ids.length === 1 ? "this piece" : ids.length === S.T.pieces.length ? "every piece" : `these ${ids.length}`;
  openMenu(x, y, [
    ...(many ? [{ label: `Join these ${S.selPieces.size} pieces`, key: "M", act: () => mergePieces([...S.selPieces]) }, "-"] : []),
    ...Object.entries(WAYS).map(([w, words]) => ({ label: `Split ${what} ${words}`, act: () => splitPieces(ids, w, 2) })),
    { label: `Split ${what} into 3, ${WAYS.lr}`, act: () => splitPieces(ids, "lr", 3) },
    { label: `Split ${what} into 3, ${WAYS.fb}`, act: () => splitPieces(ids, "fb", 3) },
    "-",
    { label: "Pick every piece", key: "Ctrl+A", act: () => pickAllPieces() },
    { label: "Pull back to auto", disabled: !(P && S.pulls[P.id]), act: () => { mark(null); delete S.pulls[id]; refresh(); } },
  ]);
}

// ------------------------------------------------------------ keys
const KEYS = [
  ["Ctrl+Z", "Undo"], ["Ctrl+Y or Ctrl+Shift+Z", "Redo"],
  ["Delete", "Remove the picked lines or cuts, or join the picked pieces"], ["Esc", "Clear the picks, close a menu, stop optimizing"],
  ["P / L", "Pick pieces / pick lines in the view"], ["Shift+click", "Pick more than one"], ["Ctrl+A", "Pick every piece"],
  ["Drag the arrow", "Slide the open cut"], ["Drag a ring", "Turn or tilt the open cut"], ["Shift while dragging", "Snap to 5° or 5%"],
  ["← →", "On a slider: 1° or 1% (Shift: 5)"], ["O", "Optimize the open cut"], ["M", "Join the picked pieces"],
  ["F", "Fit the view"], ["Numpad 1 / 3 / 7", "Front / side / top view"], ["1 / 2 / 3 / 4", "Scan / Cuts / Insert / Settings tab"], ["I", "Insert view, when the insert is on"], ["?", "Show these keys"],
];
$("#keysList").innerHTML = KEYS.map(([k, v]) => `<dt class="mono">${k}</dt><dd>${v}</dd>`).join("");
$("#keysBtn").onclick = () => { $("#keys").hidden = !$("#keys").hidden; };
$("#keysClose").onclick = () => { $("#keys").hidden = true; };
addEventListener("keydown", (e) => {
  if (S.step !== "cut") return;
  const typing = e.target.matches("input[type=number], input[type=text], select, textarea");
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (mod && k === "a" && !typing) { e.preventDefault(); pickAllPieces(); return; }
  if (mod && (k === "z" || k === "y")) {
    if (typing) return;
    e.preventDefault();
    if (k === "y" || e.shiftKey) redo(); else undo();
    return;
  }
  if (e.key === "Escape") {
    if (sizeDrag) { sizerCancel(); return; }
    if (optRun) { optRun.cancel = true; return; }
    if (insViewOn() && !typing) { setInsView(false); return; }
    if (!$("#ctx").hidden) { closeMenu(); return; }
    if (!$("#keys").hidden) { $("#keys").hidden = true; return; }
    if (!typing) clearPicks();
    return;
  }
  if (typing || mod || e.altKey || optRun || !$("#busy").hidden) return;
  if ((e.key === "i" || e.key === "I") && S.step === "cut" && S.insert?.on) { setInsView(!insViewOn()); return; }
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    if (S.selSegs.size) deleteSegs(new Set(S.selSegs));
    else if (S.selPieces.size > 1) mergePieces([...S.selPieces]);
    else if (S.selPieces.size === 1) toast("To join this piece to a neighbour, Shift-click both and press Delete, or pick Lines and delete the line between them.");
    else if (S.selCuts.size) deleteCuts([...S.selCuts]);
    else if (S.active != null) deleteCuts([S.active]);
    return;
  }
  const tabKey = { Digit1: "scan", Digit2: "cuts", Digit3: "insert", Digit4: "settings" }[e.code];
  if (tabKey) { e.preventDefault(); showTab(tabKey); return; }
  if (e.code === "Numpad1") return viewFrom("front");
  if (e.code === "Numpad3") return viewFrom("side");
  if (e.code === "Numpad7") return viewFrom("top");
  const act = {
    p: () => setMode("pieces"), l: () => setMode("lines"),
    o: () => S.active != null && optimize(S.active, ["az", "tilt", "pos"]),
    m: () => mergePieces([...S.selPieces]), f: () => viewFrom("fit"),
    "?": () => { $("#keys").hidden = !$("#keys").hidden; },
  }[e.key === "?" ? "?" : k];
  if (act) { e.preventDefault(); act(); }
});

// ------------------------------------------------------------ settings
const SET_FIELDS = $$("[data-set]");
let saveT = null;
function saveSettings() {
  clearTimeout(saveT);
  saveT = setTimeout(() => api("/api/settings", S.settings).catch((e) => toast(e.message)), 400);
}
// a number field's own label, min and max say what it may be
function badNumber(el) {
  if (el.type !== "number") return null;
  const v = el.value.trim() === "" ? NaN : +el.value, lo = el.min === "" ? -Infinity : +el.min, hi = el.max === "" ? Infinity : +el.max;
  const whole = el.step === "1";
  if (Number.isFinite(v) && v >= lo && v <= hi && (!whole || Number.isInteger(v))) return null;
  const name = (el.closest("label")?.childNodes[0]?.textContent || el.id).trim();
  return `${name} must be ${whole ? "a whole number " : ""}from ${lo} to ${hi}.`;
}
function fillSettings() {
  SET_FIELDS.forEach((el) => {
    if (S.settings[el.id] === undefined) return;
    if (el.type === "checkbox") el.checked = !!S.settings[el.id]; else el.value = S.settings[el.id];
  });
  $("#pair_gap_mm").disabled = !S.settings.channel_pairs;
  $$("#sliceStyle button").forEach((b) => b.classList.toggle("on", b.dataset.style === S.settings.test_slice_style));
  const hug = contourStyle();
  $$("#shellStyle button").forEach((b) => b.classList.toggle("on", b.dataset.style === (hug ? "CONTOUR" : "BOX")));
  $$("[data-box]").forEach((el) => el.hidden = hug);
  $$("[data-contour]").forEach((el) => el.hidden = !hug);
  $("#chanTitle").textContent = hug ? "Bungee cord" : "Bungee channels";
  $("#shellNote").textContent = hug ? "Follows the latex, with a raised strip on each seam and notches for the cord. Uses far less filament. The silicone insert needs Box." : "";
  const ss = S.settings, set = (id, t) => { const el = $(id); if (el) el.textContent = t; };
  set("#sumPour", +ss.pour_extend_mm ? `${ss.pour_extend_mm} mm` : "off");
  set("#sumShell", hug ? `hugs the latex · ${+ss.contour_mm} mm` : `box · ${+ss.wall_mm} mm wall`);
  set("#sumChan", hug ? `Ø${ss.hole_d_mm} cord · notches every ${+ss.notch_gap_mm} mm` : +ss.holes_per_corner ? `Ø${ss.hole_d_mm} · ${ss.holes_per_corner}/corner${ss.channel_pairs ? " · pairs" : ""}` : "none");
  set("#sumSlice", `${ss.test_slice_style === "VERTICAL" ? "upright" : "level"} · ${ss.test_slice_mm} mm`);
  set("#sumPrinter", `${ss.bed_mm} × ${ss.bed_d_mm ?? ss.bed_mm} × ${ss.bed_h_mm} mm`);
  const p = `${S.settings.bed_mm},${S.settings.bed_d_mm ?? S.settings.bed_mm},${S.settings.bed_h_mm}`;
  $("#plate").value = [...$("#plate").options].some((o) => o.value === p) ? p : "custom";
  $("#pourH").value = S.settings.pour_extend_mm || 0; $("#pourF").value = S.settings.pour_flare_deg || 0;
  pourLabels();
  const d = $("#defaults");
  const inch = (mm) => (Math.abs(mm - 6.35) < 0.01 ? "¼ in (6.35 mm)" : `${mm} mm`);
  d.innerHTML = `
    <dt>Shell style</dt><dd>${hug ? "hugs the latex" : "box"}</dd>` + (hug ? `
    <dt>Thickness</dt><dd>${+ss.contour_mm} mm</dd>
    <dt>Seam strips</dt><dd>${+ss.strip_w_mm} mm out · ${+ss.strip_t_mm} mm thick</dd>
    <dt>Cord notches</dt><dd>Ø${ss.hole_d_mm} mm cord · every ${+ss.notch_gap_mm} mm</dd>
    <dt>Foot</dt><dd>${+ss.foot_mm ? ss.foot_mm + " mm" : "none"}</dd>
    <dt>Alignment bumps</dt><dd>${+ss.bump_r_mm ? ss.bump_r_mm + " mm" : "none"}</dd>` : `
    <dt>Wall</dt><dd>${inch(+S.settings.wall_mm)}</dd>
    <dt>Bungee channels</dt><dd>Ø${S.settings.hole_d_mm} mm · ${S.settings.holes_per_corner} per corner${S.settings.channel_pairs ? ", in pairs" : ""}</dd>
    <dt>Channel from edge</dt><dd>${inch(+S.settings.hole_edge_mm)}</dd>`) + `
    <dt>Pour collar</dt><dd>${+S.settings.pour_extend_mm ? S.settings.pour_extend_mm + " mm" : "off"}</dd>
    <dt>Test slice</dt><dd>${S.settings.test_slice_style === "VERTICAL" ? "upright" : "level"} · ${S.settings.test_slice_mm} mm</dd>
    <dt>Printer</dt><dd>${printerName()} · ${S.settings.bed_mm} × ${S.settings.bed_d_mm ?? S.settings.bed_mm} × ${S.settings.bed_h_mm} mm</dd>`;
  if (SPLIT && S.scan) { renderSplit(); drawPrinter(); }
}
SET_FIELDS.forEach((el) => el.addEventListener("change", () => {
  const bad = badNumber(el);
  if (bad) {
    toast(`${bad} Kept ${S.settings[el.id]}.`);
    el.value = S.settings[el.id]; el.classList.add("bad"); setTimeout(() => el.classList.remove("bad"), 2500);
    return;
  }
  S.settings[el.id] = el.type === "checkbox" ? el.checked : el.type === "number" ? +el.value : el.value;
  saveSettings(); estimate(); fillSettings();
  if (["draft_deg", "wall_mm", "bottom_trim_mm", "test_slice_mm", "test_slice_at", "hole_d_mm", "holes_per_corner", "channel_pairs", "pair_gap_mm"].includes(el.id)) refresh();
}));
$$("#sliceStyle button").forEach((b) => b.onclick = () => { S.settings.test_slice_style = b.dataset.style; saveSettings(); fillSettings(); refresh(); });
$$("#shellStyle button").forEach((b) => b.onclick = () => { S.settings.shell_style = b.dataset.style; saveSettings(); fillSettings(); estimate(); refresh(); });
$("#plate").onchange = (e) => {
  if (e.target.value !== "custom") { const [w, d, h] = e.target.value.split(",").map(Number); S.settings.bed_mm = w; S.settings.bed_d_mm = d; S.settings.bed_h_mm = h; saveSettings(); fillSettings(); estimate(); }
};
$$(".resetDefaults").forEach((b) => b.onclick = async () => {
  try {
    S.settings = await api("/api/settings/reset", {});
    fillSettings(); estimate(); refresh(); updatePour();
    toast("Settings are back to the defaults.", true);
  } catch (e) { toast(e.message); }
});

function estimate() {
  const el = $("#estimate");
  if (!S.scan) { el.textContent = ""; return; }
  let bx, by, bz;
  const hug = contourStyle();
  if (hug) {
    const t = (+S.settings.contour_mm || 4) + (+S.settings.strip_w_mm || 0), [x, y, z] = S.scan.dims;
    bx = x + 2 * t; by = y + 2 * t; bz = z + (+S.settings.contour_mm || 4) + (+S.settings.pour_extend_mm || 0);
  } else if (S.T) { bx = S.T.boxHi[0] - S.T.boxLo[0]; by = S.T.boxHi[1] - S.T.boxLo[1]; bz = S.T.boxHi[2] - S.T.boxLo[2]; }
  else {
    const w = +S.settings.wall_mm || 6.35, pour = +S.settings.pour_extend_mm || 0;
    const [x, y, z] = S.scan.dims; bx = x + 2 * w; by = y + 2 * w; bz = z + w + pour;
  }
  const fits = fitsVol([bx, by, bz], printerVol());
  const n = S.T ? S.T.pieces.length : 2;
  el.className = "estimate" + (fits ? "" : " bad");
  el.textContent = `${n} pieces · ${hug ? "shell at most" : "box about"} ${Math.round(bx)} × ${Math.round(by)} × ${Math.round(bz)} mm · ${fits ? "fits your printer" : S.settings.split_big_pieces !== false ? "pieces get split to fit your printer" : "bigger than your printer"} · roughly ${Math.max(1, Math.round(S.scan.triangles / 60000 * (1 + n / 4)))} min to build`;
}

// pour collar preview
function pourLabels() {
  const h = +$("#pourH").value, f = +$("#pourF").value;
  $("#pourHv").textContent = h ? `${h} mm` : "off"; $("#pourFv").textContent = `${f}°`;
}
let pourT = null;
async function updatePour() {
  if (!S.scan) return;
  const h = +$("#pourH").value, f = +$("#pourF").value;
  groups.pour.clear();
  if (!h) return;
  try {
    const r = await api("/api/pour", { extend: h, flare: f });
    if (!r.url) return;
    const g = await loadSTL(r.url);
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: COL.latex, transparent: true, opacity: 0.45, roughness: 0.8 }));
    groups.pour.add(m);
  } catch (e) { toast(e.message); }
}
["pourH", "pourF"].forEach((id) => $("#" + id).addEventListener("input", () => {
  pourLabels();
  S.settings.pour_extend_mm = +$("#pourH").value; S.settings.pour_flare_deg = +$("#pourF").value;
  saveSettings(); refreshSoon();
  clearTimeout(pourT); pourT = setTimeout(updatePour, 350);
}));

// ------------------------------------------------------------ scan prep
// ------------------------------------------------------------ layouts
// The cuts you're working on are kept for each scan as you go, and come back
// when you open the scan again. You can also save layouts by name.
const layoutNow = () => ({ cuts: S.cuts, nextId: S.nextId, joins: S.joins, pulls: S.pulls, insert: S.insert, pieces: S.T ? S.T.pieces.length : 0, dims: S.scan && S.scan.size });
let autoT = null, autoLast = "";
function autosaveSoon() {
  if (!S.scan || S.step !== "cut") return;
  clearTimeout(autoT);
  autoT = setTimeout(() => {
    const L = layoutNow(), key = JSON.stringify([L.cuts, L.joins, L.pulls, L.insert]);
    if (key === autoLast) return;
    autoLast = key;
    api("/api/layouts", { op: "auto", layout: L }).catch(() => {});
  }, 1500);
}
function applyLayout(L) {
  S.cuts = JSON.parse(JSON.stringify(L.cuts || [])); S.joins = JSON.parse(JSON.stringify(L.joins || [])); S.pulls = JSON.parse(JSON.stringify(L.pulls || {}));
  S.nextId = Math.max(L.nextId || 1, ...S.cuts.map((c) => c.id + 1));
  S.active = S.cuts.length ? S.cuts[S.cuts.length - 1].id : null;
  S.selCuts = new Set(S.active != null ? [S.active] : []); S.selSegs.clear(); S.selPieces.clear();
  if (L.insert) { S.insert = { ...insDefaults(), ...L.insert }; insFill(); }
  renderCuts(); refresh();
}
const when = (t) => (t || "").replace("T", " ").slice(0, 16);
function renderLayouts() {
  const list = (S.layouts && S.layouts.saved) || [];
  $("#layoutsSum").textContent = list.length ? `${list.length} saved` : "";
  const box = $("#layoutList"); box.innerHTML = "";
  if (!list.length) { box.innerHTML = '<p class="muted small">None saved for this scan yet.</p>'; return; }
  for (const it of list) {
    const row = document.createElement("div"); row.className = "layout-row";
    row.innerHTML = `<button type="button" class="layout-load" title="Load this layout (Ctrl+Z goes back)"><span class="strong"></span><span class="mono small muted"></span></button><button type="button" class="x" title="Delete this saved layout">✕</button>`;
    row.querySelector(".strong").textContent = it.name;
    row.querySelector(".mono").textContent = `${it.layout.pieces || "?"} pieces · ${when(it.at)}`;
    row.querySelector(".layout-load").onclick = () => { mark(null); applyLayout(it.layout); toast(`Loaded "${it.name}". Ctrl+Z goes back.`, true); };
    row.querySelector(".x").onclick = async () => {
      if (!confirm(`Delete the saved layout "${it.name}"?`)) return;
      try { S.layouts = await api("/api/layouts", { op: "delete", name: it.name }); renderLayouts(); } catch (e) { toast(e.message); }
    };
    box.appendChild(row);
  }
}
async function saveLayout() {
  const name = $("#layoutName").value.trim() || `${S.T ? S.T.pieces.length : 0} pieces, ${new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
  try {
    S.layouts = await api("/api/layouts", { op: "save", name, layout: layoutNow() });
    $("#layoutName").value = ""; renderLayouts(); toast(`Saved "${name}".`, true);
  } catch (e) { toast(e.message); }
}
$("#layoutSave").onclick = saveLayout;
$("#layoutName").addEventListener("keydown", (e) => { if (e.key === "Enter") saveLayout(); });

async function showScan(info, keepCuts, restore) {
  S.scan = info;
  $("#fileName").textContent = info.file || info.name;
  $("#fileMeta").textContent = `${info.dims.join(" × ")} mm · ${info.triangles.toLocaleString()} triangles · ${info.watertight ? "watertight" : info.open_edges + " open edges"}`;
  $("#fileMeta").classList.toggle("bad", !info.watertight);
  const tried = S.repairTried === info.name;
  $("#scanHealth").textContent = info.watertight ? "Mesh is closed and ready." : tried ?
    `Still ${info.open_edges} open edges after repair.` : `${info.open_edges} open edges.`;
  $("#scanWarn").hidden = info.watertight;
  $("#scanWarnText").textContent = tried ?
    `Repair couldn't close every hole in this scan (${info.open_edges} open edges left). Fix it in your scan software, then load it again. The shell can't be built until then.` :
    `This scan has holes in its surface (${info.open_edges} open edges). The shell can't be carved around it properly until they're closed.`;
  $("#scanWarnFix").hidden = tried;
  fillSize();
  const g = await loadSTL(info.stl_url);
  g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3), 3));
  groups.latex.clear(); sizerReset(); if (!keepCuts) baseReset(); else if (baseH()) updateBase();
  latexMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0 }));
  groups.latex.add(latexMesh);
  latexTri = prepTriangles(g);
  latexBins = binFaces(latexTri);
  pullCache = {};
  grid.position.set(0, 0, 0);
  if (!keepCuts) {
    S.cuts = []; S.pulls = {}; S.joins = []; S.nextId = 1; S.active = null;
    S.selCuts.clear(); S.selSegs.clear(); S.selPieces.clear();
    S.insert = insDefaults(); insFill();
    if (info.suggested) { const { c, point } = cutFromSuggestion(info.suggested); S.cuts.push(c); placeFromPoint(c, point); c.auto = true; S.active = c.id; S.selCuts.add(c.id); }
    resetHistory();
  }
  if (info.layouts) S.layouts = info.layouts;
  renderLayouts();
  renderCuts();
  refresh();
  const back = restore && info.layouts && info.layouts.auto;
  if (back && back.cuts && back.cuts.length) {
    mark(null); applyLayout(back); autoLast = JSON.stringify([S.cuts, S.joins, S.pulls]);
    toast(`Brought back your last layout for this scan${info.prepared ? ", at the size you set" : ""}. Ctrl+Z gives the suggested first cut instead.`, true);
  } else if (restore && info.prepared) toast("Opened at the size you set last time.", true);
  updatePour();
  scanMarked();
}
$$("[data-prep]").forEach((b) => b.onclick = () => {
  const op = b.dataset.prep;
  const value = op === "trim_base" ? +$("#trimMm").value : op === "simplify" ? (+$("#simpPct").value) / 100 : undefined;
  const label = { lay_flat: "Laying it flat", reset: "Reloading the scan", trim_base: "Trimming the base", repair: "Repairing the mesh", simplify: "Simplifying" }[op];
  withBusy(label, async () => {
    if (op === "repair") S.repairTried = S.scan?.name; else if (op === "reset") S.repairTried = null;
    const info = await api("/api/prep", { op, value }); await showScan(info, op !== "reset" && op !== "lay_flat"); if (op === "lay_flat") viewFrom("fit");
    if (op === "repair" && info.watertight) toast(`${info.repair_note && info.repair_note !== "Nothing needed fixing." ? info.repair_note + " " : ""}The scan is closed and ready to build.`, true);
  });
});
$$("[data-rot]").forEach((b) => b.onclick = () => {
  const [axis, d] = b.dataset.rot.split(",");
  withBusy("Rotating", async () => { await showScan(await api("/api/prep", { op: "rotate", value: { axis, deg: +d } }), true); });
});
// Type the size you measured (or a %), then Apply. With proportions kept,
// one number sets the other two. The cuts stay put on the model.
const sizeIds = ["sizeX", "sizeY", "sizeZ"];
let sizeF = null; // the one factor when proportions are kept
const fmtDims = (d) => d.map((v) => (+v).toFixed(1)).join(" × ");
function fillSize() {
  const sz = S.scan && (S.scan.size || S.scan.dims); if (!sz) return;
  sizeIds.forEach((id, i) => { $("#" + id).value = (+sz[i]).toFixed(1); });
  $("#sizePct").value = "100"; sizeF = null;
  $("#sizeSum").textContent = fmtDims(sz) + " mm";
  const L = S.scan.loaded_dims;
  $("#sizeLoaded").textContent = L && L.some((v, i) => Math.abs(v - sz[i]) > 0.05) ? `· as loaded ${fmtDims(L)} mm` : "";
  sizeDirty(false);
}
function sizeDirty(on) { $("#sizeApply").disabled = $("#sizeCancel").disabled = !on; }
sizeIds.forEach((id, i) => {
  const el = $("#" + id);
  el.addEventListener("input", () => {
    const sz = S.scan && S.scan.size; const v = parseFloat(el.value); if (!sz || !(v > 0)) return;
    if ($("#sizeLock").checked) {
      sizeF = v / sz[i];
      sizeIds.forEach((o, j) => { if (j !== i) $("#" + o).value = (sz[j] * sizeF).toFixed(1); });
      $("#sizePct").value = +(sizeF * 100).toFixed(2);
    } else { sizeF = null; $("#sizePct").value = ""; }
    sizeDirty(true);
  });
});
$("#sizePct").addEventListener("input", () => {
  const sz = S.scan && S.scan.size, f = parseFloat($("#sizePct").value) / 100; if (!sz || !(f > 0)) return;
  sizeF = f; sizeIds.forEach((o, j) => { $("#" + o).value = (sz[j] * f).toFixed(1); });
  $("#sizeLock").checked = true; sizeDirty(true);
});
$("#sizeLock").onchange = () => { fillSize(); drawSizer(); };
$("#sizeCancel").onclick = () => { sizerReset(); fillSize(); };
[...sizeIds, "sizePct"].forEach((id) => $("#" + id).addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !$("#sizeApply").disabled) $("#sizeApply").click();
  if (e.key === "Escape") fillSize();
}));
$("#sizeApply").onclick = () => {
  const sz = S.scan.size;
  const f = $("#sizeLock").checked && sizeF ? [sizeF, sizeF, sizeF] : sizeIds.map((id, j) => parseFloat($("#" + id).value) / sz[j]);
  if (f.some((x) => !(x > 0.05 && x < 50))) { toast("Those sizes don't look right, so the scan wasn't changed. Type the size in mm."); sizerReset(); fillSize(); return; }
  if (f.every((x) => Math.abs(x - 1) < 1e-6)) { sizerReset(); fillSize(); return; }
  withBusy("Resizing the scan", async () => {
    await showScan(await api("/api/prep", { op: "scale", value: f }), true);
    toast(`The scan is now ${fmtDims(S.scan.size)} mm. The cuts moved with it. Build again for new test slices.`, true);
  });
};
let unitScale = 1;
$$("[data-scale]").forEach((b) => b.onclick = () => {
  const want = +b.dataset.scale; const f = want / unitScale; if (f === 1) return;
  withBusy("Changing units", async () => {
    await showScan(await api("/api/prep", { op: "scale", value: f }), true);
    unitScale = want; $$("[data-scale]").forEach((x) => x.classList.toggle("on", x === b)); viewFrom("fit");
  });
});

// ------------------------------------------------------------ sizing by dragging
// On the Scan tab the latex gets a box with a dot at each corner. Drag a corner
// to scale the whole scan (proportions kept). With "Keep proportions" off there
// are also dots on the sides and the top, to stretch one way only. It lets go
// into the same resize as Apply, so the cuts move with it.
var sizeDrag = null; // var: drawSizer can run before this line does
function sizerOn() { return !!(S.step === "cut" && S.scan && latexMesh && curTab() === "scan" && !insViewOn() && !busyNow()); }
function busyNow() { return !$("#busy").hidden; }
function sizerBase() { // the scan is scaled about the middle of its base
  const c = S.scan.center, sz = S.scan.size || S.scan.dims;
  return { o: new V3(c[0], c[1], c[2] - sz[2] / 2), sz: sz.map(Number) };
}
// ---- the printer's space, and splitting the model to fit it
var SPLIT = { cuts: [], parts: [], for: null }; // var: fillSettings may run before this line
function printerVol() { const s = S.settings || {}; return [+s.bed_mm || 256, +(s.bed_d_mm ?? s.bed_mm) || 256, +s.bed_h_mm || 256]; }
function printerName() {
  const o = $("#plate")?.selectedOptions?.[0];
  return o && o.value !== "custom" ? o.textContent.replace(/\s*\(.*\)$/, "") : "Your printer";
}
function overBy(d, v) {
  const flat = Math.min(Math.max(0, d[0] - v[0]) + Math.max(0, d[1] - v[1]), Math.max(0, d[1] - v[0]) + Math.max(0, d[0] - v[1]));
  return Math.round((Math.max(0, d[2] - v[2]) + flat) * 10) / 10;
}
function fitsVol(d, v) { return overBy(d, v) === 0; }
function modelDims() { const sz = (S.scan.size || S.scan.dims).map(Number); return [sz[0], sz[1], sz[2] + baseH()]; }
function drawPrinter() {
  const g = groups.printer;
  g.clear();
  g.visible = !!(S.step === "cut" && S.scan && curTab() === "scan" && !insViewOn() && $("#showPrinter").checked);
  if (!g.visible) return;
  const [W, D, H] = printerVol(), c = S.scan.center, sz = (S.scan.size || S.scan.dims).map(Number);
  const z0 = c[2] - sz[2] / 2 - baseH();
  const ok = fitsVol(modelDims(), [W, D, H]);
  const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(W, D, H)), new THREE.LineBasicMaterial({ color: ok ? "#7fc89a" : "#f08a70", transparent: true, opacity: 0.75 }));
  box.position.set(c[0], c[1], z0 + H / 2); g.add(box);
  const big = Math.max(...sz) * 1.25;
  for (const cut of SPLIT.cuts) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(big, big), new THREE.MeshBasicMaterial({ color: "#f0a040", transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(big, big)), new THREE.LineBasicMaterial({ color: "#f0a040" }));
    for (const o of [m, e]) {
      if (cut.kind === "x") { o.rotation.y = Math.PI / 2; o.position.set(cut.point[0], c[1], c[2]); }
      else if (cut.kind === "y") { o.rotation.x = Math.PI / 2; o.position.set(c[0], cut.point[1], c[2]); }
      else o.position.set(c[0], c[1], cut.point[2]);
      g.add(o);
    }
  }
}
function cutAxis(cut) { return cut.kind === "x" ? 0 : cut.kind === "y" ? 1 : 2; }
function renderSplit() {
  if (!S.scan) return;
  const v = printerVol(), d = modelDims(), over = overBy(d, v);
  $("#fitSum").textContent = over ? `${over} mm too big` : "fits";
  $("#fitLine").innerHTML = `${printerName()}: ${v.join(" × ")} mm. ` + (over
    ? `<span class="bad">The model (${d.map((x) => Math.round(x)).join(" × ")} mm) is ${over} mm too big for one print.</span> Press Suggest cuts.`
    : `<span class="ok">The model fits in one piece.</span>`);
  const c = S.scan.center, sz = (S.scan.size || S.scan.dims).map(Number);
  $("#splitCuts").innerHTML = SPLIT.cuts.map((cut, k) => {
    const a = cutAxis(cut), lo = Math.floor(c[a] - sz[a] / 2 - (a === 2 ? baseH() : 0)), hi = Math.ceil(c[a] + sz[a] / 2);
    const lab = cut.kind === "x" ? "upright, across" : cut.kind === "y" ? "upright, front-back" : "level";
    return `<div class="split-cut" data-k="${k}"><span>Cut ${k + 1} · ${lab}</span><input type="range" min="${lo}" max="${hi}" step="1" value="${cut.point[a]}"><input type="number" class="mono" step="1" value="${cut.point[a]}"><button type="button" class="btn sm" title="Remove this cut">×</button></div>`;
  }).join("");
  $("#splitParts").innerHTML = SPLIT.parts.map((p, k) => `<div>Part ${k + 1}: <span class="mono">${p.dims.map((x) => Math.round(x)).join(" × ")} mm</span> · <span class="${p.fits ? "ok" : "bad"}">${p.fits ? "fits" : `${p.over} mm too big`}</span>${p.file ? ` · ${p.file}` : ""}</div>`).join("");
  $("#splitGo").disabled = !SPLIT.cuts.length;
}
let splitT = null;
function splitChanged() {
  drawPrinter();
  SPLIT.parts = []; renderSplitParts();
  clearTimeout(splitT);
  splitT = setTimeout(async () => {
    if (!SPLIT.cuts.length) return;
    try { const r = await api("/api/split_plan", { cuts: SPLIT.cuts }); SPLIT.parts = r.parts; renderSplitParts(); }
    catch (e) { if (/Still working/.test(e.message)) splitT = setTimeout(splitChanged, 800); }
  }, 350);
}
function renderSplitParts() {
  $("#splitParts").innerHTML = SPLIT.parts.map((p, k) => `<div>Part ${k + 1}: <span class="mono">${p.dims.map((x) => Math.round(x)).join(" × ")} mm</span> · <span class="${p.fits ? "ok" : "bad"}">${p.fits ? "fits" : `${p.over} mm too big`}</span>${p.file ? ` · ${p.file}` : ""}</div>`).join("");
  $("#splitGo").disabled = !SPLIT.cuts.length;
}
$("#splitCuts").addEventListener("input", (e) => {
  const row = e.target.closest(".split-cut"); if (!row) return;
  const cut = SPLIT.cuts[+row.dataset.k], a = cutAxis(cut), val = +e.target.value;
  if (!Number.isFinite(val)) return;
  cut.point[a] = val;
  row.querySelectorAll("input").forEach((el) => { if (el !== e.target) el.value = val; });
  splitChanged();
});
$("#splitCuts").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  SPLIT.cuts.splice(+b.closest(".split-cut").dataset.k, 1); renderSplit(); splitChanged();
});
$("#splitAdd").onclick = () => {
  if (!S.scan) return;
  const c = S.scan.center, sz = (S.scan.size || S.scan.dims).map(Number);
  SPLIT.cuts.push({ point: [0, 0, Math.round(c[2])], normal: [0, 0, 1], kind: "level" });
  renderSplit(); splitChanged();
};
$("#splitSuggest").onclick = () => withBusy("Finding cuts that fit your printer", async () => {
  const r = await api("/api/split_plan", { suggest: true });
  SPLIT.cuts = r.cuts; SPLIT.parts = r.parts; renderSplit(); drawPrinter();
  toast(r.cuts.length ? `${r.cuts.length} ${r.cuts.length === 1 ? "cut makes" : "cuts make"} ${r.parts.length} parts that ${r.parts.every((p) => p.fits) ? "all fit" : "mostly fit"} your printer. Move them if you like, then press Split and save parts.` : "The model fits your printer in one piece, so it doesn't need splitting.", true);
});
$("#splitGo").onclick = () => withBusy("Splitting the model", async () => {
  const r = await api("/api/split", { cuts: SPLIT.cuts, open: true });
  SPLIT.parts = r.parts; renderSplitParts();
  const warn = [...r.no_room.map((k) => `cut ${k} has no room for a peg`), ...r.too_thin.map((k) => `cut ${k} is too thin for a peg`)];
  toast(`Saved ${r.parts.length} parts with ${r.pegs} ${r.pegs === 1 ? "peg" : "pegs"} in the scan's folder${warn.length ? ` (${warn.join(", ")})` : ""}. The folder is opening.`, !warn.length);
});
$("#showPrinter").onchange = () => drawPrinter();

function drawSizer() {
  const g = groups.sizer;
  if (S.scan) { if (SPLIT.for !== S.scan.name) { SPLIT.for = S.scan.name; SPLIT.cuts = []; SPLIT.parts = []; spoutReset(); seamReset(); } renderSplit(); drawPrinter(); drawSpout(); drawSeamVis(); }
  groups.base.visible = !!(S.step === "cut" && S.scan && curTab() === "scan" && !insViewOn());
  g.clear();
  g.visible = sizerOn();
  if (!g.visible) return;
  const { o, sz } = sizerBase(), f = sizeDrag ? sizeDrag.f : [1, 1, 1];
  const hx = sz[0] * f[0] / 2, hy = sz[1] * f[1] / 2, hz = sz[2] * f[2];
  const P = (x, y, z) => new V3(o.x + x, o.y + y, o.z + z);
  const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2 * hx, 2 * hy, hz)), new THREE.LineBasicMaterial({ color: "#f0c060", transparent: true, opacity: 0.7, depthTest: false }));
  box.position.copy(P(0, 0, hz / 2)); box.renderOrder = 5; g.add(box);
  const hs = Math.max(2.5, size() * 0.012);
  const knob = (p, kind, dir, col) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(hs * (sizeDrag?.kind === kind && sizeDrag.dir.equals(dir) ? 1.25 : 1), 16, 12), new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.95 }));
    m.position.copy(p); m.renderOrder = 6; m.userData.sizer = { kind, dir }; g.add(m);
  };
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz_ of [0, 1]) knob(P(sx * hx, sy * hy, sz_ * hz), "c", new V3(sx, sy, sz_), "#f0c060");
  knob(P(0, -hy, -baseH()), "b", new V3(0, -1, -1), "#8cc8ff");
  if (!$("#sizeLock").checked) {
    knob(P(hx, 0, hz / 2), "x", new V3(1, 0, 0), "#ffffff");
    knob(P(0, hy, hz / 2), "y", new V3(0, 1, 0), "#ffffff");
    knob(P(0, 0, hz), "z", new V3(0, 0, 1), "#ffffff");
  }
}
function sizerAt(e) {
  if (!groups.sizer.visible) return null;
  setRay(e);
  const hit = ray.intersectObjects(groups.sizer.children.filter((o) => o.userData.sizer), false)[0];
  return hit ? hit.object.userData.sizer : null;
}
function sizerStart(e, h) {
  const { o, sz } = sizerBase();
  if (h.kind === "b") { // the base dot: straight down from the front of the base
    sizeDrag = { ...h, from: o.clone().add(new V3(0, -sz[1] / 2, 0)), u: new V3(0, 0, -1), h0: baseH(), f: [1, 1, 1], sz };
    orbit.enabled = false; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = "grabbing"; mark(null);
    return;
  }
  // drag along the line from the anchor through the dot
  const at = h.kind === "c" ? new V3(h.dir.x * sz[0] / 2, h.dir.y * sz[1] / 2, h.dir.z * sz[2])
    : h.kind === "z" ? new V3(0, 0, sz[2]) : new V3(h.dir.x * sz[0] / 2, h.dir.y * sz[1] / 2, 0);
  const from = h.kind === "c" ? o.clone() : o.clone().add(new V3(0, 0, h.kind === "z" ? 0 : sz[2] / 2));
  sizeDrag = { ...h, from, u: at.clone().normalize(), len: at.length(), sz, f: [1, 1, 1] };
  orbit.enabled = false; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = "grabbing";
  mark(null);
}
function sizerMove(e) {
  const D = sizeDrag; setRay(e);
  if (D.kind === "b") {
    const t = lineParam(D.from, D.u); if (t == null) return;
    setBaseH(clamp(Math.round(t), 0, 80), true);
    drawSizer();
    return;
  }
  const t = lineParam(D.from, D.u); if (t == null || !(t > 0)) return;
  let k = t / D.len;
  if (shiftDown) k = Math.round(k * 20) / 20; // 5% steps
  k = clamp(k, 0.2, 5);
  if (D.kind === "c") {
    // round so the biggest side lands on a half millimetre
    const big = Math.max(...D.sz); k = Math.round(k * big * 2) / (big * 2);
    D.f = [k, k, k];
  } else {
    const i = { x: 0, y: 1, z: 2 }[D.kind]; k = Math.round(k * D.sz[i] * 2) / (D.sz[i] * 2);
    D.f = [1, 1, 1]; D.f[i] = k;
  }
  const { o } = sizerBase();
  groups.latex.scale.set(...D.f);
  groups.latex.position.set(o.x * (1 - D.f[0]), o.y * (1 - D.f[1]), o.z * (1 - D.f[2]));
  sizeIds.forEach((id, j) => { $("#" + id).value = (D.sz[j] * D.f[j]).toFixed(1); });
  $("#sizePct").value = D.kind === "c" ? +(D.f[0] * 100).toFixed(2) : "";
  sizeF = D.kind === "c" ? D.f[0] : null;
  sizeDirty(true);
  drawSizer();
}
function sizerReset() { groups.latex.scale.set(1, 1, 1); groups.latex.position.set(0, 0, 0); }
function sizerCancel() {
  if (sizeDrag && sizeDrag.kind === "b") { const h0 = sizeDrag.h0; sizeDrag = null; orbit.enabled = true; canvas.style.cursor = ""; setBaseH(h0); drawSizer(); return; }
  sizeDrag = null; sizerReset(); orbit.enabled = true; canvas.style.cursor = ""; fillSize(); drawSizer();
}
function sizerEnd(e) {
  const D = sizeDrag; sizeDrag = null;
  orbit.enabled = true; canvas.releasePointerCapture?.(e.pointerId); canvas.style.cursor = "";
  if (D.kind === "b") { setBaseH(baseH()); drawSizer(); return; }
  if (D.f.every((x) => Math.abs(x - 1) < 1e-4)) { sizerReset(); fillSize(); drawSizer(); return; }
  // the same resize as typing the size and pressing Apply
  if (D.kind !== "c") $("#sizeLock").checked = false;
  $("#sizeApply").click();
}

// ------------------------------------------------------------ a base on the model
// A base under the model itself (not the shell): its bottom outline carried
// straight down, or a flat slab round the whole footprint. You see it in blue
// while you set the height, then Add base puts it on the model for good.
function baseH() { return +$("#baseH").value || 0; }
function baseShape() { return $("#baseShape .on")?.dataset.bshape || "outline"; }
let baseT = null, baseShown = 0; // the height the preview was made at
let reachSet = false; // false: Reach up follows what the engine works out for this model
function baseLabels() {
  $("#baseHv").textContent = baseH() ? `${baseH()} mm` : "off";
  $("#baseFv").textContent = `${$("#baseF").value}°`;
  $("#baseMv").textContent = `${$("#baseM").value} mm`;
  $("#baseRv").textContent = `${$("#baseR").value} mm`;
  $("#baseRv").title = reachSet ? "" : "Set for you so the base meets the whole underside";
  if (!baseH()) $("#baseNote").hidden = true;
  $("#baseMRow").hidden = baseShape() !== "slab";
  $("#baseWRow").hidden = baseShape() === "slab";
  $("#baseWv").textContent = `${$("#baseW").value} mm`;
  $("#baseAdd").disabled = !baseH();
  $("#baseAdd").textContent = baseH() ? `Add ${baseH()} mm base` : "Add base";
}
function baseStretch() { // while dragging: stretch the last preview to the new height
  const h = baseH(), g = groups.base, z0 = S.scan ? S.scan.center[2] - (S.scan.size || S.scan.dims)[2] / 2 : 0;
  const k = baseShown > 0 ? Math.max(h, 0.01) / baseShown : 1;
  g.scale.set(1, 1, k); g.position.set(0, 0, z0 * (1 - k));
}
function setBaseH(h, live) {
  $("#baseH").value = h; baseLabels();
  if (!h) { groups.base.clear(); baseShown = 0; return; }
  baseStretch();
  clearTimeout(baseT); baseT = setTimeout(updateBase, live ? 450 : 0);
}
async function updateBase() {
  if (!S.scan || !baseH()) { groups.base.clear(); baseShown = 0; return; }
  if (sizeDrag && sizeDrag.kind === "b") { clearTimeout(baseT); baseT = setTimeout(updateBase, 300); return; }
  const v = { height: baseH(), flare: +$("#baseF").value, shape: baseShape(), margin: +$("#baseM").value, reach: reachSet ? +$("#baseR").value : "auto", widen: +$("#baseW").value };
  try {
    const r = await api("/api/base", v);
    if (!r.url || !baseH()) return;
    if (r.auto) {
      $("#baseR").value = r.reach; baseLabels();
      $("#baseNote").hidden = !(r.reach > 0);
      if (r.reach > 0) $("#baseNote").textContent = `Only part of the model touches the floor, so Reach up is set to ${r.reach} mm to meet the rest of the underside. Move it to change that.`;
      return finishBase(r, v);
    }
    const low = r.cover != null && r.cover < 0.45;
    $("#baseNote").hidden = !low;
    if (low) $("#baseNote").textContent = `Only part of the model reaches the floor${v.reach ? ` at ${v.reach} mm` : ""}, so the base meets about ${Math.round(r.cover * 100)}% of its underside. Raise Reach up until the blue meets the rest${v.shape === "slab" ? "" : ", or try Flat slab"}.`;
    const g = await loadSTL(r.url);
    groups.base.clear(); groups.base.scale.set(1, 1, 1); groups.base.position.set(0, 0, 0);
    groups.base.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: "#8cc8ff", transparent: true, opacity: 0.5, roughness: 0.8, side: THREE.DoubleSide })));
    baseShown = v.height;
    baseStretch(); // in case it moved on while the preview was made
  } catch (e) { if (!/Still working/.test(e.message)) toast(e.message); else { clearTimeout(baseT); baseT = setTimeout(updateBase, 600); } }
}
async function finishBase(r, v) {
  try {
    const g = await loadSTL(r.url);
    groups.base.clear(); groups.base.scale.set(1, 1, 1); groups.base.position.set(0, 0, 0);
    groups.base.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: "#8cc8ff", transparent: true, opacity: 0.5, roughness: 0.8, side: THREE.DoubleSide })));
    baseShown = v.height;
    baseStretch();
  } catch (e) { if (!/Still working/.test(e.message)) toast(e.message); else { clearTimeout(baseT); baseT = setTimeout(updateBase, 600); } }
}
function baseReset() { $("#baseH").value = 0; $("#baseR").value = 0; reachSet = false; $("#baseNote").hidden = true; groups.base.clear(); baseShown = 0; baseLabels(); }
$("#baseH").addEventListener("input", () => { setBaseH(baseH(), true); drawSizer(); });
$("#baseR").addEventListener("input", () => { reachSet = true; $("#baseNote").hidden = true; });
["baseF", "baseM", "baseR", "baseW"].forEach((id) => $("#" + id).addEventListener("input", () => { baseLabels(); clearTimeout(baseT); baseT = setTimeout(updateBase, 350); }));
$$("#baseShape [data-bshape]").forEach((b) => b.onclick = () => {
  $$("#baseShape [data-bshape]").forEach((x) => x.classList.toggle("on", x === b));
  baseLabels(); clearTimeout(baseT); baseT = setTimeout(updateBase, 50);
});
// ---- pour spout: placed by clicking the model, previewed here, joined on by the engine
var SPOUT = { picking: false, at: null, normal: null }; // var: drawSizer may run before this line
function spoutDir() {
  const up = $("#spoutDir .on")?.dataset.dir !== "normal";
  return up || !SPOUT.normal ? new V3(0, 0, 1) : SPOUT.normal.clone().normalize();
}
function drawSpout() {
  const g = groups.spout; g.clear();
  g.visible = !!(S.scan && curTab() === "scan" && S.step === "cut");
  $("#spoutAdd").disabled = !SPOUT.at;
  if (!SPOUT.at || !g.visible) return;
  const d = Math.max(3, +$("#spoutD").value || 20), h = Math.max(2, +$("#spoutH").value || 30), sink = Math.max(d, 5);
  const dir = spoutDir();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(d / 2, d / 2, h + sink, 40), new THREE.MeshStandardMaterial({ color: "#7fd89a", transparent: true, opacity: 0.75, roughness: 0.6 }));
  m.quaternion.setFromUnitVectors(new V3(0, 1, 0), dir);
  m.position.copy(SPOUT.at.clone().add(dir.clone().multiplyScalar((h - sink) / 2)));
  g.add(m);
  $("#spoutAdd").textContent = `Add ${d} mm spout`;
}
function spoutReset() { SPOUT.at = null; SPOUT.normal = null; SPOUT.picking = false; $("#spoutPick").classList.remove("on"); $("#spoutPick").textContent = "Place by clicking"; drawSpout(); }
canvas.addEventListener("pointerdown", (e) => {
  if (!SPOUT.picking || !latexMesh || e.button !== 0) return;
  setRay(e);
  const hit = ray.intersectObject(latexMesh, false)[0];
  if (!hit) return;
  e.stopImmediatePropagation(); e.preventDefault();
  SPOUT.at = hit.point.clone();
  SPOUT.normal = hit.face ? hit.face.normal.clone().transformDirection(latexMesh.matrixWorld) : null;
  SPOUT.picking = false; $("#spoutPick").classList.remove("on"); $("#spoutPick").textContent = "Place by clicking";
  drawSpout();
}, true);
$("#spoutPick").onclick = () => {
  SPOUT.picking = !SPOUT.picking;
  $("#spoutPick").classList.toggle("on", SPOUT.picking);
  $("#spoutPick").textContent = SPOUT.picking ? "Click the model…" : "Place by clicking";
};
$("#spoutTop").onclick = () => {
  if (!latexMesh) return;
  const pos = latexMesh.geometry.attributes.position; let best = -Infinity, at = null;
  for (let i = 0; i < pos.count; i++) { const z = pos.getZ(i); if (z > best) { best = z; at = i; } }
  // the top point, then straight down onto the surface there (a hair inside)
  SPOUT.at = new V3(pos.getX(at), pos.getY(at), best - 0.3); SPOUT.normal = new V3(0, 0, 1);
  drawSpout();
};
$$("#spoutDir button").forEach((b) => b.onclick = () => { $$("#spoutDir button").forEach((x) => x.classList.toggle("on", x === b)); drawSpout(); });
["spoutD", "spoutH"].forEach((id) => $("#" + id).addEventListener("input", drawSpout));
$("#spoutAdd").onclick = () => {
  if (!SPOUT.at) return;
  const d = +$("#spoutD").value, h = +$("#spoutH").value, dir = spoutDir();
  if (!(d >= 3 && d <= 100 && h >= 2 && h <= 200)) { toast("Spout diameter must be from 3 to 100 mm and height from 2 to 200 mm."); return; }
  withBusy("Adding the spout", async () => {
    const info = await api("/api/prep", { op: "add_spout", value: { point: SPOUT.at.toArray(), dir: dir.toArray(), d, h } });
    spoutReset(); await showScan(info, true); drawSizer();
    toast(`Added a ${d} mm spout, ${h} mm tall. The shell will be left open where it comes out. Reset scan takes it off.`, true);
  });
};

// ---- seam cards: placed by clicking (or suggested), made and shown by the engine
var SEAM = { picking: false, cards: [] }; // var: drawSizer may run before this line
let seamT = null;
function renderSeam() {
  const z0 = S.scan ? S.scan.center[2] - (S.scan.size || S.scan.dims)[2] / 2 : 0, z1 = S.scan ? z0 + +(S.scan.size || S.scan.dims)[2] : 100;
  $("#seamCards").innerHTML = SEAM.cards.map((c, k) => `<div class="split-cut" data-k="${k}"><span>Card ${k + 1} · top</span><input type="range" min="${Math.ceil(z0 + 5)}" max="${Math.floor(z1)}" step="1" value="${Math.round(c.top)}"><input type="number" class="mono" step="1" value="${Math.round(c.top - z0)}" title="Height of the card's top above the bottom (mm)"><button type="button" class="btn sm" title="Remove this card">×</button></div>`).join("");
  $("#seamSave").disabled = $("#seamClear").disabled = !SEAM.cards.length;
  $("#seamSave").textContent = SEAM.cards.length > 1 ? `Save ${SEAM.cards.length} seam card STLs` : "Save seam card STL";
}
function drawSeamVis() { groups.seam.visible = !!(S.scan && curTab() === "scan" && S.step === "cut"); }
function updateSeam() {
  clearTimeout(seamT);
  seamT = setTimeout(async () => {
    if (!SEAM.cards.length) { groups.seam.clear(); return; }
    try {
      const r = await api("/api/seam", { cards: SEAM.cards });
      if (!r.url) { groups.seam.clear(); return; }
      const g = await loadSTL(r.url);
      groups.seam.clear();
      groups.seam.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: "#a28cf0", transparent: true, opacity: 0.8, roughness: 0.6, side: THREE.DoubleSide })));
      drawSeamVis();
    } catch (e) { if (/Still working/.test(e.message)) updateSeam(); else toast(e.message); }
  }, 300);
}
function seamReset() { SEAM.cards = []; SEAM.picking = false; $("#seamPick").classList.remove("on"); $("#seamPick").textContent = "Place by clicking"; groups.seam.clear(); renderSeam(); }
canvas.addEventListener("pointerdown", (e) => {
  if (!SEAM.picking || !latexMesh || e.button !== 0) return;
  setRay(e);
  const hit = ray.intersectObject(latexMesh, false)[0];
  if (!hit || !hit.face) return;
  e.stopImmediatePropagation(); e.preventDefault();
  const n = hit.face.normal.clone().transformDirection(latexMesh.matrixWorld);
  let out = new V3(n.x, n.y, 0);
  if (out.length() < 0.2) { const c = S.scan.center; out = new V3(hit.point.x - c[0], hit.point.y - c[1], 0); }
  out.normalize();
  SEAM.cards.push({ point: hit.point.toArray(), out: out.toArray(), top: hit.point.z });
  SEAM.picking = false; $("#seamPick").classList.remove("on"); $("#seamPick").textContent = "Place by clicking";
  renderSeam(); updateSeam();
}, true);
$("#seamPick").onclick = () => {
  SEAM.picking = !SEAM.picking;
  $("#seamPick").classList.toggle("on", SEAM.picking);
  $("#seamPick").textContent = SEAM.picking ? "Click where its top goes…" : SEAM.cards.length ? "Add another card" : "Place by clicking";
};
$("#seamSuggest").onclick = () => withBusy("Checking the skin", async () => {
  const r = await api("/api/seam_suggest", {});
  if (!r.needed) { toast(`This one doesn't need a seam card: nothing above is much bigger round than the narrowest part below it (${r.ratio}×).`, true); return; }
  SEAM.cards.push({ point: r.point, out: r.out, top: r.top });
  renderSeam(); updateSeam();
  toast(`The skin has to stretch ${r.ratio}× over a part bigger round than the narrowest part below it, so it needs a seam card. Put one up the plainest side, from the bottom to ${Math.round(r.top - (S.scan.center[2] - (S.scan.size || S.scan.dims)[2] / 2))} mm up. Move it if you like.`, true);
});
$("#seamCards").addEventListener("input", (e) => {
  const row = e.target.closest(".split-cut"); if (!row) return;
  const c = SEAM.cards[+row.dataset.k], z0 = S.scan.center[2] - (S.scan.size || S.scan.dims)[2] / 2;
  const v = +e.target.value; if (!Number.isFinite(v)) return;
  c.top = e.target.type === "range" ? v : z0 + v;
  const [rg, nm] = row.querySelectorAll("input");
  if (e.target === rg) nm.value = Math.round(c.top - z0); else rg.value = Math.round(c.top);
  updateSeam();
});
$("#seamCards").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  SEAM.cards.splice(+b.closest(".split-cut").dataset.k, 1); renderSeam(); updateSeam();
});
$("#seamClear").onclick = () => seamReset();
$("#seamSave").onclick = () => withBusy("Making the seam cards", async () => {
  const r = await api("/api/seam_save", { cards: SEAM.cards, open: true });
  toast(`Saved ${r.files.map((f) => `${f.file} (${f.size[0]} × ${f.size[1]} mm)`).join(", ")} in the scan's folder, laid flat for printing. The folder is opening.`, true);
});
["seam_w_mm", "seam_t_mm", "seam_gap_mm", "seam_rim_w_mm", "seam_rim_t_mm"].forEach((id) => $("#" + id).addEventListener("change", () => setTimeout(updateSeam, 500)));

$("#baseAdd").onclick = () => {
  const v = { height: baseH(), flare: +$("#baseF").value, shape: baseShape(), margin: +$("#baseM").value, reach: +$("#baseR").value, widen: +$("#baseW").value };
  if (!v.height) return;
  withBusy("Adding the base", async () => {
    const info = await api("/api/prep", { op: "add_base", value: v });
    baseReset(); await showScan(info, true); drawSizer();
    toast(`Added a ${v.height} mm base. The model is now ${fmtDims(S.scan.size)} mm. Save model STL keeps a copy; Reset scan takes the base off.`, true);
  });
};
$("#saveModel").onclick = () => withBusy(baseH() ? "Adding the base and saving" : "Saving the model", async () => {
  // a base still showing in blue goes on first, so the saved model has it
  let added = "";
  if (baseH()) {
    const v = { height: baseH(), flare: +$("#baseF").value, shape: baseShape(), margin: +$("#baseM").value, reach: +$("#baseR").value, widen: +$("#baseW").value };
    const info = await api("/api/prep", { op: "add_base", value: v });
    baseReset(); await showScan(info, true); drawSizer();
    added = `Added the ${v.height} mm base and saved`;
  }
  const r = await api("/api/save_model", { open: true });
  toast(`${added || "Saved"} ${r.file}. The folder is opening with it picked out.`, true);
});
$("#showModel").onclick = () => api("/api/show_model", {}).catch((e) => toast(e.message));
baseLabels();

// ------------------------------------------------------------ side panel tabs
// One job per tab. Each tab keeps its own scroll place.
const tabScroll = {};
function curTab() { return $("#paneCut").dataset.tab || "cuts"; }
function showTab(t) {
  const pane = $("#paneCut"), sc = pane.querySelector(".scroll"), was = curTab();
  if (was === t) return;
  tabScroll[was] = sc.scrollTop;
  pane.dataset.tab = t;
  $$("#ptabs [data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
  sc.scrollTop = tabScroll[t] || 0;
  drawSizer();
}
$$("#ptabs [data-tab]").forEach((b) => b.onclick = () => showTab(b.dataset.tab));
function paintTabs() {
  const d = S.scan ? $("#sizeSum").textContent.match(/[\d.]+/g) : null;
  $("#tabScan").textContent = d && d.length >= 3 ? `${Math.round(+d[2])} mm tall` : "";
  $("#tabCuts").textContent = S.T ? `${S.T.pieces.length} piece${S.T.pieces.length === 1 ? "" : "s"}` : "";
  $("#tabInsert").textContent = S.insert?.on ? "on" : "off";
  $("#tabSettings").textContent = contourStyle() ? `hugs · ${+S.settings.contour_mm} mm` : S.settings?.wall_mm != null ? `${+(+S.settings.wall_mm).toFixed(2)} mm wall` : "";
}

// ------------------------------------------------------------ steps
function go(step) {
  S.step = step;
  $$(".step").forEach((b) => b.classList.toggle("on", b.dataset.step === step));
  $(".step[data-step=cut]").disabled = !S.scan;
  $(".step[data-step=done]").disabled = !S.build;
  $("#paneLoad").hidden = step !== "load"; $("#paneCut").hidden = step !== "cut"; $("#paneDone").hidden = step !== "done";
  $("#drop").hidden = step !== "load";
  $("#rail").hidden = step !== "cut"; $("#viewTools").hidden = step !== "cut"; $("#editTools").hidden = step !== "cut"; $("#toggles").hidden = step !== "cut"; $("#legend").hidden = step !== "cut"; $("#hud").hidden = step !== "cut";
  if (step !== "cut") { $("#keys").hidden = true; closeMenu(); }
  $("#labels").hidden = step !== "cut";
  $("#doneTools").hidden = step !== "done"; $("#spreadBox").hidden = step !== "done";
  groups.latex.visible = step === "cut" || (step === "done" && S.show === "latex");
  groups.slicePlan.visible = step === "cut" && $("#tSlices").checked;
  groups.pour.visible = step === "cut" && $("#tPour").checked;
  groups.insert.visible = step === "cut" && !!S.insert?.on;
  groups.pieces.visible = step === "done" && S.show !== "slices";
  groups.slices.visible = step === "done" && (S.show === "slices" || (S.show === "latex" && !!S.build?.slices_only));
  if (step === "load") { groups.latex.visible = false; loadRecent(); }
  if (step === "cut" && S.T) refresh();
  else { detachHandle(); groups.planes.visible = groups.regions.visible = groups.arrows.visible = false; }
  if (latexMesh) { latexMesh.material.transparent = step === "done"; latexMesh.material.opacity = step === "done" ? 0.9 : 1; latexMesh.material.depthWrite = true; latexMesh.material.needsUpdate = true; }
  applyInsView();
}
$$(".step").forEach((b) => b.onclick = () => go(b.dataset.step));

// file in
async function takeFile(file) {
  if (!file) return;
  if (!/\.(stl|obj|ply|blend)$/i.test(file.name)) { toast("GnomeShell opens STL, OBJ, PLY and .blend files. Export the model as one of those and drag it in."); return; }
  await withBusy("Loading scan", async () => {
    const buf = await file.arrayBuffer();
    const info = await api("/api/load", buf, file.name);
    unitScale = 1; $$("[data-scale]").forEach((x) => x.classList.toggle("on", x.dataset.scale === "1"));
    S.build = null; groups.pieces.clear(); groups.slices.clear();
    go("cut"); await showScan(info, false, true); viewFrom("fit");
    const big = Math.max(...info.dims);
    if (big < 30) {
      showTab("scan");
      toast(`This scan is only ${big} mm across. If it was saved in cm or inches, pick that under "Scan was saved in".`);
    }
  });
}
$("#fileInput").onchange = (e) => takeFile(e.target.files[0]);
const view = $("#view");
["dragenter", "dragover"].forEach((t) => view.addEventListener(t, (e) => { e.preventDefault(); $("#drop").classList.add("over"); if (S.step !== "load") $("#drop").hidden = false; }));
["dragleave", "drop"].forEach((t) => view.addEventListener(t, (e) => { e.preventDefault(); $("#drop").classList.remove("over"); if (S.step !== "load") $("#drop").hidden = true; }));
view.addEventListener("drop", (e) => takeFile(e.dataTransfer.files[0]));

async function loadRecent() {
  const list = await api("/api/recent").catch(() => null);
  const box = $("#recent");
  if (!list || !list.length) return;
  box.innerHTML = "";
  list.forEach((r) => {
    const b = document.createElement("button"); b.type = "button";
    const dims = r.scan_dims ? `${r.scan_dims.map((v) => (+v).toFixed(1)).join(" × ")} mm · ` : "";
    const what = r.built_at && r.built_at >= (r.saved_at || "") ? (r.slices_only ? `test slices cut ${r.built_at.slice(0, 10)}` : `${r.pieces} pieces · built ${r.built_at.slice(0, 10)}`) : `layout saved ${(r.saved_at || "").slice(0, 10)}`;
    b.innerHTML = `<span class="strong"></span><span class="mono">${dims}${what}${r.layouts ? ` · ${r.layouts} saved` : ""}</span>`;
    b.querySelector(".strong").textContent = r.name;
    b.onclick = () => withBusy("Loading scan", async () => {
      const info = await api("/api/load_recent", { name: r.name });
      S.build = null; groups.pieces.clear(); groups.slices.clear();
      go("cut"); await showScan(info, false, true); viewFrom("fit");
    });
    box.appendChild(b);
  });
}

// ------------------------------------------------------------ build
function startBuild(slicesOnly) {
  if (!S.cuts.length || !S.T) { toast("Add at least one cut first."); return; }
  if (S.scan && !S.scan.watertight) { toast($("#scanWarnText").textContent); showTab("scan"); return; }
  const T = S.T;
  if (T.locked.length) { toast(`Pieces ${T.locked.map((i) => i + 1).join(", ")} can't come off as set. Change one of their arrows first.`); return; }
  // every line between two pieces, so channels that a line would cut get skipped
  const byId = new Map(T.cells.map((L) => [L.id, L]));
  const cuts = [];
  for (const s of T.segs) {
    const pl = T.planes.get(s.cut);
    for (const [a, b] of s.pairs) {
      const scope = [...byId.get(a).hs, ...byId.get(b).hs].filter((h) => h.cut !== s.cut).map((h) => [h.point.toArray(), h.n.toArray()]);
      cuts.push({ point: pl.n.clone().multiplyScalar(pl.d).toArray(), normal: pl.n.toArray(), scope });
    }
  }
  const plans = T.slicePlans || slicePlans(T);
  const pieces = T.pieces.map((P, i) => ({ id: P.id, ...pieceSpec(T, P), pull: T.pull[i].toArray(), order: T.order[i], slice: planJSON(plans[i]) }));
  withBusy(slicesOnly ? "Cutting the test slices" : "Building the shell", async () => {
    const res = await api("/api/build", { cuts, pieces, frame: [T.frame.ex.toArray(), T.frame.ey.toArray()], settings: S.settings, slices_only: !!slicesOnly, insert: slicesOnly ? null : insSpec() });
    S.build = res; setShow(res.slices_only ? "latex" : "shell"); await showBuild(res); go("done"); viewFrom("fit");
  }, true);
}
$("#build").onclick = () => startBuild(false);
$("#buildSlices").onclick = () => startBuild(true);
$("#buildNow").onclick = () => { go("cut"); startBuild(false); };

async function showBuild(res) {
  groups.pieces.clear(); groups.slices.clear();
  let k = 0;
  for (const p of res.previews) {
    const g = await loadSTL(p.url);
    const idx = p.test || p.holder ? 0 : k++;
    const mat = new THREE.MeshStandardMaterial({ color: p.test ? COL.slice : p.holder ? new THREE.Color("#a77ce8") : new THREE.Color(pieceColor(idx)), roughness: 0.6, side: THREE.DoubleSide });
    const m = new THREE.Mesh(g, mat); m.userData.pull = new V3(...p.pull);
    (p.test ? groups.slices : groups.pieces).add(m);
  }
  spread();
  const mb = (b) => b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB";
  const row = (f) => `<div><span></span><span class="mono">${mb(f.size)}</span></div>`;
  const put = (id, list) => { const el = $(id); el.innerHTML = list.map(row).join(""); [...el.children].forEach((d, i) => d.firstChild.textContent = list[i].name); el.previousElementSibling.hidden = el.hidden = !list.length; };
  const first = res.files.filter((f) => /TEST|test_slices/.test(f.name));
  const shell = res.files.filter((f) => /^SHELL_\d+\.stl$|^shell\.3mf$/.test(f.name));
  const forIns = res.files.filter((f) => /^(holder|insert_cup)\./.test(f.name));
  const other = res.files.filter((f) => !first.includes(f) && !shell.includes(f) && !forIns.includes(f));
  put("#filesFirst", first); put("#filesShell", shell); put("#filesInsert", forIns); put("#filesOther", other);
  const only = !!res.slices_only;
  $("#doneTools [data-show=shell]").hidden = only;
  $("#doneTools [data-show=latex]").textContent = only ? "On the latex" : "With latex";
  $("#openBambu").hidden = only; $("#buildNow").hidden = !only;
  $("#shellNext").hidden = !only;
  $("#doneTitle").textContent = only ? `Test slices cut in ${res.seconds} s` : `Shell built in ${res.seconds} s`;
  $("#doneSub").textContent = only ? `${res.pieces} ${res.pieces === 1 ? "slice" : "slices"}, ${res.slice_mm} mm thick` :
    `${res.pieces} pieces${res.loose_bits_removed ? `, ${res.loose_bits_removed} loose bits removed` : ""}`;
  const d = res.box_mm || [0, 0, 0];
  const openP = res.open_pieces || [];
  $("#doneWarn").hidden = !openP.length;
  $("#doneWarn").textContent = openP.length ? `${openP.map((n) => n.replace("SHELL_", "Piece ").replace("_TEST", " test slice")).join(", ")} didn't come out closed, so don't print ${openP.length === 1 ? "it" : "them"}. Try moving the cut near ${openP.length === 1 ? "it" : "them"} a little and build again.` : "";
  if (only) {
    $("#doneKv").innerHTML = `
    <dt>Shell box</dt><dd>${d.join(" × ")} mm</dd>
    <dt>Fits your plate</dt><dd style="color:${res.fits_plate ? "var(--ok)" : "#f08a70"}">${res.fits_plate ? "yes" : "no"}</dd>
    <dt>Slices</dt><dd>${S.settings.test_slice_style === "VERTICAL" ? "upright, across the seam" : "level"}</dd>`;
    $("#doneOrder").innerHTML = "";
    $("#donePath").textContent = res.folder;
    return;
  }
  $("#doneKv").innerHTML = `
    ` + (res.shell_style === "CONTOUR" ? `<dt>Shell</dt><dd>hugs the latex · ${d.join(" × ")} mm across</dd>
    <dt>Cord notches</dt><dd>${res.notches}</dd>
    <dt>Alignment bumps</dt><dd>${res.bumps || "none"}</dd>` : `<dt>Box</dt><dd>${d.join(" × ")} mm</dd>
    <dt>Bungee channels</dt><dd>${res.channels}${res.skipped_channels ? ` (${res.skipped_channels} skipped at a cut)` : ""}</dd>`) + `
    <dt>Fits your printer</dt><dd style="color:${res.fits_plate ? "var(--ok)" : "#f08a70"}">${res.fits_plate ? "yes" : (res.split_pieces || []).length ? "each part does" : "no"}</dd>` + ((res.split_pieces || []).length ? `
    <dt>Split to fit</dt><dd>${res.split_pieces.map((s) => `${s.piece.replace("SHELL_", "piece ")} into ${s.parts}, ${s.pegs ? `${s.pegs} pegs` : "too thin for pegs, glue them"}`).join("; ")}</dd>` : "") + `
    <dt>Pour collar</dt><dd>${+S.settings.pour_extend_mm ? S.settings.pour_extend_mm + " mm" : "off"}</dd>` + (res.insert ? `
    <dt>Thinnest concrete</dt><dd style="color:${res.insert.thinnest_mm >= (S.insert.least || 20) ? "var(--ok)" : "#f08a70"}">${res.insert.thinnest_mm} mm</dd>
    <dt>Silicone to mix</dt><dd>about ${res.insert.silicone_l} L</dd>
    <dt>Holder</dt><dd>${res.insert.holder_mm.join(" × ")} mm</dd>
    <dt>Air holes</dt><dd>${res.insert.air_holes === 1 ? "1 (core too narrow for 3)" : res.insert.air_holes}</dd>
    <dt>Cup</dt><dd>${res.insert.cup_mm.join(" × ")} mm</dd>` : "");
  const ord = (res.order || []).filter((o) => o.order);
  const steps = [...new Set(ord.map((o) => o.order))].sort((a, b) => a - b);
  $("#doneOrder").innerHTML = ord.length && steps.length > 1 ? `<h2>Take them off in this order</h2><div class="order">${steps.map((s) =>
    `<div><span class="chip">${ordinal(s)}</span><span>${ord.filter((o) => o.order === s).map((o) => o.name.replace("SHELL_", "Piece ")).join(", ")}</span></div>`).join("")}</div>` :
    ord.length ? '<p class="muted small">The pieces can come off in any order.</p>' : "";
  $("#donePath").textContent = res.folder;
}
function spread() {
  const v = +$("#spread").value; $("#spreadVal").textContent = `${v} mm`;
  groups.pieces.children.forEach((m) => m.position.copy(m.userData.pull).multiplyScalar(v));
  groups.slices.children.forEach((m) => m.position.copy(m.userData.pull).multiplyScalar(S.show === "slices" ? v * 0.5 : 0));
}
function frameGroup(g) {
  const b = new THREE.Box3().setFromObject(g); if (b.isEmpty()) return;
  const c = b.getCenter(new V3()), r = Math.max(30, b.getSize(new V3()).length());
  camera.position.copy(c).add(new V3(0.8, -1, 0.55).normalize().multiplyScalar(r * 1.6));
  orbit.target.copy(c); orbit.update();
}
$("#spread").addEventListener("input", spread);
function setShow(v) { S.show = v; $$("#doneTools button").forEach((x) => x.classList.toggle("on", x.dataset.show === v)); }
$$("#doneTools [data-show]").forEach((b) => b.onclick = () => {
  setShow(b.dataset.show); go("done"); spread();
  if (b.dataset.show === "slices") frameGroup(groups.slices); else viewFrom("fit");
});
$("#openBambu").onclick = () => api("/api/open", { what: "bambu" }).catch((e) => toast(e.message));
$("#openSlices").onclick = () => api("/api/open", { what: "slices" }).catch((e) => toast(e.message));
$("#openFolder").onclick = () => api("/api/open", { what: "folder" }).catch((e) => toast(e.message));
$("#backCuts").onclick = () => go("cut");

// ------------------------------------------------------------ busy + toast
let pollT = null;
async function withBusy(title, fn, poll) {
  $("#busyTitle").textContent = title + "…"; $("#busySub").textContent = ""; $("#busy").hidden = false;
  if (poll) pollT = setInterval(async () => { try { const s = await api("/api/status"); $("#busySub").textContent = s.progress || ""; } catch (e) { /* engine busy */ } }, 700);
  try { await fn(); } catch (e) { toast(e.message); } finally { clearInterval(pollT); $("#busy").hidden = true; }
}
let toastT = null;
function toast(msg, good) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast" + (good ? " good" : ""); t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 6000);
}

// ------------------------------------------------------------ app window
// let the engine know the window is open, and when it closes. If the engine
// goes away, or a different one takes over this port, say so instead of
// leaving buttons that quietly fail.
let engineBoot = null, pingMisses = 0, warnKind = null;
function engineWarn(kind, msg) {
  if (warnKind === "old" && kind !== "old") return; // the clearest reason stays
  warnKind = kind;
  const w = $("#engineWarn");
  if (!msg) { w.hidden = true; warnKind = null; return; }
  $("#engineWarnText").textContent = msg; w.hidden = false;
}
$("#engineWarnClose").onclick = () => {
  window.close();
  setTimeout(() => { $("#engineWarnText").textContent += " (Use the X at the top right to close it.)"; $("#engineWarnClose").hidden = true; }, 400);
};
async function ping() {
  if (UPDATING) return; // the engine is restarting on purpose
  try {
    const j = await (await fetch("/api/ping")).json();
    pingMisses = 0;
    if (j.version !== APP_VERSION) engineWarn("old", OLD_ENGINE);
    else if (engineBoot && j.boot && j.boot !== engineBoot)
      engineWarn("replaced", "GnomeShell was started again, so this window is out of date. Close it and keep working in the newer window.");
    else if (warnKind === "gone") engineWarn("gone", null);
    if (!engineBoot) engineBoot = j.boot;
  } catch (e) {
    if (++pingMisses >= 2) engineWarn("gone", "GnomeShell's engine has stopped, so this window can't do anything. Close it and start GnomeShell again.");
  }
}
setInterval(ping, 5000);
ping();

// ------------------------------------------------------------ updates from GitHub
var UPDATING = false;
async function checkUpdate() {
  try {
    const u = await api("/api/update_check", {});
    if (!u.newer) return;
    const b = $("#updateBtn"); b.hidden = false; b.dataset.v = u.latest; b.textContent = `Update to ${u.latest}`;
    b.title = (u.notes ? u.notes.trim() + "\n\n" : "") + "Downloads the new version and restarts GnomeShell. Your scans and settings stay as they are.";
  } catch (e) { /* offline: no update shown */ }
}
$("#updateBtn").onclick = () => {
  const v = $("#updateBtn").dataset.v;
  withBusy(`Updating GnomeShell to ${v}`, async () => {
    UPDATING = true;
    try { await api("/api/update_install", {}); } catch (e) { UPDATING = false; throw e; }
    $("#busySub").textContent = "Restarting with the new version…";
    for (let i = 0; i < 150; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try { const j = await (await fetch("/api/ping")).json(); if (j.version === v) { location.reload(); return; } } catch (e) { /* still restarting */ }
    }
    UPDATING = false;
    throw new Error("The update is installed, but GnomeShell didn't restart by itself. Close this window and start it again from its shortcut.");
  });
};
addEventListener("pagehide", () => navigator.sendBeacon("/api/bye", ""));

// ------------------------------------------------------------ start
(async function start() {
  resize(); viewFrom("fit"); go("load");
  try {
    S.settings = await api("/api/settings");
    const info = await api("/api/info");
    $("#fileMeta").textContent = `Blender ${info.blender} ready · GnomeShell ${info.version || "(older engine)"}`;
    setTimeout(checkUpdate, 1500);
    if (info.version !== APP_VERSION) engineWarn("old", OLD_ENGINE);
    if (!engineBoot) engineBoot = info.boot;
  } catch (e) {
    $("#fileMeta").textContent = "Engine not running"; toast("Can't reach the engine. Start GnomeShell from its shortcut.");
  }
  fillSettings(); loadRecent();
})();

// ------------------------------------------------------------ silicone insert
// A hollow silicone insert hangs in the latex from the shell's open face, on a
// printed holder that twist-locks into the shell's corners. The numbers match
// the engine's insert.py, so what's shown here is what gets built.
const INS = { arm_w: 14, arm_t: 6, frame_w: 10, hub_lip: 5, foot_r: 10, post_r: 6, fit: 0.4, flare: 1.5, squeeze: 0.1, tab_len: 10, tab_w: 12, groove_w: 6, peg_inset: 12, slot_margin: 3, taper_deg: 1, least_floor: 3, lip: 4, play: 0.3, air_n: 3, air_d: 4 };
const insDefaults = () => ({ on: false, shape: "round", w: 90, d: 70, h: 120, wall: 3, round: 6, least: 20, cx: null, cy: null, keep: true });
S.insert = insDefaults();
const insD = (s) => (s.shape === "round" || s.shape === "square" ? s.w : s.d);

function insOutline(shape, w, d, r, seg = 72) {
  if (shape === "round" || shape === "oval") {
    if (shape === "round") d = w;
    return [...Array(seg)].map((_, i) => [w / 2 * Math.cos(2 * Math.PI * i / seg), d / 2 * Math.sin(2 * Math.PI * i / seg)]);
  }
  if (shape === "square") d = w;
  r = Math.max(0, Math.min(r, Math.min(w, d) / 2 - 0.01));
  if (r < 0.05) return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
  const k = Math.max(2, seg / 4 | 0), pts = [];
  for (const [cx, cy, a0] of [[w / 2 - r, -d / 2 + r, -90], [w / 2 - r, d / 2 - r, 0], [-w / 2 + r, d / 2 - r, 90], [-w / 2 + r, -d / 2 + r, 180]])
    for (let i = 0; i <= k; i++) { const a = (a0 + 90 * i / k) * Math.PI / 180; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return pts;
}
const insGrown = (s, by) => insOutline(s.shape, s.w + 2 * by, insD(s) + 2 * by, (s.shape === "square" || s.shape === "rect") ? Math.max(0, s.round + by) : 0);
const polyArea = (pts) => Math.abs(pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;

// The four pegs, where they lock (same as the engine's peg_places). Each turns
// about the box centre from its entry hole to here, on an arc centred on a spot
// in from the corner, moved in until the whole slot keeps 3 mm of shell
// between it and the box's sides.
function insPegs(x0, y0, x1, y1) {
  const bc = [(x0 + x1) / 2, (y0 + y1) / 2], holeR = INS.foot_r + INS.fit, room = holeR + INS.slot_margin;
  for (let e = INS.peg_inset; ; e += 0.5) {
    const spots = [[x0 + e, y0 + e], [x1 - e, y0 + e], [x1 - e, y1 - e], [x0 + e, y1 - e]];
    const R = Math.hypot(spots[0][0] - bc[0], spots[0][1] - bc[1]), theta = (2 * holeR + 3) / R;
    let ok = true;
    const pegs = spots.map(([px, py]) => {
      const a = Math.atan2(py - bc[1], px - bc[0]);
      for (let k = 0; k <= 8; k++) {
        const t = a - theta / 2 + theta * k / 8, x = bc[0] + R * Math.cos(t), y = bc[1] + R * Math.sin(t);
        ok = ok && x >= x0 + room && x <= x1 - room && y >= y0 + room && y <= y1 - room;
      }
      return [bc[0] + R * Math.cos(a + theta / 2), bc[1] + R * Math.sin(a + theta / 2)];
    });
    if (ok || e >= Math.min(x1 - x0, y1 - y0) / 2 - room) return { pegs, R, theta, spots };
  }
}
// The pegs for slots centred on the given spots (the engine's pegs_at). The
// holder turns about the box centre, so every peg turns the same angle, each on
// its own circle. null if a slot would come too close to the box's sides.
function insPegsAt(x0, y0, x1, y1, spots, minTheta = 0) {
  const bc = [(x0 + x1) / 2, (y0 + y1) / 2], holeR = INS.foot_r + INS.fit, room = holeR + INS.slot_margin;
  const Rs = spots.map(([x, y]) => Math.hypot(x - bc[0], y - bc[1]));
  if (Math.min(...Rs) < 2 * holeR) return null;
  const theta = Math.max(minTheta, ...Rs.map((R) => (2 * holeR + 3) / R));
  const pegs = [];
  for (let i = 0; i < 4; i++) {
    const [px, py] = spots[i], R = Rs[i], a = Math.atan2(py - bc[1], px - bc[0]);
    for (let k = 0; k <= 8; k++) {
      const t = a - theta / 2 + theta * k / 8, x = bc[0] + R * Math.cos(t), y = bc[1] + R * Math.sin(t);
      if (!(x >= x0 + room - 0.01 && x <= x1 - room + 0.01 && y >= y0 + room - 0.01 && y <= y1 - room + 0.01)) return null;
    }
    pegs.push([bc[0] + R * Math.cos(a + theta / 2), bc[1] + R * Math.sin(a + theta / 2)]);
  }
  return { pegs, R: Math.min(...Rs), Rs, theta, spots };
}
// How much shell is left between each slot (entry to locked end, top to bottom
// of the pocket) and the latex, in mm. Below 0 the slot breaks into the latex.
function insSlotRoom(T, bc, spot, R, theta) {
  const holeR = INS.foot_r + INS.fit, z0 = T.boxLo[2], a = Math.atan2(spot[1] - bc[1], spot[0] - bc[0]);
  let least = Infinity;
  for (let k = 0; k <= 8; k++) {
    const t = a - theta / 2 + theta * k / 8, x = bc[0] + R * Math.cos(t), y = bc[1] + R * Math.sin(t);
    for (const dz of [5, 9.5]) least = Math.min(least, -latexDistance(frameToWorld(T, x, y, z0 + dz)).d - holeR);
  }
  return least;
}
// Pegs that keep clear of the latex: any corner whose slot comes within 3 mm of
// it is moved in from the corner to where there's the most room. Worked out
// once per shell box and kept.
let pegCache = null;
function insPegsClear(T) {
  const [x0, y0] = T.boxLo, [x1, y1] = T.boxHi, key = [x0, y0, x1, y1, T.boxLo[2]].map((v) => v.toFixed(2)).join(",");
  if (pegCache && pegCache.key === key && pegCache.tri === latexTri) return pegCache.L;
  const def = insPegs(x0, y0, x1, y1), bc = [(x0 + x1) / 2, (y0 + y1) / 2];
  const rooms0 = def.spots.map((sp) => insSlotRoom(T, bc, sp, def.R, def.theta));
  let L = { ...def, Rs: [def.R, def.R, def.R, def.R], rooms: rooms0, moved: [], shifted: false };
  if (Math.min(...rooms0) < 3) {
    const corners = [[x0, y0, 1, 1], [x1, y0, -1, 1], [x1, y1, -1, -1], [x0, y1, 1, -1]];
    const pick = def.spots.map((sp, i) => {
      if (rooms0[i] >= 3) return sp;
      const [cx, cy, sx, sy] = corners[i];
      let best = null;
      for (let ex = INS.peg_inset; ex <= INS.peg_inset + 36; ex += 3) for (let ey = INS.peg_inset; ey <= INS.peg_inset + 36; ey += 3) {
        const c = [cx + sx * ex, cy + sy * ey], R = Math.hypot(c[0] - bc[0], c[1] - bc[1]);
        const one = def.spots.slice(); one[i] = c;
        const got = insPegsAt(x0, y0, x1, y1, one, def.theta);
        if (!got) continue;
        const room = insSlotRoom(T, bc, c, R, got.theta), shift = Math.hypot(c[0] - sp[0], c[1] - sp[1]);
        // enough room, moved as little as it can; failing that, the most room there is
        const score = room >= 3.5 ? 1000 - shift : room;
        if (!best || score > best.score) best = { c, score };
      }
      return best ? best.c : sp;
    });
    const got = insPegsAt(x0, y0, x1, y1, pick);
    if (got) {
      const rooms = got.spots.map((sp, i) => insSlotRoom(T, bc, sp, got.Rs[i], got.theta));
      if (Math.min(...rooms) > Math.min(...rooms0)) L = { ...got, rooms, moved: rooms0.map((r, i) => (r < 3 ? i + 1 : 0)).filter(Boolean), shifted: true };
    }
  }
  pegCache = { key, tri: latexTri, L };
  return L;
}
function insLayout(s, T) {
  const [x0, y0, z0] = T.boxLo, [x1, y1] = T.boxHi;
  const bc = [(x0 + x1) / 2, (y0 + y1) / 2];
  // the centre is kept in scan x, y so it stays put if the cuts turn the box
  const c = s.cx == null ? bc : [T.frame.ex.x * s.cx + T.frame.ex.y * s.cy, T.frame.ey.x * s.cx + T.frame.ey.y * s.cy];
  const P = latexTri ? insPegsClear(T) : { ...insPegs(x0, y0, x1, y1), rooms: null, moved: [], shifted: false };
  const { pegs, R, theta } = P, Rs = P.Rs || [R, R, R, R];
  const coreH = s.h - s.wall, innerMin = Math.min(s.w, insD(s)) - 2 * s.wall;
  const taper = Math.max(0.5, 1 - 2 * Math.tan(INS.taper_deg * Math.PI / 180) * coreH / innerMin);
  return { z0, bc, c, pegs, R, Rs, theta, coreH, taper, innerMin, rooms: P.rooms, moved: P.moved, spots: P.shifted ? P.spots : null };
}
function insSiliconeL(s, L) {
  const outer = polyArea(insGrown(s, 0)) * s.h, a1 = polyArea(insGrown(s, -s.wall)), a2 = a1 * L.taper * L.taper;
  return (outer - L.coreH / 3 * (a1 + a2 + Math.sqrt(a1 * a2))) / 1e6;
}
const frameToWorld = (T, x, y, z) => new V3().addScaledVector(T.frame.ex, x).addScaledVector(T.frame.ey, y).addScaledVector(T.frame.ez, z);

// nearest latex triangle, by its centre, on a grid of 6 mm cells
// The scan's flat base is the mold's opening, not latex the concrete meets, so
// it's left out (and anything below the shell's open face, which is cut off).
let insGrid = null;
function latexGrid() {
  const z0 = S.T ? S.T.boxLo[2] : -Infinity;
  if (insGrid && insGrid.tri === latexTri && insGrid.z0 === z0) return insGrid;
  const { n, cen, nor } = latexTri, cs = 6, map = new Map();
  const key = (i, j, k) => ((i + 1024) * 2048 + (j + 1024)) * 2048 + (k + 1024);
  for (let t = 0; t < n; t++) {
    const z = cen[t * 3 + 2];
    if (z < z0 + 0.5 || (nor[t * 3 + 2] < -0.7 && z < z0 + 5)) continue;
    const kk = key(Math.floor(cen[t * 3] / cs), Math.floor(cen[t * 3 + 1] / cs), Math.floor(cen[t * 3 + 2] / cs));
    let a = map.get(kk); if (!a) map.set(kk, (a = [])); a.push(t);
  }
  insGrid = { tri: latexTri, cs, map, key, z0 };
  return insGrid;
}
// signed distance from q to the latex: + inside the scan, - outside
function latexDistance(q) {
  const g = latexGrid(), { cen, nor } = latexTri, cs = g.cs;
  const ix = Math.floor(q.x / cs), iy = Math.floor(q.y / cs), iz = Math.floor(q.z / cs);
  let best = Infinity, bi = -1;
  for (let r = 0; r < 60; r++) {
    // only the cells on the shell of the cube r cells out
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r, edge = Math.abs(dx) === r || Math.abs(dy) === r; dz <= r; dz += edge || r === 0 ? 1 : 2 * r) {
      const a = g.map.get(g.key(ix + dx, iy + dy, iz + dz)); if (!a) continue;
      for (const t of a) {
        const ddx = q.x - cen[t * 3], ddy = q.y - cen[t * 3 + 1], ddz = q.z - cen[t * 3 + 2], d2 = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d2 < best) { best = d2; bi = t; }
      }
    }
    if (bi >= 0 && r * cs >= Math.sqrt(best)) break;
  }
  if (bi < 0) return { d: -Infinity, t: -1 };
  return { d: insideLatex(q) ? Math.sqrt(best) : -Math.sqrt(best), t: bi };
}
// inside the scan? Count the surface crossings straight up from q (odd = inside).
let upGrid = null;
function insideLatex(q) {
  const pos = latexMesh.geometry.attributes.position.array, cs = 4;
  if (!upGrid || upGrid.pos !== pos) {
    const map = new Map();
    for (let t = 0; t < pos.length / 9; t++) {
      const o = t * 9, xs = [pos[o], pos[o + 3], pos[o + 6]], ys = [pos[o + 1], pos[o + 4], pos[o + 7]];
      for (let i = Math.floor(Math.min(...xs) / cs); i <= Math.floor(Math.max(...xs) / cs); i++)
        for (let j = Math.floor(Math.min(...ys) / cs); j <= Math.floor(Math.max(...ys) / cs); j++) {
          const k = (i + 4096) * 8192 + (j + 4096); let a = map.get(k); if (!a) map.set(k, (a = [])); a.push(t);
        }
    }
    upGrid = { pos, map };
  }
  const x = q.x + 0.00137, y = q.y + 0.00291; // off any shared edge
  const a = upGrid.map.get((Math.floor(x / cs) + 4096) * 8192 + (Math.floor(y / cs) + 4096)) || [];
  let n = 0;
  for (const t of a) {
    const o = t * 9, x1 = pos[o], y1 = pos[o + 1], x2 = pos[o + 3], y2 = pos[o + 4], x3 = pos[o + 6], y3 = pos[o + 7];
    const det = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3); if (Math.abs(det) < 1e-12) continue;
    const l1 = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / det, l2 = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / det, l3 = 1 - l1 - l2;
    if (l1 < 0 || l2 < 0 || l3 < 0) continue;
    if (l1 * pos[o + 2] + l2 * pos[o + 5] + l3 * pos[o + 8] > q.z) n++;
  }
  return n % 2 === 1;
}
function insSamples(s, L, step = 5) {
  const ring = insGrown(s, 0), segs = ring.map((p, i) => [p, ring[(i + 1) % ring.length]]);
  const lens = segs.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1])), per = lens.reduce((a, b) => a + b, 0);
  const nR = Math.max(24, per / step | 0), even = [];
  for (let k = 0; k < nR; k++) {
    let t = per * k / nR;
    for (let i = 0; i < segs.length; i++) { if (t <= lens[i]) { const u = lens[i] ? t / lens[i] : 0, [a, b] = segs[i]; even.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]); break; } t -= lens[i]; }
  }
  const pts = [], nz = Math.max(2, s.h / step | 0);
  for (let i = 0; i <= nz; i++) for (const [x, y] of even) pts.push([L.c[0] + x, L.c[1] + y, L.z0 + s.h * i / nz]);
  for (const f of [0.75, 0.5, 0.25, 0]) for (const [x, y] of even.filter((_, i) => i % Math.max(1, Math.round(2 / Math.max(f, 0.25))) === 0)) pts.push([L.c[0] + x * f, L.c[1] + y * f, L.z0 + s.h]);
  return pts;
}
// thinnest concrete between insert and latex, with the holder turned by `angle` from locked
function insThinnest(s, T, angle = 0, stopBelow = -Infinity) {
  const L = insLayout(s, T), ca = Math.cos(angle), sa = Math.sin(angle);
  let best = { d: Infinity };
  for (const [x, y, z] of insSamples(s, L)) {
    const dx = x - L.bc[0], dy = y - L.bc[1];
    const q = frameToWorld(T, L.bc[0] + ca * dx - sa * dy, L.bc[1] + sa * dx + ca * dy, z);
    const r = latexDistance(q);
    if (r.d < best.d) { best = { d: r.d, q, t: r.t }; if (r.d < stopBelow) break; }
  }
  return best;
}
const insValid = (s) => Math.min(s.w, insD(s)) - 2 * s.wall >= 10 && s.h - s.wall >= 10;
// the spot in the opening farthest from its edge, so the insert has the most room there
function insCentreOnOpening(T) {
  const L = insLayout(S.insert, T);
  const seg = latexSection(T.frame.ez.clone(), L.z0 + 3), n = seg.length / 6;
  if (!n) { const w = frameToWorld(T, L.bc[0], L.bc[1], 0); S.insert.cx = +w.x.toFixed(2); S.insert.cy = +w.y.toFixed(2); return null; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < seg.length; i += 3) { x0 = Math.min(x0, seg[i]); x1 = Math.max(x1, seg[i]); y0 = Math.min(y0, seg[i + 1]); y1 = Math.max(y1, seg[i + 1]); }
  const room = (x, y) => {
    let inside = false, best = Infinity;
    for (let i = 0; i < seg.length; i += 6) {
      const ax = seg[i], ay = seg[i + 1], bx = seg[i + 3], by = seg[i + 4];
      if ((ay > y) !== (by > y) && x < ax + (y - ay) * (bx - ax) / (by - ay)) inside = !inside;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
    return inside ? best : -best;
  };
  let bx = (x0 + x1) / 2, by = (y0 + y1) / 2, br = room(bx, by);
  for (let step = Math.max(x1 - x0, y1 - y0) / 24; step > 0.25; step /= 3) {
    const cx = bx, cy = by;
    for (let i = -12; i <= 12; i++) for (let j = -12; j <= 12; j++) {
      const x = cx + i * step, y = cy + j * step; if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const r = room(x, y); if (r > br) { br = r; bx = x; by = y; }
    }
  }
  S.insert.cx = +bx.toFixed(2); S.insert.cy = +by.toFixed(2);
  return br; // half the opening's narrowest width, about
}
// As wide as the latex allows (same proportions), then as deep, with the least
// concrete all round and nothing rubbing while it turns to lock. The opening
// is usually what limits the width; the depth comes after.
function insFit(T) {
  // keep the shape's proportions if they fit; if not, try squarer ones
  const s0 = { ...S.insert }, r0 = s0.w / insD(s0);
  for (const r of [...new Set([r0, Math.min(r0, 1.5), 1].map((v) => +v.toFixed(3)))]) {
    if (s0.shape === "rect" || s0.shape === "oval") S.insert.d = Math.round(S.insert.w / r);
    const got = insFitAt(T);
    if (got) return got;
    Object.assign(S.insert, { w: s0.w, d: s0.d });
    if (s0.shape === "round" || s0.shape === "square") break;
  }
  return null;
}
function insFitAt(T) {
  const base = { ...S.insert }, L0 = insLayout(base, T), least = base.least;
  const good = (s) => insValid(s) && insThinnest(s, T, 0, least).d >= least && insThinnest(s, T, -L0.theta, 0).d >= 0;
  const hMin = base.wall + 10.5;
  const wide = (k) => ({ ...base, w: base.w * k, d: base.d * k, h: hMin });
  const kMin = (2 * base.wall + 10) / Math.min(base.w, insD(base)) * 1.001;
  if (!good(wide(kMin))) {
    const s = wide(kMin);
    S.insertFitFail = { w: Math.ceil(s.w), d: Math.ceil(insD(s)), thin: insThinnest(s, T).d };
    return null;
  }
  let lo = kMin, hi = Math.max(4, kMin * 2);
  for (let i = 0; i < 12; i++) { const m = (lo + hi) / 2; if (good(wide(m))) lo = m; else hi = m; }
  const w = Math.floor(base.w * lo * 0.995), d = Math.floor(base.d * lo * 0.995);
  let hLo = hMin, hHi = T.boxHi[2] - T.boxLo[2];
  for (let i = 0; i < 12; i++) { const m = (hLo + hHi) / 2; if (good({ ...base, w, d, h: m })) hLo = m; else hHi = m; }
  S.insert.w = w; S.insert.d = d; S.insert.h = Math.floor(hLo);
  return S.insert;
}

function insFill() {
  const s = S.insert;
  $("#insOn").checked = !!s.on; $("#insBody").hidden = !s.on; $("#insKeep").checked = s.keep !== false;
  $$("#insShape button").forEach((b) => b.classList.toggle("on", b.dataset.shape === s.shape));
  $$("[data-ins]").forEach((el) => { el.value = s[el.dataset.ins]; });
  $("#insWl").textContent = s.shape === "round" ? "Diameter (mm)" : "Width (mm)";
  $("#insDbox").hidden = s.shape === "round" || s.shape === "square";
  $("#insRoundBox").hidden = !(s.shape === "square" || s.shape === "rect");
  const name = { round: "round", oval: "oval", square: "square", rect: "rectangle" }[s.shape];
  $("#insSum").textContent = s.on ? `${name} ${s.shape === "round" ? "Ø" + s.w : s.w + " × " + insD(s)} × ${s.h} mm` : "off";
}
function drawInsert(T) {
  dispose(groups.insert); groups.insert.clear();
  groups.insert.visible = S.step === "cut" && !!S.insert.on;
  const kv = $("#insKv");
  if (!S.insert.on || !T) { kv.innerHTML = ""; return; }
  const s = S.insert, L = insLayout(s, T);
  if (!insValid(s)) { kv.innerHTML = `<dt>Insert</dt><dd class="bad">a ${s.wall} mm wall needs it at least ${Math.ceil(2 * s.wall + 10)} mm across and ${Math.ceil(s.wall + 10)} mm high</dd>`; return; }
  const W = (x, y, z) => frameToWorld(T, x, y, z);
  // the insert: blue, see-through
  const ring = insGrown(s, 0), pos = [];
  const top = ring.map(([x, y]) => W(L.c[0] + x, L.c[1] + y, L.z0)), far = ring.map(([x, y]) => W(L.c[0] + x, L.c[1] + y, L.z0 + s.h));
  const mid = W(L.c[0], L.c[1], L.z0 + s.h);
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    pos.push(...top[i].toArray(), ...top[j].toArray(), ...far[j].toArray(), ...top[i].toArray(), ...far[j].toArray(), ...far[i].toArray());
    pos.push(...far[i].toArray(), ...far[j].toArray(), ...mid.toArray());
  }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
  if (!insViewOn()) groups.insert.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: "#4f9be0", transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false })));
  // lines: insert outline, the core inside it, and the holder on the open face
  const lines = [], add = (a, b) => lines.push(...a.toArray(), ...b.toArray());
  const loop = (pts) => pts.forEach((p, i) => add(p, pts[(i + 1) % pts.length]));
  loop(top); loop(far);
  const core = insGrown(s, -s.wall);
  loop(core.map(([x, y]) => W(L.c[0] + x, L.c[1] + y, L.z0)));
  loop(core.map(([x, y]) => W(L.c[0] + x * L.taper, L.c[1] + y * L.taper, L.z0 + L.coreH)));
  const blue = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(lines.splice(0), 3)), new THREE.LineBasicMaterial({ color: "#7cb8f0" }));
  groups.insert.add(blue);
  const zf = L.z0 - INS.arm_t;
  loop(insGrown(s, INS.hub_lip).map(([x, y]) => W(L.c[0] + x, L.c[1] + y, zf)));
  L.pegs.forEach((p, i) => {
    add(W(L.c[0], L.c[1], zf), W(p[0], p[1], zf)); add(W(p[0], p[1], zf), W(L.pegs[(i + 1) % 4][0], L.pegs[(i + 1) % 4][1], zf));
    const circ = [...Array(24)].map((_, k) => W(p[0] + (INS.foot_r + 4) * Math.cos(k * Math.PI / 12), p[1] + (INS.foot_r + 4) * Math.sin(k * Math.PI / 12), zf));
    loop(circ);
    loop(insTab(L, p, INS.foot_r + 2, INS.foot_r + 4 + INS.tab_len, INS.tab_w / 2).map(([x, y]) => W(x, y, zf)));
    // the twist-lock slot in the shell's face: from where the peg goes in to where it locks
    const a = Math.atan2(p[1] - L.bc[1], p[0] - L.bc[0]), arc = [];
    for (let k = 0; k <= 12; k++) { const t = a - L.theta + L.theta * k / 12; arc.push(W(L.bc[0] + L.Rs[i] * Math.cos(t), L.bc[1] + L.Rs[i] * Math.sin(t), L.z0)); }
    arc.slice(1).forEach((q, k) => add(arc[k], q));
  });
  groups.insert.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(lines, 3)), new THREE.LineBasicMaterial({ color: "#b48cf0" })));
  // readouts, and the thinnest spot marked
  const thin = insThinnest(s, T), turn = insThinnest(s, T, -L.theta);
  if (thin.t >= 0) {
    const lp = new V3(latexTri.cen[thin.t * 3], latexTri.cen[thin.t * 3 + 1], latexTri.cen[thin.t * 3 + 2]);
    const bad = thin.d < s.least, col = bad ? "#ff6a4a" : "#7cf0b0";
    const dot = (p) => { const m = new THREE.Mesh(new THREE.SphereGeometry(Math.max(1.5, size() * 0.008), 12, 8), new THREE.MeshBasicMaterial({ color: col, depthTest: false })); m.position.copy(p); m.renderOrder = 5; return m; };
    const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints([thin.q, lp]), new THREE.LineBasicMaterial({ color: col, depthTest: false }));
    ln.renderOrder = 5;
    groups.insert.add(dot(thin.q), dot(lp), ln);
  }
  const lockRoom = L.rooms || [];
  const tight = lockRoom.map((r, i) => [r, i + 1]).filter(([r]) => r < 3);
  const lockNote = tight.length
    ? `<dt>Lock holes</dt><dd class="bad">corner ${tight.map(([, i]) => i).join(", ")} ${Math.min(...tight.map(([r]) => r)) < 0.5 ? (tight.length > 1 ? "break" : "breaks") + " into the latex" : (tight.length > 1 ? "have" : "has") + " only " + Math.min(...tight.map(([r]) => r)).toFixed(0) + " mm of shell to the latex"}${L.moved.length ? ", even moved in" : ""}. The shell's probably too small for the insert's pegs.</dd>`
    : L.moved.length ? `<dt>Lock holes</dt><dd>corner ${L.moved.join(", ")} moved in to clear the latex</dd>` : "";
  const mm = (v) => (Number.isFinite(v) ? `${v < 0 ? "pokes through by " + (-v).toFixed(0) : v.toFixed(0)} mm` : "–");
  const litres = insSiliconeL(s, L);
  const tooBig = thin.d < s.least, hits = turn.d < 0;
  const most = tooBig && s.keep && S.insertRelaxed && thin.d >= S.insertRelaxed.least - 0.5;
  kv.innerHTML = `
    <dt>Thinnest concrete</dt><dd class="${most ? "warn" : tooBig ? "bad" : "good"}">about ${mm(thin.d)}${most ? `, the most this opening allows (want ${s.least})` : tooBig ? ` (want ${s.least})` : ""}</dd>
    <dt>While turning to lock</dt><dd class="${hits ? "bad" : ""}">${hits ? "rubs the latex" : "about " + mm(turn.d)}</dd>
    <dt>Silicone to mix</dt><dd>about ${litres.toFixed(2)} L</dd>
    <dt>To lock</dt><dd>turn ${Math.round(L.theta * 180 / Math.PI)}° clockwise</dd>
    ${lockNote}`;
  S.insertCheck = { thin: thin.d, turn: turn.d, litres };
  if (insViewOn()) insSolids(s, L, T);
  // handles to pull: white on the side for width (and depth), at the far end
  // for height; gold at the opening to slide it
  const hs = Math.max(2.5, size() * 0.012), midZ = L.z0 + s.h / 2;
  const knob = (p, kind, col) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(hs * (insDrag?.kind === kind ? 1.25 : 1), 16, 12), new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.95 }));
    m.position.copy(p); m.renderOrder = 6; m.userData.insHandle = kind; groups.insert.add(m);
  };
  knob(W(L.c[0] + s.w / 2, L.c[1], midZ), "w", "#ffffff");
  if (s.shape === "oval" || s.shape === "rect") knob(W(L.c[0], L.c[1] + insD(s) / 2, midZ), "d", "#ffffff");
  knob(W(L.c[0], L.c[1], L.z0 + s.h), "h", "#ffffff");
  knob(W(L.c[0], L.c[1], L.z0), "move", "#f0c060");
}
// ------------------------------------------------------------ the insert view
// Just the insert and its holder, solid, with the latex and shell greyed out,
// for sizing them. The holder is drawn the way it's built: hub over the
// insert, tapered core, arms and frame, a pad and twist-lock peg per corner.
function insViewOn() { return !!(S.insView && S.step === "cut" && S.insert?.on && S.T); } // a declaration: paint() can run before this line
var insCam = null;
function setInsView(on) {
  if (on && !(S.insert?.on && S.T)) return;
  if (on && !S.insView) insCam = { p: camera.position.clone(), t: orbit.target.clone() };
  S.insView = on;
  if (on) showTab("insert");
  go(S.step);
  if (on) { // close on the insert and holder, not the whole shell
    const b = new THREE.Box3();
    groups.insert.traverse((o) => { if (o.isMesh && !o.userData.ghost && !o.userData.insHandle) b.expandByObject(o); });
    if (!b.isEmpty()) {
      const c = b.getCenter(new V3()), r = Math.max(30, b.getSize(new V3()).length());
      camera.position.copy(c).add(new V3(0.8, -1, 0.55).normalize().multiplyScalar(r * 1.5)); orbit.target.copy(c); orbit.update();
    }
  }
  else if (insCam) { camera.position.copy(insCam.p); orbit.target.copy(insCam.t); orbit.update(); insCam = null; }
}
function applyInsView() {
  drawSizer();
  const on = insViewOn();
  $("#insView").classList.toggle("on", on);
  $("#insView").textContent = on ? "Back to the cuts" : "Insert view";
  $("#insViewBar").hidden = !on;
  $("#railIns").classList.toggle("on", on);
  $("#railIns").setAttribute("aria-pressed", String(on));
  $("#railIns").title = S.insert?.on ? "Just the insert and its holder, with the latex and shell greyed out (I)" : "Turn the silicone insert on first, on the Insert tab";
  paintTabs();
  if (S.step === "cut") { $("#legend").hidden = on; $("#hud").hidden = on; $("#labels").hidden = on; $("#toggles").hidden = on; }
  if (!on) return;
  groups.planes.visible = groups.regions.visible = groups.arrows.visible = groups.slicePlan.visible = groups.pour.visible = false;
  detachHandle();
  const m = latexMesh.material; m.transparent = true; m.opacity = 0.2; m.depthWrite = false; m.needsUpdate = true;
}
function insTab(L, p, r0, r1, hw) { // a rectangle off a corner pad, pointing away from the shell's middle
  const dx = p[0] - L.bc[0], dy = p[1] - L.bc[1], n = Math.hypot(dx, dy) || 1, nx = dx / n, ny = dy / n, px = -ny, py = nx;
  return [[p[0] + nx * r0 - px * hw, p[1] + ny * r0 - py * hw], [p[0] + nx * r1 - px * hw, p[1] + ny * r1 - py * hw],
    [p[0] + nx * r1 + px * hw, p[1] + ny * r1 + py * hw], [p[0] + nx * r0 + px * hw, p[1] + ny * r0 + py * hw]];
}
function insSolids(s, L, T) {
  const g = new THREE.Group();
  const e = T.frame;
  g.matrixAutoUpdate = false;
  g.matrix.makeBasis(e.ex, e.ey, e.ez);
  const mat = (c, o = 1) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, transparent: o < 1, opacity: o, depthWrite: o >= 1, side: THREE.DoubleSide });
  const purple = mat("#9b7be0"), peg = mat("#b9a2f0");
  const prism = (ring, z0, z1, top = 1, material = purple, at = L.c) => {
    const sh = new THREE.Shape(ring.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ExtrudeGeometry(sh, { depth: z1 - z0, bevelEnabled: false, curveSegments: 1 });
    if (top !== 1) { const p = geo.attributes.position; for (let i = 0; i < p.count; i++) if (p.getZ(i) > (z1 - z0) - 1e-6) { p.setX(i, p.getX(i) * top); p.setY(i, p.getY(i) * top); } geo.computeVertexNormals(); }
    const m = new THREE.Mesh(geo, material); m.position.set(at[0], at[1], z0); return m;
  };
  const prismAt = (pts, z0, z1) => prism(pts, z0, z1, 1, purple, [0, 0]);
  const rod = (r0, r1, z0, z1, at, material = peg) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, z1 - z0, 32), material);
    m.rotation.x = Math.PI / 2; m.position.set(at[0], at[1], (z0 + z1) / 2); return m;
  };
  const bar = (a, b, w, z0, z1) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const m = new THREE.Mesh(new THREE.BoxGeometry(len, w, z1 - z0), purple);
    m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (z0 + z1) / 2); m.rotation.z = Math.atan2(b[1] - a[1], b[0] - a[0]); return m;
  };
  const z0 = L.z0, t = INS.arm_t;
  // the silicone: solid-looking blue round the core
  g.add(prism(insGrown(s, 0), z0, z0 + s.h, 1, mat("#4f9be0", 0.55)));
  // holder: hub, core, arms, frame, pads, pegs
  g.add(prism(insGrown(s, INS.hub_lip), z0 - t, z0));
  g.add(prism(insGrown(s, -s.wall), z0 - 0.5, z0 + L.coreH, L.taper));
  const footLo = z0 + INS.lip - INS.fit - INS.squeeze, footHi = footLo + (INS.foot_r - INS.post_r) + 2;
  L.pegs.forEach((p, i) => {
    g.add(bar(L.c, p, INS.arm_w, z0 - t, z0), bar(p, L.pegs[(i + 1) % 4], INS.frame_w, z0 - t, z0));
    g.add(rod(INS.foot_r + 4, INS.foot_r + 4, z0 - t, z0, p, purple));
    // the bungee tab: two blocks either side of the groove, and the thin floor under it
    const padR = INS.foot_r + 4, mid = padR + INS.tab_len / 2 + 1, gw = INS.groove_w / 2;
    g.add(prismAt(insTab(L, p, padR - 2, mid - gw, INS.tab_w / 2), z0 - t, z0), prismAt(insTab(L, p, mid + gw, padR + INS.tab_len, INS.tab_w / 2), z0 - t, z0),
      prismAt(insTab(L, p, mid - gw, mid + gw, INS.tab_w / 2), z0 - t + 3, z0));
    g.add(rod(INS.post_r + INS.flare, INS.post_r, z0, z0 + INS.flare, p));
    g.add(rod(INS.post_r, INS.post_r, z0 - 0.5, footLo, p), rod(INS.post_r, INS.foot_r, footLo, footLo + INS.foot_r - INS.post_r, p), rod(INS.foot_r, INS.foot_r, footLo + INS.foot_r - INS.post_r, footHi, p));
  });
  // air holes, as dark dots on the hub
  const inner = Math.min(s.w, insD(s)) - 2 * s.wall, n = inner * L.taper >= 4 * INS.air_d + 8 ? INS.air_n : 1;
  const rho = n === 1 ? 0 : Math.min(inner * L.taper / 2 - INS.air_d - 3, inner * 0.25);
  for (let k = 0; k < n; k++) {
    const a = Math.PI / 2 + 2 * Math.PI * k / n;
    g.add(rod(INS.air_d / 2, INS.air_d / 2, z0 - t - 0.3, z0 + 0.3, [L.c[0] + rho * Math.cos(a), L.c[1] + rho * Math.sin(a)], mat("#1d1f22")));
  }
  // the shell, greyed: its outline and the face the holder sits on
  const [bx0, by0, bz0] = T.boxLo, [bx1, by1, bz1] = T.boxHi;
  const box = new THREE.BoxGeometry(bx1 - bx0, by1 - by0, bz1 - bz0);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: "#8a9096", transparent: true, opacity: 0.6 }));
  edges.position.set((bx0 + bx1) / 2, (by0 + by1) / 2, (bz0 + bz1) / 2);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(bx1 - bx0, by1 - by0), mat("#8a9096", 0.12));
  face.position.set((bx0 + bx1) / 2, (by0 + by1) / 2, bz0);
  edges.userData.ghost = face.userData.ghost = true;
  g.add(edges, face);
  g.updateMatrixWorld(true);
  groups.insert.add(g);
}
$("#insView").onclick = () => setInsView(!insViewOn());
$("#railIns").onclick = () => {
  if (S.insert?.on) { setInsView(!insViewOn()); return; }
  showTab("insert"); toast("Tick \"Use a silicone insert for this scan\" first, then Insert view shows it on its own.");
};
$("#insViewBack").onclick = () => setInsView(false);
// ------------------------------------------------------------ pulling the insert's handles
var insDrag = null; // var: drawInsert can run before this line does
function insHandleAt(e) {
  if (!groups.insert.visible || S.step !== "cut") return null;
  setRay(e);
  const hit = ray.intersectObjects(groups.insert.children.filter((o) => o.userData.insHandle), false)[0];
  return hit ? hit.object.userData.insHandle : null;
}
// where along a line (through o, along u) the mouse ray passes closest
function lineParam(o, u) {
  const r = ray.ray, w0 = o.clone().sub(r.origin), b = u.dot(r.direction), d = u.dot(w0), e = r.direction.dot(w0), den = 1 - b * b;
  return Math.abs(den) < 1e-6 ? null : (b * e - d) / den;
}
function insDragStart(e, kind) {
  showTab("insert");
  const T = S.T, s = S.insert, L = insLayout(s, T);
  mark(null);
  const o = frameToWorld(T, L.c[0], L.c[1], kind === "h" ? L.z0 : L.z0 + s.h / 2);
  insDrag = { kind, o, ex: T.frame.ex.clone(), ey: T.frame.ey.clone(), ez: T.frame.ez.clone(), wasKeep: s.keep };
  if (kind === "move") {
    const p = new V3(), pl = new THREE.Plane().setFromNormalAndCoplanarPoint(T.frame.ez, frameToWorld(T, L.c[0], L.c[1], L.z0));
    setRay(e);
    insDrag.plane = pl;
    insDrag.grab = ray.ray.intersectPlane(pl, p) ? [p.dot(T.frame.ex) - L.c[0], p.dot(T.frame.ey) - L.c[1]] : [0, 0];
  }
  orbit.enabled = false; canvas.setPointerCapture(e.pointerId);
  canvas.style.cursor = "grabbing";
}
let insDragFrame = null;
function insDragMove(e) {
  const s = S.insert, D = insDrag, T = S.T;
  setRay(e);
  if (D.kind === "move") {
    const p = new V3(); if (!ray.ray.intersectPlane(D.plane, p)) return;
    const w = frameToWorld(T, p.dot(D.ex) - D.grab[0], p.dot(D.ey) - D.grab[1], 0);
    s.cx = +w.x.toFixed(1); s.cy = +w.y.toFixed(1);
  } else {
    const t = lineParam(D.o, D.kind === "w" ? D.ex : D.kind === "d" ? D.ey : D.ez); if (t == null) return;
    const minAcross = Math.ceil(2 * s.wall + 10);
    if (D.kind === "w") s.w = clamp(Math.round(2 * Math.abs(t)), minAcross, 500); // either side of the middle
    if (D.kind === "d") s.d = clamp(Math.round(2 * Math.abs(t)), minAcross, 500);
    if (D.kind === "h") s.h = clamp(Math.round(t), Math.ceil(s.wall + 10.5), Math.floor(T.boxHi[2] - T.boxLo[2]));
    s.keep = false;
  }
  if (!insDragFrame) insDragFrame = requestAnimationFrame(() => { insDragFrame = null; insFill(); drawInsert(S.T); });
}
function insDragEnd(e) {
  const D = insDrag; insDrag = null;
  orbit.enabled = true; canvas.releasePointerCapture?.(e.pointerId); canvas.style.cursor = "";
  if (D.kind === "move" && S.insert.keep) insKeepFitted();
  insChanged();
  if (D.wasKeep && !S.insert.keep) toast("Sizing it yourself now. Tick \"Keep it sized to the latex\" or press Fit to go back.", true);
}
function insChanged() { insFill(); if (S.T) drawInsert(S.T); autosaveSoon(); }
$("#insOn").onchange = () => {
  mark(null);
  S.insert.on = $("#insOn").checked;
  if (!S.insert.on && S.insView) setInsView(false);
  if (S.insert.on && S.T && S.insert.cx == null) {
    insCentreOnOpening(S.T);
    S.insert.keep = true;
    insKeepFitted();
  }
  insChanged();
};
$("#insKeep").onchange = () => {
  mark(null);
  S.insert.keep = $("#insKeep").checked;
  insKeepFitted();
  insChanged();
};
$$("#insShape button").forEach((b) => b.onclick = () => { mark(null); S.insert.shape = b.dataset.shape; insKeepFitted(); insChanged(); });
$$("[data-ins]").forEach((el) => el.addEventListener("change", () => {
  const bad = badNumber(el);
  if (bad) { toast(`${bad} Kept ${S.insert[el.dataset.ins]}.`); el.value = S.insert[el.dataset.ins]; el.classList.add("bad"); setTimeout(() => el.classList.remove("bad"), 2500); return; }
  mark(null);
  const k = el.dataset.ins;
  S.insert[k] = +el.value;
  if (k === "w" || k === "d" || k === "h") {
    if (S.insert.keep) toast("Sizing it yourself now. Tick \"Keep it sized to the latex\" or press Fit to go back.", true);
    S.insert.keep = false;
  } else insKeepFitted();
  if (!insValid(S.insert)) toast(`A ${S.insert.wall} mm silicone wall needs the insert at least ${Math.ceil(2 * S.insert.wall + 10)} mm across. Make it bigger, make the wall thinner, or press Fit.`);
  insChanged();
}));
$("#insFit").onclick = () => {
  if (!S.T) return;
  mark(null);
  const before = `${S.insert.w}×${insD(S.insert)}×${S.insert.h}`;
  const r = insAutoFit(S.T);
  if (!r) { toast(insFitFailText()); return; }
  S.insert.keep = true;
  insChanged();
  toast(`Sized to the latex: ${S.insert.shape === "round" ? "Ø" + S.insert.w : S.insert.w + " × " + insD(S.insert)} × ${S.insert.h} mm (was ${before}).${r.least ? " " + insAutoFitText(r) : ""}`, true);
};
// Fit, and if the opening is too narrow for your least concrete with your
// wall, fit with the most concrete it does allow (your wall kept). Returns
// what it had to give up, or null if nothing fits at all.
function insAutoFit(T) {
  S.insertRelaxed = null;
  if (insFit(T)) return {};
  const most = Math.floor(S.insertFitFail?.thin ?? -1);
  if (most < INS.least_floor) return null;
  const want = S.insert.least;
  S.insert.least = most;
  const ok = insFit(T);
  S.insert.least = want;
  if (!ok) return null;
  S.insertRelaxed = { least: most, want };
  return S.insertRelaxed;
}
function insAutoFitText(r) {
  if (!r) return insFitFailText();
  if (!r.least) return "";
  return `The opening is too narrow for ${r.want} mm of concrete with ${S.insert.wall} mm walls. Fitted with the most it allows: about ${r.least} mm.`;
}
// refit if "Keep it sized to the latex" is ticked; says so only when it had to give something up
function insKeepFitted(quiet) {
  if (!S.insert.on || !S.insert.keep || !S.T) return;
  const r = insAutoFit(S.T), msg = insAutoFitText(r);
  if (msg && !quiet) toast(msg);
}
function insFitFailText() {
  const f = S.insertFitFail || {}, s = S.insert;
  const thin = Number.isFinite(f.thin) ? (f.thin < 0 ? "pokes through the latex" : `leaves only ${Math.max(0, Math.floor(f.thin))} mm of concrete`) : "doesn't fit";
  return `Even the smallest insert this shape can be with ${s.wall} mm walls (${f.w} mm across) ${thin}, and you want ${s.least} mm. ` +
    "The opening is usually the narrow part. Try a smaller least concrete or a thinner wall.";
}
$("#insCentre").onclick = () => { if (S.T) { mark(null); insCentreOnOpening(S.T); insKeepFitted(); insChanged(); } };
const insSpec = () => {
  if (!S.insert.on || !S.T) return null;
  const L = insLayout(S.insert, S.T);
  return { shape: S.insert.shape, w: S.insert.w, d: insD(S.insert), h: S.insert.h, wall: S.insert.wall, round: S.insert.round, least: S.insert.least, cx: L.c[0], cy: L.c[1], spots: L.spots };
};
$("#insOnly").onclick = () => {
  if (!S.T || !S.insert.on) return;
  if (!insValid(S.insert)) { toast("The insert's wall leaves no room for the core."); return; }
  const T = S.T;
  withBusy("Making the holder and cup", async () => {
    const r = await api("/api/insert", { insert: insSpec(), cuts: [], frame: [T.frame.ex.toArray(), T.frame.ey.toArray()], settings: S.settings });
    const i = r.insert;
    toast(`Saved holder.3mf (${i.holder_mm.slice(0, 2).join(" × ")} mm) and insert_cup.3mf in the scan's folder. Mix about ${i.silicone_l} L of silicone.${i.fits_plate ? "" : " The holder is bigger than your plate."}`, true);
  }, true);
};

// for testing
window.__ms = { showTab, curTab, sizerAt, drawSizer, sizerOn, baseH, setBaseH, latexDistance, INS, S, insCentre: (T) => insCentreOnOpening(T), insFit, insAutoFit, insHandleAt, setInsView, insViewOn, insThinnest, insLayout, drawInsert, insSpec, loadRecent, frameGroup, slicePlans, startBuild, pickAt, pieceSpec, refresh, compute, splitPieces, splitNormal, pickAllPieces, mirrorCuts, mirrorPlane, applyLayout, layoutNow, labels: () => labels, renderCuts, camera, groups, removeCut, deleteSegs, deleteCuts, mergePieces, optimize, undo, redo, setMode, selectSeg, selectPiece, selectCut, H, meshes, handle, gizmoT, gizmoR, onHandleMove };

// ------------------------------------------------------------ tooltips and panels
// Hover anything with a title (or a ? icon) for a tooltip; long help lives there, not in the panel.
(() => {
  const tip = document.createElement("div"); tip.className = "tip"; tip.setAttribute("role", "tooltip"); document.body.appendChild(tip);
  let timer = 0, cur = null;
  const hide = () => { clearTimeout(timer); timer = 0; cur = null; tip.classList.remove("show"); };
  const place = (el) => {
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    const x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
    let y = r.bottom + 8; if (y + h > innerHeight - 8) y = r.top - h - 8;
    tip.style.left = x + "px"; tip.style.top = Math.max(8, y) + "px";
  };
  const show = (el) => { const t = el.dataset.tip; if (!t || !el.isConnected) return; tip.textContent = t; tip.classList.add("show"); place(el); };
  const target = (e) => {
    const el = e.target.closest?.("[title], [data-tip]");
    if (el && el.hasAttribute("title")) { el.dataset.tip = el.getAttribute("title"); el.removeAttribute("title"); }
    return el && el.dataset.tip ? el : null;
  };
  document.addEventListener("pointerover", (e) => {
    const el = target(e); if (el === cur) return; hide(); if (!el) return;
    cur = el; timer = setTimeout(() => show(el), el.classList.contains("help") ? 120 : 600);
  });
  document.addEventListener("pointerdown", (e) => { if (!e.target.closest?.(".help")) hide(); }, true);
  document.addEventListener("keydown", hide, true);
  document.addEventListener("wheel", hide, { passive: true, capture: true });
  document.addEventListener("focusin", (e) => { if (e.target.classList?.contains("help")) { hide(); cur = e.target; show(cur); } });
  document.addEventListener("focusout", (e) => { if (e.target === cur) hide(); });
  // a ? in a panel header shows its help instead of opening or closing the panel
  document.addEventListener("click", (e) => { const h = e.target.closest?.(".help"); if (h) { e.preventDefault(); e.stopPropagation(); hide(); cur = h; show(h); } }, true);
})();
// panels stay open or closed the way you left them
(() => {
  let st = {}; try { st = JSON.parse(localStorage.getItem("gs.panels") || "{}") || {}; } catch (e) { st = {}; }
  $$("details.group").forEach((d) => {
    const key = d.dataset.pnl || d.querySelector("summary span")?.textContent.trim(); if (!key) return;
    if (key in st) d.open = !!st[key];
    d.addEventListener("toggle", () => { st[key] = d.open; try { localStorage.setItem("gs.panels", JSON.stringify(st)); } catch (e) { /* not kept */ } });
  });
})();
