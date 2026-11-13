import * as THREE from "three";
import { STLLoader } from "./vendor/STLLoader.js";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { sliceShell, suggestMore, placeAt as slicePlace } from "./slicer.js";
import { TransformControls } from "./vendor/TransformControls.js";
import { cutNormal, canonical, angles, evaluate, group, removalOrder, binFaces, bestPull, rad, deg, outline, polyNormal, pieceSpec, tokens, clipPolytope, polyVerts } from "./tree.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const APP_VERSION = "0.16.0"; // must match the engine's; an older engine left running is the usual reason it doesn't
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
const PIECE_COLORS = ["#5fa497", "#5a8cc4", "#957dcb", "#c9b45a", "#84ab58", "#4fb3c9", "#8592a1", "#6e78d6", "#a3a04e", "#b072b5"];
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

const groups = { latex: new THREE.Group(), planes: new THREE.Group(), regions: new THREE.Group(), arrows: new THREE.Group(), pour: new THREE.Group(), pieces: new THREE.Group(), slices: new THREE.Group(), plates: new THREE.Group(), slicePlan: new THREE.Group(), insert: new THREE.Group(), sizer: new THREE.Group(), base: new THREE.Group(), printer: new THREE.Group(), spout: new THREE.Group(), seam: new THREE.Group(), web: new THREE.Group() };
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
  if (e.button === 0 && (insHandleAt(e) || sizerAt(e) || sliceHandleAt(e))) { gizmos.forEach((g) => (g.enabled = false)); return; } // the insert's and the sizer's handles win
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
(function loop() { orbit.update(); applyHidden(); renderer.render(scene, camera); placeLabels(); drawAxes(); requestAnimationFrame(loop); })();

