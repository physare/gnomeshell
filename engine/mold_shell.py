bl_info = {
    "name": "Mold Shell Builder",
    "author": "Gnome and Garden",
    "version": (0, 16, 1),
    "blender": (4, 2, 0),
    "location": "View3D > Sidebar (N) > Mold Shell",
    "description": "Builds a split, 3D-printable mother mold shell around a latex mold scan",
    "category": "Object",
}

"""
Mold Shell Builder
==================

What it does, in order:
  1. Takes the selected latex-mold scan.
  2. Suggest Cut: searches flat cut planes (any direction, tilted up to +/-30 deg)
     for the one whose two halves have the least overhang, and drops it in the
     scene as an object named CUT_auto. You can move/rotate it, delete it, or add
     your own planes named CUT_<anything> (Add > Mesh > Plane, then rename).
     Every visible mesh object whose name starts with "CUT" is used as a cut.
     The plane's surface is the cut; its local Z axis is the pull direction.
  3. Build Shell: a box around the scan with at least the wall thickness
     everywhere (default 1/4 in), open at the bottom, scan subtracted out,
     6 mm bungee channels bored at 45 deg across each outside vertical corner
     (4 per corner, evenly spaced, 1/4 in from the edge), then split by the
     cut planes into pieces named SHELL_1, SHELL_2, ...
     From Python you can also pass `pieces`: each piece is the part of the box
     on the kept side of its own list of planes, so a cut can split just one
     piece (a level cut across the middle columns only, say).
     Each piece also gets a fit-test slice (SHELL_n_TEST): a 0.4 mm (2 layer)
     upright slice across the seam through the tallest point of the latex,
     exported lying flat, to print first and check the fit.
  4. Export Files: an STL per piece and per test slice, plus shell.3mf
     (pieces assembled) and test_slices.3mf, all in millimetres.

Everything also works from Python (e.g. through a Blender MCP):
    import mold_shell as ms                # if installed as an add-on
    ms.suggest_cut(bpy.data.objects["LatexScan"])
    ms.build_shell(bpy.data.objects["LatexScan"])
    ms.export_pieces(r"C:\\path\\to\\folder")
"""

import math
import os
import struct

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

INCH = 25.4
DEFAULTS = dict(
    wall_mm=0.25 * INCH,        # min plastic between latex and outside
    hole_d_mm=6.0,              # bungee channel diameter
    holes_per_corner=4,         # levels per corner
    channel_pairs=False,        # two channels side by side at each level
    pair_gap_mm=10.0,           # centre-to-centre spacing of a pair
    hole_edge_mm=0.25 * INCH,   # plastic between corner edge and channel
    bottom_trim_mm=1.0,         # box floor sits this far above the scan's lowest point, so the bottom is open
    explode_mm=15.0,            # move pieces apart along their pull direction after splitting
    max_tilt_deg=30.0,
    pour_extend_mm=0.0,         # carry the base opening down this far for a pour collar
    pour_flare_deg=0.0,         # flare the collar outward like a funnel
    test_slice_mm=0.4,          # fit-test slice thickness: 2 layers at 0.2 mm
    test_slice_at=0.5,          # HORIZONTAL style only: height of the slice as a fraction of the shell
    test_slice_style="VERTICAL",  # VERTICAL: upright slice across the seam through the top of the latex
    bed_mm=256.0,               # build plate size used to centre the 3MF
    units="AUTO",               # AUTO, MM (1 unit = 1 mm), SCENE (use scene unit scale)
    # shell style: BOX (a block with bungee channels) or CONTOUR (an even skin
    # round the latex, with notched strips along each seam for the cords)
    shell_style="BOX",
    contour_mm=4.0,             # CONTOUR: shell thickness
    strip_w_mm=12.0,            # CONTOUR: how far the seam strips stand out from the shell
    strip_t_mm=5.0,             # CONTOUR: strip thickness on each piece (twice this where two meet)
    notch_gap_mm=40.0,          # CONTOUR: spacing of the cord notches up each seam
    foot_mm=12.0,               # CONTOUR: flat foot round the base opening, this wide (0 = none)
    bump_r_mm=3.0,              # CONTOUR: alignment bumps on the strips (0 = none)
)
CUT_PREFIX = "CUT"
PIECE_PREFIX = "SHELL_"
COLLECTION = "Mold Shell"


# ----------------------------------------------------------------- helpers

def _mm_to_bu(latex_obj, units):
    """Blender units per millimetre."""
    scale = bpy.context.scene.unit_settings.scale_length or 1.0
    if units == "MM":
        return 1.0
    if units == "SCENE":
        return 0.001 / scale
    # AUTO: a bust is 50-1000 mm tall. If the scene scale says metres but the
    # object is tens or hundreds of units tall, the scan was imported in mm.
    h = max(latex_obj.dimensions) if latex_obj else 1.0
    by_scene = 0.001 / scale
    real_mm = h / by_scene
    return 1.0 if real_mm > 5000 else by_scene


def _collection():
    col = bpy.data.collections.get(COLLECTION)
    if col is None:
        col = bpy.data.collections.new(COLLECTION)
        bpy.context.scene.collection.children.link(col)
    return col


def _remove(name_or_obj):
    obj = bpy.data.objects.get(name_or_obj) if isinstance(name_or_obj, str) else name_or_obj
    if obj is None:
        return
    me = obj.data if obj.type == "MESH" else None
    bpy.data.objects.remove(obj, do_unlink=True)
    if me is not None and me.users == 0:
        bpy.data.meshes.remove(me)


def _new_obj(name, bm_or_mesh, col=None, matrix=None):
    if isinstance(bm_or_mesh, bmesh.types.BMesh):
        me = bpy.data.meshes.new(name)
        bm_or_mesh.to_mesh(me)
        bm_or_mesh.free()
    else:
        me = bm_or_mesh
        me.name = name
    obj = bpy.data.objects.new(name, me)
    (col or _collection()).objects.link(obj)
    if matrix is not None:
        obj.matrix_world = matrix
    return obj


def _world_tris(obj):
    """World-space triangles of the evaluated object: verts (V,3), tris (T,3)."""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    me.calc_loop_triangles()
    nv = len(me.vertices)
    co = np.empty(nv * 3, dtype=np.float64)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    tris = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
    me.loop_triangles.foreach_get("vertices", tris)
    tris = tris.reshape(-1, 3)
    ev.to_mesh_clear()
    mw = np.array(obj.matrix_world)
    co = co @ mw[:3, :3].T + mw[:3, 3]
    return co, tris


def _tri_data(co, tris):
    a, b, c = co[tris[:, 0]], co[tris[:, 1]], co[tris[:, 2]]
    cross = np.cross(b - a, c - a)
    area2 = np.linalg.norm(cross, axis=1)
    keep = area2 > 1e-12
    cen = ((a + b + c) / 3.0)[keep]
    nrm = (cross[keep] / area2[keep, None])
    area = 0.5 * area2[keep]
    # make normals point out of the latex (into the shell)
    mid = (cen * area[:, None]).sum(0) / area.sum()
    if np.sum(area * np.einsum("ij,ij->i", cen - mid, nrm)) < 0:
        nrm = -nrm
    return cen, nrm, area


def _cut_planes():
    """Visible mesh objects named CUT*: list of (point, unit normal, obj)."""
    bpy.context.view_layer.update()  # pick up planes moved since the last redraw
    planes = []
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH" and obj.name.upper().startswith(CUT_PREFIX) and obj.visible_get():
            mw = obj.matrix_world
            n = (mw.to_3x3() @ Vector((0, 0, 1))).normalized()
            planes.append((Vector(mw.translation), n, obj))
    return planes


# ------------------------------------------------------- overhang scoring

def _overhang_score(cen, nrm, area, n, d, tol):
    """Area of latex surface that would lock a piece, for a cut plane n.x = d.
    The + side piece pulls along +n, the - side along -n. A surface facing
    against its piece's pull direction is an overhang."""
    side = cen @ n - d
    dots = nrm @ n
    bad = np.where(side > 0, dots < -tol, dots > tol)
    return float(np.sum(area[bad]))


def _trapped_score(bvh, cen, nrm, area, n, d, tol, eps):
    """Extra check: surfaces that face the right way but are blocked by
    another part of the sculpture further along the pull (deep ears, curls)."""
    total = 0.0
    side = cen @ n - d
    dots = nrm @ n
    for i in range(len(cen)):
        pull = n if side[i] > 0 else -n
        facing = dots[i] if side[i] > 0 else -dots[i]
        if facing < 0.1:
            continue  # overhangs are already counted; grazing walls give false hits
        o = Vector(cen[i]) + Vector(pull) * eps + Vector(nrm[i]) * eps
        hit = bvh.ray_cast(o, Vector(pull))
        if hit[0] is not None:
            # only blocked if the hit is on the same side of the cut
            if (np.dot(np.array(hit[0]), n) - d) * side[i] > 0:
                total += area[i]
    return total


def suggest_cut(latex_obj, max_tilt_deg=None, sample=60000, verbose=True):
    """Find the flat cut with the least overhang and place it as CUT_auto.
    Returns dict(point, normal, overhang_pct, object)."""
    max_tilt = DEFAULTS["max_tilt_deg"] if max_tilt_deg is None else max_tilt_deg
    co, tris = _world_tris(latex_obj)
    cen, nrm, area = _tri_data(co, tris)
    total_area = area.sum()
    rng = np.random.default_rng(0)
    if len(cen) > sample:
        idx = rng.choice(len(cen), sample, replace=False)
        s_cen, s_nrm, s_area = cen[idx], nrm[idx], area[idx]
        s_area = s_area * (total_area / s_area.sum())
    else:
        s_cen, s_nrm, s_area = cen, nrm, area
    tol = math.sin(math.radians(2.0))

    cands = []
    tilts = [0.0]
    t = 10.0
    while t <= max_tilt + 1e-6:
        tilts += [t, -t]
        t += 10.0
    for tilt in tilts:
        for az in range(0, 180, 5):
            a, p = math.radians(az), math.radians(tilt)
            n = np.array([math.cos(a) * math.cos(p), math.sin(a) * math.cos(p), math.sin(p)])
            proj = s_cen @ n
            for d in np.percentile(proj, np.linspace(30, 70, 9)):
                s = _overhang_score(s_cen, s_nrm, s_area, n, d, tol)
                # small nudges toward level cuts through the middle
                s_adj = s + total_area * (abs(tilt) * 2e-5)
                cands.append((s_adj, s, n, float(d)))
    cands.sort(key=lambda c: c[0])

    # re-rank the best few with a ray test for trapped pockets
    bvh = BVHTree.FromPolygons([tuple(v) for v in co], [tuple(t) for t in tris])
    k = min(len(s_cen), 4000)
    ridx = rng.choice(len(s_cen), k, replace=False)
    r_cen, r_nrm = s_cen[ridx], s_nrm[ridx]
    r_area = s_area[ridx] * (total_area / s_area[ridx].sum())
    eps = float(np.ptp(co, axis=0).max()) * 1e-3
    best = None
    for s_adj, s, n, d in cands[:12]:
        trapped = _trapped_score(bvh, r_cen, r_nrm, r_area, n, d, tol, eps)
        score = s_adj + trapped
        if best is None or score < best[0]:
            best = (score, s + trapped, n, d)
    _, raw, n, d = best

    nv = Vector(n)
    # point on the plane closest to the scan's centre
    c = Vector(co.mean(0))
    point = c - nv * (c.dot(nv) - d)
    obj = _place_cut_plane("CUT_auto", point, nv, latex_obj)
    pct = 100.0 * raw / total_area
    obj["overhang_pct"] = round(pct, 3)
    if verbose:
        print(f"[mold shell] suggested cut: normal {tuple(round(x, 3) for x in n)}, "
              f"overhang {pct:.2f}% of surface")
    return dict(point=point, normal=nv, overhang_pct=pct, object=obj)


# ------------------------------------------- piece-by-piece splitting

def canonical_normal(n):
    """Cut normals are kept pointing up (level cuts) or with a turn of
    0-180 degrees (upright cuts), so both sides of a cut get stable names."""
    n = np.asarray(n, dtype=float)
    n = n / np.linalg.norm(n)
    if abs(n[2]) > 0.7071:
        return n if n[2] > 0 else -n
    if n[1] < -1e-9 or (abs(n[1]) <= 1e-9 and n[0] < 0):
        return -n
    return n


class _PullSearch:
    """Best pull direction for a set of latex faces, fast: face normals are
    binned on a 4-degree grid and tested against a few hundred directions."""

    def __init__(self, nrm, area, tol, extra_dirs=()):
        th = np.arccos(np.clip(nrm[:, 2], -1, 1))
        ph = np.arctan2(nrm[:, 1], nrm[:, 0])
        nt, npf = 45, 90
        it = np.minimum((th / np.pi * nt).astype(int), nt - 1)
        ip = np.minimum(((ph + np.pi) / (2 * np.pi) * npf).astype(int), npf - 1)
        self.bins = it * npf + ip
        self.nb = nt * npf
        tc = (np.arange(nt) + 0.5) / nt * np.pi
        pc = (np.arange(npf) + 0.5) / npf * 2 * np.pi - np.pi
        T, P = np.meshgrid(tc, pc, indexing="ij")
        bdirs = np.stack([np.sin(T) * np.cos(P), np.sin(T) * np.sin(P), np.cos(T)], -1).reshape(-1, 3)
        # candidate pulls: the upper half of a sphere, plus any directions passed in
        k = 600
        i = np.arange(k) + 0.5
        z = 1 - i / k
        r = np.sqrt(1 - z * z)
        a = i * math.pi * (3 - math.sqrt(5))
        d = np.stack([r * np.cos(a), r * np.sin(a), z], -1)
        ring = np.array([[math.cos(x), math.sin(x), 0.0] for x in np.radians(np.arange(0, 360, 5))])
        extra = [np.asarray(e, float) / np.linalg.norm(e) for e in extra_dirs if np.linalg.norm(e) > 1e-9]
        self.dirs = np.vstack([d, ring] + ([np.array(extra)] if extra else []))
        self.M = (bdirs @ self.dirs.T < -tol).astype(np.float32)
        self.area = area

    def best(self, mask, natural=None, seams=()):
        """mask: faces in the piece. natural: preferred direction (ties go to
        it). seams: unit vectors pointing from this piece into a neighbour;
        the pull may not drive into them. Returns (overhang area, direction)."""
        w = np.bincount(self.bins[mask], weights=self.area[mask], minlength=self.nb).astype(np.float32)
        tot = float(w.sum())
        over = w @ self.M
        score = over.astype(float)
        if natural is not None:
            g = np.array(natural, float)
            g[2] = max(g[2], 0.0)
            if np.linalg.norm(g) > 1e-9:
                score = score + 0.03 * tot * (1 - self.dirs @ (g / np.linalg.norm(g)))
        for sv in seams:
            score[self.dirs @ np.asarray(sv, float) > 0.05] = np.inf
        k = int(np.argmin(score))
        if not np.isfinite(score[k]):
            return float("inf"), self.dirs[k]
        return float(over[k]), self.dirs[k]


