"""Split a model that's too big for the printer into parts that fit, with a peg
on one side of each cut and a matching hole on the other."""
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

import mold_shell as ms


def _basis(n):
    n = Vector(n).normalized()
    a = Vector((1, 0, 0)) if abs(n.x) < 0.9 else Vector((0, 1, 0))
    u = n.cross(a).normalized()
    return n, u, n.cross(u)


def _section_segs(co, tris, p, n, u, v):
    """The cross-section where the plane (p, n) cuts the mesh, as 2D segments in (u, v)."""
    d = (co - np.array(p)) @ np.array(n)
    dt = d[tris]
    s = np.sign(dt)
    s[s == 0] = 1
    cross = ~((s[:, 0] == s[:, 1]) & (s[:, 1] == s[:, 2]))
    if not cross.any():
        return np.zeros((0, 2, 2))
    T, D = tris[cross], dt[cross]
    S = np.sign(D)
    S[S == 0] = 1
    # the odd one out: the vertex whose side differs from the other two
    odd = np.where(S[:, 0] == S[:, 1], 2, np.where(S[:, 0] == S[:, 2], 1, 0))
    i0 = odd
    i1, i2 = (odd + 1) % 3, (odd + 2) % 3
    r = np.arange(len(T))
    A, B, C = co[T[r, i0]], co[T[r, i1]], co[T[r, i2]]
    dA, dB, dC = D[r, i0], D[r, i1], D[r, i2]
    P1 = A + (B - A) * (dA / (dA - dB))[:, None]
    P2 = A + (C - A) * (dA / (dA - dC))[:, None]
    U, V = np.array(u), np.array(v)
    q1 = np.stack([(P1 - p) @ U, (P1 - p) @ V], 1)
    q2 = np.stack([(P2 - p) @ U, (P2 - p) @ V], 1)
    return np.stack([q1, q2], 1)


def _raster(segs, cell):
    """Inside of the section on a grid (even-odd rule). Returns grid, origin."""
    pts = segs.reshape(-1, 2)
    lo = pts.min(0) - 2 * cell
    hi = pts.max(0) + 2 * cell
    nx, ny = int((hi[0] - lo[0]) / cell) + 1, int((hi[1] - lo[1]) / cell) + 1
    g = np.zeros((ny, nx), bool)
    x1, y1, x2, y2 = segs[:, 0, 0], segs[:, 0, 1], segs[:, 1, 0], segs[:, 1, 1]
    xc = lo[0] + (np.arange(nx) + 0.5) * cell
    for j in range(ny):
        y = lo[1] + (j + 0.5) * cell
        m = (y1 > y) != (y2 > y)
        if not m.any():
            continue
        xi = np.sort(x1[m] + (y - y1[m]) * (x2[m] - x1[m]) / (y2[m] - y1[m]))
        row = np.zeros(nx, int)
        idx = np.searchsorted(xc, xi)
        np.add.at(row, np.clip(idx, 0, nx - 1), 1)
        g[j] = (np.cumsum(row) % 2) == 1
    return g, lo


def _label(g):
    """Connected parts of the grid (4-neighbour): labels (0 = outside), count."""
    lab = np.zeros(g.shape, int)
    n = 0
    H, W = g.shape
    for j0, i0 in zip(*np.nonzero(g)):
        if lab[j0, i0]:
            continue
        n += 1
        stack = [(j0, i0)]
        lab[j0, i0] = n
        while stack:
            j, i = stack.pop()
            for jj, ii in ((j + 1, i), (j - 1, i), (j, i + 1), (j, i - 1)):
                if 0 <= jj < H and 0 <= ii < W and g[jj, ii] and not lab[jj, ii]:
                    lab[jj, ii] = n
                    stack.append((jj, ii))
    return lab, n


