"""
Silicone insert, for scans big enough to need a cavity in the casting.

A hollow silicone insert hangs in the latex mold, held by a printed holder
that twist-locks into the shell. This module makes, in millimetres:

  the holder     hub plate, core (the inside of the silicone), arms out to the
                 shell's four corners, a frame between them, a peg with a foot
                 at each corner, and air holes through the core and hub
  the cup        the outside of the silicone; you pour the silicone in, then
                 push the holder's core down into it until the hub sits on the
                 rim, inside a collar that centres it
  lock cutters   the twist-lock slots the shell gets at its four corners

Everything is laid out in the shell box's own frame (x, y along the box, z up
from the box's open face at z0, into the latex). The holder sits on that face,
outside the box, with its core reaching up into the latex.
"""

import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

DEFAULTS = dict(
    shape="round",      # round, oval, square, rect
    w=90.0,             # width, or diameter for round
    d=70.0,             # depth (oval, rect)
    h=120.0,            # how far the insert reaches into the latex from the open face
    wall=3.0,           # silicone on the sides and the bottom
    round=6.0,          # corner rounding (square, rect)
    least=20.0,         # least concrete between insert and latex
    cx=None, cy=None,   # centre in the box frame; None = middle of the latex opening
    # printed parts
    arm_w=14.0, arm_t=6.0, frame_w=10.0, hub_lip=5.0,
    air_d=4.0, air_n=3, taper_deg=1.0,
    cup_wall=3.0, cup_floor=3.0, collar_h=4.0, collar_w=3.0, cup_fit=0.5,
    # twist-lock pegs (a cam lock): a 12 mm neck with a flare at the root, a 20 mm
    # head with a 45° underside that sits in a matching seat under a 4 mm lip of
    # shell. The seat ramps `ramp` mm along the turn so turning pulls the holder
    # down tight (by `squeeze` at the end), and a `click` mm bump just before the
    # end holds it locked.
    post_r=6.0, foot_r=10.0, lip=4.0, peg_inset=12.0, slot_margin=3.0, play=0.3, fit=0.4,
    flare=1.5, ramp=1.0, click=0.6, squeeze=0.1,
    # a grooved tab off each corner pad, for a bungee cord across the corner
    tab_len=10.0, tab_w=12.0, groove_w=6.0, groove_d=3.0,
    # where each corner's slot is centred, in the box frame, when the screen moved
    # one away from the latex; None = the usual spots near the corners
    spots=None,
)


def spec_from(d):
    s = dict(DEFAULTS)
    s.update({k: v for k, v in (d or {}).items() if k in DEFAULTS and v is not None})
    if s["shape"] == "round":
        s["d"] = s["w"]
    if s["shape"] == "square":
        s["d"] = s["w"]
    for k in ("w", "d", "h", "wall", "round", "least"):
        s[k] = float(s[k])
    try:
        s["spots"] = [(float(x), float(y)) for x, y in s["spots"]] if s["spots"] else None
        if s["spots"] and (len(s["spots"]) != 4 or not all(math.isfinite(v) for p in s["spots"] for v in p)):
            s["spots"] = None
    except (TypeError, ValueError):
        s["spots"] = None
    return s


def check(s):
    """Refuse an insert that can't be made, saying why."""
    if not s["w"] > 0 or not s["d"] > 0 or not s["h"] > 0:
        raise RuntimeError("The insert needs a width, depth and height.")
    inner = min(s["w"], s["d"]) - 2 * s["wall"]
    if inner < 10:
        raise RuntimeError(f"The silicone wall ({s['wall']:g} mm) leaves less than 10 mm for the core. "
                           "Make the insert wider or the wall thinner.")
    if s["h"] - s["wall"] < 10:
        raise RuntimeError("The insert is too short for its wall. Make it taller or the wall thinner.")


# ------------------------------------------------------------ 2D shapes