def suggest_more_cuts(latex_obj, pieces, next_id, max_pieces=6, draft_deg=2.0, frame=None,
                      target_pct=1.0, sample=60000):
    """Keep splitting the piece with the most overhang.

    pieces: list of {"id": str, "hs": [(point, normal), ...]} as they stand now,
    or {"id": str, "cells": [[(point, normal), ...], ...]} for a piece made of
    several joined blocks.
    Each new cut splits one piece, upright (any turn) or level. The kept side
    of a cut (normal side) becomes "<piece id>.<cut id>p", the other side
    "<piece id>.<cut id>n". Returns dict(cuts=[{id, parent, point, normal}],
    before_pct, after_pct)."""
    co, tris = _world_tris(latex_obj)
    cen, nrm, area = _tri_data(co, tris)
    total = float(area.sum())
    if len(cen) > sample:
        idx = np.random.default_rng(0).choice(len(cen), sample, replace=False)
        cen, nrm, area = cen[idx], nrm[idx], area[idx] * (total / area[idx].sum())
    tol = math.sin(math.radians(draft_deg))
    ex = np.array(frame[0], float) if frame else np.array([1.0, 0, 0])
    ey = np.array(frame[1], float) if frame else np.array([0, 1.0, 0])
    search = _PullSearch(nrm, area, tol, extra_dirs=[ex, -ex, ey, -ey, ex + ey, ex - ey, -ex + ey, -ex - ey])

    leaves = []
    for pc in pieces:
        # a piece is one convex block ("hs") or several joined blocks ("cells")
        cells = pc.get("cells") or [pc["hs"]]
        cells = [[(np.array(a, float), np.array(b, float) / np.linalg.norm(b)) for a, b in c] for c in cells]
        m = np.zeros(len(cen), bool)
        for c in cells:
            mc = np.ones(len(cen), bool)
            for a, b in c:
                mc &= (cen - a) @ b >= 0
            m |= mc
        hs = [h for c in cells for h in c]
        nat = sum((b for _, b in hs), np.zeros(3)) / len(cells)
        over, d = search.best(m, nat)
        leaves.append({"id": pc["id"], "hs": hs, "mask": m, "nat": nat, "over": over, "stuck": False})
    before = sum(l["over"] for l in leaves if np.isfinite(l["over"]))

    # upright cuts every 15 degrees plus the box's own axes, and level cuts
    normals = [canonical_normal(ex), canonical_normal(ey)]
    for az in range(0, 180, 15):
        v = canonical_normal([math.cos(math.radians(az)), math.sin(math.radians(az)), 0.0])
        if all(abs(v @ u) < math.cos(math.radians(5)) for u in normals):
            normals.append(v)
    normals.append(np.array([0.0, 0.0, 1.0]))

    cuts = []
    cid = int(next_id)
    while len(leaves) < max_pieces:
        live = [l for l in leaves if not l["stuck"] and np.isfinite(l["over"])]
        if not live or 100 * sum(l["over"] for l in leaves) / total < target_pct:
            break
        L = max(live, key=lambda l: l["over"])
        m = L["mask"]
        la = float(area[m].sum())
        best = None
        for n in normals:
            proj = cen[m] @ n
            if len(proj) < 50:
                break
            for dval in np.percentile(proj, np.linspace(12.5, 87.5, 7)):
                side = (cen @ n - dval) >= 0
                mp, mn = m & side, m & ~side
                ap, an = float(area[mp].sum()), float(area[mn].sum())
                if min(ap, an) < 0.06 * la:
                    continue
                op, _ = search.best(mp, L["nat"] + n, seams=[-n])
                on, _ = search.best(mn, L["nat"] - n, seams=[n])
                sc = op + on
                # prefer cuts square to the box, and not stacking layers inside a piece
                if not (abs(n @ normals[0]) > 0.999 or abs(n @ normals[1]) > 0.999 or n[2] > 0.999):
                    sc += 0.004 * total
                if any(abs(n @ hn) > 0.95 for _, hn in L["hs"]):
                    sc += 0.004 * total
                if best is None or sc < best[0]:
                    best = (sc, n, float(dval), mp, mn, op, on)
        if best is None or L["over"] - best[0] < max(0.003 * total, 0.15 * L["over"]):
            L["stuck"] = True
            continue
        sc, n, dval, mp, mn, op, on = best
        c = cen[m].mean(0)
        point = c - n * (c @ n - dval)
        cuts.append({"id": cid, "parent": L["id"], "point": point.tolist(), "normal": n.tolist()})
        leaves.remove(L)
        leaves.append({"id": f"{L['id']}.{cid}p", "hs": L["hs"] + [(point, n)], "mask": mp, "nat": L["nat"] + n, "over": op, "stuck": False})
        leaves.append({"id": f"{L['id']}.{cid}n", "hs": L["hs"] + [(point, -n)], "mask": mn, "nat": L["nat"] - n, "over": on, "stuck": False})
        cid += 1
    after = sum(l["over"] for l in leaves if np.isfinite(l["over"]))
    return {"cuts": cuts, "before_pct": round(100 * before / total, 2), "after_pct": round(100 * after / total, 2)}


def _place_cut_plane(name, point, normal, latex_obj):
    _remove(name)
    size = max(latex_obj.dimensions) * 0.75 + 1e-6
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=size)
    rot = Vector((0, 0, 1)).rotation_difference(normal).to_matrix().to_4x4()
    obj = _new_obj(name, bm, matrix=Matrix.Translation(point) @ rot)
    obj.display_type = "WIRE"
    obj.show_in_front = True
    obj.hide_render = True
    return obj


# ----------------------------------------------------------- shell build

def _box_frame(planes):
    """Box axes: Y follows the first cut's horizontal pull direction so the
    main cut runs parallel to the box faces."""
    ez = Vector((0, 0, 1))
    if planes:
        n = planes[0][1]
        h = Vector((n.x, n.y, 0))
        if h.length > 1e-3:
            ey = h.normalized()
            ex = ey.cross(ez).normalized()
            return Matrix((ex, ey, ez)).transposed()  # columns = axes
    return Matrix.Identity(3)


def _cylinder(bm, center, direction, radius, length, segments=32):
    rot = Vector((0, 0, 1)).rotation_difference(direction).to_matrix().to_4x4()
    mat = Matrix.Translation(center) @ rot
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments,
                          radius1=radius, radius2=radius, depth=length, matrix=mat)


def _apply_booleans(target, cutters, op="DIFFERENCE"):
    """Boolean the cutters into target. Tries Blender's Exact solver (with
    self-intersection handling, which real scans need) and falls back to the
    Manifold solver if the result looks wrong (e.g. the whole shell vanished)."""
    v_target = _volume(target)
    v_cut = sum(min(_volume(c), v_target) for c in cutters if c.type == "MESH")
    expect_min = v_target - v_cut - 0.02 * v_target if op == "DIFFERENCE" else \
        (v_target * 1e-6 if op == "INTERSECT" else None)
    # cutting a piece out must not open up the mesh: compare open edges too
    check_edges = op in ("INTERSECT", "UNION")
    open_before = _open_edges(target.data) + sum(_open_edges(c.data) for c in cutters) if check_edges else 0
    best = None
    # the Manifold solver refuses meshes with open edges, so don't ask it
    solvers = ("EXACT",) if check_edges and open_before else ("EXACT", "MANIFOLD")
    for solver in solvers:
        for c in cutters:
            m = target.modifiers.new("ms_bool", "BOOLEAN")
            m.operation = op
            m.solver = solver
            m.object = c
            if solver == "EXACT":
                m.use_hole_tolerant = True
                m.use_self = True
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(target.evaluated_get(dg))
        target.modifiers.clear()
        bm = bmesh.new()
        bm.from_mesh(me)
        vol = abs(bm.calc_volume()) if len(bm.faces) else 0.0
        bad = sum(1 for e in bm.edges if not e.is_manifold) if check_edges else 0
        bm.free()
        vol_ok = expect_min is None or vol >= expect_min
        rank = (not vol_ok, max(0, bad - open_before))
        if best is None or rank < best[2]:
            if best is not None:
                bpy.data.meshes.remove(best[0])
            best = (me, vol, rank)
        else:
            bpy.data.meshes.remove(me)
        if rank == (False, 0):
            break
        if not vol_ok:
            print(f"[mold shell] {solver} boolean looked wrong ({vol:.0f} vs >= {expect_min:.0f}), retrying")
        else:
            print(f"[mold shell] {solver} boolean left {bad - open_before} open edges, retrying")
    old = target.data
    target.data = best[0]
    if old.users == 0:
        bpy.data.meshes.remove(old)
    return target


def _open_edges(me):
    bm = bmesh.new()
    bm.from_mesh(me)
    n = sum(1 for e in bm.edges if not e.is_manifold)
    bm.free()
    return n


def fill_holes(bm):
    """Close every hole in a surface. Blender's own hole fill does most; any
    hole it leaves (an odd-shaped or twisted rim) is closed with a fan of
    triangles around the middle of its rim. Returns the number of holes closed."""
    rim = [e for e in bm.edges if e.is_boundary]
    if not rim:
        return 0
    filled = len(bmesh.ops.holes_fill(bm, edges=rim, sides=0)["faces"])
    left = {e for e in bm.edges if e.is_boundary}
    while left:
        e0 = left.pop()
        start, v, prev = e0.verts[0], e0.verts[1], e0
        loop = [start]
        while v is not start:
            loop.append(v)
            nxt = [e for e in v.link_edges if e in left]
            if not nxt:
                break
            prev = nxt[0]
            left.discard(prev)
            v = prev.other_vert(v)
        if v is not start or len(loop) < 3:
            continue
        mid = bm.verts.new(sum((x.co for x in loop), Vector()) / len(loop))
        for a, b in zip(loop, loop[1:] + loop[:1]):
            try:
                bm.faces.new((b, a, mid))
            except ValueError:
                pass
        filled += 1
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return filled


def _loose_geometry(bm):
    bmesh.ops.delete(bm, geom=[e for e in bm.edges if not e.link_faces], context="EDGES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_edges], context="VERTS")


def _pieces_by_area(bm):
    """Connected pieces of the surface (through any shared edge), biggest first."""
    seen, parts = set(), []
    for f in bm.faces:
        if f in seen:
            continue
        stack, part, area = [f], [], 0.0
        seen.add(f)
        while stack:
            cur = stack.pop()
            part.append(cur)
            area += cur.calc_area()
            for e in cur.edges:
                for nb in e.link_faces:
                    if nb not in seen:
                        seen.add(nb)
                        stack.append(nb)
        parts.append((area, part))
    parts.sort(key=lambda p: -p[0])
    return parts


def repair_scan(bm):
    """Fix the ways scans come out broken, in order: seams that were never
    welded, stray edges, doubled triangles, crumbs floating off the surface,
    fins and double layers (an edge shared by three or more triangles),
    bow-ties (two parts touching at one point) and holes. Anything still
    wrong after a pass is cut back to clean surface and filled again.
    Returns what it did, as counts."""
    did = dict(welded=0, doubles=0, crumbs=0, trimmed=0, holes=0)
    if not bm.verts:
        return did
    lo = [min(v.co[i] for v in bm.verts) for i in range(3)]
    hi = [max(v.co[i] for v in bm.verts) for i in range(3)]
    span = max(h - l for h, l in zip(hi, lo)) or 1.0
    n0 = len(bm.verts)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=span * 1e-6)
    # a crack where the scan's halves were never joined: weld the open edges' points a little further apart
    rim = list({v for e in bm.edges if not e.is_manifold for v in e.verts})
    if rim:
        bmesh.ops.remove_doubles(bm, verts=rim, dist=max(span * 1e-4, 0.01))
    did["welded"] = n0 - len(bm.verts)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges[:], dist=span * 1e-7)
    _loose_geometry(bm)
    seen, extra = set(), []
    for f in bm.faces:
        key = frozenset(f.verts)
        if key in seen:
            extra.append(f)
        else:
            seen.add(key)
    if extra:
        bmesh.ops.delete(bm, geom=extra, context="FACES_ONLY")
        _loose_geometry(bm)
    did["doubles"] = len(extra)
    parts = _pieces_by_area(bm)
    if len(parts) > 1:
        crumbs = [p for a, p in parts[1:] if a < parts[0][0] * 0.02]
        for p in crumbs:
            bmesh.ops.delete(bm, geom=p, context="FACES_ONLY")
        _loose_geometry(bm)
        did["crumbs"] = len(crumbs)
    for _ in range(6):
        did["holes"] += fill_holes(bm)
        # triangulate the patches now: splitting a big patch can add an edge that's already there
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3], quad_method="BEAUTY", ngon_method="BEAUTY")
        bad_e = [e for e in bm.edges if not e.is_manifold]
        bad_v = [v for v in bm.verts if not v.is_manifold]
        if not bad_e and not bad_v:
            break
        # cut back to clean surface around every bad spot (one ring further out), then fill again
        kill = {f for e in bad_e for f in e.link_faces} | {f for v in bad_v for f in v.link_faces}
        kill |= {g for f in list(kill) for v in f.verts for g in v.link_faces}
        did["trimmed"] += len(kill)
        bmesh.ops.delete(bm, geom=list(kill), context="FACES_ONLY")
        _loose_geometry(bm)
        parts = _pieces_by_area(bm)  # trimming can cut crumbs loose
        for a, p in parts[1:]:
            if a < parts[0][0] * 0.02:
                bmesh.ops.delete(bm, geom=p, context="FACES_ONLY")
        _loose_geometry(bm)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return did


def _halfspace(point, normal, size):
    """Big block whose bottom face lies on the plane, extending along +normal."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * 2 * size, v.co.y * 2 * size, (v.co.z + 0.5) * size))
    rot = Vector((0, 0, 1)).rotation_difference(normal).to_matrix().to_4x4()
    obj = _new_obj("ms_tmp_half", bm, matrix=Matrix.Translation(point) @ rot)
    obj.hide_render = True
    return obj


def _region(halfspaces, lo, hi, name="ms_tmp_region"):
    """Convex block: the box lo..hi (world, padded) cut down to the kept side
    (n . (x - p) >= 0) of every (point, normal) in halfspaces."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector(tuple((lo[i] if v.co[i] < 0 else hi[i]) for i in range(3)))
    for p, n in halfspaces:
        if not bm.faces:
            break
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
                               plane_co=Vector(p), plane_no=Vector(n), clear_inner=True)
        rim = [e for e in bm.edges if e.is_boundary]
        if rim:
            bmesh.ops.holes_fill(bm, edges=rim, sides=0)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return _new_obj(name, bm)


def _region_union(cells, lo, hi, name="ms_tmp_region"):
    """Several convex blocks that touch, joined into one (maybe L or T shaped)
    block. Tries Exact, then Manifold, and keeps the one whose volume adds up."""
    regs = [_region(hs, lo, hi, name=f"ms_tmp_region_{i}") for i, hs in enumerate(cells)]
    regs = [r for r in regs if r.data.polygons]
    if not regs:
        return None
    first, rest = regs[0], regs[1:]
    if not rest:
        return first
    want = sum(_volume(r) for r in regs)
    best = None
    for solver in ("EXACT", "MANIFOLD"):
        for r in rest:
            m = first.modifiers.new("ms_union", "BOOLEAN")
            m.operation = "UNION"
            m.solver = solver
            m.object = r
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(first.evaluated_get(dg))
        first.modifiers.clear()
        bm = bmesh.new()
        bm.from_mesh(me)
        vol = abs(bm.calc_volume()) if len(bm.faces) else 0.0
        bad = sum(1 for e in bm.edges if not e.is_manifold)
        bm.free()
        err = abs(vol - want) / max(want, 1e-9)
        if best is None or (bad, err) < (best[2], best[1]):
            if best is not None:
                bpy.data.meshes.remove(best[0])
            best = (me, err, bad)
        else:
            bpy.data.meshes.remove(me)
        if bad == 0 and err < 1e-3:
            break
        print(f"[mold shell] {solver} union of {len(regs)} blocks looked wrong (volume off {err:.1%}, {bad} open edges)")
    old = first.data
    first.data = best[0]
    if old.users == 0:
        bpy.data.meshes.remove(old)
    for r in rest:
        _remove(r)
    first.name = name
    return first


def _volume(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    v = abs(bm.calc_volume()) if len(bm.faces) else 0.0
    bm.free()
    return v


def _remove_doubled_faces(bm):
    """Delete pairs of faces that sit back to back on the same vertices
    (zero-thickness fins a boolean can leave on thin slices)."""
    seen = {}
    kill = set()
    for f in bm.faces:
        key = frozenset(v.index for v in f.verts)
        if key in seen:
            kill.add(f)
            kill.add(seen[key])
        else:
            seen[key] = f
    if kill:
        bmesh.ops.delete(bm, geom=list(kill), context="FACES_ONLY")
        bmesh.ops.delete(bm, geom=[e for e in bm.edges if not e.link_faces], context="EDGES")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_edges], context="VERTS")
    return len(kill)