const center = () => new V3(...(S.scan?.center || [0, 0, 0]));
const size = () => Math.max(...(S.scan?.dims || [200, 200, 200]));
function viewFrom(dir) {
  const c = center(); const d = size() * 2.6;
  const v = { front: [0, -1, 0.12], side: [1, 0, 0.12], top: [0, -0.02, 1], bottom: [0, -0.02, -1], fit: [0.8, -1, 0.55] }[dir];
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
let sliceApplying = false; // putting a sliced layout in place keeps its alternatives showing
const snapshot = () => JSON.stringify({ cuts: S.cuts, nextId: S.nextId, joins: S.joins, pulls: S.pulls, active: S.active, insert: S.insert, slice_at: S.sliceAt ?? null });
// call before changing the layout; a run of changes with the same key (one
// slider drag) is one step back
// the overhang right now, so the readout in the view can show what a change did
const curPct = () => (S.T && latexTri && S.cuts.length ? 100 * S.T.bad / latexTri.total : null);
function mark(key) {
  if (!sliceApplying) $("#sliceAlts").hidden = true;
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
  S.sliceAt = o.slice_at ?? null;
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
function resetHistory() { H.undo = []; H.redo = []; H.key = null; H.basePct = null; undoButtons(); $("#sliceAlts").hidden = true; }
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
  scanTabQuiet();
}
// the Scan tab is about the model itself: the shell's cuts, pieces, arrows and slice line wait on the Cuts tab
function scanTabQuiet() {
  const quiet = curTab() === "scan" && S.step === "cut";
  labelBox.hidden = quiet;
  if (!quiet) return;
  groups.planes.visible = groups.regions.visible = groups.arrows.visible = groups.slicePlan.visible = false;
  detachHandle();
}
let rafT = null;
function refreshSoon(o) { if (rafT) return; rafT = requestAnimationFrame(() => { rafT = null; refresh(o); }); }

function paint(T) {
  const colors = latexMesh.geometry.attributes.color.array;
  const parts = S.step === "cut" && curTab() === "scan" && !insViewOn() ? splitPartOf() : null;
  if (parts) {
    const pc = PIECE_COLORS.map((h) => new THREE.Color(h).lerp(COL.latex, 0.2));
    for (let i = 0; i < latexTri.n; i++) {
      const col = pc[parts[i] % pc.length];
      colors[i * 9] = colors[i * 9 + 3] = colors[i * 9 + 6] = col.r;
      colors[i * 9 + 1] = colors[i * 9 + 4] = colors[i * 9 + 7] = col.g;
      colors[i * 9 + 2] = colors[i * 9 + 5] = colors[i * 9 + 8] = col.b;
    }
    latexMesh.geometry.attributes.color.needsUpdate = true;
    return;
  }
  const show = $("#tOver").checked && S.cuts.length && !insViewOn();
  const base = insViewOn() ? COL.ghost : COL.latex;
  // each piece in its own colour on the model; with some picked, the rest fade
  const byPiece = S.step === "cut" && curTab() !== "scan" && $("#tPieces").checked && S.cuts.length && !insViewOn() && T.pieces.length > 1;
  const anySel = S.selPieces.size > 0;
  const pc = byPiece ? T.pieces.map((P, k) => {
    const c = new THREE.Color(pieceColor(k)).lerp(COL.latex, 0.2);
    return anySel && !S.selPieces.has(P.id) ? c.lerp(COL.ghost, 0.65) : c;
  }) : null;
  const badDim = COL.bad.clone().lerp(COL.ghost, 0.65);
  for (let i = 0; i < latexTri.n; i++) {
    const k = T.pieceOf ? T.pieceOf[i] : -1;
    const faded = pc && anySel && k >= 0 && !S.selPieces.has(T.pieces[k].id);
    const col = show && T.badTri[i] ? (faded ? badDim : COL.bad) : pc && k >= 0 ? pc[k] : base;
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
  $("#hudArc").setAttribute("stroke-dasharray", `${pct === null ? 0 : Math.min(100, pct * 20).toFixed(1)} 100`); // the arc is full at 5%
  $("#hudArc").style.opacity = pct ? 1 : 0;
  { const n = T.pieces.length, catching = S.cuts.length ? [...badBy].filter((b, i) => b > 0.001 * (T.areaBy[i] || 1)).length : 0;
    $("#legBad").textContent = S.cuts.length ? `${catching} ${catching === 1 ? "piece" : "pieces"}` : "";
    $("#legOk").textContent = S.cuts.length ? `${n - catching} of ${n}` : ""; }
  const base = H.basePct, dEl = $("#hudDelta");
  if (pct !== null && base != null && Math.abs(pct - base) >= 0.05) {
    const down = pct < base;
    dEl.textContent = `${down ? "▼" : "▲"} ${Math.abs(pct - base).toFixed(1)} from ${base.toFixed(1)}%`;
    dEl.className = "hud-d mono " + (down ? "better" : "worse");
  } else { dEl.textContent = ""; dEl.className = "hud-d mono"; }
  $("#gl").setAttribute("aria-label", `3D view of ${S.scan?.name || "the scan"}${S.cuts.length ? `, ${T.pieces.length} pieces, ${pct.toFixed(1)}% overhang` : ""}`);
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
    w.textContent = `Pieces ${T.locked.map((i) => i + 1).join(", ")} hold each other in: each would push into another as it comes off. Drag one of their arrows so it pulls away from its neighbors.`;
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
// One test slice plane for the whole mold. Upright, it runs across the main
// seam through the tallest point of the latex; level, it sits Level slice
// height up the shell. Either way it can be dragged along its normal
// (S.sliceAt, mm along it; null = where it starts). Every piece it crosses
// gets its slice there, so together they go all the way round the model.
// Returns one entry per piece, null for a piece the plane misses.
function slicePlans(T) {
  if (!T || !S.cuts.length || !T.pieces.length || !latexMesh) return [];
  const t = +S.settings.test_slice_mm || 0.4;
  const level = S.settings.test_slice_style === "HORIZONTAL";
  const n = level ? new V3(0, 0, 1) : T.frame.ex.clone();
  const pos = latexPos(); let zi = 2;
  for (let i = 5; i < pos.length; i += 3) if (pos[i] > pos[zi]) zi = i;
  const top = new V3(pos[zi - 2], pos[zi - 1], pos[zi]);
  // channel heights, placed as the engine places them
  const nh = Math.max(0, Math.round(+S.settings.holes_per_corner || 0)), r = (+S.settings.hole_d_mm || 0) / 2;
  const z0 = T.boxLo[2], z1 = T.boxHi[2], g = (+S.settings.pair_gap_mm || 10) / 2;
  let chz = contourStyle() ? [] : [...Array(nh)].map((_, i) => z0 + (z1 - z0) * (i + 0.5) / nh);
  if (S.settings.channel_pairs) chz = chz.flatMap((z) => [z - g, z + g]);
  const span = T.pieces.map((P) => {
    const vs = P.cells.flatMap((ci) => polyVerts(T.cells[ci].poly));
    let mn = Infinity, mx = -Infinity; const c = new V3();
    for (const v of vs) { const d = n.dot(v); mn = Math.min(mn, d); mx = Math.max(mx, d); c.add(v); }
    return { mn, mx, c: c.multiplyScalar(1 / Math.max(1, vs.length)) };
  });
  const mnAll = Math.min(...span.map((p) => p.mn)), mxAll = Math.max(...span.map((p) => p.mx));
  let d0;
  if (level) {
    let z = mnAll + (mxAll - mnAll) * (+S.settings.test_slice_at || 0.5) - t / 2;
    for (let k = 0; k < 20; k++) { if (chz.every((cz) => Math.abs(z + t / 2 - cz) > r + 2)) break; z += 2 * r + 2; }
    d0 = z + t / 2;
  } else d0 = n.dot(top);
  const d = S.sliceAt == null ? d0 : clamp(d0 + S.sliceAt, mnAll + t, mxAll - t);
  const at = top.clone().addScaledVector(n, d - n.dot(top)); // the pink dot: over the tallest point, on the slice
  // every piece the plane goes through (a sliver under 1 mm across doesn't count)
  const crosses = (P) => P.cells.some((ci) => {
    const cap = clipPolytope(T.cells[ci].poly, n, d, null).cap;
    if (!cap) return false;
    let w = 0; for (const a of cap) for (const b of cap) w = Math.max(w, a.distanceTo(b));
    return w > 1;
  });
  const moved = S.sliceAt != null && Math.abs(d - d0) > 0.5;
  const why = level ? `${Math.round(d - z0)} mm up` : moved ? `${Math.round(Math.abs(d - d0))} mm from the top of the latex` : "top of the latex";
  const plans = T.pieces.map((P, i) => (crosses(P) ? { normal: n, d, d0, point: at, alt: span[i].c.clone().addScaledVector(n, d - n.dot(span[i].c)), why, at, piece: i } : null));
  if (!plans.some(Boolean)) { // shouldn't happen: then the piece nearest the dot
    let k = 0, best = Infinity;
    span.forEach((p, i) => { const dd = p.c.distanceTo(at); if (dd < best) { best = dd; k = i; } });
    plans[k] = { normal: n, d, d0, point: at, alt: span[k].c.clone().addScaledVector(n, d - n.dot(span[k].c)), why, at, piece: k };
  }
  return plans;
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
  $("#legSliceN").textContent = plans.length ? String(plans.filter(Boolean).length) : "";
  sliceNote(plans);
  if (!plans.length) return;
  const w = Math.max(1.2, size() * 0.01);
  // pieces sliced in the same plane share one sheet and one line
  const byPlane = new Map();
  plans.forEach((pl, i) => {
    if (!pl) return;
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
    groups.slicePlan.add(line); // only the line on the model: a sheet out past it is one plane too many
    sheet.geometry.dispose(); edge.geometry.dispose();
  }
  // the dot to drag it by, and a short arrow each way along its normal
  const pl = plans.find(Boolean);
  if (pl) {
    const hs = Math.max(2.5, size() * 0.013);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(hs * (sliceDrag ? 1.25 : 1), 16, 12), new THREE.MeshBasicMaterial({ color: COL.plan, depthTest: false, transparent: true, opacity: 0.95 }));
    dot.position.copy(pl.at); dot.renderOrder = 6; dot.userData = { sliceHandle: true, part: "handle" };
    const a = pl.at.clone().addScaledVector(pl.normal, -hs * 4), b = pl.at.clone().addScaledVector(pl.normal, hs * 4);
    const ax = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: COL.plan, depthTest: false, transparent: true }));
    ax.renderOrder = 6; ax.userData = { part: "handle" };
    groups.slicePlan.add(dot, ax);
  }
  highlight();
}
function sliceNote(plans) {
  const el = $("#sliceNote");
  $("#sliceReset").hidden = S.sliceAt == null;
  if (!plans.length) { el.textContent = "Add a cut to see where the test slice goes."; return; }
  const t = +S.settings.test_slice_mm || 0.4, got = plans.filter(Boolean), pl = got[0];
  const where = S.settings.test_slice_style === "HORIZONTAL" ? `a level ${t} mm slice, ${pl.why}` : `an upright ${t} mm slice across the main seam, through the ${pl.why === "top of the latex" ? "tallest point of the latex" : pl.why}`;
  const nums = got.map((p) => p.piece + 1), list = nums.length > 1 ? `${nums.slice(0, -1).join(", ")} and ${nums.at(-1)}` : String(nums[0]);
  el.textContent = `Shown in pink in the view: ${where}, through ${nums.length > 1 ? `pieces ${list}, so the slices go all the way round` : `piece ${list}`}. Drag the pink dot to move it.`;
}
// selection and hover colours, without rebuilding anything
function highlight() {
  const activeCut = S.active;
  for (const [key, o] of meshes.segs) {
    const picked = S.selSegs.has(key), hov = S.hover && S.hover.kind === "seg" && S.hover.key === key;
    const ofCut = o.cut === activeCut || S.selCuts.has(o.cut);
    const all = S.mode === "lines"; // picking lines: show every plane
    o.m.material.color.copy(picked ? COL.pick : COL.plane);
    o.m.material.opacity = picked ? 0.42 : hov ? 0.34 : ofCut ? 0.22 : all ? 0.13 : 0;
    o.e.material.color.copy(picked ? COL.pick : COL.plane);
    o.e.material.opacity = picked || hov ? 1 : ofCut ? 0.8 : all ? 0.55 : 0;
  }
  const anyPiece = S.selPieces.size > 0;
  for (const [id, o] of meshes.pieces) {
    const sel = S.selPieces.has(id), hov = S.hover && S.hover.kind === "piece" && S.hover.key === id;
    o.m.material.opacity = sel ? 0.1 : hov ? 0.06 : 0;
    o.e.material.opacity = sel ? 0.85 : hov ? 0.6 : anyPiece ? 0.15 : 0.35;
  }
  if (anyPiece) for (const [key, o] of meshes.segs) {
    if (S.selSegs.has(key) || o.cut === activeCut || S.selCuts.has(o.cut)) continue;
    o.m.material.opacity = S.mode === "lines" ? 0.05 : 0; o.e.material.opacity = S.mode === "lines" ? 0.2 : 0;
  }
  for (const o of groups.slicePlan.children) {
    const on = !anyPiece || (o.userData.pieces || []).some((id) => S.selPieces.has(id));
    o.material.opacity = { sheet: on ? 0.2 : 0.04, edge: on ? 0.8 : 0.15, line: on ? 1 : 0.25, handle: 0.95 }[o.userData.part] ?? o.material.opacity;
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
// ------------------------------------------------------------ slice it for me
// Overhang (as a % of the latex) one more piece has to save to be worth it.
const SLICE_PENALTY = 0.4, SUGGEST_PENALTY = 0.2;
function sliceCtx(first) {
  const num = (v, d) => (Number.isFinite(+v) && v !== "" ? +v : d);
  return {
    saved: { cuts: S.cuts, joins: S.joins, pulls: S.pulls },
    tri: latexTri, verts: latexPos(), opts: opts(), tol: tol(), first,
    centre: new V3(...S.scan.center),
    minFrac: clamp(num(S.settings.min_piece_pct, 7), 1, 45) / 100,
    maxPieces: Math.round(clamp(num(S.settings.auto_max_pieces, 6), 2, 16)),
    maxTilt: num(S.settings.max_tilt_deg, 30),
    penalty: SLICE_PENALTY,
    compute: (cuts, joins) => { S.cuts = cuts; S.joins = joins; S.pulls = {}; return compute(); },
    nextId: () => S.nextId++,
    say: async (t) => { $("#busySub").textContent = t; await nextFrame(); },
  };
}
const SLICE_HOW = {
  worst: "cut 1, then the piece with the most overhang split again and again",
  "layers across": "layers side to side, each split its own way",
  "layers front to back": "layers front to back, each split its own way",
  "layers level": "level layers, each split its own way",
  "layers along the first cut": "layers along cut 1, each split its own way",
  "first cut, then each half in layers": "cut 1, then each half in layers",
};
const sliceHow = (r) => (r.cuts.length === 1 ? "one cut is all it needs" : SLICE_HOW[r.how] || r.how);
const slicePct = (v) => (v < 0.005 ? "0%" : v.toFixed(v < 1 ? 2 : 1) + "%");
function applySlice(r, beforePct) {
  sliceApplying = true;
  try { mark(null); } finally { sliceApplying = false; }
  S.cuts = r.cuts.map((c) => ({ ...c })); S.joins = []; S.pulls = {};
  S.active = null; S.selCuts.clear(); S.selSegs.clear(); S.selPieces.clear();
  renderCuts(); refresh();
  $$("#sliceAlts button").forEach((b) => b.classList.toggle("on", b._r === r));
  toast(`${r.pieces} pieces: ${sliceHow(r)}. Overhang ${beforePct != null ? slicePct(beforePct) + " → " : ""}${slicePct(100 * S.T.bad / latexTri.total)}, smallest piece ${Math.round(100 * r.minShare)}% of the shell.`, true);
}
$("#sliceAuto").onclick = () => withBusy("Slicing the shell", async () => {
  if (!S.T || !latexTri) throw new Error("Load a scan first.");
  const beforePct = S.cuts.length ? 100 * S.T.bad / latexTri.total : null;
  let first = S.cuts[0] ? { ...S.cuts[0], parent: null } : null;
  if (!first) {
    const sg = await api("/api/suggest", { max_tilt: S.settings.max_tilt_deg });
    const { c, point } = cutFromSuggestion(sg);
    const tmp = sliceCtx(null);
    if (!slicePlace(tmp, [], c, point)) throw new Error("Couldn't place a first cut. Add one by hand, then try again.");
    first = c;
  }
  const ctx = sliceCtx(first);
  let res;
  try { res = await sliceShell(ctx); } finally { S.cuts = ctx.saved.cuts; S.joins = ctx.saved.joins; S.pulls = ctx.saved.pulls; }
  const ok = res.filter((r) => r.ok);
  if (!ok.length) { refresh(); throw new Error(`Every layout had a piece smaller than ${Math.round(ctx.minFrac * 100)}% of the shell. Lower Smallest piece in Settings and try again.`); }
  // the best layout for each number of pieces, to switch between
  const byCount = new Map();
  for (const r of ok) if (!byCount.has(r.pieces)) byCount.set(r.pieces, r);
  const alts = [...byCount.values()].sort((a, b) => a.pieces - b.pieces).slice(0, 6);
  const box = $("#sliceAlts");
  box.innerHTML = "<span>Other layouts:</span>";
  for (const r of alts) {
    const b = document.createElement("button");
    b.type = "button"; b._r = r;
    b.textContent = `${r.pieces} pieces · ${slicePct(r.over)}`;
    b.title = `${sliceHow(r)[0].toUpperCase() + sliceHow(r).slice(1)}. Smallest piece ${Math.round(100 * r.minShare)}% of the shell.`;
    b.onclick = () => applySlice(r, null);
    box.appendChild(b);
  }
  box.hidden = alts.length < 2;
  applySlice(ok[0], beforePct);
});
$("#autoCuts").onclick = () => withBusy("Looking for more cuts", async () => {
  if (!S.cuts.length) throw new Error("Add a first cut, or use Find best first cut.");
  const ctx = sliceCtx({ ...S.cuts[0], parent: null });
  ctx.compute = (cuts, joins) => { S.cuts = cuts; S.joins = joins; S.pulls = ctx.saved.pulls; return compute(); };
  let steps;
  try { steps = await suggestMore(ctx, { cuts: S.cuts, joins: S.joins }); } finally { S.cuts = ctx.saved.cuts; S.joins = ctx.saved.joins; S.pulls = ctx.saved.pulls; }
  const now = steps[0], score = (r) => r.over + SUGGEST_PENALTY * r.pieces + (r.locked > now.locked ? 1000 : 0);
  const best = steps.reduce((a, r) => (score(r) < score(a) ? r : a), now);
  if (best === now) { refresh(); toast(`No cut that helps enough${now.pieces >= ctx.maxPieces ? ` (already ${now.pieces} pieces, the most Suggest up to allows)` : ""}. Overhang is ${now.over.toFixed(1)}%.`, true); return; }
  mark(null);
  const added = best.cuts.length - now.cuts.length;
  S.cuts = best.cuts.map((c) => ({ ...c }));
  S.active = S.cuts[S.cuts.length - 1].id; S.selCuts = new Set([S.active]);
  renderCuts(); refresh();
  toast(`Added ${added} cut${added > 1 ? "s" : ""}. Overhang ${now.over.toFixed(1)}% → ${best.over.toFixed(1)}%.`, true);
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
  const onModel = latexMesh && S.T && S.T.pieceOf ? ray.intersectObject(latexMesh, false)[0] : null;
  if (onModel && onModel.faceIndex != null) {
    const k = S.T.pieceOf[onModel.faceIndex];
    if (k >= 0 && S.T.pieces[k]) return { kind: "piece", key: S.T.pieces[k].id };
  }
  const hit = ray.intersectObjects([...meshes.pieces.values()].map((o) => o.pick), false)[0];
  return hit ? { kind: "piece", key: hit.object.userData.piece } : null;
}
const modeKind = () => (S.mode === "lines" ? "seg" : "piece");
function setMode(m) {
  S.mode = m;
  $$("#rail [data-mode]").forEach((b) => { b.classList.toggle("on", b.dataset.mode === m); b.setAttribute("aria-pressed", String(b.dataset.mode === m)); });
  canvas.style.cursor = m === "draw" ? "crosshair" : "";
  $("#hint").textContent = m === "draw" ?
    "Draw a cut: drag a line across the model · the cut goes through the line straight away from you, through the pieces it crosses · P goes back to picking" :
    m === "lines" ?
    "Lines: click a line between pieces · Shift-click for more · Delete removes it · double-click picks the whole cut · right-click for options" :
    "Pieces: click the model to pick a piece · Shift-click for more · right-click for options · drag an arrow tip to change how it pulls off";
  S.hover = null; highlight();
}
let drag = null, down = null, hoverT = null;
canvas.addEventListener("pointerdown", (e) => {
  down = null; closeMenu();
  if (SEAM.picking || WEB.picking || SPOUT.picking || splitHandleAt(e)) return; // their own click handlers deal with it
  const sh = e.button === 0 && S.step === "cut" ? sizerAt(e) : null;
  if (sh) { sizerStart(e, sh); e.stopImmediatePropagation(); return; }
  const ih = e.button === 0 && S.step === "cut" ? insHandleAt(e) : null;
  if (ih) { insDragStart(e, ih); e.stopImmediatePropagation(); return; }
  if (e.button === 0 && S.step === "cut" && sliceHandleAt(e)) { sliceDragStart(e); e.stopImmediatePropagation(); return; }
  if (S.step !== "cut" || gizmoHot()) return;
  if (e.button === 2) { down = { x: e.clientX, y: e.clientY, button: 2 }; return; }
  if (e.button !== 0) return;
  if (S.mode === "draw" && !insViewOn()) { cutLineStart(e); e.stopImmediatePropagation(); return; }
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
  if (cutLine) { cutLineMove(e); return; }
  if (sizeDrag) { sizerMove(e); return; }
  if (insDrag) { insDragMove(e); return; }
  if (sliceDrag) { sliceDragMove(e); return; }
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
    if (S.mode === "draw") return;
    if (insHandleAt(e) || sizerAt(e) || sliceHandleAt(e)) { canvas.style.cursor = "grab"; return; }
    const h = gizmoHot() ? null : pickAt(e, modeKind());
    if ((h && h.key) !== (S.hover && S.hover.key)) { S.hover = h; highlight(); canvas.style.cursor = h ? "pointer" : ""; }
  });
});
canvas.addEventListener("pointerleave", () => { if (S.hover) { S.hover = null; highlight(); canvas.style.cursor = ""; } });
canvas.addEventListener("pointerup", (e) => {
  if (cutLine) { cutLineEnd(e); return; }
  if (sizeDrag) { sizerEnd(e); return; }
  if (insDrag) { insDragEnd(e); return; }
  if (sliceDrag) { sliceDragEnd(e); return; }
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
$$("#rail [data-mode]").forEach((b) => b.onclick = () => setMode(b.dataset.mode));
// ---- draw a cut: drag a line across the view. The cut is the plane through
// that line straight along the view, so you see it edge-on where you drew it,
// and it goes only through the pieces the line crosses (at any depth).
let cutLine = null;
function screenXY(e) { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
function lineOverlay(a, b) {
  let svg = $("#drawLayer");
  if (!svg) { svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.id = "drawLayer"; canvas.parentElement.appendChild(svg); }
  svg.innerHTML = a ? `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/><circle cx="${a[0]}" cy="${a[1]}" r="4"/><circle cx="${b[0]}" cy="${b[1]}" r="4"/>` : "";
}
function cutLineStart(e) {
  cutLine = { a: screenXY(e), b: screenXY(e) };
  orbit.enabled = false; canvas.setPointerCapture(e.pointerId);
  lineOverlay(cutLine.a, cutLine.b);
}
function cutLineMove(e) {
  cutLine.b = screenXY(e);
  if (e.shiftKey) { // Shift: level, upright or 45 degrees on screen
    const dx = cutLine.b[0] - cutLine.a[0], dy = cutLine.b[1] - cutLine.a[1], L = Math.hypot(dx, dy), q = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
    cutLine.b = [cutLine.a[0] + L * Math.cos(q), cutLine.a[1] + L * Math.sin(q)];
  }
  lineOverlay(cutLine.a, cutLine.b);
}
function rayAt(xy) {
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(xy[0] / r.width * 2 - 1, -(xy[1] / r.height) * 2 + 1), camera);
  return { o: ray.ray.origin.clone(), d: ray.ray.direction.clone() };
}
// the cut a line drawn from screen point a to b makes: {n, point, parent, under} or a reason it can't
function cutFromLine(a, b) {
  if (!S.T) return { why: "Load a scan first." };
  const A = rayAt(a), B = rayAt(b), mid = new V3(...S.scan.center), view = camera.getWorldDirection(new V3());
  const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(view, mid), pa = new V3(), pb = new V3();
  if (!new THREE.Ray(A.o, A.d).intersectPlane(pl, pa) || !new THREE.Ray(B.o, B.d).intersectPlane(pl, pb)) return { why: "Turn the view to face the model, then draw the line again." };
  // the plane through the line, straight along the view: level with the view
  // when you look from the side (so a flat line makes a level cut), straight
  // down when you look from above, and one within 3° of level or square to the
  // box snaps to it
  const ext = view.clone();
  if (Math.abs(view.z) < 0.5) ext.z = 0; else if (Math.abs(view.z) > 0.87) ext.set(0, 0, Math.sign(view.z));
  ext.normalize();
  const n = pb.clone().sub(pa).cross(ext).normalize();
  if (!(n.length() > 0.5)) return { why: "Draw a longer line." };
  for (const ax of [new V3(0, 0, 1), S.T.frame.ex, S.T.frame.ey]) if (Math.abs(n.dot(ax)) > Math.cos(3 * Math.PI / 180)) { n.copy(ax).multiplyScalar(Math.sign(n.dot(ax))); break; }
  const point = pa.clone().add(pb).multiplyScalar(0.5), d = n.dot(point);
  // which blocks the plane goes through, and which of those lie under the line
  const r = canvas.getBoundingClientRect();
  const proj = (v) => { const q = v.clone().project(camera); return [(q.x + 1) / 2 * r.width, (1 - q.y) / 2 * r.height]; };
  const ux = b[0] - a[0], uy = b[1] - a[1], uu = ux * ux + uy * uy;
  const crossing = [], under = [];
  for (const L of S.T.cells) {
    const cap = clipPolytope(L.poly, n, d, null).cap;
    if (!cap) continue;
    crossing.push(L.id);
    let lo = Infinity, hi = -Infinity;
    for (const v of cap) { const [x, y] = proj(v), t = ((x - a[0]) * ux + (y - a[1]) * uy) / uu; lo = Math.min(lo, t); hi = Math.max(hi, t); }
    if (hi > 0.02 && lo < 0.98) under.push(L.id);
  }
  if (!under.length) return { why: "That line doesn't cross the shell. Draw it across the model." };
  const parent = under.length === crossing.length ? null : under.length === 1 ? under[0] : under;
  return { n, point, parent, under };
}
function cutLineEnd(e) {
  const { a, b } = cutLine; cutLine = null;
  orbit.enabled = true; canvas.releasePointerCapture?.(e.pointerId); lineOverlay(null);
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 12) return;
  const f = cutFromLine(a, b);
  if (f.why) return toast(f.why);
  mark(null);
  const c = { id: S.nextId++, parent: f.parent, ...angles(canonical(f.n)), pos: 0.5, auto: false };
  S.cuts.push(c); placeFromPoint(c, f.point);
  S.active = c.id; S.selCuts = new Set([c.id]); S.selSegs.clear(); S.selPieces.clear();
  renderCuts(); refresh();
  const k = cutIndex(c.id) + 1;
  toast(`Cut ${k} goes through ${f.parent == null ? "the whole shell" : f.under.length === 1 ? "one piece" : `${f.under.length} pieces`}. Drag its arrow to slide it or a ring to turn it, draw another, or press P to pick pieces.`, true);
}

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
function closeMenu() { $("#ctx").hidden = true; $("#ctx").classList.remove("file-menu"); delete $("#ctx").dataset.menu; }
addEventListener("pointerdown", (e) => { if (!e.target.closest("#ctx") && !e.target.closest(".menu-btn")) closeMenu(); }, true);
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
  ["P / L", "Pick pieces / pick lines in the view"], ["D", "Draw a cut: drag a line across the model (Shift keeps it level, upright or at 45°)"], ["Shift+click", "Pick more than one"], ["Ctrl+A", "Pick every piece"],
  ["C", "Add a cut through the whole shell"], ["S", "Scale box: drag a gold corner to size the scan"], ["R / Shift+R", "Turn the scan 90° / 15° around Z"],
  ["Drag the arrow", "Slide the open cut"], ["Drag a ring", "Turn or tilt the open cut"], ["Shift while dragging", "Snap to 5° or 5%"],
  ["← →", "On a slider: 1° or 1% (Shift: 5)"], ["O", "Optimize the open cut"], ["M", "Join the picked pieces"],
  ["H / Alt+H", "Hide the row picked in the Scene list / show everything"], ["X", "Overhangs in red on or off"], ["T", "Test slices on or off"],
  ["N", "Hide or show the side panel"], ["Ctrl+S", "Save this cut layout"], ["Ctrl+B", "Build the shell"],
  ["Ctrl+T", "New tab, to open another scan"], ["Ctrl+W", "Close this tab (it asks first)"], ["Ctrl+Tab / Ctrl+Shift+Tab", "Next tab / the one before"],
  ["F", "Fit the view"], ["Numpad 1 / 3 / 7", "Front / side / top view"], ["Ctrl+Numpad 7", "From underneath"], ["1 / 2 / 3 / 4", "Scan / Cuts / Insert / Settings tab"], ["I", "Insert view, when the insert is on"], ["?", "Show these keys"],
];
$("#keysList").innerHTML = KEYS.map(([k, v]) => `<dt class="mono">${k}</dt><dd>${v}</dd>`).join("");
$("#keysBtn").onclick = () => { $("#keys").hidden = !$("#keys").hidden; };
$("#keysClose").onclick = () => { $("#keys").hidden = true; };
// the views, before a build and after it: Numpad 1 / 3 / 7, Ctrl+Numpad 7 from underneath
addEventListener("keydown", (e) => {
  if ((S.step !== "cut" && S.step !== "done") || e.target.matches("input, select, textarea")) return;
  const v = { Numpad1: "front", Numpad3: "side", Numpad7: e.ctrlKey || e.metaKey ? "bottom" : "top" }[e.code];
  if (v && !e.altKey) { e.preventDefault(); viewFrom(v); }
});
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
    else if (S.selPieces.size === 1) toast("To join this piece to a neighbor, Shift-click both and press Delete, or pick Lines and delete the line between them.");
    else if (S.selCuts.size) deleteCuts([...S.selCuts]);
    else if (S.active != null) deleteCuts([S.active]);
    return;
  }
  const tabKey = { Digit1: "scan", Digit2: "cuts", Digit3: "insert", Digit4: "settings" }[e.code];
  if (tabKey) { e.preventDefault(); showTab(tabKey); return; }
  const act = {
    p: () => setMode("pieces"), l: () => setMode("lines"), d: () => setMode("draw"),
    o: () => S.active != null && optimize(S.active, ["az", "tilt", "pos"]),
    m: () => mergePieces([...S.selPieces]), f: () => viewFrom("fit"),
    c: () => { showTab("cuts"); $("#addCut").click(); },
    s: () => showTab("scan"),
    r: () => $(e.shiftKey ? '[data-rot="z,15"]' : '[data-rot="z,90"]').click(),
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
    if (el.type === "checkbox") el.checked = !!S.settings[el.id]; else el.value = "pct" in el.dataset ? Math.round(S.settings[el.id] * 100) : S.settings[el.id];
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
  set("#sumChan", hug ? `Ø${ss.hole_d_mm} mm cord · notches every ${+ss.notch_gap_mm} mm` : +ss.holes_per_corner ? `Ø${ss.hole_d_mm} mm · ${ss.holes_per_corner}/corner${ss.channel_pairs ? " · pairs" : ""}` : "none");
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
    const was = "pct" in el.dataset ? Math.round(S.settings[el.id] * 100) : S.settings[el.id];
    toast(`${bad} Kept ${was}.`);
    el.value = was; el.classList.add("bad"); setTimeout(() => el.classList.remove("bad"), 2500);
    return;
  }
  S.settings[el.id] = el.type === "checkbox" ? el.checked : el.type === "number" ? +el.value / ("pct" in el.dataset ? 100 : 1) : el.value;
  saveSettings(); estimate(); fillSettings();
  if (["draft_deg", "wall_mm", "bottom_trim_mm", "test_slice_mm", "test_slice_at", "hole_d_mm", "holes_per_corner", "channel_pairs", "pair_gap_mm"].includes(el.id)) refresh();
}));
$$("#sliceStyle button").forEach((b) => b.onclick = () => { S.settings.test_slice_style = b.dataset.style; S.sliceAt = null; saveSettings(); fillSettings(); refresh(); });
$("#sliceReset").onclick = () => { mark(null); S.sliceAt = null; if (S.T) drawSlicePlan(S.T); autosaveSoon(); };
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
const layoutNow = () => ({ cuts: S.cuts, nextId: S.nextId, joins: S.joins, pulls: S.pulls, insert: S.insert, slice_at: S.sliceAt ?? null, pieces: S.T ? S.T.pieces.length : 0, dims: S.scan && S.scan.size });
let autoT = null, autoLast = "";
function autosaveSoon() {
  if (!S.scan || S.step !== "cut") return;
  clearTimeout(autoT);
  autoT = setTimeout(() => {
    const L = layoutNow(), key = JSON.stringify([L.cuts, L.joins, L.pulls, L.insert, L.slice_at]);
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
  S.sliceAt = L.slice_at ?? null;
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

async function showScan(info, keepCuts, restore, quiet) {
  S.scan = info;
  $("#fileName").textContent = info.file || info.name;
  $("#fileMeta").textContent = `${info.dims.join(" × ")} mm · ${info.triangles.toLocaleString()} triangles · ${info.watertight ? "watertight" : info.open_edges + " open edges"}`;
  $("#fileMeta").classList.toggle("bad", !info.watertight);
  const tried = S.repairTried === info.name;
  $("#scanHealth").textContent = info.watertight ? "Mesh is closed and ready." : tried ?
    `Still ${info.open_edges} open edges after repair.` : `${info.open_edges} open edges.`;
  $("#cleanWarn").hidden = !info.floor_share;
  $("#scanWarn").hidden = info.watertight || !!info.floor_share; // cleaning up closes it too
  $("#scanWarnText").textContent = tried ?
    `Repair couldn't close every hole in this scan (${info.open_edges} open edges left). Fix it in your scan software, then load it again. The shell can't be built until then.` :
    `This scan has holes in its surface (${info.open_edges} open edges). The shell can't be carved around it properly until they're closed.`;
  $("#scanWarnFix").hidden = tried;
  $$('[data-prep=repair]:not(#scanWarnFix)').forEach((b) => b.hidden = !$("#scanWarn").hidden); // the warning has its own
  $("#cleanBtn").hidden = !$("#cleanWarn").hidden;
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
    S.insert = insDefaults(); insFill(); S.sliceAt = null;
    if (info.suggested) { const { c, point } = cutFromSuggestion(info.suggested); S.cuts.push(c); placeFromPoint(c, point); c.auto = true; S.active = c.id; S.selCuts.add(c.id); }
    resetHistory();
  }
  if (info.layouts) S.layouts = info.layouts;
  renderLayouts();
  renderCuts();
  refresh();
  const back = restore && !info.grown && info.layouts && info.layouts.auto; // a layout made at the tiny size would be wrong now
  if (back && back.cuts && back.cuts.length) {
    mark(null); applyLayout(back); autoLast = JSON.stringify([S.cuts, S.joins, S.pulls]);
    if (!quiet) toast(`Brought back your last layout for this scan${info.prepared ? ", at the size you set" : ""}. Ctrl+Z gives the suggested first cut instead.`, true);
  } else if (restore && info.prepared && !quiet) toast("Opened at the size you set last time.", true);
  updatePour();
  scanMarked();
}
$$("[data-prep]").forEach((b) => b.onclick = () => {
  const op = b.dataset.prep;
  const value = op === "trim_base" ? +$("#trimMm").value : op === "simplify" ? (+$("#simpPct").value) / 100 : undefined;
  const label = { cleanup: "Cleaning up the scan", lay_flat: "Laying it flat", reset: "Reloading the scan", trim_base: "Trimming the base", repair: "Repairing the mesh", simplify: "Simplifying" }[op];
  withBusy(label, async () => {
    if (op === "repair") S.repairTried = S.scan?.name; else if (op === "reset") S.repairTried = null;
    const info = await api("/api/prep", { op, value }); await showScan(info, op !== "reset" && op !== "lay_flat" && op !== "cleanup"); if (op === "lay_flat" || op === "cleanup") viewFrom("fit");
    if (op === "cleanup") {
      toast(`${info.clean_note || "Cleaned up."}${info.watertight ? "" : " It still has a few holes: press Repair mesh."} Ctrl+Z puts it back.`, true);
    }
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
  if (f.some((x) => !(x > 0.05 && x < 50))) { toast(`Those sizes don't look right, so the scan wasn't changed. Type the size in ${({ mm: "mm", cm: "cm", in: "inches" })[window.__units?.get() || "mm"]}.`); sizerReset(); fillSize(); return; }
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
  if (latexMesh && latexTri) paint(S.T || { pieces: [] }); // split parts in colour on the Scan tab, pieces elsewhere
  drawSplitApart();
  if (SPLIT.draw && (S.step !== "cut" || curTab() !== "scan")) setDrawMode(SPLIT.draw); // drawing is for the Scan tab
  g.visible = !!(S.step === "cut" && S.scan && curTab() === "scan" && !insViewOn() && $("#showPrinter").checked);
  if (!g.visible) return;
  const [W, D, H] = printerVol(), c = S.scan.center, sz = (S.scan.size || S.scan.dims).map(Number);
  const z0 = c[2] - sz[2] / 2 - baseH();
  const ok = fitsVol(modelDims(), [W, D, H]);
  const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(W, D, H)), new THREE.LineBasicMaterial({ color: ok ? "#7fc89a" : "#f08a70", transparent: true, opacity: 0.75 }));
  box.position.set(c[0], c[1], z0 + H / 2); g.add(box);
  SPLIT.cuts.forEach((cut, k) => {
    if (cut.kind === "shape") { drawShapeCut(g, cut, k); return; }
    const p = splitHandlePos(cut), r = Math.max(2.5, size() * 0.022), a = cutAxis(cut);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), new THREE.MeshBasicMaterial({ color: "#f0a040", depthTest: false }));
    ball.position.copy(p); ball.renderOrder = 12; ball.userData.splitCut = k;
    // a short line along the way it moves
    const d = new V3(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0).multiplyScalar(r * 3);
    const line = new THREE.LineSegments(lineGeometry([p.clone().sub(d), p.clone().add(d)]), new THREE.LineBasicMaterial({ color: "#f0a040", depthTest: false, transparent: true, opacity: 0.8 }));
    line.renderOrder = 12;
    const tag = textSprite(String(k + 1), r * 1.6); tag.position.copy(p).add(new V3(0, 0, r * 2.2));
    g.add(ball, line, tag);
  });
  $("#splitHint").hidden = !SPLIT.cuts.length;
}
function cutAxis(cut) { return cut.kind === "shape" ? -1 : cut.kind === "x" ? 0 : cut.kind === "y" ? 1 : 2; }
// ---- cuts drawn on the view: a free line, a box or an ellipse. The outline goes
// straight through the model the way the view looked; what's inside is a part of its own.
function shapeBasis(cut) {
  const n = new V3(...cut.normal).normalize(), a = Math.abs(n.x) < 0.9 ? new V3(1, 0, 0) : new V3(0, 1, 0);
  const u = n.clone().cross(a).normalize(), v = n.clone().cross(u);
  const o = new V3(...cut.point);
  const poly = cut.pts.map((q) => { const d = new V3(...q).sub(o); return [d.dot(u), d.dot(v)]; });
  return { n, u, v, o, poly };
}
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// which triangles of the model are inside a drawn cut
function shapeInside(cut) {
  const C = splitCentroids(), n = latexTri.n, B = shapeBasis(cut), out = new Uint8Array(n);
  const { u, v, o, poly } = B;
  for (let i = 0; i < n; i++) {
    const dx = C[i * 3] - o.x, dy = C[i * 3 + 1] - o.y, dz = C[i * 3 + 2] - o.z;
    out[i] = pointInPoly(dx * u.x + dy * u.y + dz * u.z, dx * v.x + dy * v.y + dz * v.z, poly) ? 1 : 0;
  }
  return out;
}
// the outline in front of and behind the model, joined at a few corners
function drawShapeCut(g, cut, k) {
  const { n } = shapeBasis(cut), sz = (S.scan.size || S.scan.dims).map(Number);
  const R = (Math.abs(n.x) * sz[0] + Math.abs(n.y) * sz[1] + Math.abs(n.z) * sz[2]) / 2 + 4; // just past the model, front and back
  const ring = (t) => cut.pts.map((q) => new V3(...q).addScaledVector(n, t));
  const a = ring(-R), b = ring(R), segs = [];
  for (let i = 0; i < a.length; i++) { const j = (i + 1) % a.length; segs.push(a[i], a[j], b[i], b[j]); }
  const step = Math.max(1, Math.floor(a.length / 4));
  for (let i = 0; i < a.length; i += step) segs.push(a[i], b[i]);
  const line = new THREE.LineSegments(lineGeometry(segs), new THREE.LineBasicMaterial({ color: "#f0a040", transparent: true, opacity: 0.85 }));
  line.renderOrder = 12;
  const r = Math.max(2.5, size() * 0.022), tag = textSprite(String(k + 1), r * 1.6);
  tag.position.copy(a[0]);
  g.add(line, tag);
}
const SHAPE_NAMES = { free: "free line", box: "box", ellipse: "ellipse" };
var shapeDraw = null; // { kind, pts: [[x, y] on screen], start }
function setDrawMode(kind) {
  SPLIT.draw = SPLIT.draw === kind ? null : kind;
  $$("[data-draw]").forEach((b) => { b.classList.toggle("on", b.dataset.draw === SPLIT.draw); b.setAttribute("aria-pressed", b.dataset.draw === SPLIT.draw); });
  canvas.style.cursor = SPLIT.draw ? "crosshair" : "";
  $("#drawHint").hidden = !SPLIT.draw;
  if (!SPLIT.draw) { shapeDraw = null; drawOverlay(); }
}
function drawOverlay() {
  let svg = $("#drawLayer");
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.id = "drawLayer";
    canvas.parentElement.appendChild(svg);
  }
  const pts = shapeOutline();
  svg.innerHTML = pts && pts.length > 1 ? `<polygon points="${pts.map((q) => q.join(",")).join(" ")}"/>` : "";
}
// the outline being drawn, in screen pixels relative to the canvas
function shapeOutline() {
  if (!shapeDraw) return null;
  const P = shapeDraw.pts;
  if (shapeDraw.kind === "free") return P;
  const [a, b] = [P[0], P[P.length - 1]];
  if (shapeDraw.kind === "box") return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
  const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, rx = Math.abs(b[0] - a[0]) / 2, ry = Math.abs(b[1] - a[1]) / 2;
  return [...Array(48)].map((_, i) => [cx + rx * Math.cos(i / 48 * 2 * Math.PI), cy + ry * Math.sin(i / 48 * 2 * Math.PI)]);
}
function segsCross(p, q, r, s) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return d(p, q, r) * d(p, q, s) < 0 && d(r, s, p) * d(r, s, q) < 0;
}
function finishShape() {
  let P = shapeOutline(); const kind = shapeDraw.kind;
  shapeDraw = null; drawOverlay();
  if (!P || P.length < 3) return;
  const xs = P.map((q) => q[0]), ys = P.map((q) => q[1]);
  if (Math.max(...xs) - Math.min(...xs) < 8 || Math.max(...ys) - Math.min(...ys) < 8) return toast("That shape is too small. Drag a bigger one.");
  if (kind === "free") {
    // fewer points, and the line must not cross itself
    const keep = [P[0]];
    for (const q of P) { const l = keep[keep.length - 1]; if (Math.hypot(q[0] - l[0], q[1] - l[1]) >= 5) keep.push(q); }
    while (keep.length > 160) for (let i = keep.length - 2; i > 0; i -= 2) keep.splice(i, 1);
    P = keep;
    if (P.length < 3) return;
    for (let i = 0; i < P.length; i++) for (let j = i + 2; j < P.length; j++) {
      if (i === 0 && j === P.length - 1) continue;
      if (segsCross(P[i], P[(i + 1) % P.length], P[j], P[(j + 1) % P.length])) return toast("The line crosses itself. Draw it again as one loop that doesn't cross.");
    }
  }
  // onto a plane through the middle of the model, square to the view
  const n = camera.getWorldDirection(new V3()), mid = new V3(...S.scan.center);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, mid), r = canvas.getBoundingClientRect(), hit = new V3(), pts = [];
  for (const [x, y] of P) {
    ray.setFromCamera(new THREE.Vector2(x / r.width * 2 - 1, -(y / r.height) * 2 + 1), camera);
    if (!ray.ray.intersectPlane(plane, hit)) return toast("Turn the view to face the model, then draw again.");
    pts.push(hit.toArray().map((v) => Math.round(v * 10) / 10));
  }
  const cut = { kind: "shape", shape: kind, point: mid.toArray().map((v) => Math.round(v * 10) / 10), normal: n.toArray().map((v) => Math.round(v * 1e4) / 1e4), pts };
  const inn = shapeInside(cut); let k = 0; for (let i = 0; i < inn.length; i++) k += inn[i];
  if (!k || k === inn.length) return toast(k ? "That shape goes round the whole model, so it wouldn't cut anything." : "That shape misses the model. Draw it over the part you want to cut out.");
  SPLIT.cuts.push(cut);
  setDrawMode(null);
  renderSplit(); splitChanged();
}
canvas.addEventListener("pointerdown", (e) => {
  if (!SPLIT.draw || e.button !== 0 || S.step !== "cut" || curTab() !== "scan" || !S.scan) return;
  e.stopImmediatePropagation(); e.preventDefault();
  const r = canvas.getBoundingClientRect();
  shapeDraw = { kind: SPLIT.draw, pts: [[e.clientX - r.left, e.clientY - r.top]] };
  orbit.enabled = false; canvas.setPointerCapture(e.pointerId);
}, true);
canvas.addEventListener("pointermove", (e) => {
  if (!shapeDraw) return;
  e.stopImmediatePropagation();
  const r = canvas.getBoundingClientRect();
  shapeDraw.pts.push([e.clientX - r.left, e.clientY - r.top]);
  drawOverlay();
}, true);
canvas.addEventListener("pointerup", (e) => {
  if (!shapeDraw) return;
  e.stopImmediatePropagation();
  orbit.enabled = true;
  finishShape();
}, true);
addEventListener("keydown", (e) => { if (e.key === "Escape" && SPLIT.draw) { setDrawMode(null); e.stopImmediatePropagation(); } }, true);
// Pull the model's own parts apart (not the shell) to see how they go together.
// It shows the real parts, solid and with their pegs and holes: the engine cuts
// them (without saving) the first time the slider leaves 0 for these cuts, and
// Split and save parts makes them too. When a cut moves, the slider goes back to 0.
// var: go() can run before these lines
var splitApart = new THREE.Group(); scene.add(splitApart);
var splitApartKey = null, splitApartTok = 0;
function splitSpreadMM() { return +$("#splitSpread").value || 0; }
function splitHaveParts() { return SPLIT.parts.length > 0 && SPLIT.parts.every((p) => p.url); }
function drawSplitApart() {
  if (!splitApart) return;
  const mm = splitSpreadMM();
  $("#splitSpreadVal").textContent = `${mm} mm`;
  $("#splitSpreadBox").hidden = !SPLIT.cuts.length;
  const on = !!(mm > 0 && SPLIT.cuts.length && splitHaveParts() && latexMesh && latexTri && S.step === "cut" && S.scan && curTab() === "scan" && !insViewOn() && groups.latex.visible);
  if (latexMesh) latexMesh.visible = !on;
  splitApart.visible = on;
  if (!on) return;
  const parts = splitPartOf(); if (!parts) return;
  const { dirs, mids } = splitPartCache;
  const key = SPLIT.parts.map((p) => p.url).join();
  if (splitApartKey !== key) {
    splitApartKey = key;
    splitApart.children.forEach((m) => { m.geometry.dispose(); m.material.dispose(); });
    splitApart.clear();
    const tok = ++splitApartTok;
    latexMesh.visible = true; // the whole model until the parts are in
    Promise.all(SPLIT.parts.map((p) => loadSTL(p.url))).then((gs) => {
      if (tok !== splitApartTok) { gs.forEach((g) => g.dispose()); return; }
      gs.forEach((g, k) => {
        // which way each part moves: matched to the part it came from by where its middle is
        g.computeBoundingBox(); const c = g.boundingBox.getCenter(new V3());
        let best = 0, bd = Infinity;
        mids.forEach((m, j) => { const d = (m[0] - c.x) ** 2 + (m[1] - c.y) ** 2 + (m[2] - c.z) ** 2; if (d < bd) { bd = d; best = j; } });
        const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: new THREE.Color(pieceColor(k)).lerp(COL.latex, 0.2), roughness: 0.75, metalness: 0 }));
        mesh.userData.dir = dirs[best] || [0, 0, 0];
        splitApart.add(mesh);
      });
      drawSplitApart();
    });
    return;
  }
  if (!splitApart.children.length) { latexMesh.visible = true; return; }
  splitApart.children.forEach((m) => { const d = m.userData.dir; m.position.set(d[0] * mm, d[1] * mm, d[2] * mm); });
}
async function splitMakeParts() {
  if (!SPLIT.cuts.length || splitHaveParts()) return;
  const cuts = JSON.stringify(SPLIT.cuts);
  await withBusy("Cutting the parts with their pegs", async () => {
    const r = await api("/api/split", { cuts: SPLIT.cuts, preview: true });
    if (JSON.stringify(SPLIT.cuts) !== cuts) return;
    SPLIT.parts = r.parts; renderSplitParts();
  }, true);
  drawSplitApart();
}
$("#splitSpread").addEventListener("input", () => { drawSplitApart(); if (splitSpreadMM() > 0 && !splitHaveParts()) $("#splitSpreadVal").textContent = "…"; });
$("#splitSpread").addEventListener("change", () => { if (splitSpreadMM() > 0) splitMakeParts(); });
// which split part each triangle of the model is in, numbered like the parts list (bottom first, then left to right)
let splitPartCache = { key: null, parts: null };
// the middle of each triangle of the model, kept while the model stays the same
let splitCentCache = { key: null, c: null };
function splitCentroids() {
  if (splitCentCache.key === latexMesh.uuid + latexTri.n) return splitCentCache.c;
  const pos = latexPos(), n = latexTri.n, C = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) C[i * 3 + a] = (pos[i * 9 + a] + pos[i * 9 + 3 + a] + pos[i * 9 + 6 + a]) / 3;
  splitCentCache = { key: latexMesh.uuid + latexTri.n, c: C };
  return C;
}
// level cuts, lowest first: they split the model into levels (0 = bottom)
function splitLevels() { return SPLIT.cuts.filter((c) => cutAxis(c) === 2).map((c) => c.point[2]).sort((a, b) => a - b); }
function bandOf(z, lv) { let b = 0; for (const h of lv) if (z >= h) b++; return b; }
function bandName(b, lv) { return b === 0 ? "bottom level" : b === lv.length ? "top level" : `level ${b + 1}`; }
function sideName(w, s) { const o = SPLIT.cuts[w]; if (!o) return ""; return `${cutAxis(o) === 0 ? (s > 0 ? "right" : "left") : (s > 0 ? "back" : "front")} of cut ${w + 1}`; }
function splitPartOf() {
  if (!SPLIT.cuts.length || !latexMesh || !latexTri) return null;
  const key = latexMesh.uuid + JSON.stringify(SPLIT.cuts.map((c) => c.kind === "shape" ? [c.kind, c.pts] : [c.kind, c.point[cutAxis(c)], c.band, c.within]));
  if (splitPartCache.key === key) return splitPartCache.parts;
  const C = splitCentroids(), n = latexTri.n, keys = new Uint32Array(n), app = new Uint32Array(n), info = new Map(), lv = splitLevels();
  // level cuts first, right through; an upright cut can be kept to one level, or one side of another cut
  const rank = (c) => c.kind === "shape" ? 2 : cutAxis(c) === 2 ? 0 : 1;
  const seq = SPLIT.cuts.map((_, j) => j).sort((a, b) => rank(SPLIT.cuts[a]) - rank(SPLIT.cuts[b]));
  for (const j of seq) {
    const cut = SPLIT.cuts[j], ax = cutAxis(cut), at = cut.point[ax], bit = 1 << j;
    if (cut.kind === "shape") { const inn = shapeInside(cut); for (let i = 0; i < n; i++) { app[i] |= bit; if (inn[i]) keys[i] |= bit; } continue; }
    let ok = null;
    if (ax !== 2 && ((cut.band != null && lv.length) || (cut.within || []).length)) {
      const sum = new Map();
      for (let i = 0; i < n; i++) { let r = sum.get(keys[i]); if (!r) sum.set(keys[i], (r = [0, 0, 0, 0])); r[0] += C[i * 3]; r[1] += C[i * 3 + 1]; r[2] += C[i * 3 + 2]; r[3]++; }
      ok = new Map();
      for (const [k, r] of sum) {
        const m = [r[0] / r[3], r[1] / r[3], r[2] / r[3]];
        let yes = !(cut.band != null && lv.length && bandOf(m[2], lv) !== +cut.band);
        for (const [w, s] of cut.within || []) { const o = SPLIT.cuts[w]; if (o && (m[cutAxis(o)] >= o.point[cutAxis(o)]) !== (s > 0)) yes = false; }
        ok.set(k, yes);
      }
    }
    for (let i = 0; i < n; i++) if (!ok || ok.get(keys[i])) { app[i] |= bit; if (C[i * 3 + ax] < at) keys[i] |= bit; }
  }
  for (let i = 0; i < n; i++) {
    const k = keys[i], r = info.get(k), x = C[i * 3], z = C[i * 3 + 2];
    if (!r) info.set(k, { z, x }); else { if (z < r.z) r.z = z; if (x < r.x) r.x = x; }
  }
  const order = [...info.entries()].sort((a, b) => (Math.round(a[1].z / 5) - Math.round(b[1].z / 5)) || (a[1].x - b[1].x)).map((e) => e[0]);
  const idx = new Map(order.map((k, i) => [k, i])), parts = new Uint16Array(n);
  for (let i = 0; i < n; i++) parts[i] = idx.get(keys[i]);
  // which way each part moves when they're pulled apart: half a step away from each cut it touches,
  // so every cut opens up by the slider's amount and the parts stay in line
  const dirs = order.map(() => [0, 0, 0]), mid = order.map(() => [0, 0, 0, 0]), seen = new Set();
  for (let i = 0; i < n; i++) {
    const k = parts[i], m = mid[k];
    m[0] += C[i * 3]; m[1] += C[i * 3 + 1]; m[2] += C[i * 3 + 2]; m[3]++;
    if (seen.has(k)) continue;
    seen.add(k);
    SPLIT.cuts.forEach((cut, j) => {
      if (!(app[i] & (1 << j))) return;
      if (cut.kind !== "shape") { dirs[k][cutAxis(cut)] += keys[i] & (1 << j) ? -0.5 : 0.5; return; }
      // a drawn cut: the part inside comes out toward the side it's on, or toward you if it's in the middle
      if (!(keys[i] & (1 << j))) return;
      const B = shapeBasis(cut), { n: nn, o, poly } = B;
      const cx = poly.reduce((t, q) => t + q[0], 0) / poly.length, cy = poly.reduce((t, q) => t + q[1], 0) / poly.length;
      const mc = new V3(...S.scan.center).sub(o), w = B.u.clone().multiplyScalar(cx - mc.dot(B.u)).addScaledVector(B.v, cy - mc.dot(B.v));
      const d = w.length() > size() * 0.08 ? w.normalize() : nn.clone().negate();
      dirs[k][0] += d.x; dirs[k][1] += d.y; dirs[k][2] += d.z;
    });
  }
  splitPartCache = { key, parts, dirs, mids: mid.map((m) => [m[0] / m[3], m[1] / m[3], m[2] / m[3]]) };
  return parts;
}
// a handle per split cut, beside the model, to drag the cut along its axis
function splitHandlePos(cut) {
  const c = S.scan.center, sz = (S.scan.size || S.scan.dims).map(Number), m = size() * 0.12, a = cutAxis(cut), lv = splitLevels();
  const top = cut.band != null && +cut.band < lv.length ? lv[+cut.band] : c[2] + sz[2] / 2;
  return a === 0 ? new V3(cut.point[0], c[1] - sz[1] / 2 - m, top) :
    a === 1 ? new V3(c[0] + sz[0] / 2 + m, cut.point[1], top) :
    new V3(c[0] + sz[0] / 2 + m, c[1] - sz[1] / 2 - m, cut.point[2]);
}
function splitHandleAt(e) {
  if (SPLIT.draw || S.step !== "cut" || curTab() !== "scan" || !groups.printer.visible || !SPLIT.cuts.length || e.button !== 0) return null;
  setRay(e);
  const hit = ray.intersectObjects(groups.printer.children.filter((o) => o.userData.splitCut != null), false)[0];
  return hit ? hit.object.userData.splitCut : null;
}
let splitDrag = null;
canvas.addEventListener("pointerdown", (e) => {
  const k = splitHandleAt(e); if (k == null) return;
  e.stopImmediatePropagation(); e.preventDefault();
  const cut = SPLIT.cuts[k], a = cutAxis(cut), p = splitHandlePos(cut);
  $("#splitSpread").value = 0; // the parts no longer match the cuts
  splitDrag = { k, a, origin: p.clone(), dir: new V3(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0) };
  orbit.enabled = false; canvas.setPointerCapture(e.pointerId);
}, true);
canvas.addEventListener("pointermove", (e) => {
  if (!splitDrag) return;
  e.stopImmediatePropagation();
  setRay(e);
  // the point on the cut's axis nearest the mouse ray
  const { origin: o, dir: d } = splitDrag, r = ray.ray, w = o.clone().sub(r.origin);
  const b = d.dot(r.direction), den = 1 - b * b; if (den < 1e-6) return;
  const t = (b * r.direction.dot(w) - d.dot(w)) / den;
  const c = S.scan.center, sz = (S.scan.size || S.scan.dims).map(Number), a = splitDrag.a;
  const lo = c[a] - sz[a] / 2 - (a === 2 ? baseH() : 0) + 1, hi = c[a] + sz[a] / 2 - 1;
  const v = Math.round(Math.max(lo, Math.min(hi, o.getComponent(a) + t)));
  if (SPLIT.cuts[splitDrag.k].point[a] === v) return;
  SPLIT.cuts[splitDrag.k].point[a] = v;
  const row = $$("#splitCuts .split-cut")[splitDrag.k];
  if (row) row.querySelectorAll("input").forEach((el) => { el.value = v; });
  if (!splitDrag.raf) splitDrag.raf = requestAnimationFrame(() => { if (splitDrag) splitDrag.raf = null; drawPrinter(); if (S.T) paint(S.T); });
}, true);
canvas.addEventListener("pointerup", (e) => {
  if (!splitDrag) return;
  e.stopImmediatePropagation();
  splitDrag = null; orbit.enabled = true;
  splitChanged();
}, true);
function renderSplit() {
  if (!S.scan) return;
  const v = printerVol(), d = modelDims(), over = overBy(d, v);
  $("#fitSum").textContent = over ? `${over} mm too big` : "fits";
  $("#fitLine").innerHTML = `${printerName()}: ${v.join(" × ")} mm. ` + (over
    ? `<span class="bad">The model (${d.map((x) => Math.round(x)).join(" × ")} mm) is ${over} mm too big for one print.</span> Press Suggest cuts.`
    : `<span class="ok">The model fits in one piece.</span>`);
  const c = S.scan.center, sz = (S.scan.size || S.scan.dims).map(Number), lv = splitLevels();
  $("#splitCuts").innerHTML = SPLIT.cuts.map((cut, k) => {
    if (cut.kind === "shape") return `<div class="split-cut shape" data-k="${k}"><span>Cut ${k + 1} · drawn ${SHAPE_NAMES[cut.shape] || "shape"}</span><button type="button" class="btn sm" title="Remove this cut">×</button></div>`;
    const a = cutAxis(cut), lo = Math.floor(c[a] - sz[a] / 2 - (a === 2 ? baseH() : 0)), hi = Math.ceil(c[a] + sz[a] / 2);
    const lab = cut.kind === "x" ? "upright, across" : cut.kind === "y" ? "upright, front-back" : "level";
    let scope = "";
    if (a !== 2 && (lv.length || (cut.within || []).length)) {
      const w = (cut.within || []).length, b = cut.band != null && lv.length ? +cut.band : null;
      const opts = [`<option value="all"${b == null && !w ? " selected" : ""}>Through the whole model</option>`,
        ...lv.concat([0]).map((_, j) => `<option value="${j}"${b === j && !w ? " selected" : ""}>Through the ${bandName(j, lv)} only</option>`)];
      if (w) opts.push(`<option value="w" selected>Through the ${b != null ? bandName(b, lv) : "model"}, ${cut.within.map(([q, s]) => sideName(q, s)).join(" and ")}</option>`);
      scope = `<select class="split-scope" title="Which part of the model this cut goes through">${opts.join("")}</select>`;
    }
    return `<div class="split-cut" data-k="${k}"><span>Cut ${k + 1} · ${lab}</span><input type="range" min="${lo}" max="${hi}" step="1" value="${cut.point[a]}"><input type="number" class="mono" step="1" value="${cut.point[a]}"><button type="button" class="btn sm" title="Remove this cut">×</button>${scope}</div>`;
  }).join("");
  renderSplitParts();
}
let splitT = null;
function splitChanged() {
  $("#splitSpread").value = 0; // the parts no longer match the cuts
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
  $("#splitParts").innerHTML = SPLIT.parts.map((p, k) => `<div><i class="sw" style="background:${pieceColor(k)}"></i> Part ${k + 1}: <span class="mono">${p.dims.map((x) => Math.round(x)).join(" × ")} mm</span> · <span class="${p.fits ? "ok" : "bad"}">${p.fits ? "fits" : `${p.over} mm too big`}</span>${Math.min(...p.dims) < 20 ? ` · <span class="bad">a thin sliver: move or remove a cut</span>` : ""}${p.file ? ` · ${p.file}` : ""}</div>`).join("");
  $("#splitGo").disabled = !SPLIT.cuts.length;
}
$("#splitCuts").addEventListener("input", (e) => {
  const row = e.target.closest(".split-cut"); if (!row) return;
  if (e.target.matches("select")) {
    const cut = SPLIT.cuts[+row.dataset.k], v = e.target.value;
    if (v === "w") return;
    delete cut.within;
    if (v === "all") delete cut.band; else cut.band = +v;
    renderSplit(); splitChanged();
    return;
  }
  const cut = SPLIT.cuts[+row.dataset.k], a = cutAxis(cut), val = +e.target.value;
  if (!Number.isFinite(val)) return;
  cut.point[a] = val;
  row.querySelectorAll("input").forEach((el) => { if (el !== e.target) el.value = val; });
  splitChanged();
});
$("#splitCuts").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const k = +b.closest(".split-cut").dataset.k;
  SPLIT.cuts.splice(k, 1);
  const nb = splitLevels().length;
  for (const c of SPLIT.cuts) {
    if (c.within) { c.within = c.within.filter(([w]) => w !== k).map(([w, s]) => [w > k ? w - 1 : w, s]); if (!c.within.length) delete c.within; }
    if (c.band != null) { if (!nb) delete c.band; else if (c.band > nb) c.band = nb; }
  }
  renderSplit(); splitChanged();
});
function addSplitCut(kind) {
  if (!S.scan) return;
  const c = S.scan.center.map((v) => Math.round(v));
  const normal = kind === "x" ? [1, 0, 0] : kind === "y" ? [0, 1, 0] : [0, 0, 1];
  const cut = { point: [kind === "x" ? c[0] : 0, kind === "y" ? c[1] : 0, kind === "level" ? c[2] : 0], normal, kind };
  const lv = splitLevels(), a = cutAxis(cut);
  if (a !== 2 && lv.length && latexMesh && latexTri) {
    // an upright cut goes through the widest level only, across its middle
    const C = splitCentroids(), ext = lv.concat([0]).map(() => [Infinity, -Infinity]);
    for (let i = 0; i < latexTri.n; i += 3) { const e = ext[bandOf(C[i * 3 + 2], lv)], v = C[i * 3 + a]; if (v < e[0]) e[0] = v; if (v > e[1]) e[1] = v; }
    let best = 0;
    ext.forEach((e, j) => { if (e[1] - e[0] > ext[best][1] - ext[best][0]) best = j; });
    cut.band = best;
  }
  if (a !== 2 && latexMesh && latexTri) {
    // in the middle of the widest gap between the cuts already there, so it doesn't leave a sliver
    const C = splitCentroids(), lv2 = splitLevels();
    let e0 = Infinity, e1 = -Infinity;
    for (let i = 0; i < latexTri.n; i += 3) { if (cut.band != null && bandOf(C[i * 3 + 2], lv2) !== cut.band) continue; const v = C[i * 3 + a]; if (v < e0) e0 = v; if (v > e1) e1 = v; }
    const at = SPLIT.cuts.filter((o) => cutAxis(o) === a && (o.band == null || cut.band == null || +o.band === cut.band)).map((o) => o.point[a]).filter((v) => v > e0 && v < e1);
    const edges = [e0, ...at.sort((x, y) => x - y), e1];
    let g = 0;
    for (let j = 1; j < edges.length - 1; j++) if (edges[j + 1] - edges[j] > edges[g + 1] - edges[g]) g = j;
    if (Number.isFinite(e0)) cut.point[a] = Math.round((edges[g] + edges[g + 1]) / 2);
  }
  SPLIT.cuts.push(cut);
  renderSplit(); splitChanged();
}
$("#splitAdd").onclick = () => addSplitCut("level");
$$("[data-draw]").forEach((b) => b.onclick = () => setDrawMode(b.dataset.draw));
$("#splitAddX").onclick = () => addSplitCut("x");
$("#splitAddY").onclick = () => addSplitCut("y");
$("#splitSuggest").onclick = () => withBusy("Finding cuts that fit your printer", async () => {
  const r = await api("/api/split_plan", { suggest: true });
  SPLIT.cuts = r.cuts; SPLIT.parts = r.parts; $("#splitSpread").value = 0; renderSplit(); drawPrinter();
  toast(r.cuts.length ? `${r.cuts.length} ${r.cuts.length === 1 ? "cut makes" : "cuts make"} ${r.parts.length} parts that ${r.parts.every((p) => p.fits) ? "all fit" : "mostly fit"} your printer. Move them if you like, then press Split and save parts.` : "The model fits your printer in one piece, so it doesn't need splitting.", true);
});
$("#splitGo").onclick = () => withBusy("Splitting the model", async () => {
  const r = await api("/api/split", { cuts: SPLIT.cuts, open: true });
  SPLIT.parts = r.parts; renderSplitParts(); drawSplitApart();
  const warn = [...r.no_room.map((k) => `cut ${k} has no room for a peg`), ...r.too_thin.map((k) => `cut ${k} is too thin for a peg`)];
  toast(`Saved ${r.parts.length} parts with ${r.pegs} ${r.pegs === 1 ? "peg" : "pegs"} in the scan's folder${warn.length ? ` (${warn.join(", ")})` : ""}. The folder is opening.`, !warn.length);
});
$("#showPrinter").onchange = () => drawPrinter();