def _depth(g, cell):
    """Distance from each inside cell to the nearest outside one (mm), chamfer 3-4."""
    INF = 10 ** 9
    H, W = g.shape
    d = np.where(g, INF, 0).astype(np.int64)
    for j in range(H):  # forward
        row = d[j]
        if j:
            up = d[j - 1]
            row = np.minimum(row, up + 3)
            row[1:] = np.minimum(row[1:], up[:-1] + 4)
            row[:-1] = np.minimum(row[:-1], up[1:] + 4)
        for i in range(1, W):
            if row[i] > row[i - 1] + 3:
                row[i] = row[i - 1] + 3
        d[j] = row
    for j in range(H - 1, -1, -1):  # backward
        row = d[j]
        if j < H - 1:
            dn = d[j + 1]
            row = np.minimum(row, dn + 3)
            row[1:] = np.minimum(row[1:], dn[:-1] + 4)
            row[:-1] = np.minimum(row[:-1], dn[1:] + 4)
        for i in range(W - 2, -1, -1):
            if row[i] > row[i + 1] + 3:
                row[i] = row[i + 1] + 3
        d[j] = row
    return d / 3.0 * cell


def section_info(co, tris, p, n, cell=None):
    """What the cut would leave: area, the separate islands, and each island's
    deepest point (room for a peg)."""
    n, u, v = _basis(n)
    p = np.array(p, float)
    segs = _section_segs(co, tris, p, n, u, v)
    if not len(segs):
        return {"area": 0.0, "islands": []}
    span = float(np.ptp(segs.reshape(-1, 2), axis=0).max())
    cell = cell or max(0.5, span / 160.0)
    g, lo = _raster(segs, cell)
    lab, k = _label(g)
    dep = _depth(g, cell)
    isl = []
    for c in range(1, k + 1):
        m = lab == c
        area = float(m.sum()) * cell * cell
        if area < 4 * cell * cell:
            continue
        dd = np.where(m, dep, 0)
        j, i = np.unravel_index(int(np.argmax(dd)), dd.shape)
        isl.append({"area": area, "depth": float(dd[j, i]), "mask": m, "dep": dd,
                    "at": (j, i)})
    return {"area": float(g.sum()) * cell * cell, "islands": isl, "cell": cell, "lo": lo,
            "u": u, "v": v, "n": n, "p": p}


def _to_world(info, j, i):
    lo, cell = info["lo"], info["cell"]
    x, y = lo[0] + (i + 0.5) * cell, lo[1] + (j + 0.5) * cell
    return Vector(info["p"]) + info["u"] * x + info["v"] * y


def peg_spots(info, peg_d, most=3):
    """Where to put pegs on a cut: the deepest point of each island big enough
    for one, and a second (or third) on a big island, well apart."""
    need = peg_d / 2 + 2.0  # at least 2 mm of wall round the hole
    spots = []
    cell = info.get("cell", 1.0)
    for isl in info["islands"]:
        if isl["depth"] < need:
            continue
        dd = isl["dep"].copy()
        got = []
        for _ in range(most):
            j, i = np.unravel_index(int(np.argmax(dd)), dd.shape)
            if dd[j, i] < need:
                break
            got.append((j, i))
            # keep the next one well apart: 3 peg widths, or more on a big cut
            R = max(3 * peg_d, 0.3 * math.sqrt(isl["area"])) / cell
            jj, ii = np.ogrid[:dd.shape[0], :dd.shape[1]]
            dd[(jj - j) ** 2 + (ii - i) ** 2 < R * R] = 0
            if isl["area"] < (6 * peg_d) ** 2:
                break  # a small island needs just one
        spots += [_to_world(info, j, i) for j, i in got]
    return spots


def fits(dims, vol):
    """Does a part this size (x, y, z) fit the printer (W, D, H), turned about
    the vertical if that helps? Returns (fits, how many mm too big at worst)."""
    W, D, H = vol
    x, y, z = dims
    over = max(0.0, z - H)
    flat = min(max(0.0, x - W) + max(0.0, y - D), max(0.0, y - W) + max(0.0, x - D))
    return over == 0 and flat == 0, round(over + flat, 1)


