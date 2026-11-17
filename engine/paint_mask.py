"""Paint mask: a thin printed cover that sits over part of a model, with
openings where the paint should go.

The area to cover is a distance field on the model's corners, in mm: below
zero inside the mask, above zero outside, zero on its edge. The screen builds
it from the outlines drawn on the model (and the brush, and the raised
features found here), so an edge drawn as an ellipse stays an ellipse however
big the scan's triangles are: the model is cut exactly along the zero line.
That patch of the surface is lifted off the model by the gap and thickened by
the mask's thickness, so the mask follows the model's own shape and sits just
clear of the paint. Walls round every edge close it into a solid that prints.
Round the openings it thins down to a fine edge, so the spray reaches right to
the surface and the paint line is crisp.

Plain numpy, so it runs (and is tested) without Blender."""
import base64

import numpy as np

OUT = 100.0  # "nowhere near the mask", in mm


def screen_ids(co, tris):
    """How the screen numbers the model's corners: the preview STL lists each
    triangle's three corners, and the screen gives each new position (float32,
    exactly) the next number. Returns (id of each server corner, count)."""
    pos = (np.asarray(co, dtype=np.float32)[np.asarray(tris).reshape(-1)] + np.float32(0)).view(np.int32).reshape(-1, 3)
    _, first, inv = np.unique(pos, axis=0, return_index=True, return_inverse=True)
    inv = inv.reshape(-1)
    order = np.argsort(first, kind="stable")
    rank = np.empty(len(first), dtype=np.int64)
    rank[order] = np.arange(len(first))
    sid = np.full(len(co), -1, dtype=np.int64)
    sid[np.asarray(tris).reshape(-1)] = rank[inv]
    return sid, len(first)


def field_from_b64(b64, co, tris):
    """The screen's field (float32 per screen corner, base64) as one value per server corner."""
    sid, n = screen_ids(co, tris)
    try:
        f = np.frombuffer(base64.b64decode(b64), dtype="<f4").astype(np.float64)
    except Exception:
        raise ValueError("The mask didn't come through. Draw it again.")
    if len(f) != n:
        raise ValueError("The mask doesn't match this scan. Draw it again.")
    out = np.full(len(co), OUT)
    ok = sid >= 0
    out[ok] = f[sid[ok]]
    return out


def screen_mesh(co, tris, splits_b64=""):
    """The model as the screen has it for painting the mask: corners in the
    screen's numbering, plus the extra detail it added where the mask's edge
    runs. Each split (a, b) put a new corner halfway along edge a-b (numbered
    next) and cut both triangles on that edge in two. Returns (verts, tris)."""
    co = np.asarray(co, dtype=np.float64)
    tris = np.asarray(tris, dtype=np.int64)
    sid, n = screen_ids(co, tris)
    V = np.zeros((n, 3))
    ok = sid >= 0
    V[sid[ok]] = co[ok]
    T = sid[tris]
    T = T[(T >= 0).all(1)]
    try:
        S = np.frombuffer(base64.b64decode(splits_b64 or ""), dtype="<i4").reshape(-1, 2) if splits_b64 else np.zeros((0, 2), dtype=np.int64)
    except Exception:
        raise ValueError("The mask's extra detail didn't come through. Draw it again.")
    if not len(S):
        return V, T
    T = [list(map(int, t)) for t in T]
    V = list(map(tuple, V))
    edges = {}
    for i, (a, b, c) in enumerate(T):
        for x, y in ((a, b), (b, c), (c, a)):
            edges.setdefault((min(x, y), max(x, y)), set()).add(i)

    def drop(i):
        a, b, c = T[i]
        for x, y in ((a, b), (b, c), (c, a)):
            edges[(min(x, y), max(x, y))].discard(i)

    def put(i, tri):
        T[i] = tri
        a, b, c = tri
        for x, y in ((a, b), (b, c), (c, a)):
            edges.setdefault((min(x, y), max(x, y)), set()).add(i)
    for a, b in S:
        a, b = int(a), int(b)
        if not (0 <= a < len(V) and 0 <= b < len(V)):
            raise ValueError("The mask's extra detail doesn't match this scan. Draw it again.")
        m = len(V)
        V.append(tuple((np.array(V[a]) + np.array(V[b])) / 2))
        for i in list(edges.get((min(a, b), max(a, b)), ())):
            t = T[i]
            k = next(k for k in range(3) if {t[k], t[(k + 1) % 3]} == {a, b})
            p, q, r = t[k], t[(k + 1) % 3], t[(k + 2) % 3]
            drop(i)
            put(i, [p, m, r])
            T.append(None)
            put(len(T) - 1, [m, q, r])
    return np.array(V), np.array(T, dtype=np.int64)