function drawSizer() {
  const g = groups.sizer;
  if (S.scan) { if (SPLIT.for !== S.scan.name) { SPLIT.for = S.scan.name; SPLIT.cuts = []; SPLIT.parts = []; $("#splitSpread").value = 0; spoutReset(); seamReset(); webReset(); } renderSplit(); drawPrinter(); drawSpout(); drawSeamVis(); drawWebVis(); }
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
function drawSeamVis() { groups.seam.visible = !!(S.scan && S.step === "cut" && $("#tSeam").checked && !insViewOn()); }
$("#tSeam").onchange = () => drawSeamVis();
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

// ---- gap webs: thin sheets across see-through gaps, joined onto the model
var WEB = { picking: false, webs: [] }; // var: drawSizer may run before this line
let webT = null;
function renderWebs() {
  $("#webCards").innerHTML = WEB.webs.map((w, k) => `<div class="web-card" data-k="${k}">
    <div class="web-head"><span>Web ${k + 1}</span><span class="faint small">${w.err ? `<span class="bad">${w.err}</span>` : w.area ? `${w.area} cm²` : ""}</span><button type="button" class="x" title="Remove this web" aria-label="Remove web ${k + 1}">×</button></div>
    <label class="slider">Turn<input type="range" data-a="dAz" min="-45" max="45" step="1" value="${w.dAz}"><span class="mono">${w.dAz > 0 ? "+" : ""}${w.dAz}°</span></label>
    <label class="slider">Tilt<input type="range" data-a="dTilt" min="-45" max="45" step="1" value="${w.dTilt}"><span class="mono">${w.dTilt > 0 ? "+" : ""}${w.dTilt}°</span></label>
  </div>`).join("");
  $("#webAdd").disabled = $("#webClear").disabled = !WEB.webs.length;
  $("#webAdd").textContent = WEB.webs.length > 1 ? `Add ${WEB.webs.length} webs` : "Add web";
  $("#webSum").textContent = WEB.webs.length ? `${WEB.webs.length} placed` : "";
}
const webSpec = (w) => ({ point: w.point, az: w.az + w.dAz, tilt: Math.max(-80, Math.min(80, w.tilt + w.dTilt)) });
function drawWebVis() { groups.web.visible = !!(S.scan && curTab() === "scan" && S.step === "cut"); }
function updateWebs() {
  clearTimeout(webT);
  webT = setTimeout(async () => {
    if (!WEB.webs.length) { groups.web.clear(); return; }
    try {
      const r = await api("/api/web_preview", { webs: WEB.webs.map(webSpec) });
      r.webs.forEach((info, k) => { const w = WEB.webs[k]; if (!w) return; w.err = info.error || null; if (info.area) w.area = info.area; });
      renderWebs();
      groups.web.clear();
      if (r.url) {
        const g = await loadSTL(r.url);
        groups.web.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: "#5fc7d9", transparent: true, opacity: 0.85, roughness: 0.6, side: THREE.DoubleSide })));
      }
      drawWebVis();
    } catch (e) { if (/Still working/.test(e.message)) updateWebs(); else toast(e.message); }
  }, 350);
}
function webReset() { WEB.webs = []; WEB.picking = false; $("#webPick").classList.remove("on"); $("#webPick").textContent = "Click a gap"; groups.web.clear(); renderWebs(); }
const addWeb = (r) => WEB.webs.push({ point: r.point, az: r.az, tilt: r.tilt, area: r.area, dAz: 0, dTilt: 0, err: null });
canvas.addEventListener("pointerdown", (e) => {
  if (!WEB.picking || !latexMesh || e.button !== 0) return;
  e.stopImmediatePropagation(); e.preventDefault();
  setRay(e);
  // the point along the click's line that passes nearest the middle of the model: the gap is there
  const c = new V3(...S.scan.center), o = ray.ray.origin.clone(), d = ray.ray.direction.clone().normalize();
  const p = o.clone().add(d.clone().multiplyScalar(c.clone().sub(o).dot(d)));
  WEB.picking = false; $("#webPick").classList.remove("on"); $("#webPick").textContent = "Click a gap";
  withBusy("Finding the best angle for the gap", async () => {
    addWeb(await api("/api/web_click", { point: p.toArray(), look: d.toArray() }));
    renderWebs(); updateWebs();
  });
}, true);
$("#webPick").onclick = () => {
  WEB.picking = !WEB.picking;
  $("#webPick").classList.toggle("on", WEB.picking);
  $("#webPick").textContent = WEB.picking ? "Click in the gap…" : "Click a gap";
};
$("#webFind").onclick = () => withBusy("Looking for gaps", async () => {
  const r = await api("/api/web_find", {});
  const fresh = r.webs.filter((w) => !WEB.webs.some((x) => new V3(...x.point).distanceTo(new V3(...w.point)) < 10));
  if (!fresh.length) { toast(r.webs.length ? "No other gaps found." : "No closed-in gaps found. If there's a gap you can see through, turn the model to look through it and use Click a gap.", true); return; }
  fresh.forEach(addWeb); renderWebs(); updateWebs();
  toast(`Found ${fresh.length} gap${fresh.length > 1 ? "s" : ""}, shown in blue. Turn or tilt any of them, remove the ones you don't want, then Add.`, true);
}, true);
$("#webCards").addEventListener("input", (e) => {
  const card = e.target.closest(".web-card"); if (!card || !e.target.dataset.a) return;
  const w = WEB.webs[+card.dataset.k]; w[e.target.dataset.a] = +e.target.value;
  e.target.nextElementSibling.textContent = `${w[e.target.dataset.a] > 0 ? "+" : ""}${w[e.target.dataset.a]}°`;
  updateWebs();
});
$("#webCards").addEventListener("click", (e) => {
  const b = e.target.closest(".x"); if (!b) return;
  WEB.webs.splice(+b.closest(".web-card").dataset.k, 1); renderWebs(); updateWebs();
});
$("#webClear").onclick = () => webReset();
$("#webAdd").onclick = () => {
  if (WEB.webs.some((w) => w.err)) { toast("One of the webs can't be made at that angle. Turn it back, or remove it, then Add."); return; }
  const n = WEB.webs.length;
  withBusy(n > 1 ? `Joining ${n} gap webs onto the model` : "Joining the gap web onto the model", async () => {
    clearTimeout(webT); // no new preview; wait out one that's still running
    let info = null;
    for (let k = 0; ; k++) {
      try { info = await api("/api/prep", { op: "add_webs", value: { webs: WEB.webs.map(webSpec) } }); break; } catch (e) {
        if (!/Still working/.test(e.message) || k > 120) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    webReset(); await showScan(info, true); drawSizer();
    toast(`Joined ${n > 1 ? n + " gap webs" : "the gap web"} onto the model. Ctrl+Z takes ${n > 1 ? "them" : "it"} off again.`, true);
  }, true);
};
$("#web_t_mm").addEventListener("change", () => setTimeout(updateWebs, 500));

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
  if (S.T && (t === "scan" || was === "scan")) refresh({ keepHandle: true });
}
$$("#ptabs [data-tab]").forEach((b) => b.onclick = () => showTab(b.dataset.tab));
function paintTabs() {
  const d = S.scan ? modelDims() : null; // from the numbers, not the text (that may be in cm or inches)
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
  $("#toolhdr").hidden = step === "load"; $("#outliner").hidden = step === "load"; renderOutliner();
  if (step !== "cut") $("#hint").textContent = step === "done" ? "Scene list: the eye on a folder hides everything in it, the eye on a row just that part · Alt+H shows everything" : "Drop a scan on the view, or press Ctrl+O";
  else if (S.T) setMode(S.mode || "pieces");
  $("#rail").hidden = step !== "cut"; $("#viewTools").hidden = step !== "cut" && step !== "done"; $("#editTools").hidden = step !== "cut"; $("#toggles").hidden = step !== "cut"; $("#legend").hidden = step !== "cut"; $("#hud").hidden = step !== "cut";
  if (step !== "cut") { $("#keys").hidden = true; closeMenu(); }
  $("#labels").hidden = step !== "cut";
  $("#doneTools").hidden = step !== "done"; $("#spreadBox").hidden = step !== "done" || S.show === "plates";
  groups.latex.visible = step === "cut" || (step === "done" && S.show === "latex");
  drawSplitApart(); // the model's own pulled-apart parts show only on the Scan tab
  groups.slicePlan.visible = step === "cut" && $("#tSlices").checked;
  groups.pour.visible = step === "cut" && $("#tPour").checked;
  groups.insert.visible = step === "cut" && !!S.insert?.on;
  groups.pieces.visible = step === "done" && S.show !== "slices" && S.show !== "plates";
  groups.plates.visible = step === "done" && S.show === "plates";
  groups.slices.visible = step === "done" && (S.show === "slices" || (S.show === "latex" && !!S.build?.slices_only));
  if (step === "load") { groups.latex.visible = false; loadRecent(); }
  if (step === "cut" && S.T) refresh();
  else { detachHandle(); groups.planes.visible = groups.regions.visible = groups.arrows.visible = false; }
  const see = step === "done" && S.show === "latex" && !S.build?.slices_only;
  groups.pieces.children.forEach((m) => {
    const op = m.userData.op ?? 1, o = see ? Math.min(op, 0.32) : op;
    m.material.transparent = o < 1; m.material.opacity = o; m.material.depthWrite = o >= 1; m.material.needsUpdate = true;
  });
  if (latexMesh) { latexMesh.material.transparent = step === "done"; latexMesh.material.opacity = step === "done" ? 0.9 : 1; latexMesh.material.depthWrite = true; latexMesh.material.needsUpdate = true; }
  applyInsView();
}
$$(".step").forEach((b) => b.onclick = () => go(b.dataset.step));
$("#drop").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#fileInput").click(); } });
document.addEventListener("pointerdown", (e) => { const t = $("#toggles"); if (t.open && !t.contains(e.target)) t.open = false; }, true);
document.addEventListener("keydown", (e) => { const t = $("#toggles"); if (e.key === "Escape" && t.open) { t.open = false; t.querySelector("summary").focus(); } }, true);

// file in
async function takeFile(file) {
  if (!file) return;
  if (!/\.(stl|obj|ply|blend)$/i.test(file.name)) { toast("GnomeShell opens STL, OBJ, PLY and .blend files. Export the model as one of those and drag it in."); return; }
  let info = null;
  await openInTab(null, async () => (info = await api("/api/load", await file.arrayBuffer(), file.name)));
  const big = info ? Math.max(...info.dims) : 99;
  if (info && !info.grown && big < 30) {
    showTab("scan");
    toast(`This scan is only ${big} mm across. If it was saved in cm or inches, pick that under "Scan was saved in".`);
  }
}
$("#fileInput").onchange = (e) => takeFile(e.target.files[0]);
const view = $("#view");
["dragenter", "dragover"].forEach((t) => view.addEventListener(t, (e) => { e.preventDefault(); $("#drop").classList.add("over"); if (S.step !== "load") $("#drop").hidden = false; }));
["dragleave", "drop"].forEach((t) => view.addEventListener(t, (e) => { e.preventDefault(); $("#drop").classList.remove("over"); if (S.step !== "load") $("#drop").hidden = true; }));
view.addEventListener("drop", (e) => takeFile(e.dataTransfer.files[0]));

// a scan that came in only millimetres across gets scaled up on loading: say so
function grownNote(info) {
  showTab("scan");
  toast(`This scan came in only ${+(+info.grown.was).toPrecision(2)} mm across, so it was probably saved in meters or another unit. ` +
    `GnomeShell made it ${info.grown.factor}× bigger: it's now ${fmtDims(info.size || info.dims)} mm. If that isn't right, type the real size under Size.`, true);
}
async function openRecent(name) {
  await openInTab(name, () => api("/api/load_recent", { name }));
}
async function fileMenu() {
  const b = $("#fileMenu"), r = b.getBoundingClientRect();
  const list = (await api("/api/recent").catch(() => null)) || [];
  const here = S.scan && S.scan.name;
  const items = [{ label: "New tab", key: "Ctrl+T", act: () => newTab() }, { label: "Open scan…", key: "Ctrl+O", act: () => $("#fileInput").click() }];
  const recent = list.filter((x) => x.name !== here).slice(0, 8);
  if (recent.length) {
    items.push("-");
    recent.forEach((x) => items.push({ label: x.name, act: () => openRecent(x.name) }));
  }
  items.push("-", { label: "Show this scan's folder", disabled: !here, act: () => api("/api/open", { what: "folder", name: here }).catch((e) => toast(e.message)) });
  items.push({ label: "Close tab", key: "Ctrl+W", disabled: TABS.active == null, act: () => askCloseTab(TABS.active) });
  openMenu(r.left, r.bottom + 2, items);
  $("#ctx").classList.add("file-menu");
}
$("#fileMenu").onclick = async (e) => { e.stopPropagation(); if (!$("#ctx").hidden && $("#ctx").dataset.menu === "file") { closeMenu(); return; } await fileMenu(); $("#ctx").dataset.menu = "file"; };
addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") { e.preventDefault(); $("#fileInput").click(); }
});
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
    b.onclick = () => openRecent(r.name);
    box.appendChild(b);
  });
}

