"""Seam cards: a thin printed card that stands straight out from the model,
its inner edge shaped to sit flush against the surface, running up from the
bottom. The latex goes over the model and the card together, which leaves a
flap that opens so the skin can come off."""
import math

import bmesh
import numpy as np
from mathutils import Matrix, Vector

import mold_shell as ms
import split as sp

EZ = Vector((0, 0, 1))


def _frame(out_dir):
    out = Vector((out_dir[0], out_dir[1], 0.0))
    if out.length < 1e-6:
        out = Vector((1, 0, 0))
    out.normalize()
    n = EZ.cross(out).normalized()  # the card's face points this way
    return out, n


def _box(bm, origin, out, n, a0, a1, z0, z1, c0, c1):
    """A block in the card's frame: a along out, z up, c along n."""
    vs = []
    for a in (a0, a1):
        for z in (z0, z1):
            for c in (c0, c1):
                vs.append(bm.verts.new(origin + out * a + EZ * z + n * c))
    # vertex index = ia*4 + iz*2 + ic
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    for f in faces:
        bm.faces.new([vs[i] for i in f])


def _prism(bm, origin, out, n, ac, z0, z1):
    """A solid standing from z0 to z1 on the outline ac: (a, c) points, a along
    out, c along n, going round anticlockwise seen from above."""
    lo = [bm.verts.new(origin + out * a + n * c + EZ * z0) for a, c in ac]
    hi = [bm.verts.new(origin + out * a + n * c + EZ * z1) for a, c in ac]
    k = len(ac)
    for i in range(k):
        j = (i + 1) % k
        bm.faces.new([lo[i], lo[j], hi[j], hi[i]])
    bm.faces.new(hi)
    bm.faces.new(lo[::-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])


def card_solid(latex_obj, point, out_dir, top, width=50.0, thick=0.56, gap=0.0, rim_w=0.0, rim_t=2.0, name="ms_tmp_card"):
    """The card as a solid, in place against the model. point: where on the
    surface it goes; out_dir: which way it stands out (made level); top: the
    height of its top edge. Returns (card, info)."""
    out, n = _frame(out_dir)
    co, tris = ms._world_tris(latex_obj)
    z0 = float(co[:, 2].min())
    top = max(z0 + 5.0, min(float(top), float(co[:, 2].max())))
    P = Vector(point)
    origin = Vector((P.x, P.y, 0.0))
    rel = co - np.array(origin)
    a = rel @ np.array(out)
    c = rel @ np.array(n)
    # how far the model reaches out along the card, over the card's height
    near = (np.abs(c) < max(2.0, thick)) & (co[:, 2] >= z0 - 0.01) & (co[:, 2] <= top + 0.01)
    reach = float(a[near].max()) if near.any() else float((P - origin).dot(out))
    a0 = float(np.median(a))  # start from the middle of the model, so the card meets it all the way up
    a0 = min(a0, reach - 1.0)
    a1 = reach + float(gap) + float(width)
    # the card with its stiff edge as one solid: a boolean union of a card this
    # thin and the edge strip comes out torn
    t2 = thick / 2
    ac = [(a0, -t2), (a1, -t2), (a1, t2), (a0, t2)]
    if rim_w > 0 and rim_t > thick:
        ar, r2 = max(a0 + 1.0, a1 - min(rim_w, width)), rim_t / 2
        ac = [(a0, -t2), (ar, -t2), (ar, -r2), (a1, -r2), (a1, r2), (ar, r2), (ar, t2), (a0, t2)]
    bm = bmesh.new()
    _prism(bm, origin, out, n, ac, z0, top)
    card = ms._new_obj(name, bm)
    # take the model (grown by the gap) out of it, so the inner edge follows the surface
    if gap > 0:
        span = float(np.ptp(co, axis=0).max())
        cutter = ms._offset_solid(latex_obj, float(gap), max(0.25, min(gap / 2, span / 500.0)), "ms_tmp_cardgap")
    else:
        me = latex_obj.data.copy()
        me.transform(latex_obj.matrix_world)
        cutter = ms._new_obj("ms_tmp_cardcut", me)
    # the careful (Exact) boolean: the quick one flattens a card this thin into
    # long triangles that run through it from face to face
    ms._apply_booleans(card, [cutter], "DIFFERENCE")
    ms._remove(cutter)
    # keep only the card itself: bits left inside hollows of the model go
    bm = bmesh.new()
    bm.from_mesh(card.data)
    parts = [p for _, p in ms._pieces_by_area(bm)]  # (area, faces), biggest first
    if len(parts) > 1:
        def outer(part):
            return max((v.co - origin).dot(out) for f in part for v in f.verts)
        keep = max(parts, key=lambda p: (outer(p), len(p)))
        drop = [f for p in parts if p is not keep for f in p]
        bmesh.ops.delete(bm, geom=drop, context="FACES")
        loose = [v for v in bm.verts if not v.link_faces]
        if loose:
            bmesh.ops.delete(bm, geom=loose, context="VERTS")
    ms._drop_loose_bits(bm)  # and close any pinhole the boolean left
    bm.to_mesh(card.data)
    bm.free()
    card.data.update()
    info = {"point": [float(x) for x in P], "out": [float(x) for x in out], "top": round(top, 1), "bottom": round(z0, 1),
            "width": float(width), "reach": round(reach, 1), "thick": float(thick)}
    return card, info