def _footprint(co, angle_steps=18, vol=None):
    """Smallest x, y extent of the points turned about the vertical (0-90°).
    Given the printer, a turn that fits its bed wins over a smaller one that
    doesn't (a long thin part fits along the bed, not across its corner)."""
    best = fit = None
    for k in range(angle_steps + 1):
        a = math.radians(90.0 * k / angle_steps)
        c, s = math.cos(a), math.sin(a)
        x = co[:, 0] * c - co[:, 1] * s
        y = co[:, 0] * s + co[:, 1] * c
        e = (float(np.ptp(x)), float(np.ptp(y)))
        if best is None or e[0] * e[1] < best[0] * best[1]:
            best = e
        if vol is not None and fits(e + (0.0,), (vol[0], vol[1], 1e9))[0] and (fit is None or e[0] * e[1] < fit[0] * fit[1]):
            fit = e
    return fit or best


def _is_level(c):
    return abs(float(c["normal"][2])) > 0.9


def _levels(cuts):
    """Heights of the level cuts, lowest first. They split the model into
    bands: band 0 below the lowest, then up."""
    return np.array(sorted(float(c["point"][2]) for c in cuts if _is_level(c)))


def _band(z, levels):
    """Which band points at these heights are in (most of them)."""
    if not len(levels) or not len(z):
        return 0
    return int(np.median(np.searchsorted(levels, z, side="right")))


def _order(cuts):
    """Level cuts first (they go right through), then the upright ones, which
    may only cut one band."""
    return sorted(range(len(cuts)), key=lambda k: not _is_level(cuts[k]))


def _applies(c, pts, levels, cuts):
    """Does this cut go through the part with these points? A level cut goes
    through everything. An upright one can be kept to one band ("band") and
    to one side of other upright cuts ("within": [[cut index, +1 or -1]])."""
    if _is_level(c) or not len(pts):
        return True
    b = c.get("band")
    if b is not None and len(levels) and _band(pts[:, 2], levels) != int(b):
        return False
    for k, s in c.get("within") or []:
        k = int(k)
        if not 0 <= k < len(cuts):
            continue
        o = cuts[k]
        side = float(np.median((pts - np.array(o["point"], float)) @ np.array(o["normal"], float))) >= 0
        if side != (float(s) > 0):
            return False
    return True