// ------------------------------------------------------------ phone scans
// Photos from the GnomeShell Scan phone app come in over Wi-Fi; the engine
// builds the 3D model from them (photoscan.py). This panel shows the code the
// app needs, the scans as they build, and opens a finished one like any scan.
let phoneSig = "";
async function loadPhone() {
  const r = await api("/api/phone").catch(() => null);
  if (!r) return;
  if (r.error && !r.code) { $("#phoneAddr").textContent = r.error; return; }
  $("#phoneCode").textContent = r.code.replace(/(\d{3})(\d{3})/, "$1 $2");
  $("#phoneAddr").textContent = r.error ? r.error : `The app finds this PC by itself on the same Wi-Fi. If it can't, type ${(r.addresses || []).map((a) => a + ":" + r.port).join(" or ") || "this PC's address"} into the app. If Windows asks whether Blender may use the network, choose Allow.`;
  const sel = $("#phoneDetail");
  if (!sel.options.length) Object.entries(r.details).forEach(([k, v]) => sel.add(new Option(v, k)));
  if (document.activeElement !== sel) sel.value = r.detail;
  const sig = JSON.stringify(r.scans);
  if (sig === phoneSig) return;
  phoneSig = sig;
  const box = $("#phoneScans");
  if (!r.scans.length) { box.innerHTML = '<p class="muted">No phone scans yet.</p>'; return; }
  box.innerHTML = "";
  r.scans.forEach((s) => {
    const d = document.createElement("div"); d.className = "pscan";
    d.innerHTML = '<div class="ps-top"><span class="strong"></span><span class="ps-when mono"></span></div><div class="ps-msg"></div><div class="ps-acts"></div>';
    d.querySelector(".strong").textContent = s.name || s.id;
    d.querySelector(".ps-when").textContent = `${s.photos || 0} photos · ${(s.created || "").slice(5, 16)}`;
    const msg = d.querySelector(".ps-msg");
    const st = s.state;
    msg.textContent = st === "receiving" ? "Photos coming in from the phone…"
      : st === "received" ? "All photos here. Press Build to make the 3D model."
      : st === "queued" ? "Waiting its turn…"
      : st === "building" ? `${s.message || "Building"} · ${s.percent || 0}%`
      : st === "done" ? (s.message || "Ready") + (s.seconds ? ` · took ${Math.max(1, Math.round(s.seconds / 60))} min` : "")
      : st === "failed" ? "Didn't build: " + (s.error || s.message || "")
      : st === "stopped" ? "Stopped." : (s.message || "");
    msg.classList.toggle("ok", st === "done"); msg.classList.toggle("bad", st === "failed");
    if (st === "building" || st === "queued") {
      const b = document.createElement("div"); b.className = "ps-bar"; b.innerHTML = "<i></i>";
      b.firstChild.style.width = (s.percent || 0) + "%"; d.insertBefore(b, d.querySelector(".ps-acts"));
    }
    const acts = d.querySelector(".ps-acts");
    const add = (label, primary, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn sm" + (primary ? " primary" : ""); b.textContent = label; b.onclick = fn; acts.appendChild(b); };
    if (s.has_model) add("Open in GnomeShell", true, () => openPhoneScan(s.id));
    if (st === "building" || st === "queued") add("Stop", false, () => api("/api/phone/stop", { id: s.id }).then(loadPhone).catch((e) => toast(e.message)));
    else if (st !== "receiving") add(s.has_model ? "Build again" : "Build 3D model", !s.has_model, () => api("/api/phone/build", { id: s.id }).then(() => { toast("Building the 3D model. It takes a while: you can keep using GnomeShell.", true); loadPhone(); }).catch((e) => toast(e.message)));
    add("Folder", false, () => api("/api/phone/folder", { id: s.id }).catch((e) => toast(e.message)));
    box.appendChild(d);
  });
}
async function openPhoneScan(id) {
  await openInTab(null, () => api("/api/phone/open", { id }));
}
$("#phoneNewCode").onclick = () => api("/api/phone/settings", { new_code: true }).then(() => { phoneSig = ""; loadPhone(); toast("New code made. Type it into the phone app.", true); }).catch((e) => toast(e.message));
$("#phoneDetail").onchange = (e) => api("/api/phone/settings", { detail: e.target.value }).catch((e2) => toast(e2.message));
setInterval(() => { if (S.step === "load" && !document.hidden) loadPhone(); }, 3000);

// ------------------------------------------------------------ build
function startBuild(slicesOnly) {
  if (!S.cuts.length || !S.T) { toast("Add at least one cut first."); return; }
  if (S.scan && !S.scan.watertight) { toast($("#scanWarnText").textContent); showTab("scan"); return; }
  const T = S.T;
  if (T.locked.length) { toast(`Pieces ${T.locked.map((i) => i + 1).join(", ")} can't come off as set. Change one of their arrows first.`); return; }
  if (!slicesOnly && insPokes()) return;
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
  // it goes in the engine's queue and builds in the background; buildFinished() shows it when it's done
  const tab = tabNow();
  api("/api/build", { cuts, pieces, frame: [T.frame.ex.toArray(), T.frame.ey.toArray()], settings: S.settings, slices_only: !!slicesOnly, insert: slicesOnly ? null : insSpec(), seam_cards: slicesOnly ? [] : SEAM.cards })
    .then((j) => {
      if (tab) { tab.job = j; tab.unseen = false; }
      renderTabs(); pollBuilds();
      if (j.place) toast(`${j.place === 1 ? "1 build is" : `${j.place} builds are`} ahead of this one. It starts by itself; you can keep working.`, true);
    })
    .catch((e) => toast(e.message));
}
$("#build").onclick = () => startBuild(false);
$("#buildSlices").onclick = () => startBuild(true);
$("#buildNow").onclick = () => { go("cut"); startBuild(false); };

async function showBuild(res) {
  groups.pieces.clear(); groups.slices.clear();
  let k = 0;
  // the insert's parts and the seam cards have their own colours; the silicone is see-through
  const look = { holder: ["#a77ce8", 1], cup: ["#c9b27a", 1], insert: ["#4f9be0", 0.55], pour: ["#4f9be0", 0.55], seam: ["#a28cf0", 1] };
  for (const p of res.previews) {
    const g = await loadSTL(p.url);
    const kind = p.kind || (p.test ? "test" : p.holder ? "holder" : "piece");
    const [col, op] = look[kind] || [null, 1];
    const mat = new THREE.MeshStandardMaterial({ color: kind === "test" ? COL.slice : col ? new THREE.Color(col) : new THREE.Color(pieceColor(k++)), roughness: 0.6, side: THREE.DoubleSide,
      transparent: op < 1, opacity: op, depthWrite: op >= 1 });
    const m = new THREE.Mesh(g, mat); m.userData.pull = new V3(...p.pull); m.userData.name = p.name; m.userData.kind = kind; m.userData.label = p.label; m.userData.op = op;
    if (op < 1) m.renderOrder = 2;
    (kind === "test" ? groups.slices : groups.pieces).add(m);
  }
  spread();
  drawPlates(res);
  const mb = (b) => b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB";
  const row = (f) => `<div><span></span><span class="mono">${mb(f.size)}</span></div>`;
  const put = (id, list) => { const el = $(id); el.innerHTML = list.map(row).join(""); [...el.children].forEach((d, i) => d.firstChild.textContent = list[i].name); el.previousElementSibling.hidden = el.hidden = !list.length; };
  const first = res.files.filter((f) => /TEST|test[_ ]slices/.test(f.name));
  const shell = res.files.filter((f) => /^SHELL_\d+[A-Z]?\.stl$|^shell\.3mf$|^plate \d+\.3mf$/.test(f.name));
  const forIns = res.files.filter((f) => /^(holder|insert_cup)\.| - seam card/.test(f.name));
  const other = res.files.filter((f) => !first.includes(f) && !shell.includes(f) && !forIns.includes(f));
  put("#filesFirst", first); put("#filesShell", shell); put("#filesInsert", forIns); put("#filesOther", other);
  const only = !!res.slices_only;
  $("#doneTools [data-show=shell]").hidden = only;
  $("#doneTools [data-show=plates]").hidden = !(res.plates || []).length;
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
    showFolder(res.folder);
    return;
  }
  $("#doneKv").innerHTML = `
    ` + (res.shell_style === "CONTOUR" ? `<dt>Shell</dt><dd>hugs the latex · ${d.join(" × ")} mm across</dd>
    <dt>Cord notches</dt><dd>${res.notches}</dd>
    <dt>Alignment bumps</dt><dd>${res.bumps || "none"}</dd>` : `<dt>Box</dt><dd>${d.join(" × ")} mm</dd>
    <dt>Bungee channels</dt><dd>${res.channels}${res.skipped_channels ? ` (${res.skipped_channels} skipped at a cut)` : ""}</dd>`) + `
    <dt>Fits your printer</dt><dd style="color:${res.fits_plate || (res.split_pieces || []).length ? "var(--ok)" : "#f08a70"}">${res.fits_plate ? "yes" : (res.split_pieces || []).length ? "each part does" : "no"}</dd>` + ((res.plates || []).length ? `
    <dt>Plates</dt><dd>${res.plates.length}${res.plates.filter((p) => p.kind !== "test").length > 1 ? ` · shell.3mf has every plate (one Bambu Studio project), and each is also saved on its own: ${res.plates.map((p) => p.file).join(", ")}` : " · shell.3mf"}</dd>` : "") + ((res.split_pieces || []).length ? `
    <dt>Split to fit</dt><dd>${res.split_pieces.every((s) => !s.pegs)
      ? `${res.split_pieces.map((s) => `${s.piece.replace("SHELL_", "piece ")} into ${s.parts}`).join(", ")}. Too thin for pegs: glue the parts together.`
      : res.split_pieces.map((s) => `${s.piece.replace("SHELL_", "piece ")} into ${s.parts}, ${s.pegs ? `${s.pegs} pegs` : "glue (too thin for pegs)"}`).join("; ")}</dd>` : "") + `
    <dt>Pour collar</dt><dd>${+S.settings.pour_extend_mm ? S.settings.pour_extend_mm + " mm" : "off"}</dd>` + (res.bits_joined || res.bits_own_piece ? `
    <dt>Stray bits</dt><dd>${[res.bits_joined ? `${res.bits_joined} joined onto the piece beside ${res.bits_joined === 1 ? "it" : "them"}` : "", res.bits_own_piece ? `${res.bits_own_piece} big enough to be ${res.bits_own_piece === 1 ? "a piece of its own" : "pieces of their own"}` : ""].filter(Boolean).join(", ")}</dd>` : "") + (res.insert ? `
    <dt>Thinnest concrete</dt><dd style="color:${res.insert.thinnest_mm >= (S.insert.least || 20) ? "var(--ok)" : "#f08a70"}">${res.insert.thinnest_mm} mm</dd>
    <dt>Silicone to mix</dt><dd>about ${res.insert.silicone_l} L</dd>
    <dt>Holder</dt><dd>${res.insert.holder_mm.join(" × ")} mm</dd>
    <dt>Air holes</dt><dd>${res.insert.air_holes === 1 ? "1 (core too narrow for 3)" : res.insert.air_holes}</dd>
    <dt>Insert mold</dt><dd>${res.insert.cup_mm.join(" × ")} mm${res.insert.taper ? `, ${res.insert.taper}° taper` : ""}</dd>` : "") + (res.seam_cards ? `
    <dt>Seam cards</dt><dd>${res.seam_cards}, on the plate${(res.plates || []).filter((p) => p.kind !== "test").length > 1 ? "s" : ""}</dd>` : "");
  const ord = (res.order || []).filter((o) => o.order);
  const steps = [...new Set(ord.map((o) => o.order))].sort((a, b) => a - b);
  $("#doneOrder").innerHTML = ord.length && steps.length > 1 ? `<h2>Take them off in this order</h2><div class="order">${steps.map((s) =>
    `<div><span class="chip">${ordinal(s)}</span><span>${ord.filter((o) => o.order === s).map((o) => o.name.replace("SHELL_", "Piece ")).join(", ")}</span></div>`).join("")}</div>` :
    ord.length ? '<p class="muted small">The pieces can come off in any order.</p>' : "";
  showFolder(res.folder);
  renderOutliner();
}
function showFolder(path) {
  const el = $("#donePath"), name = String(path || "").split(/[\\/]/).filter(Boolean).pop() || "";
  el.textContent = name ? `Saved in the folder "${name}"` : ""; el.title = path || "";
}
// every printed piece on printer plates, side by side, as the engine laid them out
function textSprite(text, h, color = "#c9cdd1", bg = null) {
  const c = document.createElement("canvas"), x = c.getContext("2d");
  x.font = "500 64px Inter, sans-serif";
  c.width = Math.max(88, Math.ceil(x.measureText(text).width) + (bg ? 48 : 24)); c.height = 88;
  if (bg) { x.fillStyle = bg; x.beginPath(); x.roundRect(2, 2, c.width - 4, c.height - 4, 40); x.fill(); }
  x.font = "500 64px Inter, sans-serif"; x.fillStyle = color; x.textBaseline = "middle"; x.textAlign = "center"; x.fillText(text, c.width / 2, 46);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  s.scale.set(h * c.width / c.height, h, 1); s.renderOrder = 20;
  return s;
}
function drawPlates(res) {
  dispose(groups.plates); groups.plates.clear();
  const plates = res.plates || [];
  if (!plates.length) return;
  const [W, D] = res.plate_bed, gap = Math.max(40, W * 0.18);
  const byName = new Map([...groups.pieces.children, ...groups.slices.children].map((m) => [m.userData.name, m]));
  let shellNo = 0;
  plates.forEach((pl, k) => {
    // several plates go in rows, so each stays big enough to see
    const cols = Math.ceil(Math.sqrt(plates.length)), g = new THREE.Group();
    g.position.x = (k % cols) * (W + gap); g.position.y = -Math.floor(k / cols) * (D + gap * 1.5);
    const bed = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshBasicMaterial({ color: "#2a3035", side: THREE.DoubleSide }));
    bed.position.set(W / 2, D / 2, -0.3);
    const edge = new THREE.LineSegments(lineGeometry([new V3(0, 0, 0), new V3(W, 0, 0), new V3(W, 0, 0), new V3(W, D, 0), new V3(W, D, 0), new V3(0, D, 0), new V3(0, D, 0), new V3(0, 0, 0)]),
      new THREE.LineBasicMaterial({ color: "#5d666e" }));
    const big = pl.items.some((it) => it.too_big), n = pl.items.filter((it) => !it.ghost).length;
    const nShell = plates.filter((p) => p.kind !== "test").length, nTest = plates.length - nShell;
    const title = pl.kind === "test" ? `Test slices${nTest > 1 ? ` ${k + 1 - nShell}` : ""}` : `Plate ${++shellNo}`;
    const label = textSprite(`${title} · ${n} ${n === 1 ? "part" : "parts"}${big ? " · too big" : ""}`, Math.max(10, W * 0.06));
    label.position.set(W / 2, -Math.max(14, W * 0.07), 0);
    g.add(bed, edge, label);
    for (const it of pl.items) {
      const src = byName.get(it.name); if (!src) continue;
      const m = new THREE.Mesh(src.geometry, it.too_big ? new THREE.MeshStandardMaterial({ color: COL.bad, roughness: 0.6, side: THREE.DoubleSide }) : src.material);
      m.matrixAutoUpdate = false; m.matrix.set(...it.matrix); m.userData.name = it.name;
      if (it.ghost) m.renderOrder = 2;
      g.add(m);
      if (it.ghost) continue; // the poured silicone, in its mold: not printed, so no tag of its own
      if (!src.geometry.boundingBox) src.geometry.computeBoundingBox();
      const bb = src.geometry.boundingBox.clone().applyMatrix4(m.matrix), c = bb.getCenter(new V3()), h = Math.max(8, W * 0.045);
      const text = (it.label || it.name.replace("SHELL_", "")) + (pl.items.some((o) => o.ghost && it.name === "CUP") ? " (silicone shown poured)" : "");
      const tag = textSprite(text, h, "#e9ecef", "rgba(22,24,26,0.78)");
      tag.position.set(c.x, c.y, bb.max.z + h * 0.8);
      g.add(tag);
    }
    groups.plates.add(g);
  });
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
function framePlates() {
  const b = new THREE.Box3().setFromObject(groups.plates); if (b.isEmpty()) return;
  const c = b.getCenter(new V3()), s = b.getSize(new V3());
  // far enough back that every plate and the tallest piece are in view
  const fit = Math.max(s.x / camera.aspect, s.y + s.z * 0.6) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  camera.position.copy(c).add(new V3(0, -0.4, 1).normalize().multiplyScalar(fit * 1.35));
  orbit.target.copy(c); orbit.update();
}
function setShow(v) { S.show = v; $$("#doneTools button").forEach((x) => x.classList.toggle("on", x.dataset.show === v)); }
$$("#doneTools [data-show]").forEach((b) => b.onclick = () => {
  setShow(b.dataset.show); go("done"); spread();
  if (b.dataset.show === "slices") frameGroup(groups.slices);
  else if (b.dataset.show === "plates") { groups.plates.visible = true; framePlates(); }
  else viewFrom("fit");
});
$("#openBambu").onclick = () => api("/api/open", { what: "bambu", name: S.build?.name || S.scan?.name }).catch((e) => toast(e.message));
$("#openSlices").onclick = () => api("/api/open", { what: "slices", name: S.build?.name || S.scan?.name }).catch((e) => toast(e.message));
$("#openFolder").onclick = () => api("/api/open", { what: "folder", name: S.build?.name || S.scan?.name }).catch((e) => toast(e.message));
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
// a card at the bottom: Update or Ignore (ignoring skips that version; the next one asks again)
async function checkUpdate() {
  try {
    const u = await api("/api/update_check", {});
    if (!u.newer) return;
    let skipped = null; try { skipped = localStorage.getItem("gs.skipUpdate"); } catch (e) { /* none */ }
    if (skipped === u.latest) return;
    $("#updatePop").dataset.v = u.latest;
    $("#updTitle").textContent = `GnomeShell ${u.latest} is ready to install`;
    const notes = $("#updNotes"); notes.textContent = "";
    (u.notes || "").split("\n").map((l) => l.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean).slice(0, 5)
      .forEach((l) => { const d = document.createElement("div"); d.textContent = l; notes.appendChild(d); });
    $("#updatePop").hidden = false;
  } catch (e) { /* offline: no update shown */ }
}
$("#updIgnore").onclick = () => {
  try { localStorage.setItem("gs.skipUpdate", $("#updatePop").dataset.v); } catch (e) { /* not kept */ }
  $("#updatePop").hidden = true;
};
$("#updGo").onclick = () => {
  const v = $("#updatePop").dataset.v;
  $("#updatePop").hidden = true;
  withBusy(`Updating GnomeShell to ${v}`, async () => {
    UPDATING = true;
    try { await api("/api/update_install", {}); } catch (e) { UPDATING = false; throw e; }
    $("#busySub").textContent = "Restarting with the new version…";
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const j = await (await fetch("/api/ping")).json();
        if (j.version === v) { location.reload(); return; }
        if (j.restart_error) break;
      } catch (e) { /* still restarting */ }
    }
    UPDATING = false;
    throw new Error(`GnomeShell ${v} is installed, but it couldn't restart by itself. Close this window and open GnomeShell again from its shortcut.`);
  });
};
addEventListener("pagehide", () => navigator.sendBeacon("/api/bye", ""));