def outline(shape, w, d, r=0.0, seg=96):
    """The insert's cross-section, centred on 0, anticlockwise."""
    if shape in ("round", "oval"):
        d = w if shape == "round" else d
        return [(w / 2 * math.cos(2 * math.pi * i / seg), d / 2 * math.sin(2 * math.pi * i / seg)) for i in range(seg)]
    if shape == "square":
        d = w
    r = max(0.0, min(r, min(w, d) / 2 - 0.01))
    if r < 0.05:
        return [(-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)]
    k = max(2, seg // 4)
    pts = []
    for cx, cy, a0 in ((w / 2 - r, -d / 2 + r, -90), (w / 2 - r, d / 2 - r, 0), (-w / 2 + r, d / 2 - r, 90), (-w / 2 + r, -d / 2 + r, 180)):
        for i in range(k + 1):
            a = math.radians(a0 + 90 * i / k)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def grown(s, by):
    """The insert's outline grown (or shrunk, by < 0) by `by` on every side."""
    shape = s["shape"]
    r = s["round"] + by if shape in ("square", "rect") else 0.0
    return outline(shape, s["w"] + 2 * by, s["d"] + 2 * by, max(0.0, r))


def area(pts):
    return 0.5 * abs(sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1])))


# ------------------------------------------------------------ solids

def _prism(bm, pts, z_lo, z_hi, at=(0.0, 0.0), scale_hi=1.0, mirror_y=False):
    """A closed prism over a simple outline. The top ring can be scaled about
    the outline's centre, for a taper."""
    ox, oy = at
    sy = -1.0 if mirror_y else 1.0
    lo = [bm.verts.new((ox + x, oy + sy * y, z_lo)) for x, y in pts]
    hi = [bm.verts.new((ox + x * scale_hi, oy + sy * y * scale_hi, z_hi)) for x, y in pts]
    if mirror_y:
        lo.reverse()
        hi.reverse()
    n = len(pts)
    bm.faces.new(list(reversed(lo)))
    bm.faces.new(hi)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))


def _ring(bm, centre, profile, seg=40):
    """A solid of revolution about z: profile = [(z, radius), ...] from bottom to top."""
    cx, cy = centre
    rings = [[bm.verts.new((cx + r * math.cos(2 * math.pi * i / seg), cy + r * math.sin(2 * math.pi * i / seg), z))
              for i in range(seg)] for z, r in profile]
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    for a, b in zip(rings, rings[1:]):
        for i in range(seg):
            j = (i + 1) % seg
            bm.faces.new((a[i], a[j], b[j], b[i]))


def _bar(bm, p, q, width, z_lo, z_hi):
    """A flat bar from p to q (2D), `width` wide."""
    p, q = np.array(p, float), np.array(q, float)
    t = q - p
    L = np.linalg.norm(t)
    if L < 1e-6:
        return
    t /= L
    nrm = np.array([-t[1], t[0]]) * width / 2
    pts = [tuple(p - nrm), tuple(q - nrm), tuple(q + nrm), tuple(p + nrm)]
    _prism(bm, pts, z_lo, z_hi)


def _arc_band(bm, centre, radius, half_w, a0, a1, z_lo, z_hi, seg=16):
    """The part of an annulus between angles a0 and a1 (radians), as a prism."""
    cx, cy = centre
    angs = [a0 + (a1 - a0) * i / seg for i in range(seg + 1)]
    outer = [(cx + (radius + half_w) * math.cos(a), cy + (radius + half_w) * math.sin(a)) for a in angs]
    inner = [(cx + (radius - half_w) * math.cos(a), cy + (radius - half_w) * math.sin(a)) for a in reversed(angs)]
    pts = outer + inner
    if a1 < a0:
        pts.reverse()
    _prism(bm, pts, z_lo, z_hi)


def _arc_sweep(bm, centre, radius, a0, a1, section, seg=48):
    """Sweep a closed cross-section along an arc about z, from angle a0 to a1.
    section(t) gives [(u, z), ...] for t from 0 to 1, u measured out from the
    arc; every section must have the same number of points."""
    cx, cy = centre
    rings = []
    for i in range(seg + 1):
        t = i / seg
        a = a0 + (a1 - a0) * t
        ca, sa = math.cos(a), math.sin(a)
        rings.append([bm.verts.new((cx + (radius + u) * ca, cy + (radius + u) * sa, z)) for u, z in section(t)])
    n = len(rings[0])
    faces = [bm.faces.new(rings[0]), bm.faces.new(list(reversed(rings[-1])))]
    for r0, r1 in zip(rings, rings[1:]):
        for k in range(n):
            j = (k + 1) % n
            faces.append(bm.faces.new((r0[k], r0[j], r1[j], r1[k])))
    bmesh.ops.recalc_face_normals(bm, faces=faces)


