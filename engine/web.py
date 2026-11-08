"""Gap webs: a thin flat sheet across a gap you can see through, such as
between the legs or between an arm and the body. The latex goes straight
across it instead of down into the gap, so the skin comes off, and the
concrete gets a thin fin there that is punched out afterwards.

A gap is found by looking at the model from a direction: the places you can
see through that are closed in all round (legs, crotch and base around the
gap between the legs) are gaps. The best direction for a gap is the one that
looks most squarely through it, which is where it shows biggest."""
import math

import bmesh
import numpy as np

import mold_shell as ms
import split as sp

EZ = np.array((0.0, 0.0, 1.0))
MARGIN = 3.0  # how far the web reaches into the model all round, so it joins
FILL_MM = 60.0  # how far past the see-through part the web may spread to meet the model at its own depth
FILL_LEAK_MM = 8.0  # how far it spreads when the air at its depth isn't closed in


def direction(az, tilt):
    """Looking direction from degrees: az round the vertical, tilt up or down."""
    a, t = math.radians(az), math.radians(tilt)
    return np.array((math.cos(t) * math.cos(a), math.cos(t) * math.sin(a), math.sin(t)))


def angles(d):
    d = np.asarray(d, float) / np.linalg.norm(d)
    return math.degrees(math.atan2(d[1], d[0])), math.degrees(math.asin(max(-1.0, min(1.0, d[2]))))


def _frame(d):
    d = np.asarray(d, float)
    d = d / np.linalg.norm(d)
    u = np.cross(EZ, d)
    if np.linalg.norm(u) < 1e-6:
        u = np.array((1.0, 0.0, 0.0))
    u /= np.linalg.norm(u)
    return d, u, np.cross(d, u)