def _drop_loose_bits(bm, keep_fraction=0.01):
    """Delete small disconnected chunks (shell material trapped in pockets
    under the base, for example) that would print as loose crumbs."""
    if bm.verts:
        span = max(max(v.co[i] for v in bm.verts) - min(v.co[i] for v in bm.verts) for i in range(3))
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=span * 1e-6)
    _remove_doubled_faces(bm)
    bm.faces.ensure_lookup_table()
    bm.faces.index_update()
    seen, parts = set(), []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, part = [f], []
        seen.add(f.index)
        while stack:
            cur = stack.pop()
            part.append(cur)
            for e in cur.edges:
                if len(e.link_faces) != 2:
                    continue  # don't walk across fins that only touch along an edge
                for nb in e.link_faces:
                    if nb.index not in seen:
                        seen.add(nb.index)
                        stack.append(nb)
        vol = abs(sum(t.verts[0].co.dot(t.verts[1].co.cross(t.verts[2].co)) for t in part if len(t.verts) == 3)) / 6
        parts.append((vol, part))
    drop = []
    if len(parts) > 1:
        biggest = max(v for v, _ in parts)
        drop = [p for v, p in parts if v < biggest * keep_fraction]
    for p in drop:
        bmesh.ops.delete(bm, geom=p, context="FACES_ONLY")
    bmesh.ops.delete(bm, geom=[e for e in bm.edges if not e.link_faces], context="EDGES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_edges], context="VERTS")
    holes = [e for e in bm.edges if e.is_boundary]  # also a pinhole a boolean left
    if holes:  # patch where a fin was attached
        bmesh.ops.holes_fill(bm, edges=holes, sides=0)
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    return len(drop)


def _inside_loop(p, loop):
    """Is the point p (x, y) inside the closed loop of edges (seen from above)?"""
    x, y, n = p[0], p[1], 0
    for e in loop:
        (x1, y1), (x2, y2) = e.verts[0].co.xy, e.verts[1].co.xy
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            n += 1
    return n % 2 == 1


def make_pour_extension(latex_obj, extend_mm, flare_deg=0.0, mm=1.0, cut_mm=0.5, every_outer=False):
    """Carry the latex's base opening straight down by extend_mm (optionally
    flaring outward by flare_deg) so the shell gets a pour collar. Returns a
    temporary object to use in place of the latex; the latex is untouched."""
    co, tris = _world_tris(latex_obj)
    zmin = float(co[:, 2].min())
    zc = zmin + cut_mm * mm
    bm = bmesh.new()
    verts = [bm.verts.new(tuple(v)) for v in co]
    for t in tris:
        try:
            bm.faces.new([verts[i] for i in t])
        except ValueError:
            pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6 * float(np.ptp(co, axis=0).max()))
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
                           plane_co=(0, 0, zc), plane_no=(0, 0, 1), clear_inner=True)
    rim = [e for e in bm.edges if e.is_boundary]
    if not rim:
        bm.free()
        raise RuntimeError("Couldn't find the base outline to extend.")
    # split the base outline into loops; only the outer one becomes the
    # collar, smaller ones (recesses in the base) are capped off
    seen, loops = set(), []
    for e in rim:
        if e in seen:
            continue
        stack, loop = [e], []
        while stack:
            x = stack.pop()
            if x in seen:
                continue
            seen.add(x)
            loop.append(x)
            for v in x.verts:
                stack.extend(e2 for e2 in v.link_edges if e2.is_boundary and e2 not in seen)
        loops.append((sum(x.calc_length() for x in loop), loop))
    loops.sort(key=lambda L: -L[0])
    loops = [L for _, L in loops]
    if every_outer:
        # a model standing on more than one foot: every outline that isn't a
        # recess inside another one goes down
        outer = [L for i, L in enumerate(loops)
                 if not any(j != i and _inside_loop(L[0].verts[0].co.xy, M) for j, M in enumerate(loops))]
    else:
        outer = loops[:1]
    for loop in loops:
        if not any(loop is L for L in outer):
            bmesh.ops.edgeloop_fill(bm, edges=loop)
    drop = zc - (zmin - extend_mm * mm)
    grow = math.tan(math.radians(flare_deg)) * drop
    for rim in outer:
        ext = bmesh.ops.extrude_edge_only(bm, edges=rim)
        new_v = [g for g in ext["geom"] if isinstance(g, bmesh.types.BMVert)]
        cx = sum(v.co.x for v in new_v) / len(new_v)
        cy = sum(v.co.y for v in new_v) / len(new_v)
        for v in new_v:
            d = Vector((v.co.x - cx, v.co.y - cy, 0))
            if grow and d.length > 1e-9:
                v.co += d.normalized() * grow
            v.co.z = zmin - extend_mm * mm
        bottom = [e for e in ext["geom"] if isinstance(e, bmesh.types.BMEdge) and e.is_boundary]
        bmesh.ops.edgeloop_fill(bm, edges=bottom)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    obj = _new_obj("ms_tmp_pour", bm)
    obj.hide_render = True
    if _volume(obj) <= 0:
        _remove(obj)
        raise RuntimeError("The pour extension didn't close up; try repairing the scan first.")
    return obj


def _hull_area(pts):
    from mathutils.geometry import convex_hull_2d
    if len(pts) < 3:
        return 0.0
    h = pts[list(convex_hull_2d([tuple(p) for p in pts]))]
    x, y = h[:, 0], h[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1))))


def base_cover(latex_obj, reach=0.0):
    """How much of the model's underside the base will meet, 0 to 1: the
    footprint at the level the base reaches up to, against the footprint of
    the bottom quarter of the model. Low means only a bit of it touches the
    floor (a paw, a corner) and the base should reach further up."""
    co, _ = _world_tris(latex_obj)
    zmin, span = float(co[:, 2].min()), float(np.ptp(co[:, 2]))
    lvl = zmin + max(0.5, float(reach), 0.01 * span)
    whole = _hull_area(co[co[:, 2] < zmin + 0.25 * span][:, :2])
    return _hull_area(co[co[:, 2] < lvl][:, :2]) / whole if whole > 0 else 1.0


def _outer_outline_segs(latex_obj, zc):
    """The model's outline at height zc, seen from above, as segments
    (x1, y1, x2, y2): only the outer loops, so recesses get filled."""
    co, tris = _world_tris(latex_obj)
    bm = bmesh.new()
    verts = [bm.verts.new(tuple(v)) for v in co]
    for t in tris:
        try:
            bm.faces.new([verts[i] for i in t])
        except ValueError:
            pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6 * float(np.ptp(co, axis=0).max()))
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
                           plane_co=(0, 0, zc), plane_no=(0, 0, 1), clear_inner=True)
    rim = [e for e in bm.edges if e.is_boundary]
    seen, loops = set(), []
    for e in rim:
        if e in seen:
            continue
        stack, loop = [e], []
        while stack:
            x = stack.pop()
            if x in seen:
                continue
            seen.add(x)
            loop.append(x)
            for v in x.verts:
                stack.extend(e2 for e2 in v.link_edges if e2.is_boundary and e2 not in seen)
        loops.append(loop)
    outer = [L for i, L in enumerate(loops)
             if not any(j != i and _inside_loop(L[0].verts[0].co.xy, M) for j, M in enumerate(loops))]
    segs = np.array([(e.verts[0].co.x, e.verts[0].co.y, e.verts[1].co.x, e.verts[1].co.y) for L in outer for e in L])
    bm.free()
    if not len(segs):
        raise RuntimeError("Couldn't find the outline to put a base under.")
    return segs


def _outline_area(segs, cell):
    """Area inside the outline segments, counted on a grid (mm²)."""
    lo, hi = segs.reshape(-1, 2).min(0), segs.reshape(-1, 2).max(0)
    nx, ny = int((hi[0] - lo[0]) / cell) + 1, int((hi[1] - lo[1]) / cell) + 1
    xc = lo[0] + (np.arange(nx) + 0.5) * cell
    x1, y1, x2, y2 = segs.T
    n = 0
    for j in range(ny):
        y = lo[1] + (j + 0.5) * cell
        m = (y1 > y) != (y2 > y)
        if not m.any():
            continue
        xi = np.sort(x1[m] + (y - y1[m]) * (x2[m] - x1[m]) / (y2[m] - y1[m]))
        for a, b in zip(xi[0::2], xi[1::2]):
            n += int(((xc >= a) & (xc <= b)).sum())
    return n * cell * cell


def auto_reach(latex_obj):
    """How far up the base should reach so it meets the whole underside, in mm
    above the lowest point. 0 when the bottom already sits flat. Looks at the
    model's outline at a few heights in its bottom fifth: if the outline at the
    floor is much smaller than it gets a little higher (a tilted or rounded
    underside, a cat sitting on its haunches), it goes up to where the outline
    has nearly filled out."""
    co, _ = _world_tris(latex_obj)
    zmin, span = float(co[:, 2].min()), float(np.ptp(co[:, 2]))
    cell = max(0.5, float(np.ptp(co[:, :2], axis=0).max()) / 200.0)
    levels = [l for l in (0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40) if l <= max(1.0, 0.2 * span)]
    areas = []
    for l in levels:
        try:
            areas.append(_outline_area(_outer_outline_segs(latex_obj, zmin + l), cell))
        except RuntimeError:
            areas.append(0.0)
    top = max(areas) if areas else 0.0
    if top <= 0 or areas[0] >= 0.5 * top:
        return 0.0
    for l, a in zip(levels, areas):
        if a >= 0.85 * top:
            return float(l)
    return float(levels[-1])


def _widened_base(segs, widen, top, bot, grow=0.0):
    """A solid from z=bot up to z=top whose outline is the given one grown by
    widen mm all round (a rounded offset, worked out on a fine grid so it never
    folds over itself in the tight spots), and flared out by grow at the bottom."""
    lo = segs.reshape(-1, 2).min(0) - widen
    hi = segs.reshape(-1, 2).max(0) + widen
    cell = max(0.4, float((hi - lo).max()) / 400.0)
    pad = int(math.ceil(widen / cell)) + 3
    lo = lo - pad * cell + widen  # widen is already in the pad
    nx = int(math.ceil((hi[0] + widen - lo[0]) / cell)) + pad + 2
    ny = int(math.ceil((hi[1] + widen - lo[1]) / cell)) + pad + 2
    grid = np.zeros((ny, nx), bool)
    xc = lo[0] + (np.arange(nx) + 0.5) * cell
    x1, y1, x2, y2 = segs.T
    for j in range(ny):
        y = lo[1] + (j + 0.5) * cell
        m = (y1 > y) != (y2 > y)
        if not m.any():
            continue
        xi = np.sort(x1[m] + (y - y1[m]) * (x2[m] - x1[m]) / (y2[m] - y1[m]))
        for a, b in zip(xi[0::2], xi[1::2]):
            grid[j, (xc >= a) & (xc <= b)] = True
    r = widen / cell
    R = int(math.ceil(r))
    out = grid.copy()
    for dy in range(-R, R + 1):
        for dx in range(-R, R + 1):
            if (dx or dy) and dx * dx + dy * dy <= r * r:
                out[max(0, dy):ny + min(0, dy), max(0, dx):nx + min(0, dx)] |= \
                    grid[max(0, -dy):ny - max(0, dy), max(0, -dx):nx - max(0, dx)]
    while True:  # cells touching only at a corner would make a pinched solid
        a, b, c, d = out[:-1, :-1], out[:-1, 1:], out[1:, :-1], out[1:, 1:]
        diag = (a & d & ~b & ~c) | (b & c & ~a & ~d)
        if not diag.any():
            break
        out[:-1, 1:] |= diag
        out[1:, :-1] |= diag
    J, I = np.nonzero(out)
    if not len(J):
        raise RuntimeError("Couldn't find the outline to put a base under.")
    W = nx + 1
    quads = np.stack([J * W + I, J * W + I + 1, (J + 1) * W + I + 1, (J + 1) * W + I], 1)
    used, inv = np.unique(quads, return_inverse=True)
    quads = inv.reshape(-1, 4)
    vx = lo[0] + (used % W) * cell
    vy = lo[1] + (used // W) * cell
    me = bpy.data.meshes.new("ms_tmp_grid")
    me.from_pydata(np.stack([vx, vy, np.full(len(used), top)], 1).tolist(), [], quads.tolist())
    bm = bmesh.new()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    # round off the grid's steps along the edge
    edge_v = [v for v in bm.verts if v.is_boundary]
    for _ in range(4):
        new = {}
        for v in edge_v:
            nb = [e.other_vert(v) for e in v.link_edges if e.is_boundary]
            if len(nb) == 2:
                new[v] = v.co * 0.5 + (nb[0].co + nb[1].co) * 0.25
        for v, p in new.items():
            v.co = p
    # keep only the outline and fill it again (a fill is quick; merging the
    # grid's cells into one face is not)
    rim = set(e for e in bm.edges if e.is_boundary)
    bmesh.ops.delete(bm, geom=bm.faces[:], context="FACES_ONLY")
    bmesh.ops.delete(bm, geom=[e for e in bm.edges if e not in rim], context="EDGES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_edges], context="VERTS")
    rim = bm.edges[:]
    bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=rim, normal=(0, 0, 1))
    outn = {}
    if grow:
        # each outline point's outward direction (away from the top face),
        # smoothed along the outline so tight spots don't fold over
        for e in rim:
            if len(e.link_faces) != 1:
                continue
            a_, b_ = e.verts[0].co.xy, e.verts[1].co.xy
            n = Vector(((b_ - a_).y, -(b_ - a_).x))
            if n.length < 1e-9:
                continue
            n.normalize()
            if (e.link_faces[0].calc_center_median().xy - (a_ + b_) / 2).dot(n) > 0:
                n = -n
            for v in e.verts:
                outn[v] = outn.get(v, Vector((0, 0))) + n
        nbrs = {v: [e.other_vert(v) for e in v.link_edges if e in rim_set] for v in outn} if (rim_set := set(rim)) else {}
        for _ in range(min(40, max(2, int(grow / cell)))):
            outn = {v: (n + sum((outn.get(w, Vector((0, 0))) for w in nbrs[v]), Vector((0, 0)))) for v, n in outn.items()}
            outn = {v: (n.normalized() if n.length > 1e-9 else n) for v, n in outn.items()}
    ext = bmesh.ops.extrude_edge_only(bm, edges=rim)
    new_v = [g for g in ext["geom"] if isinstance(g, bmesh.types.BMVert)]
    for v in new_v:
        v.co.z = bot
    # fill the bottom while it's the same shape as the top, then flare it
    bottom = [e for e in bm.edges if e.is_boundary]
    bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=bottom, normal=(0, 0, 1))
    if grow:
        for v in new_v:
            up = next((e.other_vert(v) for e in v.link_edges if e.other_vert(v) in outn), None)
            if up is not None:
                v.co.x += outn[up].x * grow
                v.co.y += outn[up].y * grow
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    obj = _new_obj("ms_tmp_wbase", bm)
    obj.hide_render = True
    return obj