// ------------------------------------------------------------ scan tabs
// Each open scan has a tab, like a browser's. The engine works on one scan at a
// time, so switching tabs opens that scan again (its cuts come back from the
// layout kept as you go) and puts back what the window showed: the step, the
// side panel tab, the view, the build, and the seam cards, printer cuts, gap
// webs and base you were trying. Builds wait their turn in the engine's queue
// and run in the background, so you can keep working in another tab.
const TABS = { list: [], active: null, seq: 1, saveT: null, poll: null };
function tabNow() { return TABS.list.find((t) => t.key === TABS.active) || null; }
function tabMake(name) { return { key: TABS.seq++, name: name || null, ui: null, job: null, unseen: false }; }
function tabsSaveSoon() {
  clearTimeout(TABS.saveT);
  TABS.saveT = setTimeout(() => {
    const names = TABS.list.filter((t) => t.name).map((t) => t.name);
    api("/api/tabs", { tabs: names, active: tabNow()?.name || null }).catch(() => {});
  }, 300);
}
function renderTabs() {
  const box = $("#tabs"); box.innerHTML = "";
  for (const t of TABS.list) {
    const el = document.createElement("div");
    el.className = "tab" + (t.key === TABS.active ? " on" : ""); el.setAttribute("role", "tab"); el.tabIndex = t.key === TABS.active ? 0 : -1;
    el.setAttribute("aria-selected", String(t.key === TABS.active)); el.dataset.key = t.key;
    const st = t.job ? t.job.state : null;
    const dot = st === "running" ? "running" : st === "queued" ? "queued" : st === "failed" && t.unseen ? "failed" : st === "done" && t.unseen ? "done" : "";
    el.innerHTML = `${dot ? `<span class="tdot ${dot}" aria-hidden="true"></span>` : ""}<span class="tname"></span><button type="button" class="tx" aria-label="Close tab" title="Close tab (Ctrl+W)">✕</button>`;
    el.querySelector(".tname").textContent = t.name || "New tab";
    el.title = (t.name || "New tab") + (st === "running" ? ` · building: ${t.job.progress || ""}` : st === "queued" ? " · waiting to build" :
      st === "done" && t.unseen ? " · built" : st === "failed" && t.unseen ? " · the build didn't finish" : "");
    el.onclick = (e) => { if (!e.target.closest(".tx")) switchTab(t.key); };
    el.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); askCloseTab(t.key); } }; // middle click closes, as in a browser
    el.querySelector(".tx").onclick = (e) => { e.stopPropagation(); askCloseTab(t.key); };
    el.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); stepTab(e.key === "ArrowRight" ? 1 : -1); }
      if (e.key === "Delete") { e.preventDefault(); askCloseTab(t.key); }
    });
    box.appendChild(el);
  }
  box.querySelector(".tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  buildBar();
}
// what the window shows for the scan open now, to put back when you come back to its tab
function stashTab() {
  const t = tabNow();
  if (!t || !t.name || !S.scan || S.scan.name !== t.name) return;
  t.ui = {
    step: S.step, side: curTab(), show: S.show, build: S.build,
    cam: [camera.position.toArray(), orbit.target.toArray()],
    unit: unitScale, seam: JSON.parse(JSON.stringify(SEAM.cards)), split: JSON.parse(JSON.stringify(SPLIT.cuts)), webs: JSON.parse(JSON.stringify(WEB.webs)),
    base: { h: $("#baseH").value, f: $("#baseF").value, m: $("#baseM").value, r: $("#baseR").value, w: $("#baseW").value, shape: baseShape(), reachSet },
  };
}
async function saveLayoutNow() { // the cuts, saved before the engine moves to another scan
  clearTimeout(autoT);
  if (!S.scan || !S.T) return;
  const L = layoutNow(), key = JSON.stringify([L.cuts, L.joins, L.pulls, L.insert, L.slice_at]);
  if (key === autoLast) return;
  autoLast = key;
  await api("/api/layouts", { op: "auto", layout: L }).catch(() => {});
}
async function unstashTab(t, info) {
  const u = t.ui;
  drawSizer(); // a different scan: clears the last one's seam cards, printer cuts and webs
  if (u) {
    unitScale = u.unit || 1; $$("[data-scale]").forEach((x) => x.classList.toggle("on", +x.dataset.scale === unitScale));
    SPLIT.cuts = u.split || []; SPLIT.parts = []; renderSplit();
    SEAM.cards = u.seam || []; renderSeam(); updateSeam();
    WEB.webs = u.webs || []; renderWebs(); if (WEB.webs.length) updateWebs();
    const b = u.base || {};
    $("#baseF").value = b.f ?? $("#baseF").value; $("#baseM").value = b.m ?? $("#baseM").value; $("#baseW").value = b.w ?? $("#baseW").value;
    $$("#baseShape [data-bshape]").forEach((x) => x.classList.toggle("on", x.dataset.bshape === (b.shape || "outline")));
    reachSet = !!b.reachSet; $("#baseR").value = b.r ?? 0;
    if (+b.h) { $("#baseH").value = b.h; baseLabels(); updateBase(); }
    if (u.side) showTab(u.side);
  } else {
    unitScale = 1; $$("[data-scale]").forEach((x) => x.classList.toggle("on", x.dataset.scale === "1"));
  }
  drawSizer();
  // a build that finished while you were away shows first
  const fresh = t.unseen && t.job && t.job.state === "done" ? t.job.result : null;
  const res = fresh || (u && u.build) || null;
  if (res) { S.build = res; setShow(fresh ? (res.slices_only ? "latex" : "shell") : u.show || "shell"); await showBuild(res); }
  const step = fresh ? "done" : u && u.step !== "load" && !(u.step === "done" && !res) ? u.step : "cut";
  go(step);
  if (u && !fresh) { camera.position.fromArray(u.cam[0]); orbit.target.fromArray(u.cam[1]); orbit.update(); }
  else viewFrom("fit");
  if (t.unseen && t.job && t.job.state === "failed") toast(`The last build of ${t.name} didn't finish: ${t.job.error}`);
  t.unseen = false;
}
function showBlank() { // a new tab: the Load scan screen
  S.scan = null; S.build = null; S.T = null; groups.pieces.clear(); groups.slices.clear(); groups.latex.clear(); latexMesh = null;
  $("#fileName").textContent = ""; $("#fileMeta").textContent = "Open a scan in this tab"; $("#fileMeta").classList.remove("bad");
  go("load");
}
async function switchTab(key) {
  if (busyNow() || key === TABS.active) return;
  const to = TABS.list.find((t) => t.key === key);
  if (!to) return;
  stashTab(); await saveLayoutNow();
  const from = TABS.active;
  TABS.active = key; renderTabs(); tabsSaveSoon();
  if (!to.name) { showBlank(); return; }
  let ok = false;
  await withBusy(`Opening ${to.name}`, async () => {
    const info = await api("/api/load_recent", { name: to.name });
    S.build = null; groups.pieces.clear(); groups.slices.clear();
    go("cut"); await showScan(info, false, true, true);
    await unstashTab(to, info);
    ok = true;
  });
  if (!ok) {
    if (TABS.list.some((t) => t.key === from)) { TABS.active = from; tabsSaveSoon(); } // the engine still has the last scan
    else showBlank();
  }
  renderTabs();
  return ok;
}
function stepTab(d) {
  if (TABS.list.length < 2) return;
  const i = TABS.list.findIndex((t) => t.key === TABS.active);
  switchTab(TABS.list[(i + d + TABS.list.length) % TABS.list.length].key);
}
async function newTab() {
  if (busyNow()) return;
  const blank = TABS.list.find((t) => !t.name);
  if (blank) { await switchTab(blank.key); return; }
  stashTab(); await saveLayoutNow();
  const i = TABS.list.findIndex((t) => t.key === TABS.active);
  const t = tabMake(null); TABS.list.splice(i + 1, 0, t);
  TABS.active = t.key; renderTabs(); showBlank();
}
// Opening a scan: into this tab if it's a new one, its own tab if it's already
// open, or else a new tab beside this one. load() asks the engine for it.
async function openInTab(name, load, title = "Loading scan") {
  if (busyNow()) return;
  const open = name && TABS.list.find((t) => t.name === name);
  if (open) { if (open.key !== TABS.active) await switchTab(open.key); return; }
  const from = tabNow();
  stashTab(); await saveLayoutNow();
  let t = from && !from.name ? from : null;
  const made = !t;
  if (made) { t = tabMake(null); TABS.list.splice(TABS.list.indexOf(from) + 1, 0, t); TABS.active = t.key; renderTabs(); }
  let ok = false;
  await withBusy(title, async () => {
    const info = await load();
    unitScale = 1; $$("[data-scale]").forEach((x) => x.classList.toggle("on", x.dataset.scale === "1"));
    S.build = null; groups.pieces.clear(); groups.slices.clear();
    const dup = TABS.list.find((x) => x !== t && x.name === info.name); // the same scan loaded again from its file
    if (dup) TABS.list.splice(TABS.list.indexOf(dup), 1);
    t.name = info.name; t.ui = null; t.unseen = false; t.job = null;
    go("cut"); await showScan(info, false, true); viewFrom("fit");
    if (info.grown) grownNote(info);
    ok = true;
    return info;
  });
  if (!ok && made) { TABS.list.splice(TABS.list.indexOf(t), 1); TABS.active = from ? from.key : null; }
  renderTabs(); tabsSaveSoon(); pollBuilds();
  return ok;
}
// closing asks first; the scan itself, its cuts and its files stay on disk
function askCloseTab(key) {
  if (busyNow() || !$("#closeAsk").hidden) return;
  const t = TABS.list.find((x) => x.key === key);
  if (!t) return;
  const st = t.job?.state;
  $("#closeAskTitle").textContent = `Close ${t.name || "this new tab"}?`;
  $("#closeAskText").textContent = !t.name ? "Nothing is open in it." :
    st === "running" ? "It's building right now. The build carries on and its files are saved in the scan's folder, but you won't see it here. Your cuts are saved, and it's under Recent scans to open again." :
    st === "queued" ? "It's waiting to build. Closing it takes it out of the queue. Your cuts are saved, and it's under Recent scans to open again." :
    "Your cuts are saved, and it's under Recent scans (and the File menu) to open again.";
  $("#closeAsk").hidden = false; $("#closeAskYes").focus();
  $("#closeAskYes").onclick = () => { $("#closeAsk").hidden = true; closeTab(key); };
}
$("#closeAskNo").onclick = () => { $("#closeAsk").hidden = true; };
$("#closeAsk").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); $("#closeAsk").hidden = true; }
  if (e.key === "Tab") { e.preventDefault(); (document.activeElement === $("#closeAskYes") ? $("#closeAskNo") : $("#closeAskYes")).focus(); }
});
$("#closeAsk").addEventListener("pointerdown", (e) => { if (e.target === $("#closeAsk")) $("#closeAsk").hidden = true; });
async function closeTab(key) {
  const i = TABS.list.findIndex((t) => t.key === key);
  if (i < 0) return;
  const t = TABS.list[i];
  if (t.job && t.job.state === "queued") api("/api/build_cancel", { id: t.job.id }).catch(() => {});
  const wasActive = key === TABS.active;
  if (wasActive) await saveLayoutNow();
  TABS.list.splice(i, 1);
  if (!wasActive) { renderTabs(); tabsSaveSoon(); return; }
  const next = TABS.list[i] || TABS.list[i - 1];
  if (!next) { const b = tabMake(null); TABS.list.push(b); TABS.active = b.key; renderTabs(); tabsSaveSoon(); showBlank(); return; }
  TABS.active = null; // nothing to keep from the closed one
  await switchTab(next.key);
  tabsSaveSoon();
}
$("#tabNew").onclick = () => newTab();
// keys: Ctrl+W close, Ctrl+T new, Ctrl+Tab / Ctrl+Shift+Tab (and Ctrl+PageDown / PageUp) next and back
addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "w") { e.preventDefault(); if (TABS.active != null) askCloseTab(TABS.active); }
  else if (k === "t" && !e.shiftKey) { e.preventDefault(); newTab(); }
  else if (k === "tab") { e.preventDefault(); stepTab(e.shiftKey ? -1 : 1); }
  else if (k === "pagedown" || k === "pageup") { e.preventDefault(); stepTab(k === "pagedown" ? 1 : -1); }
}, true);