def field_from_list(b64, n):
    """The screen's field for its own (finer) mesh: one float32 per corner."""
    try:
        f = np.frombuffer(base64.b64decode(b64), dtype="<f4").astype(np.float64)
    except Exception:
        raise ValueError("The mask didn't come through. Draw it again.")
    if len(f) != n:
        raise ValueError("The mask doesn't match this scan. Draw it again.")
    return f


def to_b64(values):
    return base64.b64encode(np.asarray(values, dtype="<f4").tobytes()).decode("ascii")


def _weld(co, tris, tol=1e-5):
    """Shared corners for triangles that only touch by position (STL-style)."""
    key = np.round(co / tol).astype(np.int64)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inv = inv.reshape(-1)
    return co[first], inv[tris]


def _vertex_normals(co, tris, smooth=2):
    """Area-weighted corner normals, pointing out of the model, smoothed a
    little over their neighbours so scan noise doesn't make the mask bumpy."""
    a, b, c = co[tris[:, 0]], co[tris[:, 1]], co[tris[:, 2]]
    fn = np.cross(b - a, c - a)  # length = 2 * area
    cen = (a + b + c) / 3
    area = np.linalg.norm(fn, axis=1)
    mid = (cen * area[:, None]).sum(0) / max(area.sum(), 1e-30)
    if np.sum(np.einsum("ij,ij->i", cen - mid, fn)) < 0:  # wound inside out
        fn, tris = -fn, tris[:, ::-1]
    vn = np.zeros_like(co)
    for k in range(3):
        np.add.at(vn, tris[:, k], fn)
    for _ in range(smooth):
        acc = vn.copy()
        for i, j in ((0, 1), (1, 2), (2, 0)):
            np.add.at(acc, tris[:, i], vn[tris[:, j]])
            np.add.at(acc, tris[:, j], vn[tris[:, i]])
        vn = acc
    ln = np.linalg.norm(vn, axis=1)
    ln[ln == 0] = 1
    return vn / ln[:, None], tris


def _boundary(tris):
    """Directed open edges (a->b as wound in their triangle) of a patch, and
    the patch's triangles with any that share an edge with two or more others
    taken out (they'd make the mask non-manifold)."""
    for _ in range(4):
        e = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
        und = np.sort(e, axis=1)
        _, inv, cnt = np.unique(und, axis=0, return_inverse=True, return_counts=True)
        inv = inv.reshape(-1)
        bad = cnt[inv] > 2
        if not bad.any():
            return e[cnt[inv] == 1], tris
        drop = np.zeros(len(tris), dtype=bool)
        drop[np.flatnonzero(bad) % len(tris)] = True
        tris = tris[~drop]
    return e[cnt[inv] == 1], tris


def _loops(bedges):
    """Open edges chained into loops: list of vertex-index arrays."""
    nxt = {}
    for a, b in bedges:
        nxt.setdefault(int(a), []).append(int(b))
    loops, used = [], set()
    for a0, b0 in bedges:
        if (int(a0), int(b0)) in used:
            continue
        loop, a, b = [int(a0)], int(a0), int(b0)
        used.add((a, b))
        while b != loop[0]:
            loop.append(b)
            cand = [c for c in nxt.get(b, []) if (b, c) not in used]
            if not cand:
                break
            a, b = b, cand[0]
            used.add((a, b))
        loops.append(np.array(loop))
    return loops


def _components(tris, nv):
    """Connected patch pieces (sharing a corner): component id per triangle."""
    parent = np.arange(nv)

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for t in tris:
        r0 = find(t[0])
        for v in t[1:]:
            r = find(v)
            if r != r0:
                parent[r] = r0
    roots = np.array([find(v) for v in range(nv)])
    return roots


