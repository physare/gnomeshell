"""Clean up a fresh scan: take away the floor it was scanned on and anything
else in the background, and leave just the latex mold, closed underneath.

Phone and photo scans (KIRI, Polycam, the GnomeShell Scan app) come back with
the table or floor round the object, and often bits of whatever else was near
it. The floor is found as the biggest flat stretch of the scan; the scan is cut
just above the floor's highest bumps, everything not joined to the main object
is dropped (other things on the table, stray blobs), and the cut is filled flat.
The scan is turned so the floor is level, with the object standing on it.

A mold scanned on a bench or stool has a second flat stretch: the bench top,
with the legs under it. After the floor goes, the bench top is looked for too
(find_bench), and the scan is cut just above it as well.

keep_box keeps only what's inside a box the person sets round the mold, for
scans the automatic clean-up gets wrong."""
import math

import bmesh
import numpy as np
from mathutils import Matrix, Vector


def _faces(co, tris):
    a, b, c = co[tris[:, 0]], co[tris[:, 1]], co[tris[:, 2]]
    cr = np.cross(b - a, c - a)
    area = np.linalg.norm(cr, axis=1) / 2
    nor = cr / np.maximum(area * 2, 1e-30)[:, None]
    return (a + b + c) / 3, nor, area


def find_floor(co, tris, seed=1):
    """The biggest flat stretch of the scan: (point, normal pointing at the
    object, share of the surface it covers), or None if nothing flat is big
    enough to be a floor. Plane fitting by random sampling: a plane through a
    triangle, scored by the area of triangles lying in it and facing the same
    way (bumpy photo floors allowed)."""
    cen, nor, area = _faces(co, tris)
    tot = float(area.sum())
    if tot <= 0:
        return None
    diag = float(np.linalg.norm(co.max(0) - co.min(0)))
    tol = 0.012 * diag
    rng = np.random.default_rng(seed)
    pick = rng.choice(len(area), size=min(400, len(area)), replace=True, p=area / tot)
    # score on a sample of triangles, for speed on big scans
    sub = rng.choice(len(area), size=min(60000, len(area)), replace=False)
    sc, sn, sa = cen[sub], nor[sub], area[sub]
    scale = tot / float(sa.sum())
    best = None
    for f in pick:
        n, p = nor[f], cen[f]
        if not np.isfinite(n).all():
            continue
        ok = (np.abs((sc - p) @ n) < tol) & (np.abs(sn @ n) > math.cos(math.radians(25)))
        s = float(sa[ok].sum()) * scale
        if best is None or s > best[0]:
            best = (s, n.copy(), p.copy(), ok)
    if best is None:
        return None
    s, n, p, ok = best
    # refine: least-squares plane through the floor triangles
    pts, w = sc[ok], sa[ok]
    if len(pts) >= 3 and w.sum() > 0:
        m = (pts * w[:, None]).sum(0) / w.sum()
        u, sv, vt = np.linalg.svd((pts - m) * np.sqrt(w)[:, None], full_matrices=False)
        if len(vt) == 3:
            n2 = vt[2]
            if n2 @ n < 0:
                n2 = -n2
            n, p = n2, m
    # the object is on the side with most of the rest of the surface
    h = (cen - p) @ n
    off = np.abs(h) > 2 * tol
    if float((area[off] * np.sign(h[off])).sum()) < 0:
        n = -n
        h = -h
    # A floor reaches out past the object standing on it; a model's own flat
    # base lies within the object's footprint. Compare the floor's area with
    # the footprint (bounding rectangle, in the floor's plane) of what's above.
    a = np.cross(n, [1.0, 0, 0] if abs(n[0]) < 0.9 else [0, 1.0, 0])
    a /= np.linalg.norm(a)
    b = np.cross(n, a)
    above = h > 3 * tol
    if not above.any():
        return None
    q = cen[above] - p
    fx, fy = q @ a, q @ b
    foot = float((fx.max() - fx.min()) * (fy.max() - fy.min()))
    return p, n, s / tot, s / max(foot, 1e-30)


def is_floor(fl, min_floor=0.12, reach=1.3):
    """find_floor's answer looks like a real floor: a big share of the scan,
    and reaching well past the footprint of the object on it."""
    return bool(fl) and fl[2] >= min_floor and fl[3] >= reach