def _underside_base(latex_obj, height, reach=None, widen=0.0, grow=0.0):
    """A base that fills in under the model right up to its underside, however
    uneven or tilted that is, down to a flat bottom height mm below the lowest
    point. Only underside within reach mm of the lowest point is filled (so a
    raised paw or a chin isn't); reach None works it out from the model.
    widen grows it out all round at the height of the nearest underside; grow
    slopes that rim down to the bottom like a flare. Returns (solid, reach)."""
    co, tris = _world_tris(latex_obj)
    zmin = float(co[:, 2].min())
    hgt = float(np.ptp(co[:, 2]))
    bot = zmin - float(height)
    tree = BVHTree.FromPolygons([tuple(v) for v in co], [tuple(t) for t in tris])
    lo, hi = co[:, :2].min(0), co[:, :2].max(0)
    span = float((hi - lo).max())
    cell = max(0.5, span / 300.0, (widen + grow) / 40.0)
    pad = widen + grow + 3 * cell
    lo, hi = lo - pad, hi + pad
    nx, ny = int(math.ceil((hi[0] - lo[0]) / cell)), int(math.ceil((hi[1] - lo[1]) / cell))
    xs, ys = lo[0] + np.arange(nx + 1) * cell, lo[1] + np.arange(ny + 1) * cell
    hz = np.full((ny + 1, nx + 1), np.inf)
    up = Vector((0, 0, 1))
    for j, y in enumerate(ys):
        for i, x in enumerate(xs):
            h = tree.ray_cast(Vector((x + 1.3e-4, y + 2.9e-4, zmin - 1.0)), up)
            if h[0] is not None:
                hz[j, i] = h[0].z
    cz = np.maximum(np.maximum(hz[:-1, :-1], hz[:-1, 1:]), np.maximum(hz[1:, :-1], hz[1:, 1:]))  # each cell's highest corner
    if reach is None:
        # go up until the filled area stops growing much: the whole underside, not what's raised above it
        rs = np.arange(0.5, max(1.5, 0.3 * hgt), 0.5)
        A = np.array([(cz <= zmin + r).sum() for r in rs], float)
        reach = float(rs[-1])
        for k, r in enumerate(rs):
            k5 = min(len(rs) - 1, k + 10)  # 5 mm further up
            if A[k] > 0 and (A[k5] - A[k]) < 0.02 * A[k]:
                reach = float(r)
                break
    cap = zmin + max(0.5, float(reach))
    core_v = hz <= cap
    # grow out from the filled part: each new point takes the height of the nearest one in it
    h = np.where(core_v, hz, np.nan)
    dist = np.where(core_v, 0.0, np.inf)
    reachd = widen + grow
    if reachd > 0:
        rr = reachd / cell
        Rn = int(math.ceil(rr))
        offs = sorted(((dx * dx + dy * dy) ** 0.5 * cell, dy, dx) for dy in range(-Rn, Rn + 1) for dx in range(-Rn, Rn + 1)
                      if 0 < dx * dx + dy * dy <= rr * rr)
        H, Wd = h.shape
        for d, dy, dx in offs:
            ty, tx = slice(max(0, dy), H + min(0, dy)), slice(max(0, dx), Wd + min(0, dx))
            sy, sx = slice(max(0, -dy), H - max(0, dy)), slice(max(0, -dx), Wd - max(0, dx))
            take = core_v[sy, sx] & np.isinf(dist[ty, tx])
            if take.any():
                dist[ty, tx][take] = d
                h[ty, tx][take] = hz[sy, sx][take]
    ok_v = dist <= reachd + 1e-9
    top = np.where(dist <= widen + 1e-9, h, h - (dist - widen) / max(grow, 1e-9) * (h - bot))
    top = np.where(ok_v, np.maximum(top + 0.3, bot + 0.6), np.nan)  # 0.3 into the model so they fuse
    filled = ok_v[:-1, :-1] & ok_v[:-1, 1:] & ok_v[1:, :-1] & ok_v[1:, 1:]
    while True:  # cells touching only at a corner would make a pinched solid
        a, b, c, d = filled[:-1, :-1], filled[:-1, 1:], filled[1:, :-1], filled[1:, 1:]
        diag = (a & d & ~b & ~c) | (b & c & ~a & ~d)
        if not diag.any():
            break
        filled[:-1, 1:] |= diag
        filled[1:, :-1] |= diag
    J, I = np.nonzero(filled)
    if not len(J):
        raise RuntimeError("Couldn't find the underside to put a base under.")
    # a cell filled by the pinch fix may have a corner with no height: borrow the lowest nearby
    top = np.where(np.isnan(top), bot + 0.6, top)
    Wv = nx + 1
    quads = np.stack([J * Wv + I, J * Wv + I + 1, (J + 1) * Wv + I + 1, (J + 1) * Wv + I], 1)
    used, inv = np.unique(quads, return_inverse=True)
    quads = inv.reshape(-1, 4)
    vy, vx = used // Wv, used % Wv
    verts = np.stack([xs[vx], ys[vy], top[vy, vx]], 1)
    me = bpy.data.meshes.new("ms_tmp_grid")
    me.from_pydata(verts.tolist(), [], quads.tolist())
    bm = bmesh.new()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    edge_v = [v for v in bm.verts if v.is_boundary]
    for _ in range(4):  # round off the grid's steps along the edge
        new = {}
        for v in edge_v:
            nb = [e.other_vert(v) for e in v.link_edges if e.is_boundary]
            if len(nb) == 2:
                q = v.co.xy * 0.5 + (nb[0].co.xy + nb[1].co.xy) * 0.25
                new[v] = q
        for v, q in new.items():
            v.co.x, v.co.y = q.x, q.y
    rim = [e for e in bm.edges if e.is_boundary]
    ext = bmesh.ops.extrude_edge_only(bm, edges=rim)
    for g in ext["geom"]:
        if isinstance(g, bmesh.types.BMVert):
            g.co.z = bot
    bottom = [e for e in bm.edges if e.is_boundary]
    bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=bottom, normal=(0, 0, 1))
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    obj = _new_obj("ms_tmp_ubase", bm)
    obj.hide_render = True
    return obj, float(reach)


def spout_solid(latex_obj, point, direction, diameter, height, name="ms_tmp_spout"):
    """A round pour spout standing out of the model at point: diameter wide,
    height out from the surface along direction, sunk in far enough to join it
    even on a slope. Returns (solid, the spout's outer end)."""
    d = Vector(direction).normalized()
    r = float(diameter) / 2
    sink = max(float(diameter), 5.0)
    p = Vector(point)
    bm = bmesh.new()
    _cylinder(bm, p + d * (height - sink) / 2, d, r, height + sink, segments=48)
    return _new_obj(name, bm), p + d * height


def add_spout(latex_obj, point, direction, diameter, height):
    """The model with a pour spout joined on. Returns (object, spout record)."""
    sp_obj, top = spout_solid(latex_obj, point, direction, diameter, height)
    me = latex_obj.data.copy()
    me.transform(latex_obj.matrix_world)
    work = _new_obj("ms_tmp_spouted", me)
    v0 = _volume(work)
    if _open_edges(work.data):
        bm = bmesh.new()
        bm.from_mesh(work.data)
        bm.from_mesh(sp_obj.data)
        bm.to_mesh(work.data)
        bm.free()
    else:
        _fast_union(work, sp_obj)
        if _volume(work) <= v0 * 1.0001 or _open_edges(work.data):
            _remove(sp_obj)
            _remove(work)
            raise RuntimeError("The spout didn't join the model cleanly; try Repair mesh first, or move it.")
    _remove(sp_obj)
    rec = {"top": [float(x) for x in top], "dir": [float(x) for x in Vector(direction).normalized()],
           "d": float(diameter), "h": float(height)}
    return work, rec


def _fast_union(target, other):
    """Union two closed solids: Blender's Manifold solver first (seconds on a
    big scan), the careful Exact one only if that comes out wrong."""
    v_need = max(_volume(target), _volume(other)) * 0.999
    m = target.modifiers.new("ms_bool", "BOOLEAN")
    m.operation, m.solver, m.object = "UNION", "MANIFOLD", other
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(target.evaluated_get(dg))
    target.modifiers.clear()
    bm = bmesh.new()
    bm.from_mesh(me)
    ok = len(bm.faces) and abs(bm.calc_volume()) >= v_need and not any(not e.is_manifold for e in bm.edges)
    bm.free()
    if ok:
        old = target.data
        target.data = me
        if old.users == 0:
            bpy.data.meshes.remove(old)
        return target
    bpy.data.meshes.remove(me)
    return _apply_booleans(target, [other], "UNION")


def make_base(latex_obj, height, flare_deg=0.0, shape="outline", margin=5.0, preview=False, reach=0.0, widen=0.0, reach_auto=False):
    """A base under the model itself, height mm below its lowest point.
    "outline" carries the model's outline straight down (flaring out by
    flare_deg), like the pour collar does for the shell. "slab" is a flat
    plinth round the whole footprint, margin mm wider, fused on. When only a
    bit of the model touches the floor, reach (mm above the lowest point) takes
    the base up to meet the rest: the outline is taken at that level, and the
    parts that hang lower are kept. Returns a new object: the model with its
    base, or with preview=True just the base. The model is untouched."""
    height = float(height)
    reach = max(0.0, float(reach or 0))
    if not height > 0:
        raise RuntimeError("Give the base a height first.")
    widen = max(0.0, float(widen or 0))
    if shape != "slab":
        # fill in under the whole underside, however uneven
        grow = math.tan(math.radians(float(flare_deg))) * float(height)
        base, used = _underside_base(latex_obj, height, reach if reach_auto is False else None, widen, grow)
        base["reach"] = used
        if preview:
            return base
        me = latex_obj.data.copy()
        me.transform(latex_obj.matrix_world)
        work = _new_obj("ms_tmp_base", me)
        if _open_edges(work.data):
            # the scan has holes, so a boolean can't be trusted: keep the base as
            # its own overlapping part (slicers merge overlapping parts anyway)
            bm = bmesh.new()
            bm.from_mesh(work.data)
            bm.from_mesh(base.data)
            bm.to_mesh(work.data)
            bm.free()
            _remove(base)
            work["reach"] = used
            return work
        v0 = _volume(work)
        _fast_union(work, base)
        _remove(base)
        if _volume(work) <= v0 * 1.001 or _open_edges(work.data):
            _remove(work)
            raise RuntimeError("The base didn't join the model cleanly; try Repair mesh first, or the flat slab.")
        work["reach"] = used
        return work
    if shape != "slab" and (widen > 0 or reach > 0.5):
        # the outline (grown all round, or taken higher up): built as its own
        # solid and fused on, so whatever hangs lower is kept
        co, _ = _world_tris(latex_obj)
        zmin = float(co[:, 2].min())
        top, bot = zmin + max(0.5, reach), zmin - height
        segs = _outer_outline_segs(latex_obj, top)
        base = _widened_base(segs, widen, top, bot, math.tan(math.radians(float(flare_deg))) * (top - bot))
        if flare_deg and _open_edges(base.data):
            print("[mold shell] flared base didn't close; making it straight")
            _remove(base)
            base = _widened_base(segs, widen, top, bot, 0.0)
        if preview:
            return base
        me = latex_obj.data.copy()
        me.transform(latex_obj.matrix_world)
        work = _new_obj("ms_tmp_base", me)
        v0 = _volume(work)
        _fast_union(work, base)
        _remove(base)
        if _volume(work) <= v0 * 1.001:
            _remove(work)
            raise RuntimeError("The base didn't join the model; try Repair mesh first, or the flat slab.")
        if _open_edges(work.data):
            _remove(work)
            raise RuntimeError("The base didn't join the model cleanly; try Repair mesh first, or the flat slab.")
        return work
    if shape != "slab":
        obj = make_pour_extension(latex_obj, height, flare_deg, 1.0, every_outer=True)
        obj.name = "ms_tmp_base"
        return obj
    from mathutils.geometry import convex_hull_2d
    co, _ = _world_tris(latex_obj)
    zmin, span = float(co[:, 2].min()), float(np.ptp(co[:, 2]))
    foot = co[co[:, 2] < zmin + max(1.0, 0.02 * span, reach)][:, :2]
    hull = foot[list(convex_hull_2d([tuple(p) for p in foot]))]
    margin = max(0.0, float(margin))
    if margin > 0:  # round the corners: the footprint grown by a circle
        a = np.linspace(0, 2 * math.pi, 32, endpoint=False)
        ring = np.stack([np.cos(a), np.sin(a)], -1) * margin
        pts = (hull[:, None, :] + ring[None]).reshape(-1, 2)
        hull = pts[list(convex_hull_2d([tuple(p) for p in pts]))]
    c = hull.mean(0)
    top, bot = zmin + max(0.5, reach), zmin - height
    grow = math.tan(math.radians(float(flare_deg))) * (top - bot)
    bm = bmesh.new()
    up = [bm.verts.new((p[0], p[1], top)) for p in hull]
    dn = []
    for p in hull:
        d = p - c
        L = float(np.hypot(*d))
        q = p + (d / L * grow if L > 1e-9 else 0)
        dn.append(bm.verts.new((q[0], q[1], bot)))
    n = len(hull)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((up[i], up[j], dn[j], dn[i]))
    bm.faces.new(up)
    bm.faces.new(dn[::-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    slab = _new_obj("ms_tmp_slab", bm)
    slab.hide_render = True
    if preview:
        return slab
    me = latex_obj.data.copy()
    me.transform(latex_obj.matrix_world)
    work = _new_obj("ms_tmp_base", me)
    _fast_union(work, slab)
    _remove(slab)
    if _open_edges(work.data):
        _remove(work)
        raise RuntimeError("The slab didn't join the model cleanly; try Repair mesh first, or the outline base.")
    return work


on_piece = None  # optional callback(k, n) while pieces are cut; (None, n) when done
on_plane = None  # optional callback(g, n) before each test-slice carve in build_test_slices


def _slab(centre, normal, thickness, size, name="ms_tmp_slab"):
    """A thin block, `thickness` through, centred on `centre` and square to `normal`."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size, v.co.y * size, v.co.z * thickness))
    rot = Vector((0, 0, 1)).rotation_difference(Vector(normal).normalized()).to_matrix().to_4x4()
    obj = _new_obj(name, bm, matrix=Matrix.Translation(Vector(centre)) @ rot)
    obj.hide_render = True
    return obj


def _band(obj, normal, d, half, name="ms_tmp_band"):
    """Just the part of obj within `half` of the plane n.x = d, closed off flat
    on both sides. Carving a test slice out of this instead of the whole scan
    gives the same slice in a fraction of the time. None if it won't close."""
    n = Vector(normal).normalized()
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.transform(obj.matrix_world)
    for off, outer in ((d + half, True), (d - half, False)):
        res = bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-7,
                                     plane_co=n * off, plane_no=n, clear_outer=outer, clear_inner=not outer)
        rim = [e for e in res["geom_cut"] if isinstance(e, bmesh.types.BMEdge) and e.is_valid and e.is_boundary]
        if rim:
            bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=rim, normal=n if outer else -n)
    ok = bool(bm.faces) and all(e.is_manifold for e in bm.edges)
    if ok:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        return _new_obj(name, bm)
    bm.free()
    return None


def _offset_solid(obj, dist, voxel, name="ms_tmp_offset"):
    """The solid grown out by dist all round (an even offset that never folds
    over itself), worked out on a voxel grid of the given size. Smooth and
    closed; the fine detail of the scan is softened to about one voxel."""
    ng = bpy.data.node_groups.new("ms_offset", "GeometryNodeTree")
    ng.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    ng.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    gi, go = ng.nodes.new("NodeGroupInput"), ng.nodes.new("NodeGroupOutput")
    sdf, g2m = ng.nodes.new("GeometryNodeMeshToSDFGrid"), ng.nodes.new("GeometryNodeGridToMesh")
    sdf.inputs["Voxel Size"].default_value = voxel
    sdf.inputs["Band Width"].default_value = int(math.ceil(dist / voxel)) + 3
    g2m.inputs["Threshold"].default_value = dist
    g2m.inputs["Adaptivity"].default_value = 0.1
    ng.links.new(gi.outputs[0], sdf.inputs["Mesh"])
    ng.links.new(sdf.outputs[0], g2m.inputs["Grid"])
    ng.links.new(g2m.outputs[0], go.inputs[0])
    me = obj.data.copy()
    me.transform(obj.matrix_world)
    tmp = _new_obj("ms_tmp_offsrc", me)
    m = tmp.modifiers.new("ms_offset", "NODES")
    m.node_group = ng
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    out = bpy.data.meshes.new_from_object(tmp.evaluated_get(dg))
    _remove(tmp)
    bpy.data.node_groups.remove(ng)
    res = _new_obj(name, out)
    res.hide_render = True
    if not len(out.polygons):
        _remove(res)
        raise RuntimeError("Couldn't grow the shell round the scan. Try Repair mesh on the Scan tab.")
    return res