def _dist_to(pts, targets, chunk=4096):
    """Distance from each point to the nearest target point (brute force, in chunks)."""
    if not len(targets):
        return np.full(len(pts), np.inf)
    out = np.empty(len(pts))
    tt = (targets ** 2).sum(1)
    for s in range(0, len(pts), chunk):
        p = pts[s:s + chunk]
        d2 = (p ** 2).sum(1)[:, None] - 2 * p @ targets.T + tt[None, :]
        out[s:s + chunk] = np.sqrt(np.maximum(d2.min(1), 0))
    return out


def _cut(co, vn, tris, f):
    """The part of the surface where f < 0, cut exactly along f = 0: new
    corners where an edge crosses zero (shared by both triangles on that
    edge, so the patch stays in one piece). Returns (co, normals, patch tris)."""
    f = f.copy()
    f[np.abs(f) < 1e-4] = 1e-4  # no corner sits right on the edge (no sliver triangles)
    ins = f < 0
    k = ins[tris].sum(1)
    keep = [tris[k == 3]]
    new_co, new_n, cache = [], [], {}
    base = len(co)

    def cross(a, b):
        key = (a, b) if a < b else (b, a)
        i = cache.get(key)
        if i is None:
            t = f[a] / (f[a] - f[b])
            new_co.append(co[a] + t * (co[b] - co[a]))
            m = vn[a] + t * (vn[b] - vn[a])
            new_n.append(m / (np.linalg.norm(m) or 1))
            i = cache[key] = base + len(new_co) - 1
        return i
    out = []
    for t3, kk in zip(tris[(k == 1) | (k == 2)], k[(k == 1) | (k == 2)]):
        a, b, c = (int(x) for x in t3)
        # turn the triangle so its odd corner out is first
        for _ in range(3):
            if (kk == 1 and ins[a]) or (kk == 2 and not ins[a]):
                break
            a, b, c = b, c, a
        if kk == 1:  # a inside
            out.append((a, cross(a, b), cross(a, c)))
        else:  # b, c inside, a outside
            pab, pac = cross(a, b), cross(a, c)
            out.append((pab, b, c))
            out.append((pab, c, pac))
    if out:
        keep.append(np.array(out, dtype=np.int64))
    if new_co:
        co = np.vstack([co, np.array(new_co)])
        vn = np.vstack([vn, np.array(new_n)])
    return co, vn, np.vstack(keep) if keep else np.zeros((0, 3), dtype=np.int64)


def _taubin(P, tris, fixed, passes=4, lam=0.5, mu=-0.53):
    """Smooth the patch's own surface a little (without shrinking it), so a
    low-detail scan's flat facets don't print into the mask."""
    e = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    e = np.unique(np.sort(e, 1), axis=0)
    nv = len(P)
    deg = np.bincount(e.ravel(), minlength=nv).astype(float)
    deg[deg == 0] = 1
    P = P.copy()
    for _ in range(passes):
        for w in (lam, mu):
            s = np.zeros_like(P)
            for k in range(3):
                s[:, k] = np.bincount(e[:, 0], P[e[:, 1], k], nv) + np.bincount(e[:, 1], P[e[:, 0], k], nv)
            step = w * (s / deg[:, None] - P)
            step[fixed] = 0
            P += step
    return P


PINHOLE_MM = 12.0  # an opening with a shorter edge than this (about 4 mm across), or round just one corner or two, is filled in