def _obj(name, bm, matrix=None):
    import mold_shell as ms
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
    return ms._new_obj(name, bm, matrix=matrix)


def _open(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    n = sum(1 for e in bm.edges if not e.is_manifold)
    bm.free()
    return n


def _bool(target, others, op):
    """Boolean simple closed parts together. These are clean primitives, not a
    scan, so Blender's Manifold solver does it fastest and cleanest; the
    scan-proof route in mold_shell is the fallback."""
    import mold_shell as ms
    for o in others:
        m = target.modifiers.new("ins_bool", "BOOLEAN")
        m.operation, m.solver, m.object = op, "MANIFOLD", o
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(target.evaluated_get(dg))
    target.modifiers.clear()
    old = target.data
    target.data = me
    if len(me.polygons) and _open(target) == 0:
        bpy.data.meshes.remove(old)
        return target
    target.data = old
    bpy.data.meshes.remove(me)
    print("[mold shell] insert boolean: Manifold solver failed, trying Exact", flush=True)
    return ms._apply_booleans(target, others, op)


def _union(name, parts, matrix=None):
    """One clean solid from several overlapping closed parts (each a bmesh
    holding one closed part)."""
    import mold_shell as ms
    objs = [_obj(f"{name}_part{i}", bm, matrix) for i, bm in enumerate(parts)]
    base = objs[0]
    if len(objs) > 1:
        _bool(base, objs[1:], "UNION")
    for o in objs[1:]:
        ms._remove(o)
    base.name = base.data.name = name
    _tidy(base)
    return base


def _tidy(obj):
    """Merge points a boolean left a hair apart and drop sliver faces, so a
    slicer sees one clean closed solid. Kept only if it stays closed."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-3)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges[:], dist=1e-3)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    if bm.faces and all(e.is_manifold for e in bm.edges):
        bm.to_mesh(obj.data)
    bm.free()


# ------------------------------------------------------------ layout

def _tab_outline(s, L, p, r0, r1, half_w):
    """A rectangle off the pad at p, pointing away from the shell's middle,
    from r0 to r1 out from the peg and half_w either side (counter-clockwise)."""
    bc = L["bc"]
    dx, dy = p[0] - bc[0], p[1] - bc[1]
    n = math.hypot(dx, dy) or 1.0
    nx, ny = dx / n, dy / n
    px, py = -ny, nx
    return [(p[0] + nx * r0 - px * half_w, p[1] + ny * r0 - py * half_w), (p[0] + nx * r1 - px * half_w, p[1] + ny * r1 - py * half_w),
            (p[0] + nx * r1 + px * half_w, p[1] + ny * r1 + py * half_w), (p[0] + nx * r0 + px * half_w, p[1] + ny * r0 + py * half_w)]


def peg_places(box, inset, hole_r, margin):
    """The four pegs, where they lock. Each turns about the box centre from its
    entry hole to here; that arc is centred on a spot `inset` in from the
    corner, moved further in until the whole slot (entry hole and arc) keeps
    `margin` of shell between it and the box's sides."""
    x0, y0, _, x1, y1, _ = box
    bc = ((x0 + x1) / 2, (y0 + y1) / 2)
    e = inset
    while True:
        spots = [(x0 + e, y0 + e), (x1 - e, y0 + e), (x1 - e, y1 - e), (x0 + e, y1 - e)]
        R = math.hypot(spots[0][0] - bc[0], spots[0][1] - bc[1])
        th = (2 * hole_r + 3.0) / R  # turn far enough that the foot is fully under the lip
        room = hole_r + margin
        ok, pegs = True, []
        for px, py in spots:
            a = math.atan2(py - bc[1], px - bc[0])
            for k in range(9):
                t = a - th / 2 + th * k / 8
                x, y = bc[0] + R * math.cos(t), bc[1] + R * math.sin(t)
                ok = ok and x0 + room <= x <= x1 - room and y0 + room <= y <= y1 - room
            pegs.append((bc[0] + R * math.cos(a + th / 2), bc[1] + R * math.sin(a + th / 2)))
        if ok or e >= min(x1 - x0, y1 - y0) / 2 - room:
            return pegs, R, th
        e += 0.5


def pegs_at(box, spots, hole_r, margin):
    """The pegs for slots centred on the given spots. The holder turns about
    the box centre, so every peg turns the same angle, each on its own circle:
    far enough that the tightest one (nearest the middle) gets fully under its
    lip. None if a slot would come too close to the box's sides."""
    x0, y0, _, x1, y1, _ = box
    bc = ((x0 + x1) / 2, (y0 + y1) / 2)
    Rs = [math.hypot(x - bc[0], y - bc[1]) for x, y in spots]
    if min(Rs) < 2 * hole_r:
        return None
    th = max((2 * hole_r + 3.0) / R for R in Rs)
    room = hole_r + margin
    pegs = []
    for (px, py), R in zip(spots, Rs):
        a = math.atan2(py - bc[1], px - bc[0])
        for k in range(9):
            t = a - th / 2 + th * k / 8
            x, y = bc[0] + R * math.cos(t), bc[1] + R * math.sin(t)
            if not (x0 + room - 0.01 <= x <= x1 - room + 0.01 and y0 + room - 0.01 <= y <= y1 - room + 0.01):
                return None
        pegs.append((bc[0] + R * math.cos(a + th / 2), bc[1] + R * math.sin(a + th / 2)))
    return pegs, Rs, th


def layout(s, box):
    """Where everything goes, in the box frame. box = (x0, y0, z0, x1, y1, z1)."""
    x0, y0, z0, x1, y1, z1 = box
    bc = ((x0 + x1) / 2, (y0 + y1) / 2)
    c = (bc[0] if s.get("cx") is None else float(s["cx"]), bc[1] if s.get("cy") is None else float(s["cy"]))
    hole_r = s["foot_r"] + s["fit"]
    pegs, R, theta = peg_places(box, s["peg_inset"], hole_r, s.get("slot_margin", 3.0))
    Rs = [R] * 4
    sp = s.get("spots")
    if sp and len(sp) == 4:
        got = pegs_at(box, [(float(a), float(b)) for a, b in sp], hole_r, s.get("slot_margin", 3.0))
        if got:
            pegs, Rs, theta = got
            R = min(Rs)
    core_h = s["h"] - s["wall"]
    inner_min = min(s["w"], s["d"]) - 2 * s["wall"]
    taper = max(0.5, 1 - 2 * math.tan(math.radians(s["taper_deg"])) * core_h / inner_min)
    pocket_lo = z0 + s["lip"]  # the seat's top edge at the locked end
    foot_lo = pocket_lo - s["fit"] - s["squeeze"]  # where the head's cone starts: it meets the seat at the slot's edge
    foot_hi = foot_lo + (s["foot_r"] - s["post_r"]) + 2.0
    pocket_hi = foot_hi + s["fit"] + s["play"]
    return dict(z0=z0, bc=bc, c=c, pegs=pegs, R=R, Rs=Rs, theta=theta, hole_r=hole_r, core_h=core_h, taper=taper,
                pocket_lo=pocket_lo, pocket_hi=pocket_hi, foot_lo=foot_lo, foot_hi=foot_hi)


def silicone_ml(s):
    L = layout(s, (0, 0, 0, 200, 200, 200))
    outer = area(grown(s, 0)) * s["h"]
    a1 = area(grown(s, -s["wall"]))
    a2 = a1 * L["taper"] ** 2
    core = L["core_h"] / 3 * (a1 + a2 + math.sqrt(a1 * a2))
    return (outer - core) / 1000.0


# ------------------------------------------------------------ the parts

def lock_cutters(s, box, frame4):
    """The twist-lock slots for the shell's four corners, as one object to
    carve out of the shell. Each slot: a round entry the foot drops into, then
    an arc you turn along, narrow at the face (the lip) and wide underneath
    (the pocket the foot slides into)."""
    L = layout(s, box)
    z0, bc, th = L["z0"], L["bc"], L["theta"]
    bm = bmesh.new()
    for (px, py), R in zip(L["pegs"], L["Rs"]):
        a = math.atan2(py - bc[1], px - bc[0])
        ex = (bc[0] + R * math.cos(a - th), bc[1] + R * math.sin(a - th))  # where the peg goes in
        _ring(bm, ex, [(z0 - 1.0, L["hole_r"]), (L["pocket_hi"], L["hole_r"])])
        _arc_sweep(bm, bc, R, a - th, a, lambda t, R=R: _slot_section(s, L, t, R))
        sl = _slot_section(s, L, 1.0, R)  # round off the locked end: the same section, turned about the peg
        _ring(bm, (px, py), [(z, u) for u, z in sl[:len(sl) // 2]])
    return _obj("ms_tmp_locks", bm, frame4)


def seat_depth(s, L, t, R=None):
    """How far in from the face the seat's top edge is, t from 0 (where the
    peg goes in) to 1 (locked). It ramps up to its full depth, then the click
    bump, then flat where the head sits locked."""
    arc = (R or L["R"]) * L["theta"]
    sb = arc - L["hole_r"] - s["click"] - 0.2  # the bump sits just behind the locked head
    sr = sb - 1.4                              # the ramp is done before the bump
    x = t * arc
    d = L["pocket_lo"] - s["ramp"] * max(0.0, 1.0 - x / sr) if sr > 0 else L["pocket_lo"]
    d += s["click"] * max(0.0, 1.0 - abs(x - sb) / 1.2)
    return d


def _slot_section(s, L, t, R=None):
    """The slot's cross-section across the arc: a chamfer at the face for the
    peg's root flare, the narrow part through the lip, a 45° seat, the pocket.
    Points go down the outer side and back up the inner one."""
    z0, nr, hr, fl = L["z0"], s["post_r"] + s["fit"], L["hole_r"], s["flare"]
    zs, ph = seat_depth(s, L, t, R), L["pocket_hi"]
    right = [(nr + fl + 1.0, z0 - 1.0), (nr + fl, z0), (nr, z0 + fl), (nr, zs), (hr, zs + hr - nr), (hr, ph)]
    return right + [(-u, z) for u, z in reversed(right)]


def make_holder(s, box, frame4=None):
    """The holder, in the box frame (pegs locked in). Its hub and arms sit on
    the open face (z0) on the outside, the core and pegs reach in."""
    L = layout(s, box)
    z0, c, t = L["z0"], L["c"], s["arm_t"]
    parts = []
    bm = bmesh.new()  # hub plate, over the insert's open end
    _prism(bm, grown(s, s["hub_lip"]), z0 - t, z0, at=c)
    parts.append(bm)
    bm = bmesh.new()  # the core: the inside of the silicone, tapered so the insert slides off
    _prism(bm, grown(s, -s["wall"]), z0 - 0.5, z0 + L["core_h"], at=c, scale_hi=L["taper"])
    parts.append(bm)
    for i, p in enumerate(L["pegs"]):  # arms from the hub to each corner, and a frame between the corners
        bm = bmesh.new()
        _bar(bm, c, p, s["arm_w"], z0 - t, z0)
        parts.append(bm)
        bm = bmesh.new()
        _bar(bm, p, L["pegs"][(i + 1) % 4], s["frame_w"], z0 - t, z0)
        parts.append(bm)
    pad_r = s["foot_r"] + 4
    for p in L["pegs"]:  # a pad at each corner, a grooved tab off it, and the peg: flared root, neck, head with a 45° underside
        bm = bmesh.new()
        _ring(bm, p, [(z0 - t, pad_r), (z0, pad_r)])
        parts.append(bm)
        bm = bmesh.new()
        _prism(bm, _tab_outline(s, L, p, pad_r - 2, pad_r + s["tab_len"], s["tab_w"] / 2), z0 - t, z0)
        parts.append(bm)
        bm = bmesh.new()
        fl = s["flare"]
        _ring(bm, p, [(z0 - 0.5, s["post_r"] + fl), (z0, s["post_r"] + fl), (z0 + fl, s["post_r"]), (L["foot_lo"], s["post_r"]),
                      (L["foot_lo"] + s["foot_r"] - s["post_r"], s["foot_r"]), (L["foot_hi"], s["foot_r"])])
        parts.append(bm)
    holder = _union("HOLDER", parts, frame4)
    # air holes straight through the core and hub
    import mold_shell as ms
    inner = min(s["w"], s["d"]) - 2 * s["wall"]
    n = int(s["air_n"]) if inner * L["taper"] >= 4 * s["air_d"] + 8 else 1
    rho = 0.0 if n == 1 else min(inner * L["taper"] / 2 - s["air_d"] - 3, inner * 0.25)
    bm = bmesh.new()
    for k in range(n):
        a = math.pi / 2 + 2 * math.pi * k / n
        _ring(bm, (c[0] + rho * math.cos(a), c[1] + rho * math.sin(a)),
              [(z0 - t - 1, s["air_d"] / 2), (z0 + L["core_h"] + 1, s["air_d"] / 2)], seg=20)
    # the bungee groove across each tab, on the outer face
    mid = pad_r + s["tab_len"] / 2 + 1
    for p in L["pegs"]:
        _prism(bm, _tab_outline(s, L, p, mid - s["groove_w"] / 2, mid + s["groove_w"] / 2, s["tab_w"] / 2 + 2),
               z0 - t - 1, z0 - t + s["groove_d"])
    air = _obj("ms_tmp_air", bm, frame4)
    _bool(holder, [air], "DIFFERENCE")
    ms._remove(air)
    _tidy(holder)
    holder["air_holes"] = n
    return holder


def make_cup(s, box):
    """The cup to cast the silicone in, upright on the plate: its inside is the
    insert's outside. The hub plate sits on its rim inside a collar, with
    notches where the arms cross the collar."""
    L = layout(s, box)
    f, h, fit = s["cup_floor"], s["h"], s["cup_fit"]
    rim = f + h
    top = rim + s["collar_h"]
    lip_in = s["hub_lip"] + fit
    lip_out = lip_in + s["collar_w"]
    parts = []
    bm = bmesh.new()
    _prism(bm, grown(s, s["cup_wall"]), 0.0, rim - 2.0)
    parts.append(bm)
    bm = bmesh.new()
    _prism(bm, grown(s, lip_out), rim - 4.0, top)
    parts.append(bm)
    cup = _union("CUP", parts)
    import mold_shell as ms
    cuts = []
    bm = bmesh.new()  # the silicone's outside
    _prism(bm, grown(s, 0), f, rim + 0.01)
    cuts.append(_obj("ms_tmp_cav", bm))
    bm = bmesh.new()  # room for the hub plate, inside the collar
    _prism(bm, grown(s, lip_in), rim, top + 1)
    cuts.append(_obj("ms_tmp_seat", bm))
    # notches for the arms. The holder goes in upside down (turned over about
    # its x axis), so the arms' directions flip in y.
    reach = max(s["w"], s["d"]) / 2 + lip_out + 5
    cxy = L["c"]
    for i, (px, py) in enumerate(L["pegs"]):
        v = np.array([px - cxy[0], -(py - cxy[1])])
        v = v / (np.linalg.norm(v) or 1)
        bm = bmesh.new()
        _bar(bm, tuple(v * (max(s["w"], s["d"]) / 4)), tuple(v * reach), s["arm_w"] + 2 * fit, rim, top + 1)
        cuts.append(_obj(f"ms_tmp_notch{i}", bm))
    _bool(cup, cuts, "DIFFERENCE")
    for o in cuts:
        ms._remove(o)
    _tidy(cup)
    return cup


# ------------------------------------------------------------ checks

def clearances(s, box, R, latex_obj):
    """Thinnest concrete between the insert and the latex (mm, negative if the
    insert pokes through), the same with the holder turned back to unlock,
    and the least plastic around each twist-lock slot."""
    from mathutils.bvhtree import BVHTree
    import mold_shell as ms
    co, tris = ms._world_tris(latex_obj)
    L = layout(s, box)
    # the scan's flat base is the opening, not latex the concrete meets: leave it out
    z0w = (R @ Vector((0, 0, L["z0"]))).z
    a, b, c = co[tris[:, 0]], co[tris[:, 1]], co[tris[:, 2]]
    nz = np.cross(b - a, c - a)
    nz = nz[:, 2] / np.maximum(np.linalg.norm(nz, axis=1), 1e-12)
    cz = (a[:, 2] + b[:, 2] + c[:, 2]) / 3
    keep = ~((cz < z0w + 0.5) | ((nz < -0.7) & (cz < z0w + 5)))
    bvh = BVHTree.FromPolygons([tuple(v) for v in co], [tuple(t) for t in tris[keep]])
    whole = BVHTree.FromPolygons([tuple(v) for v in co], [tuple(t) for t in tris])
    up = Vector((0.0, 0.0, 1.0))

    def inside(q):  # odd number of surface crossings straight up
        n, o = 0, Vector(q) + Vector((0.00137, 0.00291, 0.0))
        for _ in range(200):
            hit = whole.ray_cast(o, up)
            if hit[0] is None:
                break
            n += 1
            o = hit[0] + up * 1e-4
        return n % 2 == 1
    pts = _insert_samples(s, L)

    def thinnest(angle):
        best = None
        ca, sa = math.cos(angle), math.sin(angle)
        for x, y, z in pts:
            dx, dy = x - L["bc"][0], y - L["bc"][1]
            q = R @ Vector((L["bc"][0] + ca * dx - sa * dy, L["bc"][1] + sa * dx + ca * dy, z))
            hit = bvh.find_nearest(q)
            if hit[0] is None:
                continue
            dist = hit[3] if inside(q) else -hit[3]
            if best is None or dist < best[0]:
                best = (dist, tuple(q), tuple(hit[0]))
        return best

    locked = thinnest(0.0)
    turning = min((thinnest(-L["theta"] * f) for f in (0.5, 1.0)), key=lambda b: b[0])
    lock_room = []
    for px, py in L["pegs"]:
        q = R @ Vector((px, py, L["z0"] + (L["pocket_lo"] - L["z0"] + L["pocket_hi"] - L["z0"]) / 2))
        hit = bvh.find_nearest(q)
        lock_room.append(round(hit[3] - L["hole_r"], 1) if hit[0] is not None else None)
    return dict(thinnest_mm=round(locked[0], 1), at=locked[1], latex_at=locked[2],
                turning_mm=round(turning[0], 1), lock_room_mm=lock_room)


def _insert_samples(s, L, step=4.0):
    """Points over the insert's outside (sides and far end), in the box frame."""
    pts = []
    ring = grown(s, 0)
    per = sum(math.dist(a, b) for a, b in zip(ring, ring[1:] + ring[:1]))
    n_ring = max(24, int(per / step))
    # resample the outline evenly
    seg = list(zip(ring, ring[1:] + ring[:1]))
    lens = [math.dist(a, b) for a, b in seg]
    even = []
    for k in range(n_ring):
        t = per * k / n_ring
        for (a, b), ln in zip(seg, lens):
            if t <= ln:
                u = t / ln if ln else 0
                even.append((a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u))
                break
            t -= ln
    cx, cy = L["c"]
    nz = max(2, int(s["h"] / step))
    for i in range(nz + 1):
        z = L["z0"] + s["h"] * i / nz
        pts += [(cx + x, cy + y, z) for x, y in even]
    # the far end, on a few rings in toward the middle
    for f in (0.75, 0.5, 0.25, 0.0):
        pts += [(cx + x * f, cy + y * f, L["z0"] + s["h"]) for x, y in even[:: max(1, int(2 / max(f, 0.25)))]]
    return pts


def mesh_local(obj):
    """Vertices and triangles in the object's own coordinates (the box frame)."""
    me = obj.data
    me.calc_loop_triangles()
    co = np.array([v.co[:] for v in me.vertices], dtype=float)
    tris = np.array([t.vertices[:] for t in me.loop_triangles], dtype=np.int64)
    return co, tris