// ---- the build queue, as each tab sees it
function buildBar() {
  const t = tabNow(), j = t && t.job, st = j && j.state;
  const on = st === "running" || st === "queued";
  $("#buildBar").hidden = !on;
  if (!on) return;
  const what = j.slices_only ? "test slices" : "shell";
  $("#buildBar").classList.toggle("queued", st === "queued");
  $("#bbTitle").textContent = st === "running" ? (j.slices_only ? "Cutting the test slices…" : "Building the shell…") :
    `Waiting to build the ${what}: ${j.place === 1 ? "1 build" : `${j.place} builds`} ahead`;
  $("#bbSub").textContent = st === "running" ? (j.progress || "") + " · you can keep working, or open another tab" : "It starts by itself when the one before it is done.";
  $("#bbStop").textContent = st === "running" ? "Stop" : "Take it out";
  $("#bbStop").onclick = () => api("/api/build_cancel", { id: j.id }).then(pollBuilds).catch((e) => toast(e.message));
}
let buildsBusy = false, buildsAgain = false;
async function pollBuilds() {
  if (buildsBusy) { buildsAgain = true; return; }
  buildsBusy = true; buildsAgain = false;
  try {
    const list = await api("/api/builds");
    for (const t of TABS.list) {
      if (!t.name) continue;
      const j = list.filter((x) => x.name === t.name).pop() || null;
      const was = t.job && t.job.state;
      if (!j || !t.job || j.id !== t.job.id || j.state !== was || j.progress !== t.job.progress || j.place !== t.job.place) {
        const finished = (was === "running" || was === "queued") && j && j.id === t.job?.id && (j.state === "done" || j.state === "failed");
        t.job = j;
        if (finished) await buildFinished(t);
      }
    }
    renderTabs();
  } catch (e) { /* engine busy or gone: try again next time */ } finally { buildsBusy = false; }
  clearTimeout(TABS.poll);
  const waiting = TABS.list.some((t) => t.job && (t.job.state === "running" || t.job.state === "queued"));
  TABS.poll = setTimeout(pollBuilds, waiting || buildsAgain ? (buildsAgain ? 0 : 1000) : 5000);
}
async function buildFinished(t) {
  const j = t.job, here = t.key === TABS.active && S.scan && S.scan.name === t.name && !busyNow();
  if (j.state === "failed") {
    if (here) toast(j.error); else { t.unseen = true; toast(`${t.name}: the build didn't finish. ${j.error}`); }
    return;
  }
  if (!here) { t.unseen = true; toast(`${t.name} is ${j.slices_only ? "sliced" : "built"}. Its tab has it.`, true); return; }
  S.build = j.result; setShow(j.result.slices_only ? "latex" : "shell"); await showBuild(j.result); go("done"); viewFrom("fit");
}
// the tabs you had open come back when GnomeShell starts
async function startTabs() {
  let saved = null;
  try { saved = await api("/api/tabs"); } catch (e) { /* none */ }
  const names = (saved && saved.tabs) || [];
  TABS.list = names.map((n) => tabMake(n));
  if (!TABS.list.length) TABS.list.push(tabMake(null));
  const first = TABS.list.find((t) => t.name === saved?.active) || TABS.list[0];
  if (!first.name) { TABS.active = first.key; renderTabs(); pollBuilds(); return; }
  TABS.active = null; renderTabs();
  await switchTab(first.key);
  pollBuilds();
}

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
  fillSettings(); loadRecent(); loadPhone();
  await startTabs();
})();