def build(co, tris, field, thickness=1.2, gap=0.1, fine_edge=True, edge_mm=0.45, smooth=True, lip_mm=0.0, lip_t_mm=1.6):
    """The mask as a closed mesh: (verts, tris, info).

    co, tris: the whole model (world space, mm); field: one value per corner of
    co, below zero where the mask goes. gap: how far the mask sits off the
    model's surface (negative tucks it in, e.g. to fit a cast when the scan is
    of the latex). fine_edge: thin down to edge_mm round the openings.
    lip_mm: a collar this tall standing up off the outside edge, lip_t_mm
    thick, to tape the mask down by (0 = none)."""
    co = np.asarray(co, dtype=np.float64)
    tris = np.asarray(tris, dtype=np.int64)
    field = np.asarray(field, dtype=np.float64)
    if len(field) != len(co):
        raise ValueError("The mask doesn't match this scan. Draw it again.")
    if not (field < 0).any():
        raise ValueError("Select the area the mask should cover first.")
    thickness, gap = float(thickness), float(gap)
    if not (0.2 <= thickness <= 20):
        raise ValueError("Mask thickness must be from 0.2 to 20 mm.")
    key = np.round(co / 1e-5).astype(np.int64)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    co, tris, field = co[first], inv.reshape(-1)[tris], field[first]
    vn, tris = _vertex_normals(co, tris)  # normals from the whole model, so the edges agree
    co, vn, patch = _cut(co, vn, tris, field)
    a, b, c = co[patch[:, 0]], co[patch[:, 1]], co[patch[:, 2]]
    ar = np.linalg.norm(np.cross(b - a, c - a), axis=1)
    patch, ar = patch[ar > 1e-10], ar[ar > 1e-10]
    # stray specks (a sliver caught on the far side of an ear, say) aren't worth printing
    if len(patch):
        roots = _components(patch, len(co))[patch[:, 0]]
        u, inv = np.unique(roots, return_inverse=True)
        tot = np.bincount(inv, ar)
        patch = patch[tot[inv] >= max(0.05 * tot.max(), 200.0)]  # area here is doubled: 1 cm2
    bedges, patch = _boundary(patch)
    if not len(patch):
        raise ValueError("The selected area is too small to make a mask from.")
    # just the corners the patch uses, numbered afresh
    used = np.unique(patch)
    remap = -np.ones(len(co), dtype=np.int64)
    remap[used] = np.arange(len(used))
    P, N = co[used], vn[used]
    patch, bedges = remap[patch], remap[bedges]
    nv = len(P)
    # each piece's longest open loop is its outside edge; the rest are openings
    loops = _loops(bedges)
    comp = _components(patch, nv)
    longest = {}
    for i, lp in enumerate(loops):
        L = float(np.linalg.norm(P[lp] - P[np.roll(lp, -1)], axis=1).sum())
        r = comp[lp[0]]
        if r not in longest or L > longest[r][0]:
            longest[r] = (L, i)
    outer = {i for _, i in longest.values()}
    holes = [lp for i, lp in enumerate(loops) if i not in outer]
    # pinholes (where a drawn outline grazed a hidden corner, say) are filled in:
    # a fan of triangles from the middle of each
    bset = {(int(a), int(b)) for a, b in bedges}
    perim = lambda lp: float(np.linalg.norm(P[lp] - P[np.roll(lp, -1)], axis=1).sum())
    pin = [lp for lp in holes if (perim(lp) < PINHOLE_MM or len(lp) <= 8) and (int(lp[-1]), int(lp[0])) in bset]
    if pin:
        holes = [lp for lp in holes if not any(lp is q for q in pin)]
        addP, addN, addF, gone = [], [], [], set()
        for lp in pin:
            c = nv + len(addP)
            addP.append(P[lp].mean(0))
            n = N[lp].sum(0)
            addN.append(n / (np.linalg.norm(n) or 1))
            for a, b in zip(lp, np.roll(lp, -1)):
                addF.append((int(b), int(a), c))
                gone.add((int(a), int(b)))
        P, N = np.vstack([P, addP]), np.vstack([N, addN])
        patch = np.vstack([patch, np.array(addF, dtype=np.int64)])
        bedges = np.array([e for e in bedges if (int(e[0]), int(e[1])) not in gone], dtype=np.int64).reshape(-1, 2)
        comp = _components(patch, len(P))
        nv = len(P)
    P = P.copy()
    if smooth:
        P = _taubin(P, patch, np.zeros(nv, dtype=bool))
    t = np.full(nv, thickness)
    if fine_edge and holes and thickness > edge_mm:
        hv = np.unique(np.concatenate(holes))
        d = _dist_to(P, P[hv])
        reach = max(3 * thickness, 2.0)
        t = np.minimum(thickness, edge_mm + (thickness - edge_mm) * d / reach)
    inner = P + N * gap
    outer_v = P + N * (gap + t)[:, None]
    V = np.vstack([inner, outer_v])
    F = [patch[:, ::-1], patch + nv]  # inner faces the model, outer faces away
    lip_mm, lip_t_mm = float(lip_mm or 0), float(lip_t_mm or 0)
    lip_v = set()
    if lip_mm > 0 and lip_t_mm > 0:
        lip_v = {int(v) for i in outer for v in loops[i]}
    walls = np.array([not (int(a) in lip_v and int(b) in lip_v) for a, b in bedges], dtype=bool) if len(bedges) else np.zeros(0, dtype=bool)
    ea, eb = bedges[walls, 0], bedges[walls, 1]
    F.append(np.stack([eb + nv, ea + nv, ea], 1))
    F.append(np.stack([eb + nv, ea, eb], 1))
    if lip_v:
        # the outside edge's wall becomes a collar: from the inner face out
        # along the model by lip_t_mm, up lip_mm past the outer face, back in
        # and down onto the outer face
        third = {}
        for x, y, z in patch:
            third[(int(x), int(y))] = int(z)
            third[(int(y), int(z))] = int(x)
            third[(int(z), int(x))] = int(y)
        lip_e = bedges[~walls]
        out_dir = np.zeros((len(P), 3))
        for a, b in lip_e:
            e = P[b] - P[a]
            o = np.cross(e, N[a] + N[b])
            c = third.get((int(a), int(b)))
            if c is not None and o @ (P[c] - (P[a] + P[b]) / 2) > 0:
                o = -o
            ln = np.linalg.norm(o)
            if ln > 0:
                out_dir[a] += o / ln
                out_dir[b] += o / ln
        # the lip stands straight up the way the mask faces (the way it prints
        # dome up), not along the model's own surface: a wall swept one way
        # can't fan out or fold over itself round a tight bend such as an ear
        U = (outer_v - inner).sum(0)
        U /= np.linalg.norm(U) or 1.0
        # it follows the edge smoothed over about 3 mm, so a ragged stretch
        # of edge (where it runs along an ear's outline, say) still gets an
        # even wall; the strip along its foot and its top close the gap
        O = np.zeros((len(P), 3))
        Si, So = inner.copy(), outer_v.copy()
        for i in outer:
            lp = np.asarray(loops[i])
            seg = np.linalg.norm(P[lp] - P[np.roll(lp, -1)], axis=1).mean() or 1.0
            si, so = inner[lp].copy(), outer_v[lp].copy()
            for _ in range(int(min(400, max(2, (3.0 / seg) ** 2)))):
                for A in (si, so):
                    A[:] = 0.25 * np.roll(A, 1, 0) + 0.5 * A + 0.25 * np.roll(A, -1, 0)
            Si[lp], So[lp] = si, so
            tan = np.roll(si, -1, 0) - np.roll(si, 1, 0)
            tan -= U * (tan @ U)[:, None]
            o = np.cross(tan, U)
            o /= np.maximum(np.linalg.norm(o, axis=1), 1e-9)[:, None]
            # which side is out: the side the edge's own outward steps lean to
            if np.einsum("ij,ij->", o, out_dir[lp]) < 0:
                o = -o
            for _ in range(int(min(100, max(2, (1.0 / seg) ** 2)))):
                o = 0.25 * np.roll(o, 1, 0) + 0.5 * o + 0.25 * np.roll(o, -1, 0)
            o -= U * (o @ U)[:, None]
            O[lp] = o / np.maximum(np.linalg.norm(o, axis=1), 1e-9)[:, None]
        vs = np.array(sorted(lip_v))
        O = O[vs]
        base = len(V)
        k = {int(v): j for j, v in enumerate(vs)}
        foot = Si[vs] + O * lip_t_mm
        top_i = So[vs] + U * lip_mm
        top_o = top_i + O * lip_t_mm
        V = np.vstack([V, foot, top_o, top_i])
        m = len(vs)
        prof = lambda v: [v, base + k[v], base + m + k[v], base + 2 * m + k[v], v + nv]  # inner, foot, top out, top in, outer
        for a, b in lip_e:
            pa, pb = prof(int(a)), prof(int(b))
            for s_ in range(4):
                xa, ya, xb, yb = pa[s_], pa[s_ + 1], pb[s_], pb[s_ + 1]
                F.append(np.array([[yb, ya, xa], [yb, xa, xb]]))
    F = np.vstack(F)
    area = 0.5 * np.linalg.norm(np.cross(P[patch[:, 1]] - P[patch[:, 0]], P[patch[:, 2]] - P[patch[:, 0]]), axis=1).sum()
    lo, hi = V.min(0), V.max(0)
    info = {"openings": len(holes), "pieces": len(longest), "area_cm2": round(float(area) / 100, 1),
            "size_mm": [round(float(x), 1) for x in hi - lo], "thickness_mm": thickness, "gap_mm": gap,
            "fine_edge": bool(fine_edge and holes), "smooth": bool(smooth), "triangles": int(len(F)),
            "lip_mm": lip_mm if lip_v else 0, "layer_corners": int(nv)}
    return V, F, info