def find_bench(co, tris, up=(0.0, 0.0, 1.0), min_share=0.025, reach=1.2, min_above=0.25, min_below=0.03):
    """A bench or table top the object stands on, once the floor is gone (or
    when the scan never had one): (point, normal, cut height above the point),
    or None. `up` is which way is up (the scan is upright by then).

    Up-facing triangles are grouped by height; each big group is a candidate
    top. A bench top has most of the object above it, reaches well past that
    object's footprint, has something under it (its legs), and is a board: the
    part sticking out past the object has an underside facing down just below
    it and under the object too. A mold's own ledges fail that (under a gnome's
    shoulders is solid body, not an underside; a hat brim is only a ring), and so
    does a flange at the bottom (nothing under it).
    The highest candidate that passes wins. When the underside wasn't scanned
    nothing is found, and Keep box does it by hand."""
    cen, nor, area = _faces(co, tris)
    tot = float(area.sum())
    if tot <= 0 or len(area) < 20:
        return None
    up = np.asarray(up, float)
    up = up / np.linalg.norm(up)
    diag = float(np.linalg.norm(co.max(0) - co.min(0)))
    tol = 0.012 * diag
    h = cen @ up
    facing = (nor @ up) > math.cos(math.radians(25))
    if not facing.any():
        return None
    # height histogram of up-facing area, bins of half the tolerance
    lo, hi = float(h.min()), float(h.max())
    nb = max(8, int(math.ceil((hi - lo) / (tol / 2))) + 1)
    idx = np.clip(((h - lo) / (tol / 2)).astype(int), 0, nb - 1)
    hist = np.bincount(idx[facing], weights=area[facing], minlength=nb)
    sm = np.convolve(hist, [1, 1, 1], mode="same")
    peaks = [i for i in range(nb) if sm[i] >= min_share * tot and sm[i] == sm[max(0, i - 2):i + 3].max()]
    a = np.cross(up, [1.0, 0, 0] if abs(up[0]) < 0.9 else [0, 1.0, 0])
    a /= np.linalg.norm(a)
    b = np.cross(up, a)
    best = None
    for i in sorted(peaks, reverse=True):  # highest first
        z0 = lo + (i + 0.5) * tol / 2
        top = facing & (np.abs(h - z0) < 1.5 * tol)
        if not top.any():
            continue
        # fit the plane (the bench may lean a little), then take its triangles again
        pts, w = cen[top], area[top]
        m = (pts * w[:, None]).sum(0) / w.sum()
        n = up
        if len(pts) >= 3:
            _, _, vt = np.linalg.svd((pts - m) * np.sqrt(w)[:, None], full_matrices=False)
            if len(vt) == 3:
                n2 = vt[2] if vt[2] @ up > 0 else -vt[2]
                if n2 @ up > math.cos(math.radians(15)):
                    n = n2
        d = (cen - m) @ n
        top = (np.abs(d) < tol) & ((nor @ n) > math.cos(math.radians(25)))
        share = float(area[top].sum()) / tot
        if share < min_share:
            continue
        above = d > 3 * tol
        below = d < -2 * tol
        if float(area[above].sum()) / tot < min_above or float(area[below].sum()) / tot < min_below:
            continue
        # it reaches past the footprint of what stands on it, where it stands
        # (compare outlines: the bench under the object never shows in a scan)
        near = above & (d < 3 * tol + 0.15 * (float(d.max()) - 3 * tol))
        q = cen[near if near.any() else above] - m
        fx, fy = q @ a, q @ b
        foot = float((fx.max() - fx.min()) * (fy.max() - fy.min()))
        tv = co[np.unique(tris[top])] - m  # corners, not middles: the board's real edge
        ext = float(np.ptp(tv @ a) * np.ptp(tv @ b))
        t = cen[top] - m
        tx, ty = t @ a, t @ b
        if ext / max(foot, 1e-30) < reach:
            continue
        # and it's a board, not the top of something solid (a gnome's shoulders):
        # there's an underside, facing down, a little below the part that sticks out
        out_ = ~((tx >= fx.min()) & (tx <= fx.max()) & (ty >= fy.min()) & (ty <= fy.max()))
        stick = float(area[top][out_].sum())
        r = cen - m
        rx, ry = r @ a, r @ b
        outside = ~((rx >= fx.min()) & (rx <= fx.max()) & (ry >= fy.min()) & (ry <= fy.max()))
        under = outside & (d < 0) & (d > -12 * tol) & ((nor @ n) < -math.cos(math.radians(35)))
        if stick <= 0 or float(area[under].sum()) < 0.3 * stick:
            continue
        # and the board goes on under the object (a hat brim is a ring: under the
        # hat is the gnome's body, not the underside of a board)
        under_in = ~outside & (d < 0) & (d > -12 * tol) & ((nor @ n) < -math.cos(math.radians(35)))
        if float(area[under_in].sum()) < 0.15 * foot:
            continue
        cut = float(np.percentile(d[top], 99)) + 0.004 * diag
        best = (m, n, cut, share)
        break
    return best