def _fast_bool(target, other, op):
    """A boolean with Blender's Manifold solver (quick on big meshes), checked;
    the careful Exact one if the result doesn't add up."""
    v0, v1 = _volume(target), _volume(other)
    m = target.modifiers.new("ms_bool", "BOOLEAN")
    m.operation, m.solver, m.object = op, "MANIFOLD", other
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(target.evaluated_get(dg))
    target.modifiers.clear()
    bm = bmesh.new()
    bm.from_mesh(me)
    vol = abs(bm.calc_volume()) if len(bm.faces) else 0.0
    closed = len(bm.faces) and not any(not e.is_manifold for e in bm.edges)
    bm.free()
    ok = closed and (vol >= max(v0, v1) * 0.999 if op == "UNION" else
                     vol <= v0 * 1.0001 if op == "DIFFERENCE" else vol <= min(v0, v1) * 1.0001)
    if ok:
        old = target.data
        target.data = me
        if old.users == 0:
            bpy.data.meshes.remove(old)
        return target
    bpy.data.meshes.remove(me)
    return _apply_booleans(target, [other], op)


def _contour_outer(work, p, planes, scopes, R, box, mm, report):
    """The outside of a contour shell, before the latex is carved out of it:
    the scan grown by the shell thickness, a strip along each seam standing out
    further, a flat foot round the base opening, trimmed flat at the bottom,
    with a notch for the cord at the tip of the strips every so often up each
    seam. Returns the solid and the places for alignment bumps."""
    t = p["contour_mm"] * mm
    W = p["strip_w_mm"] * mm
    st = p["strip_t_mm"] * mm
    F = p["foot_mm"] * mm
    gap = max(10.0, p["notch_gap_mm"]) * mm
    rc = (p["hole_d_mm"] / 2 + 0.4) * mm  # the cord, with a little room
    x0, y0, z0, x1, y1, z1 = box
    co, _ = _world_tris(work)
    span = float(np.ptp(co, axis=0).max())
    voxel = max(0.4 * mm, span / 450.0)
    big = span * 4 + 20 * (t + W + F)
    ez = R.col[2].normalized()
    lo, hi = co.min(0) - (t + W + F + 10 * mm), co.max(0) + (t + W + F + 10 * mm)

    outer = _offset_solid(work, t, voxel, "ms_tmp_outer")
    steep = []
    if planes:
        slabs = None
        for (pt, n, _), scope in zip(planes, scopes):
            pt, n = Vector(pt), Vector(n).normalized()
            s = _slab(pt, n, 2 * st, big, name="ms_tmp_strip")
            if scope:
                reg = _region(scope, lo, hi)
                _fast_bool(s, reg, "INTERSECT")
                _remove(reg)
            if slabs is None:
                slabs = s
            else:
                _fast_bool(slabs, s, "UNION")
                _remove(s)
            u = n.cross(ez)
            if u.length > 0.5:  # a seam that runs up the side: cords go round it
                steep.append((pt, n, u.normalized(), scope))
        if slabs is not None and len(slabs.data.polygons):
            wide = _offset_solid(work, t + W, voxel, "ms_tmp_wide")
            _fast_bool(wide, slabs, "INTERSECT")
            _fast_bool(outer, wide, "UNION")
            _remove(wide)
        if slabs is not None:
            _remove(slabs)
    if F > 0:
        footslab = _slab(R @ Vector(((x0 + x1) / 2, (y0 + y1) / 2, z0 + t / 2)), ez, t, big, name="ms_tmp_foot")
        foot = _offset_solid(work, t + F, voxel, "ms_tmp_footw")
        _fast_bool(foot, footslab, "INTERSECT")
        _fast_bool(outer, foot, "UNION")
        _remove(foot)
        _remove(footslab)
    # flat and open at the bottom, like the box
    floor = _halfspace(R @ Vector((0, 0, z0)), ez, big)
    _fast_bool(outer, floor, "INTERSECT")
    _remove(floor)

    # notches at the strip tips, and places for the alignment bumps between them
    zf = co @ np.array(ez)
    oco, otris = _world_tris(outer)
    otree = BVHTree.FromPolygons([tuple(v) for v in oco], [tuple(x) for x in otris])

    def tip(origin, d):
        """Where a line in the seam plane, coming in along d, first meets the
        outside of the shell: the very tip of the strip."""
        h = otree.ray_cast(origin - d * big, d, 2 * big)
        return h[0]

    bm = bmesh.new()
    notches, bumps = 0, []
    in_scope = lambda q, scope: all((q - Vector(sp)).dot(Vector(sn).normalized()) >= -mm for sp, sn in scope)
    for pt, n, u, scope in steep:
        w = u.cross(n).normalized()
        if w.dot(ez) < 0:
            w = -w
        c = (co - np.array(pt)) @ np.array(n)
        near = np.abs(c) < 2.0 * mm
        if not near.any():
            continue
        top = float(zf[near].max())
        a_all = (co - np.array(pt)) @ np.array(u)

        def at_level(L):
            sel = near & (np.abs(zf - L) < 2.0 * mm)
            if not sel.any():
                return None
            return float(a_all[sel].min()), float(a_all[sel].max())

        def on_plane(a, L):
            b = (L - ez.dot(pt)) / w.dot(ez)
            return pt + u * a + w * b

        levels = []
        L = z0 + t + gap * 0.5
        while L < top - gap * 0.25:
            levels.append(L)
            L += gap
        for i, L in enumerate(levels):
            ext = at_level(L)
            if ext is None:
                continue
            for a_ext, sgn in ((ext[1], 1), (ext[0], -1)):
                q = tip(on_plane(a_ext, L), -u * sgn)
                if q is None:
                    continue
                q = q - u * sgn * 0.3 * rc  # the cord sits in a U open to the outside
                if scope and not in_scope(q, scope):
                    continue
                _cylinder(bm, q, n, rc, 2 * st + 4 * mm)
                notches += 1
            # an alignment bump half way to the next notch
            Lb = L + gap / 2
            extb = at_level(Lb) if Lb < top - t else None
            if extb is not None and p.get("bump_r_mm", 0) > 0:
                for a_ext, sgn in ((extb[1], 1), (extb[0], -1)):
                    q = tip(on_plane(a_ext, Lb), -u * sgn)
                    if q is None:
                        continue
                    q = q - u * sgn * (W * 0.5)  # half way across the strip
                    if not scope or in_scope(q, scope):
                        bumps.append((tuple(q), tuple(n)))
        # one at the top for a cord over the top
        i_top = int(np.argmax(np.where(near, zf, -np.inf)))
        q = Vector(co[i_top])
        q -= n * (q - pt).dot(n)
        q = tip(q, -ez)
        if q is not None:
            q = q - ez * 0.3 * rc
        if q is not None and (not scope or in_scope(q, scope)):
            _cylinder(bm, q, n, rc, 2 * st + 4 * mm)
            notches += 1
    if notches:
        cut = _new_obj("ms_tmp_notches", bm)
        _fast_bool(outer, cut, "DIFFERENCE")
        _remove(cut)
    else:
        bm.free()
    report["notches"] = notches
    report["contour_mm"] = p["contour_mm"]
    return outer, bumps


def _add_bumps(pieces, bumps, r, clear, mm):
    """Where a strip meets the next piece's strip: a round bump on one, a
    socket a little bigger in the other, so the pieces only go together one way."""
    def bvh(o):
        b = bmesh.new()
        b.from_mesh(o.data)
        b.transform(o.matrix_world)
        t = BVHTree.FromBMesh(b)
        b.free()
        return t

    def inside(tree, q):
        n, o, d = 0, Vector(q) + Vector((1.3e-3, 2.9e-3, 0)) * mm, Vector((0.01, 0.02, 1)).normalized()
        for _ in range(60):
            h = tree.ray_cast(o, d)
            if h[0] is None:
                break
            n += 1
            o = h[0] + d * 1e-4 * mm
        return n % 2 == 1

    trees = [bvh(o) for o in pieces]
    plus = {i: bmesh.new() for i in range(len(pieces))}
    minus = {i: bmesh.new() for i in range(len(pieces))}
    used = 0
    for q, n in bumps:
        q, n = Vector(q), Vector(n)
        a = next((i for i, t in enumerate(trees) if inside(t, q + n * (r + mm))), None)
        b = next((i for i, t in enumerate(trees) if inside(t, q - n * (r + mm))), None)
        if a is None or b is None or a == b:
            continue
        # the piece on the + side gets the bump, poking into the - side
        bmesh.ops.create_uvsphere(plus[a], u_segments=24, v_segments=12, radius=r, matrix=Matrix.Translation(q))
        bmesh.ops.create_uvsphere(minus[b], u_segments=24, v_segments=12, radius=r + clear, matrix=Matrix.Translation(q))
        used += 1
    for i, o in enumerate(pieces):
        for bm, op in ((plus[i], "UNION"), (minus[i], "DIFFERENCE")):
            if not bm.verts:
                bm.free()
                continue
            tool = _new_obj("ms_tmp_bumps", bm)
            _fast_bool(o, tool, op)
            _remove(tool)
    return used


def _shell_setup(latex_obj, p, planes, cuts, frame, report):
    """The box, its axes and the bungee channels, before anything is carved.
    build_shell and build_test_slices both start here, so a slice printed on
    its own matches the shell built later."""
    mm = _mm_to_bu(latex_obj, p["units"])
    wall = p["wall_mm"] * mm
    r = p["hole_d_mm"] * mm / 2
    edge = p["hole_edge_mm"] * mm

    # --- box in the cut-aligned frame
    if frame is not None:
        ex = Vector(frame[0]).normalized()
        ey = Vector(frame[1]).normalized()
        R = Matrix((ex, ey, ex.cross(ey).normalized())).transposed()
    else:
        R = _box_frame(planes)        # columns ex, ey, ez
    Rinv = R.transposed()
    # pour collar: build around an extended copy of the latex
    work = latex_obj
    if p.get("pour_extend_mm"):
        work = make_pour_extension(latex_obj, p["pour_extend_mm"], p.get("pour_flare_deg", 0.0), mm)
        report["pour_extend_mm"] = p["pour_extend_mm"]
    co, tris = _world_tris(work)
    local = co @ np.array(Rinv).T
    lo, hi = local.min(0), local.max(0)
    x0, y0 = lo[0] - wall, lo[1] - wall
    x1, y1 = hi[0] + wall, hi[1] + wall
    z0, z1 = lo[2] + p["bottom_trim_mm"] * mm, hi[2] + wall
    frame4 = R.to_4x4()

    # --- 45 degree bungee channels at the 4 vertical corners
    c = math.sqrt(2) * (edge + r)      # centreline offset along each face from the corner edge
    extra = 3 * r
    length = c * math.sqrt(2) + 2 * extra
    n_h = int(p["holes_per_corner"])
    zs = [z0 + (z1 - z0) * (i + 0.5) / n_h for i in range(n_h)]
    if p.get("channel_pairs"):
        g = p.get("pair_gap_mm", 10.0) * mm / 2
        zs = [z + s for z in zs for s in (-g, g)]
    bm = bmesh.new()
    hole_count = 0
    world_planes = [(Vector(pt), Vector(nn)) for pt, nn, _ in planes]
    scopes = [[(Vector(sp), Vector(sn).normalized()) for sp, sn in (c[2] or [])] for c in cuts] if cuts is not None \
        else [[] for _ in planes]
    contour = str(p.get("shell_style", "BOX")).upper() == "CONTOUR"
    for cx, sx in (() if contour else ((x0, -1), (x1, 1))):
        for cy, sy in ((y0, -1), (y1, 1)):
            for z in zs:
                centre_l = Vector((cx - sx * c / 2, cy - sy * c / 2, z))
                dir_l = Vector((sx, -sy, 0)).normalized()
                centre_w = R @ centre_l
                dir_w = R @ dir_l
                # skip a channel that a cut would slice through
                half = length / 2
                clash = False
                for (pt, nn), scope in zip(world_planes, scopes):
                    da = (centre_w - dir_w * half - pt).dot(nn)
                    db = (centre_w + dir_w * half - pt).dot(nn)
                    if da * db < 0 or min(abs(da), abs(db), abs((centre_w - pt).dot(nn))) < r + mm:
                        # a cut that only splits one piece matters only inside that piece
                        x = centre_w - dir_w * half + dir_w * (2 * half) * (da / (da - db)) if da * db < 0 else centre_w
                        if all((x - sp).dot(sn) >= -(r + mm) for sp, sn in scope):
                            clash = True
                if clash:
                    report["skipped_channels"] += 1
                    continue
                _cylinder(bm, centre_l, dir_l, r, length)
                hole_count += 1
    holes = _new_obj("ms_tmp_holes", bm, matrix=frame4) if hole_count else None
    report["channels"] = hole_count

    # clearance check: channels vs latex
    if holes is not None:
        bvh = BVHTree.FromPolygons([tuple(v) for v in co], [tuple(t) for t in tris])
        hmw = holes.matrix_world
        worst = min(bvh.find_nearest(hmw @ v.co)[3] for v in holes.data.vertices)
        report["channel_clearance_mm"] = round(worst / mm, 2)
    report["box_mm"] = [round(float(v) / mm, 1) for v in (x1 - x0, y1 - y0, z1 - z0)]
    outer, bumps = None, []
    if contour:
        if p.get("insert"):
            raise RuntimeError("The silicone insert needs the Box shell style for now. Switch Shell style to Box "
                               "on the Settings tab, or turn the insert off.")
        outer, bumps = _contour_outer(work, p, planes, scopes, R, (x0, y0, z0, x1, y1, z1), mm, report)
        oco, _ = _world_tris(outer)
        olo, ohi = (oco @ np.array(Rinv).T).min(0), (oco @ np.array(Rinv).T).max(0)
        report["box_mm"] = [round(float(v) / mm, 1) for v in (ohi - olo)]
        report["shell_style"] = "CONTOUR"

    # silicone insert: the shell gets a twist-lock slot at each corner of its open face
    locks = None
    if p.get("insert"):
        import insert as ins
        spec = ins.spec_from(p["insert"])
        ins.check(spec)
        box = (x0 / mm, y0 / mm, z0 / mm, x1 / mm, y1 / mm, z1 / mm)
        locks = ins.lock_cutters(spec, box, frame4 @ Matrix.Scale(mm, 4))
        L = ins.layout(spec, box)
        if zs:
            report["lock_channel_gap_mm"] = round(min(zs) / mm - r / mm - L["pocket_hi"], 1)
    report["box_frame"] = [float(v) / mm for v in (x0, y0, z0, x1, y1, z1)]
    report["frame_R"] = [list(row) for row in R]
    return dict(mm=mm, wall=wall, r=r, R=R, zs=[] if contour else zs, co=co, work=work, holes=holes, locks=locks,
                box=(x0, y0, z0, x1, y1, z1), frame4=frame4, outer=outer, bumps=bumps, spouts=p.get("spouts") or [])


