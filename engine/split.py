"""Split a model that's too big for the printer into parts that fit, with a peg
on one side of each cut and a matching hole on the other."""
import math

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


def _footprint(co, angle_steps=18):
    """Smallest x, y extent of the points turned about the vertical (0-90°)."""
    best = None
    for k in range(angle_steps + 1):
        a = math.radians(90.0 * k / angle_steps)
        c, s = math.cos(a), math.sin(a)
        x = co[:, 0] * c - co[:, 1] * s
        y = co[:, 0] * s + co[:, 1] * c
        e = (float(np.ptp(x)), float(np.ptp(y)))
        if best is None or e[0] * e[1] < best[0] * best[1]:
            best = e
    return best


def part_sizes(co, cuts):
    """Rough size of each part the cuts make (by sorting points into them)."""
    groups = [np.ones(len(co), bool)]
    for c in cuts:
        p, n = np.array(c["point"], float), np.array(c["normal"], float)
        side = (co - p) @ n >= 0
        new = []
        for g in groups:
            for s in (side, ~side):
                m = g & s
                if m.sum() > 10:
                    new.append(m)
        groups = new
    out = []
    for m in groups:
        pts = co[m]
        fx, fy = _footprint(pts[::max(1, len(pts) // 20000)])
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
    # still too wide: upright cuts through the whole model along its longer side
    fx, fy = _footprint(co[::max(1, len(co) // 20000)])
    for axis, ext, lim in ((0, float(np.ptp(co[:, 0])), max(W, D)), (1, float(np.ptp(co[:, 1])), min(W, D))):
        if fits((fx, fy, 0), (W, D, 1e9))[0]:
            break
        if ext <= lim:
            continue
        k = int(math.ceil(ext / (lim - margin)))
        a0 = float(co[:, axis].min())
        for c in range(1, k):
            pt = [0.0, 0.0, 0.0]
            pt[axis] = round(a0 + ext * c / k, 1)
            nn = [0.0, 0.0, 0.0]
            nn[axis] = 1.0
            cuts.append({"point": pt, "normal": nn, "kind": "x" if axis == 0 else "y"})
        if axis == 0:
            fx = ext / k
        else:
            fy = ext / k
    return cuts


def _peg_tool(spots, n, r, length, name):
    bm = bmesh.new()
    for q in spots:
        ms._cylinder(bm, q, n, r, length)
    return ms._new_obj(name, bm)


def split(obj, cuts, peg_d=8.0, peg_len=10.0, clear=0.2, report=None, progress=None):
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
    for k, c in enumerate(cuts):
        if progress:
            progress(f"Cutting {k + 1} of {len(cuts)}")
        p, n = Vector(c["point"]), Vector(c["normal"]).normalized()
        nxt = []
        for part in parts:
            co, tris = ms._world_tris(part)
            d = (co - np.array(p)) @ np.array(n)
            if d.min() >= -1e-6 or d.max() <= 1e-6:
                nxt.append(part)  # this cut misses this part
                continue
            info = section_info(co, tris, p, n)
            spots = peg_spots(info, peg_d)
            hs = ms._halfspace(p, n, size)
            up = part.copy()
            up.data = part.data.copy()
            ms._collection().objects.link(up)
            ms._fast_bool(up, hs, "INTERSECT")
            ms._fast_bool(part, hs, "DIFFERENCE")
            ms._remove(hs)
            if spots:
                # how far each peg may go: not out through the far side
                L = peg_len
                for side, sgn in ((up, 1), (part, -1)):
                    sco, stris = ms._world_tris(side)
                    tree = BVHTree.FromPolygons([tuple(x) for x in sco], [tuple(t) for t in stris])
                    for q in spots:
                        h = tree.ray_cast(q + n * sgn * 0.05, n * sgn, 1e5)
                        if h[0] is not None:
                            L = min(L, (h[0] - q).length - 2.0)
                L = max(0.0, L)
                if L >= 3.0:
                    peg = _peg_tool([q + n * (L / 2 - 1.0) for q in spots], n, r, L + 2.0, "ms_tmp_pegs")
                    ms._fast_union(part, peg)
                    ms._remove(peg)
                    hole = _peg_tool([q + n * (L / 2 + 0.25) for q in spots], n, r + clear, L + 0.5 + 0.01, "ms_tmp_holes")
                    ms._fast_bool(up, hole, "DIFFERENCE")
                    ms._remove(hole)
                    pegs += len(spots)
                else:
                    report.setdefault("too_thin", []).append(k + 1)
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
