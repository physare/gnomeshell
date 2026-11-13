"""Clean up a fresh scan: take away the floor it was scanned on and anything
else in the background, and leave just the latex mold, closed underneath.

Phone and photo scans (KIRI, Polycam, the GnomeShell Scan app) come back with
the table or floor round the object, and often bits of whatever else was near
it. The floor is found as the biggest flat stretch of the scan; the scan is cut
just above the floor's highest bumps, everything not joined to the main object
is dropped (other things on the table, stray blobs), and the cut is filled flat.
The scan is turned so the floor is level, with the object standing on it."""
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


def clean_scan(obj, min_floor=0.12):
    """Clean obj's mesh in place. Returns what it did, for the person:
    {"floor": bool, "cut_mm": height of the cut above the floor in scan units,
     "dropped": share of the surface removed, "bits": loose pieces removed}."""
    me = obj.data
    M = obj.matrix_world.copy()
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.transform(M)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.verts.ensure_lookup_table()
    co = np.array([v.co[:] for v in bm.verts])
    tris = np.array([[v.index for v in f.verts] for f in bm.faces])
    _, _, area0 = _faces(co, tris)
    total0 = float(area0.sum())
    out = {"floor": False, "cut": 0.0, "dropped": 0.0, "bits": 0}
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
        # stand it up: floor normal to +z
        R = Vector(n.tolist()).rotation_difference(Vector((0, 0, 1))).to_matrix().to_4x4()
        bm.transform(R)
        pz = (R.to_3x3() @ Vector(p.tolist())).z
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
                               plane_co=(0, 0, pz + cut), plane_no=(0, 0, 1), clear_inner=True)
    # keep the biggest connected piece, by surface area
    bm.faces.ensure_lookup_table()
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
    if groups:
        groups.sort(key=lambda t: -t[0])
        drop = [f for _, grp in groups[1:] for f in grp]
        out["bits"] = len(groups) - 1
        if drop:
            bmesh.ops.delete(bm, geom=drop, context="FACES")
        loose = [v for v in bm.verts if not v.link_faces]
        if loose:
            bmesh.ops.delete(bm, geom=loose, context="VERTS")
    # close the cut: the open edges lying in the cut plane
    if out["floor"]:
        zs = [v.co.z for v in bm.verts]
        zc, eps = (min(zs), 1e-4 * (max(zs) - min(zs) + 1e-9)) if zs else (0.0, 1e-9)
        rim = [e for e in bm.edges if e.is_boundary and all(abs(v.co.z - zc) < eps for v in e.verts)]
        if rim:
            bmesh.ops.holes_fill(bm, edges=rim, sides=0)
            bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    total1 = sum(f.calc_area() for f in bm.faces)
    out["dropped"] = round(max(0.0, 1 - total1 / total0), 3) if total0 else 0.0
    bm.transform(M.inverted())  # back to the object's own space; the stand-up turn stays in the mesh
    bm.to_mesh(me)
    bm.free()
    me.update()
    return out