def print_pose(V, F, layer=None):
    """Turned so it prints dome up (the side away from the model on top), set
    on the plate at z = 0: the 4x4 that does it."""
    # build() puts the inner layer first and the outer layer second, corner for
    # corner: the mean step from one to the other is the way the mask faces
    half = int(layer) if layer else len(V) // 2
    n = (V[half:2 * half] - V[:half]).sum(0)
    ln = np.linalg.norm(n)
    R = np.eye(3)
    if ln > 1e-9:
        n = n / ln
        z = np.array([0.0, 0.0, 1.0])
        v = np.cross(n, z)
        s, cth = np.linalg.norm(v), float(n @ z)
        if s < 1e-9:
            R = np.eye(3) if cth > 0 else np.diag([1.0, -1.0, -1.0])
        else:
            K = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
            R = np.eye(3) + K + K @ K * ((1 - cth) / s ** 2)
    W = V @ R.T
    M = np.eye(4)
    M[:3, :3] = R
    M[2, 3] = -W[:, 2].min()
    return M


def _edges(tris):
    e = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    return np.unique(np.sort(e, 1), axis=0)


def _diffuse(co, E, iters, lam=0.6):
    nv = len(co)
    deg = np.bincount(E.ravel(), minlength=nv).astype(float)
    deg[deg == 0] = 1
    x = co.copy()
    for _ in range(iters):
        s = np.zeros_like(x)
        for k in range(x.shape[1]):
            s[:, k] = np.bincount(E[:, 0], x[E[:, 1], k], nv) + np.bincount(E[:, 1], x[E[:, 0], k], nv)
        x += lam * (s / deg[:, None] - x)
    return x