class View:
    """The model seen along d on a grid: which cells it covers, and how near
    and far it reaches in each."""

    def __init__(self, co, tris, d, cell):
        self.d, self.u, self.v = _frame(d)
        self.cell = cell
        P = np.stack([co @ self.u, co @ self.v], 1)
        D = co @ self.d
        self.lo = P.min(0) - 4 * cell
        hi = P.max(0) + 4 * cell
        self.W, self.H = int((hi[0] - self.lo[0]) / cell) + 1, int((hi[1] - self.lo[1]) / cell) + 1
        n = self.W * self.H
        near = np.full(n, np.inf)
        far = np.full(n, -np.inf)
        tp, td = P[tris], D[tris]
        ext = (tp.max(1) - tp.min(1)).max(1)
        # sample every triangle finely enough that no cell it covers is missed
        k = np.maximum(1, np.ceil(ext / (0.5 * cell))).astype(int)
        for kk in np.unique(k):
            sel = np.nonzero(k == kk)[0]
            a, b = np.meshgrid(np.arange(kk + 1), np.arange(kk + 1))
            m = (a + b) <= kk
            w1, w2 = a[m] / kk, b[m] / kk
            w0 = 1 - w1 - w2
            W3 = np.stack([w0, w1, w2], 1)  # (s, 3)
            for chunk in np.array_split(sel, max(1, len(sel) * len(W3) // 2_000_000 + 1)):
                q = np.einsum("sk,tkc->tsc", W3, tp[chunk]).reshape(-1, 2)
                z = np.einsum("sk,tk->ts", W3, td[chunk]).reshape(-1)
                idx = self._cells(q)
                np.minimum.at(near, idx, z)
                np.maximum.at(far, idx, z)
        self.near = near.reshape(self.H, self.W)
        self.far = far.reshape(self.H, self.W)
        self.solid = np.isfinite(self.near)

    def _cells(self, q):
        ij = np.floor((q - self.lo) / self.cell).astype(int)
        ij[:, 0] = np.clip(ij[:, 0], 0, self.W - 1)
        ij[:, 1] = np.clip(ij[:, 1], 0, self.H - 1)
        return ij[:, 1] * self.W + ij[:, 0]

    def cell_of(self, p):
        p = np.asarray(p, float)
        i = int((p @ self.u - self.lo[0]) / self.cell)
        j = int((p @ self.v - self.lo[1]) / self.cell)
        return j, i

    def point(self, j, i, depth):
        x = self.lo[0] + (i + 0.5) * self.cell
        y = self.lo[1] + (j + 0.5) * self.cell
        return self.u * x + self.v * y + self.d * depth


def _grow(g, n=1):
    for _ in range(n):
        h = g.copy()
        h[1:] |= g[:-1]
        h[:-1] |= g[1:]
        h[:, 1:] |= g[:, :-1]
        h[:, :-1] |= g[:, 1:]
        g = h
    return g


def _holes(view):
    """Cells you can see through that are closed in all round, labelled."""
    s = _grow(view.solid, 1)  # close hairline cracks
    empty = ~s
    out = np.zeros_like(empty)
    out[0], out[-1], out[:, 0], out[:, -1] = empty[0], empty[-1], empty[:, 0], empty[:, -1]
    n = out.sum()
    while True:
        out = _grow(out, 4) & empty
        m = out.sum()
        if m == n:
            break
        n = m
    lab, count = sp._label(empty & ~out)
    return lab, count, s


def _depth(view, hole, s):
    """Where the web goes along the looking direction: through the middle of
    the model all round the gap."""
    ring = _grow(hole, 3) & s & view.solid
    if not ring.any():
        return None
    return float(np.median((view.near[ring] + view.far[ring]) / 2))


def _find_label(lab, j, i, reach):
    H, W = lab.shape
    if 0 <= j < H and 0 <= i < W and lab[j, i]:
        return lab[j, i]
    j0, j1, i0, i1 = max(0, j - reach), min(H, j + reach + 1), max(0, i - reach), min(W, i + reach + 1)
    win = lab[j0:j1, i0:i1]
    ys, xs = np.nonzero(win)
    if not len(ys):
        return 0
    k = np.argmin((ys + j0 - j) ** 2 + (xs + i0 - i) ** 2)
    return win[ys[k], xs[k]]


def _coarse(co):
    return max(1.0, float(np.ptp(co, axis=0).max()) / 90.0)


def _fine(co):
    return min(1.0, max(0.35, float(np.ptp(co, axis=0).max()) / 350.0))


def _gap_at(co, tris, d, cell, point, reach_mm=12.0):
    """The gap that point is in (or next to), seen along d: (area mm2, view, hole mask, label grid, s)."""
    view = View(co, tris, d, cell)
    lab, count, s = _holes(view)
    if not count:
        return 0.0, view, None, s
    j, i = view.cell_of(point)
    L = _find_label(lab, j, i, int(reach_mm / cell))
    if not L:
        return 0.0, view, None, s
    hole = lab == L
    view.lab = lab
    return float(hole.sum()) * cell * cell, view, hole, s


def best_for_point(latex_obj, point, look, progress=None):
    """Click a gap: the direction near `look` that sees most squarely through
    the gap at `point`. Returns a web record, or None if there's no closed gap there."""
    co, tris = ms._world_tris(latex_obj)
    cell = _coarse(co)
    az0, t0 = angles(look)
    looks = []
    for az in range(-45, 46, 15):
        for tl in (-20, 0, 20):
            t = max(-80, min(80, t0 + tl))
            looks.append((_gap_at(co, tris, direction(az0 + az, t), cell, point)[0], az0 + az, t))
    if max(f[0] for f in looks) <= 0:
        return None
    az, tl = _middle(looks)
    az, tl = _refine(co, tris, point, az, tl, cell)
    return _record(co, tris, point, az, tl, cell)


def _middle(looks):
    """The middle of the directions that see the gap about as big as the best
    one does: a gap often looks the same over a spread of angles."""
    top = max(f[0] for f in looks)
    near = [f for f in looks if f[0] >= 0.97 * top]
    # turn is averaged on doubled angles, since looking from the front or the back is the same web
    z = sum(np.exp(2j * math.radians(f[1])) for f in near)
    ref = max(near)[1]
    az = math.degrees(np.angle(z)) / 2
    az += 180 * round((ref - az) / 180)  # the copy of it nearest the best look
    return az, float(np.mean([f[2] for f in near]))


def _refine(co, tris, point, az, tl, cell):
    """A closer look round a direction, on a finer grid: along each of turn and
    tilt, fit a curve through the gap's size either side and go to its peak,
    so a gap that looks the same over a range of angles is faced square on."""
    fine = cell / 2
    size = lambda a, t: _gap_at(co, tris, direction(a, max(-80, min(80, t))), fine, point)[0]  # noqa: E731
    f0 = size(az, tl)
    for step in (8.0, 4.0):
        for axis in (0, 1):
            da, dt = (step, 0) if axis == 0 else (0, step)
            fm, fp = size(az - da, tl - dt), size(az + da, tl + dt)
            if fm > f0 * 1.01 and fm >= fp:  # clearly bigger that way (not just grid noise)
                off = -step
            elif fp > f0 * 1.01:
                off = step
            else:
                den = fm - 2 * f0 + fp
                off = 0.0 if den >= 0 else max(-step, min(step, step * (fm - fp) / (2 * den)))
            if abs(off) > 0.5:
                na, nt = (az + off, tl) if axis == 0 else (az, max(-80, min(80, tl + off)))
                fn = size(na, nt)
                if fn >= f0 * 0.98:  # the peak of the curve, or near enough
                    az, tl, f0 = na, nt, max(fn, f0)
    return az, tl


def _record(co, tris, point, az, tilt, cell):
    a, view, hole, s = _gap_at(co, tris, direction(az, tilt), cell, point)
    if hole is None:
        return None
    depth = _depth(view, hole, s)
    ys, xs = np.nonzero(hole)
    jc, ic = float(ys.mean()), float(xs.mean())
    # the middle of the gap, on the web
    j, i = ys[np.argmin((ys - jc) ** 2 + (xs - ic) ** 2)], xs[np.argmin((ys - jc) ** 2 + (xs - ic) ** 2)]
    p = view.point(j, i, depth)
    return {"point": [float(x) for x in p], "az": round(float(az) % 360, 1), "tilt": round(float(tilt), 1),
            "area": round(a / 100.0, 1)}  # cm2


def find(latex_obj, progress=None):
    """Every closed gap you can see through, each looked at from its best direction."""
    co, tris = ms._world_tris(latex_obj)
    cell = _coarse(co)
    span = float(np.ptp(co, axis=0).max())
    min_area = max(30.0, (span * 0.04) ** 2)
    found = []  # (area, az, tilt, centre)
    dirs = [(az, tl) for tl in (0, -20, 20) for az in range(0, 180, 15)]
    for k, (az, tl) in enumerate(dirs):
        if progress:
            progress(f"Looking for gaps ({k + 1} of {len(dirs)})")
        view = View(co, tris, direction(az, tl), cell)
        lab, count, s = _holes(view)
        for L in range(1, count + 1):
            hole = lab == L
            a = float(hole.sum()) * cell * cell
            if a < min_area:
                continue
            depth = _depth(view, hole, s)
            if depth is None:
                continue
            ys, xs = np.nonzero(hole)
            c = view.point(float(ys.mean()), float(xs.mean()), depth)
            j, i = ys[np.argmin((ys - ys.mean()) ** 2 + (xs - xs.mean()) ** 2)], xs[np.argmin((ys - ys.mean()) ** 2 + (xs - xs.mean()) ** 2)]
            found.append((a, az, tl, c, view.point(j, i, depth)))
    # the same gap seen from several directions: keep the best look at each
    found.sort(key=lambda f: -f[0])
    keep = []
    for f in found:
        if all(np.linalg.norm(f[3] - g[3]) > max(15.0, 0.5 * math.sqrt(g[0])) for g in keep):
            keep.append(f)
    out = []
    for k, (a, az, tl, c, p) in enumerate(keep[:6]):
        same = [(g[0], g[1], g[2]) for g in found if np.linalg.norm(g[3] - c) <= max(15.0, 0.5 * math.sqrt(a))]
        az, tl = _middle(same)
        if progress:
            progress(f"Finding the best angle for gap {k + 1} of {min(len(keep), 6)}")
        az, tl = _refine(co, tris, p, az, tl, cell)
        r = _record(co, tris, p, az, tl, cell)
        if r:
            out.append(r)
    return out


def _web_area(view, hole, depth, co, tris):
    """The cells the web covers. The see-through gap is only where nothing at
    any depth is in the way; at the web's own depth the model is often further
    back (a loincloth hanging in front of the crotch, a calf bulging forward),
    and the web has to go all the way to it or it leaves holes. So: spread from
    the gap through the air at the web's depth until the model closes it in, then
    reach MARGIN into the model all round. Returns the mask."""
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    tree = BVHTree.FromPolygons([tuple(v) for v in co], [tuple(t) for t in tris])
    state = np.zeros(hole.shape, np.int8)  # 0 untested, 1 air, 2 model, at the web's depth
    state[hole] = 1

    def test(mask):
        ys, xs = np.nonzero(mask & (state == 0))
        for j, i in zip(ys, xs):
            p = Vector(view.point(j, i, depth))
            hit = tree.find_nearest(p)
            inside = hit[0] is not None and (p - hit[0]).dot(hit[1]) < 0
            state[j, i] = 2 if inside else 1

    near = _grow(view.solid, 1)  # the model as seen, closed over hairline cracks as the gap was found
    outside = ~near & (view.lab == 0)  # open air round the model
    m = max(1, int(round(MARGIN / view.cell)))

    def spread(limit):
        reg = hole.copy()
        for _ in range(limit):
            front = _grow(reg, 1) & ~reg & near
            test(front)
            new = front & (state == 1)
            if not new.any():
                return reg, False
            reg |= new
            if (_grow(reg, 1) & outside).any():
                return reg, True  # the air at this depth gets out round the model
        return reg, True

    reg, leaked = spread(int(FILL_MM / view.cell))
    if leaked:
        reg, _ = spread(max(1, int(FILL_LEAK_MM / view.cell)))
        reg &= ~_grow(outside, 1)
    edge = _grow(reg, m) & ~reg & view.solid
    test(edge)
    return reg | (edge & (state == 2))


def _clean(mask):
    """No cells that touch only at a corner (the mesh would pinch there)."""
    for _ in range(20):
        a, b, c, d = mask[:-1, :-1], mask[:-1, 1:], mask[1:, :-1], mask[1:, 1:]
        diag = (a & d & ~b & ~c) | (b & c & ~a & ~d)
        if not diag.any():
            return mask
        ys, xs = np.nonzero(diag)
        mask[ys, xs + 1] = True
        mask[ys + 1, xs] = True
    return mask


def web_solid(latex_obj, point, az, tilt, thick=1.0, name="ms_tmp_web"):
    """The web as a closed solid in place. Returns (object, info) or raises."""
    co, tris = ms._world_tris(latex_obj)
    cell = _fine(co)
    a, view, hole, s = _gap_at(co, tris, direction(az, tilt), cell, point, reach_mm=15.0)
    if hole is None:
        raise RuntimeError("There's no closed gap there from this angle. Turn or tilt it back, or click the gap again.")
    depth = _depth(view, hole, s)
    if depth is None:
        raise RuntimeError("Couldn't tell where the gap's edges are.")
    # out to the model at the web's depth, then into it all round
    m = max(1, int(round(MARGIN / cell)))
    area = _web_area(view, hole, depth, co, tris)
    mask = _grow(area, 1)
    mask = ~_grow(~mask, 1)  # close small notches
    mask = _clean(mask & _grow(area, 1))
    H, W = mask.shape
    ys, xs = np.nonzero(mask)
    # one vertex per used grid corner, on each face of the sheet
    corners = np.unique(np.concatenate([ys * (W + 1) + xs, ys * (W + 1) + xs + 1,
                                        (ys + 1) * (W + 1) + xs, (ys + 1) * (W + 1) + xs + 1]))
    vid = {int(c): k for k, c in enumerate(corners)}
    nc = len(corners)
    cj, ci = corners // (W + 1), corners % (W + 1)
    px = view.lo[0] + ci * view.cell
    py = view.lo[1] + cj * view.cell
    base = np.outer(px, view.u) + np.outer(py, view.v)
    top = base + view.d * (depth + thick / 2)
    bot = base + view.d * (depth - thick / 2)
    bm = bmesh.new()
    verts = [bm.verts.new(p) for p in np.vstack([top, bot])]
    def V(j, i, layer):
        return verts[vid[j * (W + 1) + i] + layer * nc]
    for j, i in zip(ys, xs):
        q = [(j, i), (j, i + 1), (j + 1, i + 1), (j + 1, i)]
        bm.faces.new([V(a, b, 0) for a, b in q])
        bm.faces.new([V(a, b, 1) for a, b in reversed(q)])
        for (j1, i1), (j2, i2), (nj, ni) in (((j, i), (j, i + 1), (j - 1, i)), ((j, i + 1), (j + 1, i + 1), (j, i + 1)),
                                             ((j + 1, i + 1), (j + 1, i), (j + 1, i)), ((j + 1, i), (j, i), (j, i - 1))):
            if not (0 <= nj < H and 0 <= ni < W and mask[nj, ni]):
                bm.faces.new([V(j1, i1, 0), V(j1, i1, 1), V(j2, i2, 1), V(j2, i2, 0)])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bmesh.ops.dissolve_limit(bm, angle_limit=0.0005, verts=bm.verts[:], edges=bm.edges[:])
    obj = ms._new_obj(name, bm)
    info = {"point": [float(x) for x in point], "az": float(az), "tilt": float(tilt), "thick": float(thick),
            "area": round(float(hole.sum()) * cell * cell / 100.0, 1), "depth": depth}
    return obj, info


def add_web(latex_obj, point, az, tilt, thick=1.0):
    """The model with the web joined on. Returns (object, info)."""
    w, info = web_solid(latex_obj, point, az, tilt, thick)
    me = latex_obj.data.copy()
    me.transform(latex_obj.matrix_world)
    work = ms._new_obj("ms_tmp_webbed", me)
    if ms._open_edges(work.data):
        bm = bmesh.new()
        bm.from_mesh(work.data)
        bm.from_mesh(w.data)
        bm.to_mesh(work.data)
        bm.free()
    else:
        v0 = ms._volume(work)
        ms._fast_union(work, w)
        if ms._volume(work) <= v0 * 1.00001 or ms._open_edges(work.data):
            ms._remove(w)
            ms._remove(work)
            raise RuntimeError("The web didn't join the model cleanly; try Repair mesh first, or turn it a little.")
    ms._remove(w)
    return work, info