def _arrays(bm):
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    bm.verts.ensure_lookup_table()
    bm.verts.index_update()
    co = np.array([v.co[:] for v in bm.verts]) if bm.verts else np.zeros((0, 3))
    tris = np.array([[v.index for v in f.verts] for f in bm.faces], dtype=int).reshape(-1, 3)
    return co, tris


def _level_and_cut(bm, p, n, cut):
    """Turn bm so n points up (+z), then cut away everything below the plane
    through p raised by cut."""
    R = Vector(tuple(float(x) for x in n)).rotation_difference(Vector((0, 0, 1))).to_matrix().to_4x4()
    bm.transform(R)
    pz = (R.to_3x3() @ Vector(tuple(float(x) for x in p))).z
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
                           plane_co=(0, 0, pz + cut), plane_no=(0, 0, 1), clear_inner=True)


def _keep_biggest(bm):
    """Keep the biggest connected piece, by surface area. Returns how many
    pieces went."""
    bm.faces.ensure_lookup_table()
    bm.faces.index_update()
    seen, groups = set(), []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, grp = [f], []
        seen.add(f.index)
        while stack:
            g = stack.pop()
            grp.append(g)
            for e in g.edges:
                for k in e.link_faces:
                    if k.index not in seen:
                        seen.add(k.index)
                        stack.append(k)
        groups.append((sum(x.calc_area() for x in grp), grp))
    if not groups:
        return 0
    groups.sort(key=lambda t: -t[0])
    drop = [f for _, grp in groups[1:] for f in grp]
    if drop:
        bmesh.ops.delete(bm, geom=drop, context="FACES")
    loose = [v for v in bm.verts if not v.link_faces]
    if loose:
        bmesh.ops.delete(bm, geom=loose, context="VERTS")
    return len(groups) - 1


def _fill_flat(bm, on_plane):
    """Close the open edges that lie in a cut: on_plane(co) says whether a
    vertex is on it."""
    rim = [e for e in bm.edges if e.is_boundary and all(on_plane(v.co) for v in e.verts)]
    if rim:
        bmesh.ops.holes_fill(bm, edges=rim, sides=0)
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    return len(rim)


def _fill_bottom(bm):
    zs = [v.co.z for v in bm.verts]
    if not zs:
        return
    zc, eps = min(zs), 1e-4 * (max(zs) - min(zs) + 1e-9)
    _fill_flat(bm, lambda c: abs(c.z - zc) < eps)


def clean_scan(obj, min_floor=0.12, bench=True):
    """Clean obj's mesh in place. Returns what it did, for the person:
    {"floor": bool, "bench": bool, "bench_cut": how far up the bench top is
     from the bottom, in scan units, "dropped": share of the surface removed,
     "bits": loose pieces removed}."""
    me = obj.data
    M = obj.matrix_world.copy()
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.transform(M)
    co, tris = _arrays(bm)
    _, _, area0 = _faces(co, tris)
    total0 = float(area0.sum())
    out = {"floor": False, "bench": False, "cut": 0.0, "dropped": 0.0, "bits": 0}
    z_bottom = float(co[:, 2].min()) if len(co) else 0.0
    fl = find_floor(co, tris)
    if is_floor(fl, min_floor):
        p, n, share, _ = fl
        cen, nor, area = _faces(co, tris)
        h = (cen - p) @ n
        diag = float(np.linalg.norm(co.max(0) - co.min(0)))
        tol = 0.012 * diag
        floor = (np.abs(h) < 2 * tol) & (nor @ n > math.cos(math.radians(30)))
        # just above the floor's bumps (the highest few being spikes, not floor)
        cut = float(np.percentile(h[floor], 99)) + 0.004 * diag if floor.any() else tol
        out.update(floor=True, cut=cut, share=round(share, 3))
        _level_and_cut(bm, p, n, cut)  # stand it up: floor normal to +z
        z_bottom = min((v.co.z for v in bm.verts), default=0.0)
    out["bits"] = _keep_biggest(bm)
    # a bench or table under it: the floor's gone (or never was), so the bench top
    # is now the biggest flat stretch with the object on it
    if bench:
        co, tris = _arrays(bm)
        bn = find_bench(co, tris) if len(tris) else None
        if bn is not None:
            p, n, cut, _ = bn
            out.update(bench=True, bench_cut=round(float(p @ n + cut - z_bottom), 1))
            _level_and_cut(bm, p, n, cut)
            out["bits"] += _keep_biggest(bm)
    # close the cut: the open edges lying in the cut plane
    if out["floor"] or out["bench"]:
        _fill_bottom(bm)
    total1 = sum(f.calc_area() for f in bm.faces)
    out["dropped"] = round(max(0.0, 1 - total1 / total0), 3) if total0 else 0.0
    bm.transform(M.inverted())  # back to the object's own space; the stand-up turn stays in the mesh
    bm.to_mesh(me)
    bm.free()
    me.update()
    return out