def _labels(mask, E, n):
    """Connected parts of the corners in mask (one root id per corner, -1 off it)."""
    parent = np.arange(n)

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for a, b in E[mask[E[:, 0]] & mask[E[:, 1]]]:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    lab = np.full(n, -1)
    idx = np.flatnonzero(mask)
    lab[idx] = [find(v) for v in idx]
    return lab


def _grow(m, E, within, k):
    for _ in range(k):
        x = m[E[:, 0]] | m[E[:, 1]]
        g = np.zeros_like(m)
        g[E[x].ravel()] = True
        m = (m | g) & within
    return m


def _shrink(m, E, k):
    for _ in range(k):
        x = m[E[:, 0]] != m[E[:, 1]]
        b = np.zeros_like(m)
        b[E[x].ravel()] = True
        m = m & ~b
    return m


def find_raised(co, tris, feature_mm=None, most=8, area=None):
    """Raised parts like eyes inside the painted area: where the surface stands
    out from a smoothed copy of itself (smoothed over about feature_mm). A raised
    outline (an eye drawn as a rim with a pupil) counts with everything inside
    it. Returns a list, the ones to cut first, of {center, normal, width_mm,
    raised_mm, ring, cut, dist}: cut is True for the parts to open (rims round
    a hollow if there are any, else the biggest), and dist is the signed distance (mm) from each corner to the
    part's edge, below zero on it. area (a True per corner) is the painted part;
    without it the whole model is searched."""
    co = np.asarray(co, dtype=np.float64)
    tris = np.asarray(tris, dtype=np.int64)
    E = _edges(tris)
    el = float(np.linalg.norm(co[E[:, 0]] - co[E[:, 1]], axis=1).mean())
    size = float((co.max(0) - co.min(0)).max())
    area = np.ones(len(co), dtype=bool) if area is None else np.asarray(area, dtype=bool)
    if area.sum() < 20:
        return []
    # the smoothing reach is set by the scan, not by how big an area was drawn,
    # so the same eye is found whatever is drawn round it
    R = float(feature_mm) if feature_mm else min(0.04 * size, max(2.0, 4 * el))
    iters = int(min(3000, max(4, (R / max(el, 1e-6)) ** 2)))
    vn, _ = _vertex_normals(co, tris, smooth=1)
    d = np.einsum("ij,ij->i", co - _diffuse(co, E, iters), vn)
    d = _diffuse(d[:, None], E, 2)[:, 0]
    # the painted area's own edge: a part touching it isn't inside the area
    x = area[E[:, 0]] != area[E[:, 1]]
    edge = np.zeros(len(co), dtype=bool)
    edge[E[x].ravel()] = True
    edge &= area
    tri_area = 0.5 * np.linalg.norm(np.cross(co[tris[:, 1]] - co[tris[:, 0]], co[tris[:, 2]] - co[tris[:, 0]]), axis=1)
    v_area = np.bincount(tris.ravel(), np.repeat(tri_area / 3, 3), len(co))
    kmax = int(np.clip(round(0.6 / max(el, 1e-6)), 1, 2))  # gaps in a rim up to about half a mm

    def parts(level, k):
        """Raised parts (standing above the smoothed surface), with gaps in a
        rim up to k corners wide closed: grow, fill what the rim encloses,
        shrink back."""
        up = _grow(area & (d > level), E, area, k)
        low = area & ~up
        llab = _labels(low, E, len(co))
        open_ = set(np.unique(llab[edge & low]).tolist())
        filled = up.copy()
        for r in np.unique(llab[low]):
            if r not in open_:
                filled[llab == r] = True
        filled = _shrink(filled, E, k) & area
        lab = _labels(filled, E, len(co))
        return [lab == r for r in np.unique(lab[filled])]
    taken = np.zeros(len(co), dtype=bool)
    found = []
    span = float((co[area].max(0) - co[area].min(0)).max())
    # above the smoothed surface first; where the whole area bulges (so that
    # comes out as one big part) again higher up
    levels = [0.0] + [float(np.percentile(d[area], q)) for q in (60, 75, 90)]
    for level, k in [(lv, k) for lv in levels for k in range(kmax, -1, -1)]:
        for mask in parts(level, k):
            m = np.flatnonzero(mask)
            if len(m) < max(10, 0.002 * area.sum()) or edge[m].any() or taken[m].mean() > 0.3:
                continue
            c = co[m].mean(0)
            w = float(np.linalg.norm(co[m] - c, axis=1).max() * 2)
            if w > 0.5 * span or v_area[m].sum() < 0.45 * np.pi * (w / 2) ** 2:
                continue  # most of the area, or a long thin streak: not a rounded part
            taken |= mask
            inner = _shrink(mask, E, 1)  # a hollow inside it: a rim round a pupil, say
            ring = bool((inner & (d <= 0)).sum() >= max(3, 0.01 * inner.sum()))
            found.append((mask, m, c, w, ring))
    out = []
    for mask, m, c, w, ring in found:
        cross = E[mask[E[:, 0]] != mask[E[:, 1]]]
        inside = np.where(mask[cross[:, 0]], cross[:, 0], cross[:, 1])
        outside = np.where(mask[cross[:, 0]], cross[:, 1], cross[:, 0])
        pts = 0.5 * (co[inside] + co[outside])  # the edge: halfway across each edge leaving it
        near = np.linalg.norm(co - c, axis=1) < w / 2 + 80
        dist = np.full(len(co), OUT)
        dist[near] = _dist_to(co[near], pts)
        dist[mask] *= -1
        nrm = vn[m].sum(0)
        nrm /= np.linalg.norm(nrm) or 1
        lift = float(np.clip(d[m], 0, None) @ v_area[m] / v_area[m].sum())
        out.append({"center": c, "normal": nrm, "width_mm": w, "raised_mm": float(d[m].max()), "ring": ring,
                    "lift": lift, "score": lift * v_area[m].sum(), "dist": np.clip(dist, -OUT, OUT)})
    if out:  # far fainter than the strongest: the lie of the surface, not a feature
        top = max(o["lift"] for o in out)
        out = [o for o in out if o["lift"] >= 0.3 * top]
    # which to cut: a raised rim round a hollow (an eye drawn with a pupil) if
    # there is one, else the biggest; parts much smaller are left filled in
    pool = [o for o in out if o["ring"]] or out
    wmax = max((o["width_mm"] for o in pool), default=0)
    for o in out:
        o["cut"] = bool((o["ring"] or pool is out) and o["width_mm"] >= 0.65 * wmax)
    out.sort(key=lambda o: (not o["cut"], -o["score"]))
    return out[:most]