// ------------------------------------------------------------ silicone insert
// A hollow silicone insert hangs in the latex from the shell's open face, on a
// printed holder that twist-locks into the shell's corners. The numbers match
// the engine's insert.py, so what's shown here is what gets built.
const INS = { arm_w: 14, arm_t: 6, frame_w: 10, hub_lip: 5, foot_r: 10, post_r: 6, fit: 0.4, flare: 1.5, squeeze: 0.1, tab_len: 10, tab_w: 12, groove_w: 6, peg_inset: 12, slot_margin: 3, taper_deg: 1, least_floor: 3, lip: 4, play: 0.3, air_n: 3, air_d: 4 };
const insDefaults = () => ({ on: false, shape: "round", w: 90, d: 70, h: 120, wall: 3, round: 6, least: 20, taper: 0, peg_d: 20, cup_wall: 0.56, arm_w: 14, frame_w: 10, arm_t: 6, cx: null, cy: null, keep: true });
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
// the outline grown by `by`, then brought in by `inset` (the taper, toward the
// far end); always the same number of points for the same `by`, so rings at
// different depths join up (the engine's ring())
function insRing(s, by, inset = 0) {
  const w = s.w + 2 * (by - inset), d = insD(s) + 2 * (by - inset);
  if (s.shape === "square" || s.shape === "rect") { const r0 = s.round + by; return insOutline(s.shape, w, d, r0 >= 0.05 ? Math.max(r0 - inset, 0.06) : 0); }
  return insOutline(s.shape, w, d, 0);
}
const slopeOf = (deg) => Math.tan((+deg || 0) * Math.PI / 180);
const polyArea = (pts) => Math.abs(pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;

// The pegs' size from the head's diameter (the engine's spec_from does the same)
function insPegSize(s) {
  const d = Math.min(30, Math.max(10, +s.peg_d || 20)), r = d / 2;
  INS.foot_r = r; INS.post_r = +(r * 0.6).toFixed(2); INS.flare = Math.min(1.5, 0.15 * r); INS.peg_inset = r + 2;
  // the holder's arms (from the hub to the corners), the frame between the corners, and how thick they all are
  INS.arm_w = clamp(+s.arm_w || 14, 4, 40); INS.frame_w = clamp(+s.frame_w || 10, 4, 40); INS.arm_t = clamp(+s.arm_t || 6, 3, 20);
}
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
// The pegs at the box's four corners, and how much shell each slot keeps
// between it and the latex. Worked out once per shell box and peg size.
let pegCache = null;
function insPegsClear(T) {
  const [x0, y0] = T.boxLo, [x1, y1] = T.boxHi, key = [x0, y0, x1, y1, T.boxLo[2], INS.foot_r].map((v) => v.toFixed(2)).join(",");
  if (pegCache && pegCache.key === key && pegCache.tri === latexTri) return pegCache.L;
  const def = insPegs(x0, y0, x1, y1), bc = [(x0 + x1) / 2, (y0 + y1) / 2];
  const L = { ...def, Rs: [def.R, def.R, def.R, def.R], rooms: def.spots.map((sp) => insSlotRoom(T, bc, sp, def.R, def.theta)), moved: [], shifted: false };
  pegCache = { key, tri: latexTri, L };
  return L;
}
// The biggest pegs (20 mm heads down to 10) whose slots all keep 3 mm of shell to the latex
function insFitPegs(T) {
  for (let d = 20; d >= 10; d--) {
    S.insert.peg_d = d;
    const L = insLayout(S.insert, T);
    if (!L.rooms || Math.min(...L.rooms) >= 3) return d;
  }
  return null;
}
function insLayout(s, T) {
  insPegSize(s);
  const [x0, y0, z0] = T.boxLo, [x1, y1] = T.boxHi;
  const bc = [(x0 + x1) / 2, (y0 + y1) / 2];
  // the centre is kept in scan x, y so it stays put if the cuts turn the box
  const c = s.cx == null ? bc : [T.frame.ex.x * s.cx + T.frame.ex.y * s.cy, T.frame.ey.x * s.cx + T.frame.ey.y * s.cy];
  const P = latexTri ? insPegsClear(T) : { ...insPegs(x0, y0, x1, y1), rooms: null, moved: [], shifted: false };
  const { pegs, R, theta } = P, Rs = P.Rs || [R, R, R, R];
  const coreH = s.h - s.wall, innerMin = Math.min(s.w, insD(s)) - 2 * s.wall;
  // the outside comes in by the taper toward the far end; the core by at least 1°, so the holder slides out
  const outIn = slopeOf(s.taper) * s.h, coreIn = slopeOf(Math.max(+s.taper || 0, INS.taper_deg)) * coreH;
  const taper = Math.max(0.05, (innerMin - 2 * coreIn) / innerMin);
  return { z0, bc, c, pegs, R, Rs, theta, coreH, taper, outIn, coreIn, innerMin, rooms: P.rooms, moved: P.moved, spots: P.shifted ? P.spots : null };
}
function insSiliconeL(s, L) {
  const loft = (by, inset, h) => h / 6 * (polyArea(insRing(s, by)) + 4 * polyArea(insRing(s, by, inset / 2)) + polyArea(insRing(s, by, inset)));
  return (loft(0, L.outIn, s.h) - loft(-s.wall, L.coreIn, L.coreH)) / 1e6;
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
function insEven(ring, n) { // n points evenly round an outline
  const segs = ring.map((p, i) => [p, ring[(i + 1) % ring.length]]);
  const lens = segs.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1])), per = lens.reduce((a, b) => a + b, 0), even = [];
  for (let k = 0; k < n; k++) {
    let t = per * k / n;
    for (let i = 0; i < segs.length; i++) { if (t <= lens[i]) { const u = lens[i] ? t / lens[i] : 0, [a, b] = segs[i]; even.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]); break; } t -= lens[i]; }
  }
  return even;
}
function insSamples(s, L, step = 5) {
  const base = insGrown(s, 0), per = base.reduce((a, p, i) => a + Math.hypot(base[(i + 1) % base.length][0] - p[0], base[(i + 1) % base.length][1] - p[1]), 0);
  const nR = Math.max(24, per / step | 0), slope = L.outIn / s.h;
  const pts = [], nz = Math.max(2, s.h / step | 0);
  for (let i = 0; i <= nz; i++) { const dz = s.h * i / nz; for (const [x, y] of insEven(insRing(s, 0, slope * dz), nR)) pts.push([L.c[0] + x, L.c[1] + y, L.z0 + dz]); }
  const far = insEven(insRing(s, 0, L.outIn), nR);
  for (const f of [0.75, 0.5, 0.25, 0]) for (const [x, y] of far.filter((_, i) => i % Math.max(1, Math.round(2 / Math.max(f, 0.25))) === 0)) pts.push([L.c[0] + x * f, L.c[1] + y * f, L.z0 + s.h]);
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
const insValid = (s) => Math.min(s.w, insD(s)) - 2 * s.wall >= 10 && s.h - s.wall >= 10 &&
  Math.min(s.w, insD(s)) - 2 * s.wall - 2 * slopeOf(Math.max(+s.taper || 0, INS.taper_deg)) * (s.h - s.wall) >= 6;
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
  // a rectangle or oval takes the opening's own shape: width and depth fitted on their own
  if (S.insert.shape === "rect" || S.insert.shape === "oval") return insFitFree(T);
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
function insFitFree(T) {
  const base = { ...S.insert }, L0 = insLayout(base, T), least = base.least;
  const good = (s) => insValid(s) && insThinnest(s, T, 0, least).d >= least && insThinnest(s, T, -L0.theta, 0).d >= 0;
  const m = Math.ceil(2 * base.wall + 10.5);
  const s = { ...base, w: m, d: m, h: base.wall + 10.5 };
  if (!good(s)) { S.insertFitFail = { w: m, d: m, thin: insThinnest(s, T).d }; return null; }
  // as wide as it goes, then as deep, then wider again if the depth left room
  const grow = (k, top) => {
    let lo = s[k], hi = top;
    for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (good({ ...s, [k]: mid })) lo = mid; else hi = mid; }
    s[k] = Math.max(m, Math.floor(lo * 0.995));
  };
  const span = Math.max(T.boxHi[0] - T.boxLo[0], T.boxHi[1] - T.boxLo[1]);
  grow("w", span); grow("d", span); grow("w", span);
  let hLo = s.h, hHi = T.boxHi[2] - T.boxLo[2];
  for (let i = 0; i < 12; i++) { const mid = (hLo + hHi) / 2; if (good({ ...s, h: mid })) hLo = mid; else hHi = mid; }
  S.insert.w = s.w; S.insert.d = s.d; S.insert.h = Math.floor(hLo);
  return S.insert;
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
  $("#insOn").checked = !!s.on; $("#insBody").hidden = !s.on; $("#insIntro").hidden = !!s.on; $("#insKeep").checked = s.keep !== false;
  $$("#insShape button").forEach((b) => b.classList.toggle("on", b.dataset.shape === s.shape));
  $$("[data-ins]").forEach((el) => { el.value = s[el.dataset.ins]; });
  $("#insWl").textContent = s.shape === "round" ? "Diameter (mm)" : "Width (mm)";
  $("#insDbox").hidden = s.shape === "round" || s.shape === "square";
  $("#insRoundBox").hidden = !(s.shape === "square" || s.shape === "rect");
  const name = { round: "round", oval: "oval", square: "square", rect: "rectangle" }[s.shape];
  $("#insSum").textContent = s.on ? `${name} ${s.shape === "round" ? "Ø" + s.w : s.w + " × " + insD(s)} × ${s.h} mm${+s.taper ? `, ${s.taper}° taper` : ""}` : "off";
}
function drawInsert(T) {
  dispose(groups.insert); groups.insert.clear();
  groups.insert.visible = S.step === "cut" && !!S.insert.on;
  const kv = $("#insKv");
  if (!S.insert.on || !T) { kv.innerHTML = ""; return; }
  const s = S.insert, L = insLayout(s, T);
  if (!insValid(s)) {
    kv.innerHTML = Math.min(s.w, insD(s)) - 2 * s.wall >= 10 && s.h - s.wall >= 10
      ? `<dt>Insert</dt><dd class="bad">a ${s.taper}° taper over ${s.h} mm brings the core to a point. Use less taper, or make it wider or shorter.</dd>`
      : `<dt>Insert</dt><dd class="bad">a ${s.wall} mm wall needs it at least ${Math.ceil(2 * s.wall + 10)} mm across and ${Math.ceil(s.wall + 10)} mm high</dd>`;
    return;
  }
  const W = (x, y, z) => frameToWorld(T, x, y, z);
  // the insert: blue, see-through
  const ring = insRing(s, 0), pos = [];
  const top = ring.map(([x, y]) => W(L.c[0] + x, L.c[1] + y, L.z0)), far = insRing(s, 0, L.outIn).map(([x, y]) => W(L.c[0] + x, L.c[1] + y, L.z0 + s.h));
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
  loop(insRing(s, -s.wall).map(([x, y]) => W(L.c[0] + x, L.c[1] + y, L.z0)));
  loop(insRing(s, -s.wall, L.coreIn).map(([x, y]) => W(L.c[0] + x, L.c[1] + y, L.z0 + L.coreH)));
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
  // corner numbers, out past each peg's tab: the same numbers the notes below use
  const tightAt = new Set((L.rooms || []).map((r, i) => (r < 3 ? i : -1)));
  L.pegs.forEach((p, i) => {
    const dx = p[0] - L.bc[0], dy = p[1] - L.bc[1], n = Math.hypot(dx, dy) || 1, out = INS.foot_r + 4 + INS.tab_len + 12;
    const tag = textSprite(String(i + 1), Math.max(9, size() * 0.035), "#16181a", tightAt.has(i) ? "#ff8a6a" : "#f0c060");
    tag.position.copy(W(p[0] + dx / n * out, p[1] + dy / n * out, zf));
    tag.userData.cornerTag = i + 1;
    groups.insert.add(tag);
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
  const worst = tight.length ? Math.min(...tight.map(([r]) => r)) : 0, small = INS.foot_r * 2 <= 10;
  const lockNote = tight.length
    ? `<dt>Lock holes</dt><dd class="bad">corner ${tight.map(([, i]) => i).join(", ")} ${worst < 0.5 ? (tight.length > 1 ? "break" : "breaks") + " into the latex" : (tight.length > 1 ? "have" : "has") + " only " + worst.toFixed(0) + " mm of shell to the latex"} with ${INS.foot_r * 2} mm pegs. ${small ? "Even the smallest pegs don't fit: the latex comes too close to the box's corners." : "Press Fit the pegs to make them smaller."} The corners are numbered in the view.</dd>`
    : "";
  const mm = (v) => (Number.isFinite(v) ? `${v < 0 ? "pokes through by " + (-v).toFixed(0) : v.toFixed(0)} mm` : "–");
  const litres = insSiliconeL(s, L);
  const tooBig = thin.d < s.least, hits = turn.d < 0;
  const most = tooBig && s.keep && S.insertRelaxed && thin.d >= S.insertRelaxed.least - 0.5;
  kv.innerHTML = `
    <dt>Thinnest concrete</dt><dd class="${most ? "warn" : tooBig ? "bad" : "good"}">about ${mm(thin.d)}${most ? `, the most this opening allows (want ${s.least} mm)` : tooBig ? ` (want ${s.least} mm)` : ""}</dd>
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
  knob(W(L.c[0] + s.w / 2 - L.outIn / 2, L.c[1], midZ), "w", "#ffffff");
  if (s.shape === "oval" || s.shape === "rect") knob(W(L.c[0], L.c[1] + insD(s) / 2 - L.outIn / 2, midZ), "d", "#ffffff");
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
  $("#railIns").dataset.tip = S.insert?.on ? "Just the insert and its holder, with the latex and shell grayed out." : "Turn the silicone insert on first, on the Insert tab.";
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
  // a prism whose far ring is its own outline (same number of points): the taper
  const loft = (ring, ringHi, z0, z1, material) => {
    const m = prism(ring, z0, z1, 1, material), p = m.geometry.attributes.position, h = z1 - z0;
    for (let i = 0; i < p.count; i++) {
      if (p.getZ(i) < h - 1e-6) continue;
      let k = 0, best = Infinity;
      ring.forEach(([x, y], j) => { const d = (x - p.getX(i)) ** 2 + (y - p.getY(i)) ** 2; if (d < best) { best = d; k = j; } });
      p.setX(i, ringHi[k][0]); p.setY(i, ringHi[k][1]);
    }
    m.geometry.computeVertexNormals();
    return m;
  };
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
  g.add(loft(insRing(s, 0), insRing(s, 0, L.outIn), z0, z0 + s.h, mat("#4f9be0", 0.55)));
  // holder: hub, core, arms, frame, pads, pegs
  g.add(prism(insGrown(s, INS.hub_lip), z0 - t, z0));
  g.add(loft(insRing(s, -s.wall), insRing(s, -s.wall, L.coreIn), z0 - 0.5, z0 + L.coreH, purple));
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
// ------------------------------------------------------------ dragging the test slice
var sliceDrag = null;
function sliceHandleAt(e) {
  if (!groups.slicePlan.visible || S.step !== "cut") return false;
  setRay(e);
  return !!ray.intersectObjects(groups.slicePlan.children.filter((o) => o.userData.sliceHandle), false)[0];
}
function sliceDragStart(e) {
  const pl = (S.T.slicePlans || []).find(Boolean); if (!pl) return;
  mark(null);
  setRay(e);
  sliceDrag = { o: pl.at.clone(), n: pl.normal.clone(), from: (S.sliceAt == null ? pl.d - pl.d0 : S.sliceAt), t0: lineParam(pl.at, pl.normal) || 0 };
  orbit.enabled = false; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = "grabbing";
}
let sliceFrame = null;
function sliceDragMove(e) {
  setRay(e);
  const t = lineParam(sliceDrag.o, sliceDrag.n); if (t == null) return;
  S.sliceAt = +(sliceDrag.from + t - sliceDrag.t0).toFixed(1);
  if (!sliceFrame) sliceFrame = requestAnimationFrame(() => { sliceFrame = null; drawSlicePlan(S.T); });
}
function sliceDragEnd(e) {
  sliceDrag = null;
  orbit.enabled = true; canvas.releasePointerCapture?.(e.pointerId); canvas.style.cursor = "";
  drawSlicePlan(S.T); autosaveSoon();
}
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
$("#insPegFit").onclick = () => {
  if (!S.T || !S.insert.on) return;
  mark(null);
  const before = S.insert.peg_d, d = insFitPegs(S.T);
  insFill(); insChanged();
  if (d == null) toast("Even 10 mm pegs come too close to the latex at a corner: the latex runs too close to the box's corners there.");
  else toast(d === before ? `The ${d} mm pegs already fit.` : `Pegs sized to ${d} mm, the biggest that fit all four corners.`, true);
};
$("#insCentre").onclick = () => { if (S.T) { mark(null); insCentreOnOpening(S.T); insKeepFitted(); insChanged(); } };
const insSpec = () => {
  if (!S.insert.on || !S.T) return null;
  const L = insLayout(S.insert, S.T);
  return { shape: S.insert.shape, w: S.insert.w, d: insD(S.insert), h: S.insert.h, wall: S.insert.wall, round: S.insert.round, least: S.insert.least, taper: +S.insert.taper || 0, peg_d: Math.min(30, Math.max(10, +S.insert.peg_d || 20)), cup_wall: Math.min(5, Math.max(0.3, +S.insert.cup_wall || 0.56)), arm_w: INS.arm_w, frame_w: INS.frame_w, arm_t: INS.arm_t, cx: L.c[0], cy: L.c[1], spots: null };
};
// the insert can't go through the latex: say so, and show it, instead of building
function insPokes() {
  const c = S.insert?.on && S.insertCheck;
  if (!c || !(c.thin < 0)) return false;
  toast(`The silicone insert pokes through the latex by ${(-c.thin).toFixed(0)} mm, so the concrete would have a hole. Press Fit to the latex, make it smaller, or turn the insert off, then build.`);
  showTab("insert");
  return true;
}
$("#insOnly").onclick = () => {
  if (!S.T || !S.insert.on) return;
  if (insPokes()) return;
  if (!insValid(S.insert)) { toast("The insert's wall leaves no room for the core."); return; }
  const T = S.T;
  withBusy("Making the holder and cup", async () => {
    const r = await api("/api/insert", { insert: insSpec(), cuts: [], frame: [T.frame.ex.toArray(), T.frame.ey.toArray()], settings: S.settings });
    const i = r.insert;
    toast(`Saved holder.3mf (${i.holder_mm.slice(0, 2).join(" × ")} mm) and insert_cup.3mf in the scan's folder. Mix about ${i.silicone_l} L of silicone.${i.fits_plate ? "" : " The holder is bigger than your plate."}`, true);
  }, true);
};

// for testing
window.__ms = { sliceShell, suggestMore, sliceCtx, showTab, splitPartOf, SPLIT, splitApart: () => splitApart, setDrawMode, tri: () => latexTri, bins: () => latexBins, verts: () => latexPos(), opts, renderCuts, SEAM, drawSlicePlan, sliceDragStart, curTab, sizerAt, drawSizer, sizerOn, baseH, setBaseH, latexDistance, INS, S, insCentre: (T) => insCentreOnOpening(T), insFit, insAutoFit, insHandleAt, setInsView, insViewOn, insThinnest, insLayout, drawInsert, insSpec, loadRecent, frameGroup, slicePlans, startBuild, pickAt, pieceSpec, refresh, compute, splitPieces, splitNormal, pickAllPieces, mirrorCuts, mirrorPlane, applyLayout, layoutNow, labels: () => labels, renderCuts, camera, groups, removeCut, deleteSegs, deleteCuts, mergePieces, optimize, undo, redo, setMode, selectSeg, selectPiece, selectCut, H, meshes, handle, gizmoT, gizmoR, onHandleMove };

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
    return el && el.dataset.tip && !el.dataset.tname ? el : null; // the tool rail has tips of its own
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
    d.addEventListener("toggle", () => {
      if (d.open && d.dataset.in === "scan") $$('details.group[data-in="scan"]').forEach((o) => { if (o !== d && o.open) o.open = false; });
      st[key] = d.open; try { localStorage.setItem("gs.panels", JSON.stringify(st)); } catch (e) { /* not kept */ }
    });
  });
  const open = $$('details.group[data-in="scan"]').filter((d) => d.open);
  open.slice(1).forEach((d) => { d.open = false; });
})();