def _carve(ctx, clip=None, name="ms_tmp_shell"):
    """The box minus the latex and the channels. clip=(centre, normal,
    thickness) first trims the box to that slab, so only a test slice's worth
    of shell is carved."""
    x0, y0, z0, x1, y1, z1 = ctx["box"]
    if ctx.get("outer") is not None:
        shell = _new_obj(name, ctx["outer"].data.copy())
    else:
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            v.co = Vector((x0 if v.co.x < 0 else x1, y0 if v.co.y < 0 else y1, z0 if v.co.z < 0 else z1))
        shell = _new_obj(name, bm, matrix=ctx["frame4"])
    if clip is not None:
        slab = _slab(clip[0], clip[1], clip[2], max(x1 - x0, y1 - y0, z1 - z0) * 4 + 1)
        _apply_booleans(shell, [slab], "INTERSECT")
        _remove(slab)
        if not len(shell.data.polygons):
            return shell
    band = None
    if clip is not None:  # only the latex near the slice matters
        n = Vector(clip[1]).normalized()
        band = _band(ctx["work"], n, Vector(clip[0]).dot(n), clip[2] / 2 + 2.0 * ctx["mm"])
    spouts = None
    if ctx.get("spouts"):
        bm = bmesh.new()
        far = max(x1 - x0, y1 - y0, z1 - z0) * 3 + 10 * ctx["mm"]
        for s in ctx["spouts"]:
            d = Vector(s["dir"]).normalized()
            top = Vector(s["top"]) * ctx["mm"]
            _cylinder(bm, top + d * (far / 2 - 1.0 * ctx["mm"]), d, s["d"] / 2 * ctx["mm"], far, segments=48)
        spouts = _new_obj("ms_tmp_spoutholes", bm)
    _apply_booleans(shell, [band or ctx["work"]] + [o for o in (ctx["holes"], ctx.get("locks"), spouts) if o], "DIFFERENCE")
    if spouts is not None:
        _remove(spouts)
    if band is not None:
        _remove(band)
    # tidy the shell before cutting it up: triangles only, no doubled
    # vertices or back-to-back faces, so each piece's boolean starts clean
    bm = bmesh.new()
    bm.from_mesh(shell.data)
    bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method="BEAUTY", ngon_method="BEAUTY")
    if bm.verts:
        span = max(max(v.co[i] for v in bm.verts) - min(v.co[i] for v in bm.verts) for i in range(3))
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=span * 1e-6)
    _remove_doubled_faces(bm)
    bm.to_mesh(shell.data)
    bm.free()
    return shell


def _world_box(ctx, pad):
    x0, y0, z0, x1, y1, z1 = ctx["box"]
    pts = np.array([(ctx["frame4"] @ Vector((x, y, z)))[:] for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)])
    if ctx.get("outer") is not None:  # a contour shell's strips and foot stand out past the box
        oco, _ = _world_tris(ctx["outer"])
        pts = np.vstack([pts, oco.min(0), oco.max(0)])
    return pts.min(0) - pad, pts.max(0) + pad


def _cut_piece(shell, spec, lo_w, hi_w, min_vol):
    """One piece: a copy of the shell inside the piece's region, or None if
    nothing is left. Returns (object, the piece's half-spaces)."""
    V = lambda hs: [(Vector(a), Vector(b).normalized()) for a, b in hs]
    cells = [V(c) for c in (spec.get("cells") or [spec.get("hs") or []])]
    hs = [h for c in cells for h in c]
    a = shell.copy()
    a.data = shell.data.copy()
    _collection().objects.link(a)
    if spec.get("hull") is not None:
        # an L or T shaped piece: the block around it, minus the
        # notches where other pieces sit (each cleaner than a union)
        hull = V(spec["hull"])
        if hull:
            region = _region(hull, lo_w, hi_w)
            _apply_booleans(a, [region], "INTERSECT")
            _remove(region)
        for group in spec.get("notches") or []:
            group = [V(c) for c in group]
            notch = _region(group[0], lo_w, hi_w, name="ms_tmp_notch") if len(group) == 1 else \
                _region_union(group, lo_w, hi_w, name="ms_tmp_notch")
            if notch is None:
                continue
            if notch.data.polygons and len(a.data.vertices):
                _apply_booleans(a, [notch], "DIFFERENCE")
            _remove(notch)
    else:
        region = _region(cells[0], lo_w, hi_w) if len(cells) == 1 else _region_union(cells, lo_w, hi_w)
        if region is None or not region.data.polygons:
            if region is not None:
                _remove(region)
            _remove(a)
            return None
        _apply_booleans(a, [region], "INTERSECT")
        _remove(region)
    if not len(a.data.vertices) or _volume(a) <= min_vol:
        _remove(a)
        return None
    return a, hs


def _tri_volume(co, tris):
    a, b, c = co[tris[:, 0]], co[tris[:, 1]], co[tris[:, 2]]
    return abs(float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum()) / 6.0)


def _split_loose(obj):
    """The object's separate solid bits, each an object of its own (just
    [obj] when it's all one piece). Faces count as joined when they share an
    edge, so the mesh itself is kept exactly as it is."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    seen, comps = set(), []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, comp = [f], [f.index]
        seen.add(f.index)
        while stack:
            cur = stack.pop()
            for e in cur.edges:
                for nb in e.link_faces:
                    if nb.index not in seen:
                        seen.add(nb.index)
                        comp.append(nb.index)
                        stack.append(nb)
        comps.append(set(comp))
    bm.free()
    if len(comps) <= 1:
        return [obj]
    out = []
    for keep in comps:
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index not in keep], context="FACES")
        out.append(_new_obj(obj.name + "_bit", bm, matrix=obj.matrix_world.copy()))
    _remove(obj)
    return out


def _union_ok(target, other):
    """Union other into target if that comes out a clean closed solid;
    otherwise leave target as it was. True if it joined."""
    keep = target.data.copy()
    _fast_union(target, other)
    if len(target.data.polygons) and not _open_edges(target.data):
        bpy.data.meshes.remove(keep)
        return True
    old = target.data
    target.data = keep
    if old.users == 0:
        bpy.data.meshes.remove(old)
    return False


def _props(obj):
    """The object's own settings as plain values (they outlive the object)."""
    return {k: (obj[k].to_list() if hasattr(obj[k], "to_list") else obj[k].to_dict() if hasattr(obj[k], "to_dict") else obj[k])
            for k in obj.keys()}


def _settle_bits(pieces, wall, report, small=0.15):
    """A piece whose region catches the shell in more than one place would
    print as separate bits. A small bit is joined onto the bit it meets across
    a cut; a big one becomes a piece of its own. Each piece file is then one
    solid part."""
    from mathutils.kdtree import KDTree
    props = [_props(obj) for obj, _ in pieces]
    if os.environ.get("GS_DEBUG_SPLIT"):
        print("[settle] open before", [_open_edges(o.data) for o, _ in pieces])
    pulls = [pull for _, pull in pieces]
    bits, dropped = [], 0  # [piece index, object, points, triangles, volume]
    for i, (obj, _) in enumerate(pieces):
        for o in _split_loose(obj):
            co, tris = _world_tris(o)
            tris = np.asarray(tris)
            v = _tri_volume(co, tris)
            if v <= (wall ** 3) * 0.001:
                _remove(o)
                dropped += 1
                continue
            bits.append([i, o, co, tris, v])
    if len(bits) == len(pieces) and not dropped:
        return pieces
    main = {}
    for b, (i, _, _, _, v) in enumerate(bits):
        if i not in main or v > bits[main[i]][4]:
            main[i] = b
    pts = [(b, v) for b, bit in enumerate(bits) for v in bit[2]]
    kd = KDTree(len(pts))
    for j, (_, v) in enumerate(pts):
        kd.insert(Vector(v), j)
    kd.balance()

    def touching(b):
        """The other bits this bit meets face to face, and over how many faces."""
        near = set()
        for v in bits[b][2]:
            for _, j, _ in kd.find_range(Vector(v), 2e-3):
                if pts[j][0] != b:
                    near.add(pts[j][0])
        cnt = {}
        cen = bits[b][2][bits[b][3]].mean(1)
        for o in near:
            tree = BVHTree.FromPolygons([tuple(x) for x in bits[o][2]], [tuple(t) for t in bits[o][3]])
            n = sum(1 for c in cen if tree.find_nearest(Vector(c), 0.02)[0] is not None)
            if n:
                cnt[o] = n
        return cnt
    # where each bit ends up: its own piece's main part, a piece of its own,
    # or (a small one) with the bit it meets over the most faces
    home, follow = {}, {}
    for b, (i, _, _, _, v) in enumerate(bits):
        if main[i] == b:
            home[b] = ("piece", i)
        elif v >= small * bits[main[i]][4]:
            home[b] = ("own", b)
        else:
            cnt = touching(b)
            if cnt:
                follow[b] = max(cnt, key=cnt.get)
            elif v < 0.01 * bits[main[i]][4]:
                home[b] = None  # a crumb touching nothing: as before, left out
            else:
                home[b] = ("own", b)

    def resolve(b, seen=()):
        if b in home:
            return home[b]
        if b in seen:
            return ("own", b)  # small bits only touching each other: one piece
        h = resolve(follow[b], seen + (b,))
        home[b] = ("own", b) if h is None else h
        return home[b]
    for b in list(follow):
        resolve(b)
    groups = {}
    for b in range(len(bits)):
        if home[b] is None:
            _remove(bits[b][1])
            dropped += 1
        else:
            groups.setdefault(home[b], []).append(b)
    out, joined, own = [], 0, 0
    order = sorted(groups, key=lambda k: (k[0] != "piece", k[1]))
    for key in order:
        mine = sorted(groups[key], key=lambda b: -bits[b][4])
        if key[0] == "piece":
            mine.remove(main[key[1]])
            mine.insert(0, main[key[1]])
        i = key[1] if key[0] == "piece" else bits[key[1]][0]
        target = bits[mine[0]][1]
        alone = []
        for b in mine[1:]:
            if _union_ok(target, bits[b][1]):
                _remove(bits[b][1])
                joined += 1
            else:
                alone.append(b)  # wouldn't join cleanly: printed on its own
        for o in [target] + [bits[b][1] for b in alone]:
            for k, v in props[i].items():
                o[k] = v
            out.append((o, pulls[i]))
        own += (key[0] == "own") + len(alone)
    if os.environ.get("GS_DEBUG_SPLIT"):
        print("[settle] open after", [(o.name, _open_edges(o.data)) for o, _ in out])
    report["bits_joined"] = joined
    report["bits_own_piece"] = own
    report["loose_bits_removed"] = report.get("loose_bits_removed", 0) + dropped
    return out


def _keep_slice_plan(obj, spec):
    """Remember where this piece's test slice goes, as worked out in the app."""
    plan = spec.get("slice") or {}
    if plan.get("point") and plan.get("normal"):
        obj["slice_point"] = tuple(float(x) for x in plan["point"])
        obj["slice_normal"] = tuple(float(x) for x in plan["normal"])
        obj["slice_why"] = str(plan.get("why") or "")
        if plan.get("alt"):
            obj["slice_alt"] = tuple(float(x) for x in plan["alt"])


def build_shell(latex_obj, auto_cut=True, test_slices=True, cuts=None, pieces=None, frame=None, **params):
    """Build the split shell. Returns list of piece objects and a report dict.

    cuts:   optional list of (point, normal, scope). scope is the list of
            (point, normal) half-spaces of the piece that cut splits; empty
            means it runs through the whole box. Used for the box's alignment
            (first cut) and to skip channels a cut runs through.
    pieces: optional list of dicts {"hs": [(point, normal), ...],
            "pull": (x, y, z), "id": str, "order": int}. Each piece is the
            shell on the kept side of all its planes. A piece made of several
            joined blocks gives "cells": [[(point, normal), ...], ...] instead
            of "hs", and for building, "hull" (the convex block around it)
            plus "notches" (groups of blocks to take out of the hull).
            "slice": {"point", "normal", "alt"} says where its test slice goes
            (centre of the slice, and a second place to try if that one
            misses the piece). Without pieces, every cut splits every piece it
            crosses (the original behaviour).
    frame:  optional (ex, ey) box axes; by default they follow the first cut."""
    p = dict(DEFAULTS)
    p.update({k: v for k, v in params.items() if v is not None})
    p["test_slices"] = test_slices
    report = {"skipped_channels": 0}

    planes = _cut_planes() if cuts is None else \
        [(Vector(c[0]), Vector(c[1]).normalized(), None) for c in cuts]
    if not planes and auto_cut:
        res = suggest_cut(latex_obj, p["max_tilt_deg"], verbose=False)
        report["overhang_pct"] = res["overhang_pct"]
        planes = _cut_planes()
    if not planes and not (pieces and frame):
        raise RuntimeError("No cut planes. Run Suggest Cut or add a plane named CUT_something.")

    for o in [o for o in bpy.data.objects if o.name.startswith((PIECE_PREFIX, "ms_tmp", "POUR_PREVIEW"))]:
        _remove(o)

    ctx = _shell_setup(latex_obj, p, planes, cuts, frame, report)
    mm, wall, R, zs, r, co, work = ctx["mm"], ctx["wall"], ctx["R"], ctx["zs"], ctx["r"], ctx["co"], ctx["work"]
    report["units_per_mm"] = mm
    world_planes = [(Vector(pt), Vector(nn)) for pt, nn, _ in planes]
    shell = _carve(ctx)
    if ctx.get("outer") is not None:
        _remove(ctx["outer"])
    if ctx["holes"]:
        _remove(ctx["holes"])
    if ctx.get("locks"):
        _remove(ctx["locks"])
    if work is not latex_obj:
        work.name = "POUR_PREVIEW"  # kept so you can see the collar; ignored by later builds
        work.display_type = "WIRE"

    # --- split
    size = float(np.ptp(co, axis=0).max()) * 4 + 10 * wall
    specs = pieces
    pieces = [(shell, Vector((0, 0, 0)))]
    if specs is not None:
        # each piece is the shell inside its own convex region
        sco, _ = _world_tris(shell)
        pad = 10 * wall + 1.0
        lo_w, hi_w = sco.min(0) - pad, sco.max(0) + pad
        pieces = []
        for k, spec in enumerate(specs):
            if callable(on_piece):
                on_piece(k + 1, len(specs))
            got = _cut_piece(shell, spec, lo_w, hi_w, (wall ** 3) * 0.01)
            if got is None:
                continue
            a, hs = got
            pull = Vector(spec.get("pull") or (0, 0, 0))
            if pull.length < 1e-6:
                pull = sum((n for _, n in hs), Vector((0, 0, 0)))
            a["piece_id"] = str(spec.get("id", k))
            a["order"] = int(spec.get("order", 0))
            _keep_slice_plan(a, spec)
            pieces.append((a, pull))
        _remove(shell)
        world_planes = []
        if callable(on_piece):
            on_piece(None, len(specs))
    for pt, nn in world_planes:
        nxt = []
        for obj, pull in pieces:
            hs = _halfspace(pt, nn, size)
            a = obj.copy()
            a.data = obj.data.copy()
            _collection().objects.link(a)
            _apply_booleans(a, [hs], "INTERSECT")
            _apply_booleans(obj, [hs], "DIFFERENCE")
            _remove(hs)
            for o, s in ((a, 1), (obj, -1)):
                if len(o.data.vertices) and _volume(o) > (wall ** 3) * 0.01:
                    nxt.append((o, pull + nn * s))
                else:
                    _remove(o)
        pieces = nxt
    # every piece one solid part: stray bits onto a neighbour, or their own piece
    if len(pieces) > 1:
        pieces = _settle_bits(pieces, wall, report)

    if ctx.get("bumps") and len(pieces) > 1:
        report["bumps"] = _add_bumps([o for o, _ in pieces], ctx["bumps"], p["bump_r_mm"] * mm, 0.3 * mm, mm)
    out = []
    for i, (obj, pull) in enumerate(pieces, 1):
        # triangulate here: the boolean leaves big many-sided faces that some
        # exporters split badly, which slicers then flag as non-manifold
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method="BEAUTY", ngon_method="BEAUTY")
        report["loose_bits_removed"] = report.get("loose_bits_removed", 0) + _drop_loose_bits(bm)
        bm.to_mesh(obj.data)
        bm.free()
        obj.name = obj.data.name = f"{PIECE_PREFIX}{i}"
        if p["explode_mm"] and pull.length > 1e-6:
            obj.matrix_world = Matrix.Translation(pull.normalized() * p["explode_mm"] * mm) @ obj.matrix_world
        obj["pull_direction"] = tuple(pull.normalized()) if pull.length else (0, 0, 0)
        obj["channel_z"] = [float((R @ Vector((0, 0, z))).z) for z in zs]
        obj["channel_r"] = r
        obj["units_per_mm"] = mm
        obj["box_angle"] = math.atan2(R[1][0], R[0][0])  # box rotation about Z
        obj["frame_ex"] = tuple(R.col[0])
        obj["top_point"] = tuple(co[int(np.argmax(co[:, 2]))])
        obj["explode_offset"] = tuple(pull.normalized() * p["explode_mm"] * mm) if (p["explode_mm"] and pull.length > 1e-6) else (0, 0, 0)
        out.append(obj)
    report["pieces"] = [o.name for o in out]
    bpy.context.scene["mold_shell_units_per_mm"] = mm
    if p.get("test_slices", True):
        report["test_slices"] = [o.name for o in make_test_slices(out, p["test_slice_mm"], p["test_slice_at"], p["test_slice_style"])]
    print("[mold shell]", report)
    return out, report