def keep_box(obj, lo, hi, frame=None):
    """Keep only what's inside the box lo..hi, the biggest piece of it, closed
    flat where the box cut through. lo and hi are in world coordinates, or,
    with frame (a 4x4 matrix, rows, from the box's own space to the world: a
    box turned or tilted), in the box's own space. A tilted box's bottom ends
    up level, so a scan made on a sloping bench stands straight.
    Returns {"dropped": share of the surface removed, "bits": loose pieces
    removed, "open": whether a side or the top of the box cut through what was
    kept, not just the bottom}."""
    lo = [float(x) for x in lo]
    hi = [float(x) for x in hi]
    if any(h - l <= 0 for l, h in zip(lo, hi)):
        raise RuntimeError("The box has no room inside it.")
    me = obj.data
    M = obj.matrix_world.copy()
    bm = bmesh.new()
    bm.from_mesh(me)
    F = Matrix([[float(x) for x in row] for row in frame]) if frame is not None else Matrix.Identity(4)
    bm.transform(F.inverted() @ M)  # into the box's own space, where the box is square to the axes
    co, tris = _arrays(bm)
    _, _, area0 = _faces(co, tris)
    total0 = float(area0.sum())
    if len(co) == 0:
        raise RuntimeError("The scan is empty.")
    inside = np.all((co >= lo) & (co <= hi), axis=1)
    if not inside.any():
        bm.free()
        raise RuntimeError("Nothing of the scan is inside the box. Drag its sides out round the mold.")
    planes = []
    for ax in range(3):
        for side, val in ((-1, lo[ax]), (1, hi[ax])):
            if (co[:, ax] < val if side < 0 else co[:, ax] > val).any():  # the box cuts this way
                no = [0.0, 0.0, 0.0]
                no[ax] = float(side)
                pc = [0.0, 0.0, 0.0]
                pc[ax] = val
                # clear_outer drops what's on the side the normal points to: outside the box
                bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
                                       plane_co=pc, plane_no=no, clear_outer=True)
                planes.append((ax, val))
    bits = _keep_biggest(bm)
    eps = 1e-4 * float(np.linalg.norm(np.subtract(hi, lo)))

    def on_box(c):
        return any(abs(c[ax] - val) < eps for ax, val in planes)
    # a side and the bottom can cut the same hole, so close them all together
    rim = {v for e in bm.edges if e.is_boundary and all(on_box(v.co) for v in e.verts) for v in e.verts}
    sides = any(abs(v.co[ax] - val) < eps for v in rim for ax, val in planes if not (ax == 2 and val == lo[2]))
    _fill_flat(bm, on_box)
    total1 = sum(f.calc_area() for f in bm.faces)
    out = {"dropped": round(max(0.0, 1 - total1 / total0), 3) if total0 else 0.0, "bits": bits, "open": bool(sides)}
    # back to the world, less the box's tilt: the box's up becomes straight up
    R = F.to_3x3()
    tilt = (R @ Vector((0, 0, 1))).normalized().rotation_difference(Vector((0, 0, 1))).to_matrix().to_4x4()
    bm.transform(M.inverted() @ tilt @ F)
    bm.to_mesh(me)
    bm.free()
    me.update()
    return out
