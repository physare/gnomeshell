"""Paint mask: a thin printed cover that sits over part of a model, with
openings where the paint should go.

The person paints the area to cover on the model (and rubs out the openings,
such as the eyes). That patch of the model's surface is lifted off it by the
gap and thickened by the mask's thickness, so the mask follows the model's own
shape and sits just clear of the paint. The walls round every edge close it
into a solid that prints. Round the openings the mask thins down to a fine
edge, so the spray reaches right to the surface and the paint line is crisp.

Plain numpy, so it runs (and is tested) without Blender."""
import numpy as np


def ranges_to_mask(ranges, n):
    """[[start, length], ...] runs of picked triangles -> bool array of n."""
    sel = np.zeros(n, dtype=bool)
    for r in ranges or []:
        a, k = int(r[0]), int(r[1])
        if a < 0 or k <= 0 or a + k > n:
            raise ValueError("The painted mask doesn't match this scan. Paint it again.")
        sel[a:a + k] = True
    return sel


def mask_to_ranges(sel):
    sel = np.asarray(sel, dtype=bool)
    if not sel.any():
        return []
    d = np.diff(np.concatenate([[0], sel.astype(np.int8), [0]]))
    starts, ends = np.flatnonzero(d == 1), np.flatnonzero(d == -1)
    return [[int(a), int(b - a)] for a, b in zip(starts, ends)]


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


def build(co, tris, sel, thickness=1.2, gap=0.3, fine_edge=True, edge_mm=0.45):
    """The mask as a closed mesh: (verts, tris, info).

    co, tris: the whole model (world space, mm); sel: bool per triangle, the
    area to cover. gap: how far the mask sits off the model's surface
    (negative tucks it in, e.g. to fit a cast when the scan is of the latex).
    fine_edge: thin down to edge_mm round the openings."""
    co = np.asarray(co, dtype=np.float64)
    tris = np.asarray(tris, dtype=np.int64)
    sel = np.asarray(sel, dtype=bool)
    if len(sel) != len(tris):
        raise ValueError("The painted mask doesn't match this scan. Paint it again.")
    if not sel.any():
        raise ValueError("Paint the area the mask should cover first.")
    thickness, gap = float(thickness), float(gap)
    if not (0.2 <= thickness <= 20):
        raise ValueError("Mask thickness must be from 0.2 to 20 mm.")
    co, tris = _weld(co, tris)
    vn, tris = _vertex_normals(co, tris)  # normals from the whole model, so the edges agree
    patch = tris[sel]
    a, b, c = co[patch[:, 0]], co[patch[:, 1]], co[patch[:, 2]]
    patch = patch[np.linalg.norm(np.cross(b - a, c - a), axis=1) > 1e-12]
    bedges, patch = _boundary(patch)
    if not len(patch):
        raise ValueError("The painted area is too small to make a mask from.")
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
    # the painted edge follows the model's triangles, so it zigzags: smooth each
    # edge along itself so the openings (and so the paint line) come out clean
    P = P.copy()
    for lp in loops:
        if len(lp) < 6:
            continue
        for _ in range(4):
            P[lp] = 0.5 * P[lp] + 0.25 * (P[np.roll(lp, 1)] + P[np.roll(lp, -1)])
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
    ea, eb = bedges[:, 0], bedges[:, 1]
    F.append(np.stack([eb + nv, ea + nv, ea], 1))
    F.append(np.stack([eb + nv, ea, eb], 1))
    F = np.vstack(F)
    area = 0.5 * np.linalg.norm(np.cross(P[patch[:, 1]] - P[patch[:, 0]], P[patch[:, 2]] - P[patch[:, 0]]), axis=1).sum()
    lo, hi = V.min(0), V.max(0)
    info = {"openings": len(holes), "pieces": len(longest), "area_cm2": round(float(area) / 100, 1),
            "size_mm": [round(float(x), 1) for x in hi - lo], "thickness_mm": thickness, "gap_mm": gap,
            "fine_edge": bool(fine_edge and holes), "triangles": int(len(F))}
    return V, F, info


def print_pose(V, F):
    """Turned so it prints dome up (the side away from the model on top), set
    on the plate at z = 0: the 4x4 that does it."""
    # build() puts the inner layer first and the outer layer second, corner for
    # corner: the mean step from one to the other is the way the mask faces
    half = len(V) // 2
    n = (V[half:] - V[:half]).sum(0)
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