def build_test_slices(latex_obj, cuts=None, pieces=None, frame=None, **params):
    """Only the fit-test slices, without the shell. The box is trimmed to each
    slice before the latex is carved out of it, so this takes a fraction of a
    full build, and the slices come out the same as build_shell's.

    cuts, pieces, frame: as for build_shell. Every piece needs its "slice"
    plan ({"point", "normal", "alt"}). Pieces whose slices lie in the same
    plane share one carve. Returns the slice objects (SHELL_n_TEST, n being
    the piece's number) and a report."""
    p = dict(DEFAULTS)
    p.update({k: v for k, v in params.items() if v is not None})
    report = {"skipped_channels": 0}
    if not pieces:
        raise RuntimeError("Add at least one cut first.")
    cuts = cuts or []
    planes = [(Vector(c[0]), Vector(c[1]).normalized(), None) for c in cuts]
    for o in [o for o in bpy.data.objects if o.name.startswith((PIECE_PREFIX, "ms_tmp", "POUR_PREVIEW"))]:
        _remove(o)
    ctx = _shell_setup(latex_obj, p, planes, cuts, frame, report)
    mm, wall, R, work = ctx["mm"], ctx["wall"], ctx["R"], ctx["work"]
    report["units_per_mm"] = mm
    t = p["test_slice_mm"] * mm
    lo_w, hi_w = _world_box(ctx, 10 * wall + 1.0)
    min_vol = wall * wall * t * 0.01

    def plane_of(k, use_alt):
        plan = pieces[k].get("slice") or {}
        n = Vector(plan.get("normal") or (0, 0, 1)).normalized()
        pt = Vector(plan.get("alt") if use_alt else plan.get("point") or (0, 0, 0))
        return pt, n

    got = {}
    carves = {"done": 0}
    # the app plans one slice for the whole mold, on one piece; the rest have none
    todo = [(k, False) for k in range(len(pieces)) if (pieces[k].get("slice") or {}).get("point")] or \
        [(k, False) for k in range(len(pieces))]
    step, steps = 0, len(todo)
    while todo:
        # the pieces whose slices lie in one plane are carved together
        groups = {}
        for k, use_alt in todo:
            pt, n = plane_of(k, use_alt)
            key = (round(pt.dot(n) / mm, 3),) + tuple(round(x, 5) for x in n)
            groups.setdefault(key, (pt, n, use_alt, []))[3].append(k)
        nxt = []
        round_total = carves["done"] + len(groups)
        for pt, n, use_alt, ks in groups.values():
            carves["done"] += 1
            if callable(on_plane):
                on_plane(carves["done"], round_total)
            shell = _carve(ctx, (pt, n, t))
            for k in ks:
                step += 1
                if callable(on_piece):
                    on_piece(min(step, steps), steps)
                res = _cut_piece(shell, pieces[k], lo_w, hi_w, min_vol) if len(shell.data.polygons) else None
                if res is not None:
                    got[k] = (res, n, "middle of the piece" if use_alt else (pieces[k].get("slice") or {}).get("why", ""))
                elif not use_alt and (pieces[k].get("slice") or {}).get("alt"):
                    nxt.append((k, True))  # this slice misses the piece: try its middle
                    steps += 1
            _remove(shell)
        todo = nxt
    if ctx.get("outer") is not None:
        _remove(ctx["outer"])
    if ctx["holes"]:
        _remove(ctx["holes"])
    if ctx.get("locks"):
        _remove(ctx["locks"])
    if work is not latex_obj:
        work.name = "POUR_PREVIEW"
        work.display_type = "WIRE"
    if callable(on_piece):
        on_piece(None, len(pieces))

    out = []
    for k in sorted(got):
        (sl, hs), n, why = got[k]
        spec = pieces[k]
        bm = bmesh.new()
        bm.from_mesh(sl.data)
        bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method="BEAUTY", ngon_method="BEAUTY")
        _drop_loose_bits(bm)
        bm.to_mesh(sl.data)
        bm.free()
        if not len(sl.data.polygons):
            _remove(sl)
            continue
        pull = Vector(spec.get("pull") or (0, 0, 0))
        if pull.length < 1e-6:
            pull = sum((h for _, h in hs), Vector((0, 0, 0)))
        sl.name = sl.data.name = f"{PIECE_PREFIX}{k + 1}{TEST_SUFFIX}"
        sl["piece_id"] = str(spec.get("id", k))
        sl["order"] = int(spec.get("order", 0))
        sl["pull_direction"] = tuple(pull.normalized()) if pull.length else (0, 0, 0)
        sl["units_per_mm"] = mm
        sl["frame_ex"] = tuple(R.col[0])
        sl["flat_normal"] = tuple(n)
        sl["slice_through"] = why
        out.append(sl)
    report["test_slices"] = [o.name for o in out]
    bpy.context.scene["mold_shell_units_per_mm"] = mm
    print("[mold shell] slices only", report)
    return out, report


# --------------------------------------------------- fit-test slices

TEST_SUFFIX = "_TEST"


def _pieces(tests=False):
    objs = [o for o in bpy.context.scene.objects
            if o.type == "MESH" and o.name.startswith(PIECE_PREFIX)
            and o.name.endswith(TEST_SUFFIX) == tests]
    return sorted(objs, key=lambda o: o.name)


def make_test_slices(pieces=None, thickness_mm=None, at=None, style=None):
    """For each shell piece, a thin slice (default 2 layers, 0.4 mm) to print
    first and check the fit against the latex.
    A piece that carries a slice plan from the app (slice_point,
    slice_normal, slice_alt) is sliced there. Otherwise:
    style "VERTICAL" (default): an upright slice running across the seam,
      through the tallest point of the latex, so each piece gives its full
      top-to-bottom profile. Exported lying flat.
    style "HORIZONTAL": a level slice at `at` of the height, clear of channels."""
    thickness_mm = DEFAULTS["test_slice_mm"] if thickness_mm is None else thickness_mm
    at = DEFAULTS["test_slice_at"] if at is None else at
    style = style or DEFAULTS["test_slice_style"]
    pieces = pieces or _pieces()
    # the app plans one slice for the whole mold: then only that piece gets one
    if any("slice_point" in p for p in pieces):
        for p in pieces:
            _remove(p.name + TEST_SUFFIX)
        pieces = [p for p in pieces if "slice_point" in p]
    out = []
    for piece in pieces:
        _remove(piece.name + TEST_SUFFIX)
        mm = piece.get("units_per_mm", bpy.context.scene.get("mold_shell_units_per_mm", 1.0))
        t = thickness_mm * mm
        pv = np.array([(piece.matrix_world @ v.co)[:] for v in piece.data.vertices])
        shift = Vector(piece.get("explode_offset", (0, 0, 0)))  # the piece may have been spread apart along its pull
        planned = "slice_point" in piece and "slice_normal" in piece
        tries = []  # (centre of the slice, normal, what it goes through)
        if planned:
            n = Vector(piece["slice_normal"]).normalized()
            tries.append((Vector(piece["slice_point"]) + shift, n, ("slice_through", piece.get("slice_why") or "as planned")))
            if "slice_alt" in piece:
                tries.append((Vector(piece["slice_alt"]) + shift, n, ("slice_through", "middle of the piece")))
            if len(pv):  # a piece made from a stray bit keeps its parent's plan, which can miss it
                tries.append((Vector(pv.mean(0).tolist()), n, ("slice_through", "middle of the piece")))
        elif style == "VERTICAL" and "top_point" in piece and "frame_ex" in piece:
            n = Vector(piece["frame_ex"]).normalized()
            top = Vector(piece["top_point"]) + shift
            mid = Vector(pv.mean(0).tolist()) if len(pv) else top
            dist = (pv - np.array(top[:])) @ np.array(n[:]) if len(pv) else np.zeros(1)
            if dist.max() < -t / 2 or dist.min() > t / 2:  # the slice misses this piece: go straight to its middle
                tries.append((mid, n, ("slice_through", "middle of the piece")))
            else:
                tries.append((top, n, ("slice_through", "top of the latex")))
                tries.append((mid, n, ("slice_through", "middle of the piece")))
        else:
            zs_w = pv[:, 2] if len(pv) else np.zeros(1)
            lo, hi = float(zs_w.min()), float(zs_w.max())
            z = lo + (hi - lo) * at - t / 2
            r = piece.get("channel_r", 0.0)
            for _ in range(20):  # step clear of any channel
                if all(abs(z + t / 2 - cz) > r + 2 * mm for cz in piece.get("channel_z", [])):
                    break
                z += 2 * r + 2 * mm
            n = Vector((0, 0, 1))
            tries.append((Vector((0, 0, z + t / 2)), n, ("slice_height_mm", round((z - lo) / mm, 2))))
        sl, info = None, None
        for centre, n, info in tries:
            # big enough to reach every part of the piece from the slice's centre
            size = 2 * float(np.linalg.norm(pv - np.array(centre[:]), axis=1).max()) + 1 if len(pv) else 1.0
            slab = _slab(centre, n, t, size)
            sl = piece.copy()
            sl.data = piece.data.copy()
            _collection().objects.link(sl)
            sl.name = sl.data.name = piece.name + TEST_SUFFIX
            _apply_booleans(sl, [slab], "INTERSECT")
            _remove(slab)
            if len(sl.data.polygons):
                break
            _remove(sl)
            sl = None
        if sl is None:
            continue
        bm = bmesh.new()
        bm.from_mesh(sl.data)
        bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method="BEAUTY", ngon_method="BEAUTY")
        _drop_loose_bits(bm)
        bm.to_mesh(sl.data)
        bm.free()
        sl["flat_normal"] = tuple(n)
        sl[info[0]] = info[1]
        out.append(sl)
    return out


# ------------------------------------------------------------- export

def _mm_mesh(obj, mm, angle=0.0):
    """Mesh in mm, turned about Z so the shell box lines up with the plate."""
    co, tris = _world_tris(obj)
    co = co / mm
    if angle:
        c, s_ = math.cos(-angle), math.sin(-angle)
        co = co @ np.array([[c, s_, 0], [-s_, c, 0], [0, 0, 1]])
    return co, tris


def _write_stl(path, co, tris):
    a, b, c = co[tris[:, 0]], co[tris[:, 1]], co[tris[:, 2]]
    n = np.cross(b - a, c - a)
    ln = np.linalg.norm(n, axis=1)
    ln[ln == 0] = 1
    n = n / ln[:, None]
    with open(path, "wb") as f:
        f.write(b"Mold Shell Builder".ljust(80, b" "))
        f.write(struct.pack("<I", len(tris)))
        rec = np.zeros(len(tris), dtype=[("n", "<f4", 3), ("a", "<f4", 3), ("b", "<f4", 3), ("c", "<f4", 3), ("x", "<u2")])
        rec["n"], rec["a"], rec["b"], rec["c"] = n, a, b, c
        f.write(rec.tobytes())


def arrange_on_plate(named_meshes, bed_mm, gap=8.0):
    """Each mesh set down on the plate (its lowest point at z = 0) and moved so
    none of them touch: rows from front to back, in the order given, the whole
    layout centred on the plate. Anything past the plate's back edge is still
    kept apart, and the number of plates it would take is returned too."""
    out, rows, row, x, depth = [], [], [], 0.0, 0.0
    for name, v, t in named_meshes:
        lo, hi = v.min(0), v.max(0)
        w, d = hi[0] - lo[0], hi[1] - lo[1]
        if row and x + w > bed_mm:
            rows.append((row, depth))
            row, x, depth = [], 0.0, 0.0
        row.append((name, v - np.array([lo[0] - x, lo[1], lo[2]]), t, d))
        x += w + gap
        depth = max(depth, d)
    if row:
        rows.append((row, depth))
    y = 0.0
    for row, depth in rows:
        for name, v, t, d in row:
            out.append((name, v + np.array([0.0, y + (depth - d) / 2, 0.0]), t))
        y += depth + gap
    allv = np.vstack([m[1] for m in out])
    lo, hi = allv.min(0), allv.max(0)
    fits = hi[1] - lo[1] <= bed_mm and hi[0] - lo[0] <= bed_mm
    off = np.array([bed_mm / 2 - (lo[0] + hi[0]) / 2,
                    bed_mm / 2 - (lo[1] + hi[1]) / 2 if hi[1] - lo[1] <= bed_mm else -lo[1], 0.0])
    return [(n, v + off, t) for n, v, t in out], fits