def part_sizes(co, cuts, vol=None):
    """Rough size of each part the cuts make (by sorting points into them)."""
    groups = [np.ones(len(co), bool)]
    levels = _levels(cuts)
    for k in _order(cuts):
        c = cuts[k]
        p, n = np.array(c["point"], float), np.array(c["normal"], float)
        side = (co - p) @ n >= 0
        new = []
        for g in groups:
            if not _applies(c, co[g], levels, cuts):
                new.append(g)  # an upright cut kept to another part
                continue
            for s in (side, ~side):
                m = g & s
                if m.sum() > 10:
                    new.append(m)
        groups = new
    out = []
    for m in groups:
        pts = co[m]
        fx, fy = _footprint(pts[::max(1, len(pts) // 20000)], vol=vol)
        out.append({"dims": [round(fx, 1), round(fy, 1), round(float(np.ptp(pts[:, 2])), 1)],
                    "z": [round(float(pts[:, 2].min()), 1), round(float(pts[:, 2].max()), 1)],
                    "x0": float(pts[:, 0].min())})
    out.sort(key=lambda o: (round(o["z"][0] / 5), o.pop("x0")))  # bottom part first, like the saved files
    return out


def suggest(obj, vol, peg_d=8.0, margin=4.0):
    """Cuts so every part fits the printer: level cuts for height (each placed,
    within what still fits, where the cut is one solid island with room for a
    peg), then upright cuts if a part is still too wide."""
    W, D, H = [float(x) for x in vol]
    co, tris = ms._world_tris(obj)
    tris = np.asarray(tris)
    z0, z1 = float(co[:, 2].min()), float(co[:, 2].max())
    tall = z1 - z0
    room = H - margin
    cuts = []
    if tall > H:
        k = int(math.ceil(tall / room))
        prev = z0
        for c in range(1, k):
            lo = max(prev + 10.0, z1 - (k - c) * room)
            hi = min(prev + room, z1 - 10.0)
            if hi < lo:
                lo = hi = (lo + hi) / 2
            mid = z0 + tall * c / k
            best, bz = None, (lo + hi) / 2
            steps = max(1, int((hi - lo) / 2.0))
            for t in range(steps + 1):
                z = lo + (hi - lo) * t / steps
                info = section_info(co, tris, (0, 0, z), (0, 0, 1))
                isl = info["islands"]
                if not isl:
                    continue
                pegs_ok = all(i["depth"] >= peg_d / 2 + 2 for i in isl)
                score = (-len(isl) * 10 + (5 if pegs_ok else 0) + min(i["depth"] for i in isl) / max(peg_d, 1)
                         - abs(z - mid) / max(room, 1) * 2)
                if best is None or score > best:
                    best, bz = score, z
            cuts.append({"point": [0.0, 0.0, round(bz, 1)], "normal": [0.0, 0.0, 1.0], "kind": "level"})
            prev = bz
    # a band still too wide: upright cuts through that band only, so a part
    # that already fits isn't cut up for nothing
    levels = [c["point"][2] for c in cuts]
    edges = [-1e9] + levels + [1e9]
    cz = co[:, 2]
    tz = co[tris][:, :, 2].mean(1)
    for b in range(len(edges) - 1):
        m = (cz >= edges[b]) & (cz < edges[b + 1])
        if m.sum() < 10:
            continue
        sel = (tz >= edges[b]) & (tz < edges[b + 1])
        band = b if levels else None
        first = _axis_cuts(co[m], co, tris[sel], W, D, margin, peg_d, band, None, len(cuts), max(W, D))
        cuts += first
        # a part along the first cuts still too big: cut that part only, the other way
        if first:
            axis = 0 if first[0]["kind"] == "x" else 1
            at = [-1e9] + [c["point"][axis] for c in first] + [1e9]
            idx = list(range(len(cuts) - len(first), len(cuts)))
            for j in range(len(at) - 1):
                inp = m & (co[:, axis] >= at[j]) & (co[:, axis] < at[j + 1])
                tc = co[tris][:, :, axis].mean(1)
                within = ([[idx[j - 1], 1]] if j > 0 else []) + ([[idx[j], -1]] if j < len(idx) else [])
                cuts += _axis_cuts(co[inp], co, tris[sel & (tc >= at[j]) & (tc < at[j + 1])], W, D, margin, peg_d, band,
                                   within, len(cuts), min(W, D), axis=1 - axis)
        else:
            cuts += _axis_cuts(co[m], co, tris[sel], W, D, margin, peg_d, band, None, len(cuts), min(W, D), short=True)
    return cuts


def _axis_cuts(pts, co, tris, W, D, margin, peg_d, band, within, base, lim, axis=None, short=False):
    """Upright cuts along one axis so these points fit: each placed (within
    what still fits) where the cut is solid with room for pegs, and never so
    near the edge or another cut that it leaves a thin sliver."""
    out = []
    if len(pts) < 10:
        return out
    fx, fy = _footprint(pts[::max(1, len(pts) // 20000)], vol=(W, D))
    if fits((fx, fy, 0), (W, D, 1e9))[0]:
        return out
    ext = np.ptp(pts[:, :2], axis=0)
    if axis is None:
        axis = 0 if ext[0] >= ext[1] else 1
        if short:  # the long side fits: cut across the short one
            axis = 1 - axis
    for _ in (0,):
        e = float(ext[axis])
        if e <= lim:
            return out
        room = lim - margin
        k = int(math.ceil(e / room))
        a0, a1 = float(pts[:, axis].min()), float(pts[:, axis].max())
        least = max(15.0, 0.4 * e / k)  # no part thinner than this
        prev, at = a0, []
        for c in range(1, k):
            lo = max(prev + least, a1 - (k - c) * room)
            hi = min(prev + room, a1 - (k - c) * least)
            if hi < lo:
                lo = hi = (lo + hi) / 2
            mid = a0 + e * c / k
            nn = [0.0, 0.0, 0.0]
            nn[axis] = 1.0
            best, bx = None, mid if lo <= mid <= hi else (lo + hi) / 2
            steps = min(60, max(1, int((hi - lo) / 2.0)))
            for t in range(steps + 1):
                x = lo + (hi - lo) * t / steps
                pt = [0.0, 0.0, 0.0]
                pt[axis] = x
                isl = section_info(co, tris, pt, nn)["islands"] if len(tris) else []
                if not isl:
                    continue
                pegs_ok = all(i["depth"] >= peg_d / 2 + 2 for i in isl)
                score = (-len(isl) * 10 + (5 if pegs_ok else 0) + min(i["depth"] for i in isl) / max(peg_d, 1)
                         - abs(x - mid) / max(room, 1) * 2)
                if best is None or score > best:
                    best, bx = score, x
            pt = [0.0, 0.0, 0.0]
            pt[axis] = round(bx, 1)
            cut = {"point": pt, "normal": nn, "kind": "x" if axis == 0 else "y"}
            if band is not None:
                cut["band"] = band
            if within:
                cut["within"] = within
            out.append(cut)
            at.append(bx)
            prev = bx
    return out


def _peg_tool(spots, n, r, length, name):
    bm = bmesh.new()
    for q in spots:
        ms._cylinder(bm, q, n, r, length)
    return ms._new_obj(name, bm)


def _add_pegs(part, up, spots, n, peg_len, r, clear):
    """Pegs on part (the - side of the cut) at these spots, holes to match in up
    (the + side). How many went on, or None when the walls are too thin."""
    L = peg_len
    for side, sgn in ((up, 1), (part, -1)):
        sco, stris = ms._world_tris(side)
        tree = BVHTree.FromPolygons([tuple(x) for x in sco], [tuple(t) for t in stris])
        for q in spots:
            h = tree.ray_cast(q + n * sgn * 0.05, n * sgn, 1e5)
            if h[0] is not None:
                L = min(L, (h[0] - q).length - 2.0)  # not out through the far side
    L = max(0.0, L)
    if L < 3.0:
        return None
    peg = _peg_tool([q + n * (L / 2 - 1.0) for q in spots], n, r, L + 2.0, "ms_tmp_pegs")
    ms._fast_union(part, peg)
    ms._remove(peg)
    hole = _peg_tool([q + n * (L / 2 + 0.25) for q in spots], n, r + clear, L + 0.5 + 0.01, "ms_tmp_holes")
    ms._fast_bool(up, hole, "DIFFERENCE")
    ms._remove(hole)
    return len(spots)


def split(obj, cuts, peg_d=8.0, peg_len=10.0, clear=0.2, report=None, progress=None, pegs_on=True):
    """The parts, each a new object. Each cut: the piece on the + side of the
    plane gets the holes, the - side keeps a peg sticking out into them."""
    report = report if report is not None else {}
    me = obj.data.copy()
    me.transform(obj.matrix_world)
    parts = [ms._new_obj("ms_part", me)]
    co_all, _ = ms._world_tris(parts[0])
    size = float(np.ptp(co_all, axis=0).max()) * 4 + 100
    pegs = 0
    r = peg_d / 2
    levels = _levels(cuts)
    for step, k in enumerate(_order(cuts)):
        c = cuts[k]
        if progress:
            progress(f"Cutting {step + 1} of {len(cuts)}")
        p, n = Vector(c["point"]), Vector(c["normal"]).normalized()
        nxt = []
        for part in parts:
            co, tris = ms._world_tris(part)
            d = (co - np.array(p)) @ np.array(n)
            if d.min() >= -1e-6 or d.max() <= 1e-6 or not _applies(c, co, levels, cuts):
                nxt.append(part)  # this cut misses this part
                continue
            spots = peg_spots(section_info(co, tris, p, n), peg_d) if pegs_on else []
            hs = ms._halfspace(p, n, size)
            up = part.copy()
            up.data = part.data.copy()
            ms._collection().objects.link(up)
            ms._fast_bool(up, hs, "INTERSECT")
            ms._fast_bool(part, hs, "DIFFERENCE")
            ms._remove(hs)
            if not pegs_on:
                pass
            elif spots:
                got = _add_pegs(part, up, spots, n, peg_len, r, clear)
                if got is None:
                    report.setdefault("too_thin", []).append(k + 1)
                else:
                    pegs += got
            else:
                report.setdefault("no_room", []).append(k + 1)
            for o in (part, up):
                if len(o.data.polygons) and ms._volume(o) > 1.0:
                    nxt.append(o)
                else:
                    ms._remove(o)
        parts = nxt
    report["pegs"] = pegs
    return parts


# ---- shell pieces: as few parts as fit, no loose scraps ---------------------

def _signed_volume(co, tris):
    a, b, c = co[tris[:, 0]], co[tris[:, 1]], co[tris[:, 2]]
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum()) / 6.0


def _caps(co, tris, planes, eps=1e-3):
    """For each plane, the triangles lying flat on it (where a cut left a face)."""
    out = []
    for p, n in planes:
        on = np.abs((co - p) @ n) < eps
        out.append(np.where(on[tris].all(1))[0])
    return out


def split_regrouped(obj, cuts, vol, peg_d=8.0, peg_len=10.0, clear=0.2, report=None, progress=None):
    """Like split, for a shell piece: a flat cut through a curved wall can leave
    several separate bits on each side, so cut into all the bits first, then
    join bits back together across the cuts wherever the joined part still
    fits the printer. That leaves as few parts as fit, each in one piece, and
    no loose scraps. Pegs go where two parts still meet, if the wall has room."""
    report = report if report is not None else {}
    W, D, H = [float(x) for x in vol]
    orig_co, orig_tris = ms._world_tris(obj)
    orig_tris = np.asarray(orig_tris)
    if os.environ.get("GS_DEBUG_SPLIT"):
        ms._write_stl(os.path.join(os.environ["GS_DEBUG_SPLIT"], obj.name + ".stl"), orig_co, orig_tris)
    planes = [(np.array(c["point"], float), np.array(c["normal"], float) / np.linalg.norm(c["normal"])) for c in cuts]
    cells = split(obj, cuts, peg_d, peg_len, clear, report={}, progress=progress, pegs_on=False)
    # every separate bit, each its own object, the mesh kept as the cut left it
    frags = []  # (points, triangles, object)
    for o in cells:
        for q in ms._split_loose(o):
            co, tris = ms._world_tris(q)
            tris = np.asarray(tris)
            if abs(_signed_volume(co, tris)) < 1.0:
                ms._remove(q)  # a paper-thin fin, nothing to print
                continue
            frags.append((co, tris, q))
    if progress:
        progress("Joining the bits that fit together")
    # which bits touch across a cut, and by how much
    from mathutils.kdtree import KDTree
    capv = []
    for i, (co, tris, _) in enumerate(frags):
        on = np.zeros(len(co), bool)
        for p, n in planes:
            on |= np.abs((co - p) @ n) < 1e-3
        capv += [(i, v) for v in co[on]]
    touch = {}
    if capv:
        kd = KDTree(len(capv))
        for j, (_, v) in enumerate(capv):
            kd.insert(Vector(v), j)
        kd.balance()
        for i, v in capv:
            for _, j, _ in kd.find_range(Vector(v), 2e-3):
                g = capv[j][0]
                if g != i:
                    key = (min(i, g), max(i, g))
                    touch[key] = touch.get(key, 0) + 1
    touch = {k: v for k, v in touch.items() if v >= 6}  # both ways round: 3 points or more
    # join the smallest bits into a neighbour first, as long as the join still fits
    groups = {i: [i] for i in range(len(frags))}
    pts = {i: f[0][::max(1, len(f[0]) // 3000)] for i, f in enumerate(frags)}
    fvol = [abs(_signed_volume(f[0], f[1])) for f in frags]
    size = dict(enumerate(fvol))
    adj = dict(touch)
    while True:
        best = None
        for (a, b), cnt in adj.items():
            q = np.vstack([pts[a], pts[b]])
            if float(np.ptp(q[:, 2])) > H:
                continue
            if not fits(_footprint(q, vol=(W, D)) + (0.0,), (W, D, 1e9))[0]:
                continue
            key = (min(size[a], size[b]), -cnt)
            if best is None or key < best[0]:
                best = (key, a, b)
        if best is None:
            break
        _, a, b = best
        groups[a] += groups.pop(b)
        q = np.vstack([pts[a], pts.pop(b)])
        pts[a] = q[::max(1, len(q) // 3000)]
        size[a] += size.pop(b)
        nadj = {}
        for (x, y), cnt in adj.items():
            x, y = (a if x == b else x), (a if y == b else y)
            if x != y:
                key = (min(x, y), max(x, y))
                nadj[key] = nadj.get(key, 0) + cnt
        adj = nadj
    if os.environ.get("GS_DEBUG_SPLIT"):
        print("[split] cuts", cuts)
        for i, (co, tris, _) in enumerate(frags):
            print("[split] bit", i, np.ptp(co, 0).round(1).tolist(), round(abs(_signed_volume(co, tris))))
        print("[split] touch", touch)
        print("[split] groups", groups)
    # build each part: its bits joined into one solid (a bit that won't join
    # cleanly is printed on its own rather than risk a broken part)
    parts = []
    for gi, members in groups.items():
        members = sorted(members, key=lambda m: -fvol[m])
        target = frags[members[0]][2]
        for m in members[1:]:
            if ms._union_ok(target, frags[m][2]):
                ms._remove(frags[m][2])
            else:
                parts.append(frags[m][2])
        parts.append(target)
    # pegs where two parts still meet across a cut
    pegs, r = 0, peg_d / 2
    for k, (p, n) in enumerate(planes):
        spots = peg_spots(section_info(orig_co, orig_tris, p, n), peg_d)
        if not spots:
            continue
        info = []
        for o in parts:
            co, tris = ms._world_tris(o)
            tris = np.asarray(tris)
            cap = _caps(co, tris, [(p, n)])[0]
            side = float(np.median((co - p) @ n)) >= 0
            info.append((BVHTree.FromPolygons([tuple(x) for x in co], [tuple(t) for t in tris[cap]]) if len(cap) else None, side))
        pairs = {}
        for q in spots:
            lo = hi = None
            for j, (tree, side) in enumerate(info):
                if tree is not None and tree.find_nearest(q, 0.1)[0] is not None:
                    if side:
                        hi = j
                    else:
                        lo = j
            if lo is not None and hi is not None:
                pairs.setdefault((lo, hi), []).append(q)
        for (lo, hi), qs in pairs.items():
            got = _add_pegs(parts[lo], parts[hi], qs, Vector(n), peg_len, r, clear)
            if got is None:
                report.setdefault("too_thin", []).append(k + 1)
            else:
                pegs += got
    report["pegs"] = pegs
    report["bits"] = len(frags)
    return parts