// Units shown: everything inside stays in mm. Inputs that hold a length show
// it in the chosen unit (and hand back mm to the code), and any "12 mm" in
// the page's text is shown as cm or inches. "Scan was saved in" is separate:
// that's about the file.
(() => {
  const F = { mm: 1, cm: 10, in: 25.4 };
  let U = "mm";
  try { U = localStorage.getItem("gs.units") || "mm"; } catch (e) { /* default */ }
  if (!F[U]) U = "mm";
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  const num = /-?\d+(?:\.\d+)?/g;
  const fmt = (s) => {
    const v = parseFloat(s) / F[U], a = Math.abs(v);
    return String(+v.toFixed(U === "in" ? (a < 1 ? 3 : 2) : (a < 1 ? 2 : 1)));
  };
  const conv = (s) => U === "mm" ? s : s
    .replace(/\(mm\)/g, `(${U})`)
    .replace(/(-?\d+(?:\.\d+)?)((?:\s*×\s*-?\d+(?:\.\d+)?)*)(\s*)mm\b(?![²³23])/g, (m, a, rest, sp) => fmt(a) + rest.replace(num, fmt) + sp + U);

  // inputs that hold a length
  const SEL = '#sizeX, #sizeY, #sizeZ, #spoutD, #spoutH, #trimMm, #insW, #insD, #insH, #insWall, #insRound, #insLeast, #insTaper, #insPeg, #insCupWall, #insArmW, #insFrameW, #insArmT, input[type=number][id$="_mm"]';
  const shown = (mm) => String(+(mm / F[U]).toFixed(U === "in" ? 3 : 2));
  function wrap(el) {
    if (el._mm) return;
    el._mm = { min: el.getAttribute("min"), max: el.getAttribute("max"), step: el.getAttribute("step") };
    const raw = desc.get.call(el); // in mm until now
    Object.defineProperty(el, "value", {
      configurable: true,
      get() {
        const raw = desc.get.call(this);
        if (U === "mm" || raw === "") return raw;
        if (this._mmLast && raw === this._mmLast.shown) return this._mmLast.mm; // no drift from rounding
        const n = parseFloat(raw);
        return isFinite(n) ? String(+(n * F[U]).toFixed(4)) : raw;
      },
      set(v) {
        const n = parseFloat(v);
        if (U === "mm" || v === "" || v == null || !isFinite(n)) { this._mmLast = null; desc.set.call(this, v); return; }
        const s = shown(n);
        this._mmLast = { mm: String(v), shown: s };
        desc.set.call(this, s);
      },
    });
    if (raw !== "") el.value = raw;
    attrs(el);
  }
  function attrs(el) {
    for (const a of ["min", "max"]) {
      const o = el._mm[a];
      if (o == null) continue;
      el.setAttribute(a, U === "mm" ? o : shown(+o));
    }
    if (el._mm.step != null) el.setAttribute("step", U === "mm" ? el._mm.step : "any");
  }

  // text: remember each text node's mm wording, show it converted
  const orig = new WeakMap();
  const skip = (n) => { const p = n.parentElement; return !p || p.closest("script, style, textarea, [data-raw], .seg[aria-label='Scan units']"); };
  function doNode(n) {
    if (skip(n)) return;
    let o = orig.get(n);
    if (o == null || (n.data !== o.out)) { o = { src: n.data, out: null }; orig.set(n, o); }
    const out = conv(o.src);
    o.out = out;
    if (n.data !== out) n.data = out;
  }
  function walk(root) {
    if (root.nodeType === 1) { if (root.matches(SEL)) wrap(root); root.querySelectorAll(SEL).forEach(wrap); }
    if (root.nodeType === 3) { if (/mm/.test(root.data) || orig.has(root)) doNode(root); return; }
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (/mm/.test(n.data) || orig.has(n)) doNode(n);
  }
  const mo = new MutationObserver((recs) => {
    mo.disconnect();
    for (const r of recs) {
      if (r.type === "characterData") walk(r.target);
      else r.addedNodes.forEach((n) => walk(n));
    }
    watch();
  });
  const watch = () => mo.observe(document.body, { childList: true, subtree: true, characterData: true });

  function apply() {
    $$(SEL).forEach(wrap);
    mo.disconnect();
    walk(document.body);
    watch();
    $$("[data-units]").forEach((b) => b.classList.toggle("on", b.dataset.units === U));
  }
  $$("[data-units]").forEach((b) => b.onclick = () => {
    const vals = new Map();
    $$(SEL).forEach((el) => vals.set(el, el.value)); // mm, read with the old unit
    U = b.dataset.units;
    try { localStorage.setItem("gs.units", U); } catch (e) { /* not kept */ }
    vals.forEach((v, el) => { el.value = v; attrs(el); });
    apply();
  });
  window.__units = { get: () => U, conv };
  apply();
})();

// ------------------------------------------------------------ 0.14: scene list, axes, menus, tool rail, more keys
// What the eye buttons in the scene list have hidden. Kept per name, so it
// survives a rebuild of the same parts, and re-applied every frame because
// other code turns groups back on as you work.
// var, not const: the render loop and go() run before this part of the file does
var HID = new Set();
var OL = { open: new Set(["shell", "split", "insert", "cut-scan", "cut-guides"]), closed: new Set(), sel: null };
function applyHidden() {
  if (!HID) return;
  if (HID.has("latex") && S.step === "cut") groups.latex.visible = false;
  for (const g of [groups.pieces, groups.slices]) g.children.forEach((m) => { m.visible = !HID.has(m.userData.name); });
  groups.plates.children.forEach((pl) => pl.children.forEach((m) => { if (m.userData.name) m.visible = !HID.has(m.userData.name); }));
}
// the cut step's rows stand for the Show menu's switches, so the two always agree
const CUT_ROWS = [
  { id: "latex", name: "Latex scan", kind: "scan" },
  { id: "tPlanes", name: "Cut planes", kind: "cut", box: true },
  { id: "tPieces", name: "Piece colors", kind: "piece", box: true },
  { id: "tPour", name: "Pour collar", kind: "pour", box: true },
  { id: "tSlices", name: "Test slices", kind: "test", box: true },
  { id: "tSeam", name: "Seam cards", kind: "seam", box: true },
];
const OL_ICON = {
  folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
  scan: '<path d="M12 3c-3 0-5 3-5 6 0 2 1 3 1 5-2 1-4 3-4 7h16c0-4-2-6-4-7 0-2 1-3 1-5 0-3-2-6-5-6z"/>',
  piece: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  cut: '<path d="M4 20L20 4"/><path d="M4 14l6 6M14 4l6 6"/>',
  pour: '<path d="M6 4h12l-2 16H8z"/>',
  test: '<path d="M4 8h16M4 12h16M4 16h16"/>',
  seam: '<rect x="5" y="3" width="14" height="18" rx="1"/>',
  holder: '<path d="M4 8h16v11H4z"/><path d="M8 8V5h8v3"/>',
};
const EYE = '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
const EYE_OFF = '<path d="M3 3l18 18"/><path d="M10.6 6.1A10 10 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3 3.6M6.6 6.6C3.8 8.4 2 12 2 12s4 7 10 7a9 9 0 0 0 4-1"/>';
const svgI = (body, cls = "") => `<svg class="${cls}" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

// the built parts, in folders: the mold shell (a piece split to fit the printer
// gets a folder of its own inside it), the insert, the seam cards, the test slices
function builtTree() {
  const parts = groups.pieces.children.map((m) => m.userData), tests = groups.slices.children.map((m) => m.userData);
  const leaf = (u, kind) => ({ id: u.name, name: u.label || u.name, kind });
  const shell = [], splits = new Map();
  for (const u of parts.filter((u) => u.kind === "piece")) {
    const m = /^(SHELL_\d+)([A-Z])$/.exec(u.name);
    if (!m) { shell.push(leaf(u, "piece")); continue; }
    if (!splits.has(m[1])) splits.set(m[1], []);
    splits.get(m[1]).push(leaf(u, "piece"));
  }
  for (const [base, kids] of splits) shell.push({ id: "split-" + base, name: `${base.replace("SHELL_", "Shell ")} · split to fit`, folder: true, kids });
  shell.sort((a, b) => (a.id.replace("split-", "") > b.id.replace("split-", "") ? 1 : -1));
  const tree = [];
  if (shell.length) tree.push({ id: "shell", name: "Mold Shell", folder: true, kids: shell });
  const ins = parts.filter((u) => ["holder", "cup", "insert", "pour"].includes(u.kind)).map((u) => leaf(u, u.kind === "holder" || u.kind === "cup" ? "holder" : "pour"));
  if (ins.length) tree.push({ id: "insert", name: "Silicone insert", folder: true, kids: ins });
  const seams = parts.filter((u) => u.kind === "seam").map((u) => leaf(u, "seam"));
  if (seams.length) tree.push({ id: "seams", name: "Seam cards", folder: true, kids: seams });
  if (tests.length) tree.push({ id: "tests", name: "Test slices", folder: true, kids: tests.map((u) => leaf(u, "test")) });
  return tree;
}
function cutTree() {
  const rows = CUT_ROWS.filter((r) => r.id !== "tSeam" || SEAM.cards.length).map((r) => ({ ...r }));
  return [
    { id: "cut-scan", name: "Scan", folder: true, kids: [{ ...rows[0], name: S.scan?.file || S.scan?.name || "Latex scan" }] },
    { id: "cut-guides", name: "Guides", folder: true, kids: rows.slice(1) },
  ];
}
const leaves = (n) => (n.folder ? n.kids.flatMap(leaves) : [n]);
const isShown = (n) => (n.box ? $("#" + n.id).checked : !HID.has(n.id));
function setShown(n, on) {
  if (n.box) { const b = $("#" + n.id); if (b.checked !== on) { b.checked = on; b.dispatchEvent(new Event("change", { bubbles: true })); } return; }
  if (on) HID.delete(n.id); else HID.add(n.id);
  if (n.id === "latex" && on) groups.latex.visible = S.step === "cut";
}
let olTree = [];
function renderOutliner() {
  if (!OL_READY) return;
  const box = $("#olTree"); if (!box) return;
  olTree = S.step === "done" ? builtTree() : S.step === "cut" ? cutTree() : [];
  const rows = [];
  const walk = (n, depth) => {
    const L = leaves(n), on = L.filter(isShown).length, all = on === L.length;
    const open = n.folder && !OL.closed.has(n.id);
    rows.push(`<div class="ol-row${OL.sel === n.id ? " sel" : ""}${on ? "" : " off"}" role="treeitem" aria-level="${depth + 1}" ${n.folder ? `aria-expanded="${open}"` : ""} aria-selected="${OL.sel === n.id}" data-id="${n.id}" style="--d:${depth}" tabindex="-1">` +
      (n.folder ? `<button type="button" class="ol-fold" data-fold="${n.id}" aria-label="${open ? "Collapse" : "Expand"}">${svgI('<path d="M9 6l6 6-6 6"/>', open ? "rot" : "")}</button>` : `<span class="ol-fold"></span>`) +
      svgI(OL_ICON[n.folder ? "folder" : n.kind] || OL_ICON.piece, "ol-ic k-" + (n.folder ? "folder" : n.kind)) +
      `<span class="ol-name"></span>` +
      `<span class="ol-meta">${n.folder && !all ? `${on} of ${L.length}` : n.folder ? L.length : ""}</span>` +
      `<button type="button" class="ol-eye${on && !all ? " part" : ""}" data-eye="${n.id}" aria-pressed="${on > 0}" aria-label="${on ? "Hide" : "Show"}">${svgI(on ? EYE : EYE_OFF)}</button></div>`);
    if (open) n.kids.forEach((k) => walk(k, depth + 1));
  };
  olTree.forEach((n) => walk(n, 0));
  box.innerHTML = rows.join("");
  // names come from files, so they go in as text
  const byId = new Map(); const index = (n) => { byId.set(n.id, n); if (n.folder) n.kids.forEach(index); }; olTree.forEach(index);
  box.querySelectorAll(".ol-row").forEach((r) => {
    const n = byId.get(r.dataset.id); r.querySelector(".ol-name").textContent = n.name;
    r.querySelector(".ol-eye").title = (isShown(n) || (n.folder && leaves(n).some(isShown)) ? "Hide " : "Show ") + n.name + (n.folder ? " and everything in it" : "");
  });
  renderOutliner.byId = byId;
}
function olToggle(id) {
  const n = renderOutliner.byId?.get(id); if (!n) return;
  const L = leaves(n), any = L.some(isShown);
  L.forEach((l) => setShown(l, !any));
  renderOutliner();
}
$("#olTree").addEventListener("click", (e) => {
  const eye = e.target.closest("[data-eye]"), fold = e.target.closest("[data-fold]"), row = e.target.closest(".ol-row");
  if (eye) { olToggle(eye.dataset.eye); return; }
  if (fold) { const id = fold.dataset.fold; if (OL.closed.has(id)) OL.closed.delete(id); else OL.closed.add(id); renderOutliner(); return; }
  if (row) { OL.sel = OL.sel === row.dataset.id ? null : row.dataset.id; renderOutliner(); }
});
$("#olTree").addEventListener("dblclick", (e) => { const row = e.target.closest(".ol-row"); if (row && !e.target.closest("button")) olToggle(row.dataset.id); });
$$(".show-list input").forEach((b) => b.addEventListener("change", () => { if (S.step === "cut") renderOutliner(); }));
function showAll() { HID.clear(); CUT_ROWS.filter((r) => r.box).forEach((r) => setShown(r, true)); if (S.step === "cut") groups.latex.visible = !insViewOn(); renderOutliner(); }
function hideSelected() {
  if (!OL.sel) { toast("Click a row in the Scene list first, then press H to hide it. Alt+H shows everything again.", true); return; }
  const n = renderOutliner.byId?.get(OL.sel); if (!n) return;
  leaves(n).forEach((l) => setShown(l, false)); renderOutliner();
}

// the little X / Y / Z axes in the corner turn with the view
var AX = [["X", new V3(1, 0, 0), "#e5674a", "#1a0b08"], ["Y", new V3(0, 1, 0), "#7cb342", "#0d1a05"], ["Z", new V3(0, 0, 1), "#4f86f7", "#0b1220"]];
var axesKey = "";
function drawAxes() {
  if (!AX) return;
  const g = $("#axesG"); if (!g || $("#axes").hidden) return;
  const q = camera.quaternion.clone().invert();
  const pts = AX.map(([n, v, c, ink]) => { const p = v.clone().applyQuaternion(q); return { n, c, ink, x: p.x * 26, y: -p.y * 26, z: p.z }; });
  const key = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(";");
  if (key === axesKey) return; axesKey = key;
  pts.sort((a, b) => a.z - b.z); // far ones first
  g.innerHTML = '<circle cx="0" cy="0" r="3" fill="#4a5157"/>' + pts.map((p) =>
    `<line x1="0" y1="0" x2="${p.x}" y2="${p.y}" stroke="${p.c}" stroke-width="2" opacity="${p.z < -0.2 ? 0.45 : 1}"/>` +
    `<circle cx="${p.x}" cy="${p.y}" r="8" fill="${p.c}" opacity="${p.z < -0.2 ? 0.55 : 1}"/>` +
    `<text x="${p.x}" y="${p.y + 3.5}" text-anchor="middle" font-size="10" font-weight="600" fill="${p.ink}">${p.n}</text>`).join("");
}
// click an axis ball to look down it
$("#axes").addEventListener("click", (e) => {
  const r = $("#axes").getBoundingClientRect(), x = e.clientX - r.left - r.width / 2, y = e.clientY - r.top - r.height / 2;
  const q = camera.quaternion.clone().invert();
  const hit = AX.map(([n, v]) => { const p = v.clone().applyQuaternion(q); return { n, d: Math.hypot(p.x * 26 - x, -p.y * 26 - y) }; }).sort((a, b) => a.d - b.d)[0];
  if (hit && hit.d < 12) viewFrom({ X: "side", Y: "front", Z: "top" }[hit.n]);
});

// menus along the top
function topMenu(id, items) {
  const b = $("#" + id);
  b.onclick = (e) => {
    e.stopPropagation();
    if (!$("#ctx").hidden && $("#ctx").dataset.menu === id) { closeMenu(); return; }
    const r = b.getBoundingClientRect(); openMenu(r.left, r.bottom + 2, items().filter((it, i, a) => it !== "-" || (i && a[i - 1] !== "-")));
    $("#ctx").classList.add("file-menu"); $("#ctx").dataset.menu = id;
  };
}
const inCut = () => S.step === "cut" && !!S.T;
topMenu("editMenu", () => [
  { label: "Undo", key: "Ctrl+Z", disabled: !H.undo.length, act: undo },
  { label: "Redo", key: "Ctrl+Y", disabled: !H.redo.length, act: redo },
  "-",
  { label: "Pick every piece", key: "Ctrl+A", disabled: !inCut(), act: pickAllPieces },
  { label: "Clear the picks", key: "Esc", disabled: !inCut(), act: clearPicks },
  { label: "Join the picked pieces", key: "M", disabled: !inCut() || S.selPieces.size < 2, act: () => mergePieces([...S.selPieces]) },
  "-",
  { label: "Add a cut", key: "C", disabled: !inCut(), act: railCut },
  { label: "Save this layout", key: "Ctrl+S", disabled: !inCut(), act: saveLayout },
  { label: "Build shell", key: "Ctrl+B", disabled: !inCut() || $("#build").disabled, act: () => startBuild(false) },
]);
topMenu("viewMenu", () => [
  { label: "Front", key: "Numpad 1", disabled: S.step === "load", act: () => viewFrom("front") },
  { label: "Side", key: "Numpad 3", disabled: S.step === "load", act: () => viewFrom("side") },
  { label: "Top", key: "Numpad 7", disabled: S.step === "load", act: () => viewFrom("top") },
  { label: "Bottom", key: "Ctrl+Numpad 7", disabled: S.step === "load", act: () => viewFrom("bottom") },
  { label: "Fit", key: "F", disabled: S.step === "load", act: () => viewFrom("fit") },
  "-",
  { label: ($("#tOver").checked ? "Hide" : "Show") + " overhangs in red", key: "X", disabled: S.step !== "cut", act: () => flip("tOver") },
  { label: ($("#tSlices").checked ? "Hide" : "Show") + " test slices", key: "T", disabled: S.step !== "cut", act: () => flip("tSlices") },
  { label: (document.body.classList.contains("no-panel") ? "Show" : "Hide") + " the side panel", key: "N", act: togglePanel },
  "-",
  { label: "Hide the picked row", key: "H", disabled: !OL.sel, act: hideSelected },
  { label: "Show everything", key: "Alt+H", act: showAll },
]);
topMenu("helpMenu", () => [
  { label: "Keyboard shortcuts", key: "?", act: () => { $("#keys").hidden = false; } },
  { label: `GnomeShell ${APP_VERSION}`, disabled: true, act: () => {} },
]);

// the tool rail
function railCut() { if (!inCut()) return; showTab("cuts"); $("#addCut").click(); }
$("#railCut").onclick = railCut;
$("#railOpt").onclick = () => { if (S.active == null) { toast("Click a cut first, then optimize it.", true); return; } optimize(S.active, ["az", "tilt", "pos"]); };
$("#railJoin").onclick = () => { if (S.selPieces.size < 2) { toast("Shift-click two or more pieces first, then join them.", true); return; } mergePieces([...S.selPieces]); };
$("#railScale").onclick = () => showTab("scan");
$("#railRot").onclick = (e) => $(e.shiftKey ? '[data-rot="z,15"]' : '[data-rot="z,90"]').click();
function flip(id) { const b = $("#" + id); b.checked = !b.checked; b.dispatchEvent(new Event("change", { bubbles: true })); }
function togglePanel() {
  const off = document.body.classList.toggle("no-panel");
  $("#panelBtn").setAttribute("aria-pressed", String(!off));
  dispatchEvent(new Event("resize"));
}
$("#panelBtn").onclick = togglePanel;
$("#sbRight").textContent = `GnomeShell ${APP_VERSION}`;

// more keys, in every step
addEventListener("keydown", (e) => {
  if (e.target.matches("input[type=number], input[type=text], select, textarea") || !$("#busy").hidden) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (mod && k === "s") { e.preventDefault(); if (inCut()) saveLayout(); return; }
  if (mod && k === "b") { e.preventDefault(); if (inCut() && !$("#build").disabled) startBuild(false); return; }
  if (mod) return;
  if (e.altKey && k === "h") { e.preventDefault(); showAll(); return; }
  if (e.altKey || S.step === "load") return;
  if (k === "h") { e.preventDefault(); hideSelected(); return; }
  if (k === "n") { e.preventDefault(); togglePanel(); return; }
  if (S.step !== "cut" || insViewOn()) return;
  if (k === "x") { e.preventDefault(); flip("tOver"); return; }
  if (k === "t") { e.preventDefault(); flip("tSlices"); }
});

// the tool rail's tips: name, key and a line on what it does, beside the button
(() => {
  const t = document.createElement("div"); t.className = "rtip"; t.setAttribute("role", "tooltip"); document.body.appendChild(t);
  let timer = 0;
  const hide = () => { clearTimeout(timer); t.classList.remove("show"); };
  const show = (b) => {
    t.innerHTML = '<div class="rtip-top"><span class="rtip-name"></span><kbd></kbd></div><div class="rtip-desc"></div>';
    t.querySelector(".rtip-name").textContent = b.dataset.tname; t.querySelector("kbd").textContent = b.dataset.tkey; t.querySelector(".rtip-desc").textContent = b.dataset.tip || "";
    const r = b.getBoundingClientRect(); t.style.left = r.right + 10 + "px"; t.style.top = Math.max(8, r.top + r.height / 2 - t.offsetHeight / 2) + "px";
    t.classList.add("show");
  };
  $$("#rail [data-tname]").forEach((b) => {
    b.addEventListener("pointerenter", () => { clearTimeout(timer); timer = setTimeout(() => show(b), t.classList.contains("show") ? 0 : 350); });
    b.addEventListener("pointerleave", hide);
    b.addEventListener("focus", () => show(b)); b.addEventListener("blur", hide);
    b.addEventListener("click", hide);
  });
})();
var OL_READY = true;
renderOutliner();