def _turn_z(deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def plan_plates(items, bed_w, bed_d, bed_h=None, gap=6.0, margin=0.0):
    """Every piece set down on printer plates, as many plates as it takes.
    items: (name, verts_mm) as they print (upright, box lined up with the
    plate). Each piece may be turned about the vertical to fit (square on
    first, then whatever angle makes it fit). Pieces go biggest first into
    rows on the first plate with room, the rows of each plate centred.
    Returns a list of plates; each plate a list of
    {"name", "turn" (degrees about Z), "off" (mm, after turning), "dims", "too_big"}."""
    W, D = bed_w - 2 * margin, bed_d - 2 * margin
    sized = []
    for name, v in items:
        v = np.asarray(v, float)
        best = None
        for deg in [0, 90] + list(range(5, 90, 5)):
            p = v @ _turn_z(deg).T
            w, d = float(np.ptp(p[:, 0])), float(np.ptp(p[:, 1]))
            if w < d and w <= D and d <= W:  # wide side along the plate's width packs rows better
                deg, p, w, d = deg + 90, v @ _turn_z(deg + 90).T, d, w
            fits = w <= W and d <= D
            score = (not fits, deg not in (0, 90, 180, 270) and fits, w * d)
            if best is None or score < best[0]:
                best = (score, deg % 360, w, d, fits)
        _, deg, w, d, fits = best
        tall = bed_h is not None and float(np.ptp(v[:, 2])) > bed_h
        sized.append({"name": name, "turn": deg, "w": w, "d": d, "fits": fits and not tall, "tall": tall, "v": v})
    sized.sort(key=lambda s: (-s["d"], -s["w"]))
    plates = []  # each: {"rows": [[y, h, x]], "y": next free y, "items": []}
    for it in sized:
        w, d = it["w"], it["d"]
        spot = None
        if it["fits"]:
            for pl in [q for q in plates if not q.get("closed")]:
                for row in pl["rows"]:
                    if row[2] + w <= W + 1e-6 and d <= row[1] + 1e-6:
                        spot = (pl, row[2], row[0]); row[2] += w + gap
                        break
                if spot:
                    break
                if pl["y"] + d <= D + 1e-6:
                    pl["rows"].append([pl["y"], d, w + gap])
                    spot = (pl, 0.0, pl["y"]); pl["y"] += d + gap
                    break
        if not spot:
            pl = {"rows": [[0.0, d, w + gap]], "y": d + gap, "items": [], "closed": not it["fits"]}  # too big: a plate of its own
            plates.append(pl)
            spot = (pl, 0.0, 0.0)
        pl, x, y = spot
        pl["items"].append((it, x, y))
    out = []
    for pl in plates:
        # centre what's on the plate
        xs = [x + it["w"] for it, x, y in pl["items"]]
        ys = [y + it["d"] for it, x, y in pl["items"]]
        cx = (bed_w - max(xs)) / 2 if max(xs) <= bed_w else margin
        cy = (bed_d - max(ys)) / 2 if max(ys) <= bed_d else margin
        rec = []
        for it, x, y in pl["items"]:
            p = it["v"] @ _turn_z(it["turn"]).T
            lo = p.min(0)
            off = np.array([cx + x - lo[0], cy + y - lo[1], -lo[2]])
            rec.append({"name": it["name"], "turn": it["turn"], "off": [float(a) for a in off],
                        "dims": [round(it["w"], 1), round(it["d"], 1), round(float(np.ptp(p[:, 2])), 1)],
                        "too_big": bool(not it["fits"] or it["tall"])})
        out.append(rec)
    return out


def write_3mf(path, named_meshes, bed_mm=None, arrange=False, keep=False):
    """named_meshes: list of (name, verts_mm, tris). Each becomes its own
    object. arrange=False keeps them in place relative to each other (an
    assembly to look at), centred on the plate; arrange=True sets each one down
    on the plate apart from the others, ready to slice; keep=True writes them
    exactly where they are (already laid out on a plate)."""
    import zipfile
    bed = DEFAULTS["bed_mm"] if bed_mm is None else bed_mm
    if keep:
        off = np.zeros(3)
    elif arrange:
        named_meshes, _ = arrange_on_plate(named_meshes, bed)
        off = np.zeros(3)
    else:
        allv = np.vstack([m[1] for m in named_meshes])
        lo, hi = allv.min(0), allv.max(0)
        off = np.array([bed / 2 - (lo[0] + hi[0]) / 2, bed / 2 - (lo[1] + hi[1]) / 2, -lo[2]])
    objs = []
    for i, (name, v, t) in enumerate(named_meshes, 1):
        v = v + off
        vs = "".join(f'<vertex x="{a:.5f}" y="{b:.5f}" z="{c:.5f}"/>' for a, b, c in v)
        ts = "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in t)
        objs.append(f'<object id="{i}" name="{name}" type="model"><mesh><vertices>{vs}</vertices>'
                    f'<triangles>{ts}</triangles></mesh></object>')
    items = "".join(f'<item objectid="{i}"/>' for i in range(1, len(named_meshes) + 1))
    model = ('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" '
             'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>'
             + "".join(objs) + f'</resources><build>{items}</build></model>')
    ct = ('<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Target="/3D/3dmodel.model" Id="rel0" '
            'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr("_rels/.rels", rels)
        z.writestr("3D/3dmodel.model", model)
    return path


def write_bambu_project(path, plates, W, D):
    """One 3MF with every plate in it, as Bambu Studio keeps a project: plates
    is a list of plates, each a list of (name, verts_mm, tris) already set out
    on a W x D plate. Bambu lays its plates out in a grid (columns: the
    smallest square that holds them all), a fifth of a plate apart, the next
    row toward -y; each object sits at its plate's spot in that grid, and
    Metadata/model_settings.config says which plate each one is on. Other
    slicers read it as one plate with everything on it, side by side."""
    import zipfile
    from xml.sax.saxutils import quoteattr
    n = len(plates)
    cols = max(1, int(math.ceil(math.sqrt(n))))
    objs, items, conf, plate_conf = [], [], [], []
    oid = 0
    for k, pl in enumerate(plates):
        ox, oy = (k % cols) * W * 1.2, -(k // cols) * D * 1.2
        inst = []
        for name, v, t in pl:
            oid += 1
            v = np.asarray(v, dtype=float)
            c = np.array([(v[:, 0].min() + v[:, 0].max()) / 2, (v[:, 1].min() + v[:, 1].max()) / 2, 0.0])
            lv = v - c
            vs = "".join(f'<vertex x="{a:.5f}" y="{b:.5f}" z="{z:.5f}"/>' for a, b, z in lv)
            ts = "".join(f'<triangle v1="{a}" v2="{b}" v3="{z}"/>' for a, b, z in t)
            objs.append(f'<object id="{oid}" name={quoteattr(name)} type="model"><mesh><vertices>{vs}</vertices>'
                        f'<triangles>{ts}</triangles></mesh></object>')
            tx, ty = c[0] + ox, c[1] + oy
            items.append(f'<item objectid="{oid}" transform="1 0 0 0 1 0 0 0 1 {tx:.5f} {ty:.5f} 0" printable="1"/>')
            conf.append(f'  <object id="{oid}">\n    <metadata key="name" value={quoteattr(name)}/>\n    <metadata key="extruder" value="1"/>\n'
                        f'    <part id="1" subtype="normal_part">\n      <metadata key="name" value={quoteattr(name)}/>\n    </part>\n  </object>')
            inst.append(f'    <model_instance>\n      <metadata key="object_id" value="{oid}"/>\n      <metadata key="instance_id" value="0"/>\n'
                        f'      <metadata key="identify_id" value="{100 + oid}"/>\n    </model_instance>')
        plate_conf.append(f'  <plate>\n    <metadata key="plater_id" value="{k + 1}"/>\n    <metadata key="plater_name" value=""/>\n'
                          f'    <metadata key="locked" value="false"/>\n' + "\n".join(inst) + '\n  </plate>')
    model = ('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" '
             'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" '
             'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">'
             '<metadata name="Application">BambuStudio-01.10.00.00</metadata>'
             '<metadata name="BambuStudio:3mfVersion">1</metadata>'
             '<metadata name="Title">GnomeShell shell</metadata><resources>'
             + "".join(objs) + '</resources><build>' + "".join(items) + '</build></model>')
    config = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' + "\n".join(conf + plate_conf) + '\n</config>\n'
    ct = ('<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
          '<Default Extension="config" ContentType="text/xml"/></Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Target="/3D/3dmodel.model" Id="rel0" '
            'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr("_rels/.rels", rels)
        z.writestr("3D/3dmodel.model", model)
        z.writestr("Metadata/model_settings.config", config)
    return path


def test_flat_basis(obj):
    """3x3 B: a test slice's points @ B lie it flat (its slice normal up)."""
    e3 = np.array(obj.get("flat_normal", (0, 0, 1)), dtype=float)
    e3 /= np.linalg.norm(e3)
    ex = np.array(obj.get("frame_ex", (1, 0, 0)), dtype=float)
    up = np.array([0.0, 0.0, 1.0])
    e2 = up - e3 * up.dot(e3)
    if np.linalg.norm(e2) < 1e-6:  # level slice: keep the box's own axes
        e2 = np.cross(e3, ex)
    e2 /= np.linalg.norm(e2)
    e1 = np.cross(e2, e3)
    return np.stack([e1, e2, e3], axis=1)


def export_pieces(folder, units="AUTO", latex_obj=None, include_latex_in_3mf=False, bed_mm=None):
    """Write, in millimetres:
      SHELL_n.stl        each shell piece
      SHELL_n_TEST.stl   each fit-test slice, laid flat
      shell.3mf          all pieces set out on the plate, one object each
      test_slices.3mf    all fit-test slices laid flat and set out on the plate"""
    os.makedirs(folder, exist_ok=True)
    mm = bpy.context.scene.get("mold_shell_units_per_mm") or (_mm_to_bu(latex_obj, units) if latex_obj else 1.0)
    paths, assembly, tests = [], [], []
    angle = _pieces()[0].get("box_angle", 0.0) if _pieces() else 0.0
    for obj in _pieces() + _pieces(tests=True):
        is_test = obj.name.endswith(TEST_SUFFIX)
        if is_test:
            # lay the slice flat: its slice normal becomes up
            co, tris = _mm_mesh(obj, mm)
            B = test_flat_basis(obj)
            co = co @ B
            if np.linalg.det(B) < 0:
                tris = tris[:, ::-1]
            flat = co - np.array([0, 0, co[:, 2].min()])
            path = os.path.join(folder, obj.name + ".stl")
            _write_stl(path, flat, tris)
            paths.append(path)
            tests.append((obj.name, flat, tris))
            continue
        co, tris = _mm_mesh(obj, mm, angle)
        path = os.path.join(folder, obj.name + ".stl")
        _write_stl(path, co - np.array([0, 0, co[:, 2].min()]), tris)
        paths.append(path)
        assembly.append((obj.name, co, tris))
    if include_latex_in_3mf and latex_obj is not None:
        co, tris = _mm_mesh(latex_obj, mm, angle)
        assembly.insert(0, (latex_obj.name, co, tris))
    if assembly:
        paths.append(write_3mf(os.path.join(folder, "shell.3mf"), assembly, bed_mm, arrange=True))
    if tests:
        paths.append(write_3mf(os.path.join(folder, "test_slices.3mf"), tests, bed_mm, arrange=True))
    print("[mold shell] exported", paths)
    return paths


# ------------------------------------------------------------------- UI

class MoldShellProps(bpy.types.PropertyGroup):
    wall_mm: bpy.props.FloatProperty(name="Wall (mm)", default=DEFAULTS["wall_mm"], min=1.0)
    hole_d_mm: bpy.props.FloatProperty(name="Channel Ø (mm)", default=DEFAULTS["hole_d_mm"], min=1.0)
    holes_per_corner: bpy.props.IntProperty(name="Channels per corner", default=DEFAULTS["holes_per_corner"], min=0, max=12)
    hole_edge_mm: bpy.props.FloatProperty(name="From edge (mm)", default=DEFAULTS["hole_edge_mm"], min=0.5)
    channel_pairs: bpy.props.BoolProperty(name="Channels in pairs", default=DEFAULTS["channel_pairs"])
    pair_gap_mm: bpy.props.FloatProperty(name="Pair spacing (mm)", default=DEFAULTS["pair_gap_mm"], min=1.0)
    explode_mm: bpy.props.FloatProperty(name="Spread pieces (mm)", default=DEFAULTS["explode_mm"], min=0.0)
    max_tilt_deg: bpy.props.FloatProperty(name="Max cut tilt (°)", default=DEFAULTS["max_tilt_deg"], min=0.0, max=60.0)
    units: bpy.props.EnumProperty(name="Scan units", default="AUTO", items=[
        ("AUTO", "Auto", "Guess from size and scene units"),
        ("MM", "1 unit = 1 mm", "Scan was imported in millimetres"),
        ("SCENE", "Scene units", "Use the scene's unit scale"),
    ])
    test_slice_mm: bpy.props.FloatProperty(name="Test slice (mm)", default=DEFAULTS["test_slice_mm"], min=0.1)
    test_slice_style: bpy.props.EnumProperty(name="Test slice", default="VERTICAL", items=[
        ("VERTICAL", "Upright, through top", "Upright slice across the seam through the tallest point of the latex"),
        ("HORIZONTAL", "Level", "Level slice at the height below"),
    ])
    test_slice_at: bpy.props.FloatProperty(name="Test slice height", default=DEFAULTS["test_slice_at"], min=0.05, max=0.95, subtype="FACTOR")
    export_dir: bpy.props.StringProperty(name="Export folder", subtype="DIR_PATH", default="//shell_stl")


def _latex_from_context(ctx):
    obj = ctx.active_object
    if obj is None or obj.type != "MESH" or obj.name.startswith((CUT_PREFIX, PIECE_PREFIX)):
        return None
    return obj


class MOLDSHELL_OT_suggest(bpy.types.Operator):
    bl_idname = "moldshell.suggest_cut"
    bl_label = "Suggest Cut"
    bl_description = "Find the flat cut with the least overhang and add it as CUT_auto"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, ctx):
        latex = _latex_from_context(ctx)
        if latex is None:
            self.report({"ERROR"}, "Select the latex scan first")
            return {"CANCELLED"}
        ctx.scene["mold_shell_latex"] = latex.name
        res = suggest_cut(latex, ctx.scene.mold_shell.max_tilt_deg)
        self.report({"INFO"}, f"CUT_auto placed, overhang {res['overhang_pct']:.2f}% of surface")
        return {"FINISHED"}


class MOLDSHELL_OT_build(bpy.types.Operator):
    bl_idname = "moldshell.build"
    bl_label = "Build Shell"
    bl_description = "Build the box, bungee channels and split pieces using the visible CUT planes"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, ctx):
        latex = _latex_from_context(ctx) or bpy.data.objects.get(ctx.scene.get("mold_shell_latex", ""))
        if latex is None:
            self.report({"ERROR"}, "Select the latex scan first")
            return {"CANCELLED"}
        ctx.scene["mold_shell_latex"] = latex.name
        pr = ctx.scene.mold_shell
        try:
            pieces, rep = build_shell(latex, wall_mm=pr.wall_mm, hole_d_mm=pr.hole_d_mm,
                                      holes_per_corner=pr.holes_per_corner, hole_edge_mm=pr.hole_edge_mm,
                                      channel_pairs=pr.channel_pairs, pair_gap_mm=pr.pair_gap_mm,
                                      explode_mm=pr.explode_mm, max_tilt_deg=pr.max_tilt_deg, units=pr.units,
                                      test_slice_mm=pr.test_slice_mm, test_slice_at=pr.test_slice_at,
                                      test_slice_style=pr.test_slice_style)
        except RuntimeError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}
        ctx.scene["mold_shell_units_per_mm"] = rep["units_per_mm"]
        self.report({"INFO"}, f"{len(pieces)} pieces, {rep['channels']} channels")
        return {"FINISHED"}


class MOLDSHELL_OT_export(bpy.types.Operator):
    bl_idname = "moldshell.export"
    bl_label = "Export Files"
    bl_description = "Write STLs for each piece and test slice, plus shell.3mf and test_slices.3mf, in millimetres"

    def execute(self, ctx):
        folder = bpy.path.abspath(ctx.scene.mold_shell.export_dir)
        latex = bpy.data.objects.get(ctx.scene.get("mold_shell_latex", ""))
        paths = export_pieces(folder, ctx.scene.mold_shell.units, latex)
        self.report({"INFO"}, f"Exported {len(paths)} files to {folder}")
        return {"FINISHED"}


class MOLDSHELL_PT_panel(bpy.types.Panel):
    bl_label = "Mold Shell"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Mold Shell"

    def draw(self, ctx):
        pr = ctx.scene.mold_shell
        col = self.layout.column(align=True)
        col.label(text="1. Select the latex scan")
        col.operator("moldshell.suggest_cut", icon="MOD_BOOLEAN")
        col.label(text="2. Adjust or add CUT planes (optional)")
        col.operator("moldshell.build", icon="MESH_CUBE")
        col.separator()
        for name in ("wall_mm", "hole_d_mm", "holes_per_corner", "hole_edge_mm", "channel_pairs", "pair_gap_mm", "explode_mm", "max_tilt_deg", "units", "test_slice_style", "test_slice_mm", "test_slice_at"):
            col.prop(pr, name)
        col.separator()
        col.prop(pr, "export_dir")
        col.operator("moldshell.export", icon="EXPORT")


CLASSES = (MoldShellProps, MOLDSHELL_OT_suggest, MOLDSHELL_OT_build, MOLDSHELL_OT_export, MOLDSHELL_PT_panel)


def register():
    for c in CLASSES:
        bpy.utils.register_class(c)
    bpy.types.Scene.mold_shell = bpy.props.PointerProperty(type=MoldShellProps)


def unregister():
    del bpy.types.Scene.mold_shell
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)


if __name__ == "__main__":
    register()