def lay_flat(card, out_dir):
    """The card turned to lie on its face, on z = 0, for printing."""
    out, n = _frame(out_dir)
    co, tris = ms._world_tris(card)
    R = n.rotation_difference(Vector((0, 0, -1))).to_matrix()
    pts = np.array(co) @ np.array(R).T
    pts -= pts.min(0)
    return pts, tris


def _perimeter(co, tris, z):
    n, u, v = sp._basis((0, 0, 1))
    segs = sp._section_segs(co, tris, np.array((0, 0, z)), n, u, v)
    if not len(segs):
        return 0.0
    return float(np.linalg.norm(segs[:, 1] - segs[:, 0], axis=1).sum())


def suggest(latex_obj, stretch=1.5):
    """Does the skin need a seam card, and where? The skin comes off over the
    bottom opening; if it has to stretch over a part well bigger round than
    the narrowest part below it (a head over a neck, shoulders over a narrow
    stand), it needs one. The card goes up the plainest side, from the bottom
    to that bigger part."""
    co, tris = ms._world_tris(latex_obj)
    z0, z1 = float(co[:, 2].min()), float(co[:, 2].max())
    H = z1 - z0
    zs = [z0 + H * (k + 0.5) / 40 for k in range(40)]
    per = [_perimeter(co, tris, z) for z in zs]
    best, top, low = 1.0, None, None
    lowest = None
    for z, p in zip(zs, per):
        if p <= 0:
            continue
        if lowest is None or p < lowest[1]:
            lowest = (z, p)
        r = p / lowest[1]
        if r > best:
            best, top, low = r, z, lowest[0]
    if best < stretch or top is None:
        return {"needed": False, "ratio": round(best, 2)}
    # the plainest side over that height: the smoothest outline seen from each direction
    band = (co[:, 2] >= z0) & (co[:, 2] <= top)
    pts = co[band]
    cx, cy = float(np.median(pts[:, 0])), float(np.median(pts[:, 1]))
    nb = 24
    bins = np.clip(((pts[:, 2] - z0) / max(top - z0, 1e-6) * nb).astype(int), 0, nb - 1)
    scores = []
    for k in range(16):
        th = 2 * math.pi * k / 16
        d = np.array((math.cos(th), math.sin(th)))
        rel = pts[:, :2] - (cx, cy)
        along = rel @ d
        side = np.abs(rel @ np.array((-d[1], d[0])))
        prof = []
        for b in range(nb):
            m = (bins == b) & (side < 10.0)
            prof.append(float(along[m].max()) if m.any() else np.nan)
        prof = np.array(prof)
        if np.isnan(prof).mean() > 0.3:
            scores.append((1e9, th))
            continue
        prof = np.where(np.isnan(prof), np.nanmean(prof), prof)
        rough = float(np.abs(np.diff(prof, 2)).sum())
        scores.append((rough, th))
    rough, th = min(scores)
    d = Vector((math.cos(th), math.sin(th), 0))
    zm = (z0 + top) / 2
    m = (np.abs(co[:, 2] - zm) < 3.0)
    rel = co[m][:, :2] - (cx, cy)
    side = np.abs(rel @ np.array((-d.y, d.x)))
    along = rel @ np.array((d.x, d.y))
    sel = side < 5.0
    a = float(along[sel].max()) if sel.any() else 0.0
    pt = Vector((cx, cy, zm)) + d * a
    return {"needed": True, "ratio": round(best, 2), "point": [float(x) for x in pt], "out": [d.x, d.y, 0.0],
            "top": round(top + 0.15 * (z1 - z0) * 0, 1), "narrow_at": round(low, 1)}
