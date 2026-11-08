"""
GnomeShell app engine.

Runs inside Blender (started by "GnomeShell.bat" as
`blender -b --factory-startup --python engine/server.py`), serves the app's
screens to your browser on http://127.0.0.1:8765, and does the geometry
with Blender. Only your own computer can reach it.
"""

import json
import math
import os
import queue
import re
import subprocess
import urllib.request
import shutil
import sys
import tempfile
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(os.path.dirname(HERE), "web")
sys.path.insert(0, HERE)

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import mold_shell as ms  # noqa: E402
import insert as ins  # noqa: E402
import split as sp  # noqa: E402
import web as gapweb  # noqa: E402
import seam  # noqa: E402

HOME_DOCS = os.path.join(os.path.expanduser("~"), "Documents")
OUT_ROOT = os.path.join(HOME_DOCS if os.path.isdir(HOME_DOCS) else os.path.expanduser("~"), "Mold Shells")
SETTINGS_FILE = os.path.join(OUT_ROOT, "settings.json")
PREVIEW_DIR = tempfile.mkdtemp(prefix="moldshell_")
PORT = int(os.environ.get("MOLDSHELL_PORT", "8765"))
APP_VERSION = "0.13.5"  # the web screens check this, so a window never talks to an older engine
BOOT = f"{os.getpid()}-{int(time.time())}"  # tells an open window that a different engine has taken over

DEFAULT_SETTINGS = {
    "wall_mm": ms.DEFAULTS["wall_mm"],
    "hole_d_mm": ms.DEFAULTS["hole_d_mm"],
    "holes_per_corner": ms.DEFAULTS["holes_per_corner"],
    "channel_pairs": ms.DEFAULTS["channel_pairs"],
    "pair_gap_mm": ms.DEFAULTS["pair_gap_mm"],
    "hole_edge_mm": ms.DEFAULTS["hole_edge_mm"],
    "test_slice_mm": ms.DEFAULTS["test_slice_mm"],
    "test_slice_style": ms.DEFAULTS["test_slice_style"],
    "test_slice_at": ms.DEFAULTS["test_slice_at"],
    "bed_mm": ms.DEFAULTS["bed_mm"],
    "bed_h_mm": 256.0,
    "bed_d_mm": 256.0,
    "peg_d_mm": 8.0,
    "peg_len_mm": 10.0,
    "peg_clear_mm": 0.2,
    "split_big_pieces": True,
    "seam_t_mm": 0.56,
    "seam_w_mm": 50.0,
    "seam_gap_mm": 0.0,
    "seam_rim_w_mm": 0.0,
    "seam_rim_t_mm": 2.0,
    "web_t_mm": 1.0,
    "bottom_trim_mm": ms.DEFAULTS["bottom_trim_mm"],
    "pour_extend_mm": 0.0,
    "pour_flare_deg": 0.0,
    "max_tilt_deg": ms.DEFAULTS["max_tilt_deg"],
    "draft_deg": 2.0,
    "auto_max_pieces": 6,
    "shell_style": "BOX",
    "contour_mm": ms.DEFAULTS["contour_mm"],
    "strip_w_mm": ms.DEFAULTS["strip_w_mm"],
    "strip_t_mm": ms.DEFAULTS["strip_t_mm"],
    "notch_gap_mm": ms.DEFAULTS["notch_gap_mm"],
    "foot_mm": ms.DEFAULTS["foot_mm"],
    "bump_r_mm": ms.DEFAULTS["bump_r_mm"],
}
SHELL_STYLES = ("BOX", "CONTOUR")

# what each setting may be: (name on screen, lowest, highest, whole numbers only)
LIMITS = {
    "wall_mm": ("Wall", 1, 50, False),
    "hole_d_mm": ("Channel diameter", 1, 30, False),
    "holes_per_corner": ("Channels per corner", 0, 12, True),
    "pair_gap_mm": ("Pair spacing", 1, 100, False),
    "hole_edge_mm": ("Channel from edge", 0.5, 30, False),
    "test_slice_mm": ("Test slice thickness", 0.1, 20, False),
    "test_slice_at": ("Level slice height", 0.05, 0.95, False),
    "bed_mm": ("Plate width", 50, 1000, False),
    "bed_h_mm": ("Max height", 50, 1000, False),
    "bed_d_mm": ("Plate depth", 50, 1000, False),
    "peg_d_mm": ("Peg diameter", 2, 30, False),
    "peg_len_mm": ("Peg length", 3, 60, False),
    "peg_clear_mm": ("Peg clearance", 0, 2, False),
    "seam_t_mm": ("Seam card thickness", 0.1, 5, False),
    "seam_w_mm": ("Seam card sticks out", 5, 300, False),
    "seam_gap_mm": ("Seam card gap", 0, 5, False),
    "seam_rim_w_mm": ("Stiff edge width", 0, 100, False),
    "seam_rim_t_mm": ("Stiff edge thickness", 0.5, 10, False),
    "web_t_mm": ("Gap web thickness", 0.2, 10, False),
    "bottom_trim_mm": ("Floor gap", 0, 50, False),
    "pour_extend_mm": ("Pour collar", 0, 200, False),
    "pour_flare_deg": ("Collar flare", 0, 60, False),
    "max_tilt_deg": ("Auto-cut max tilt", 0, 60, False),
    "draft_deg": ("Overhang tolerance", 0, 15, False),
    "auto_max_pieces": ("Suggest up to", 2, 16, True),
    "contour_mm": ("Contour thickness", 1.5, 20, False),
    "strip_w_mm": ("Strip width", 4, 40, False),
    "strip_t_mm": ("Strip thickness", 2, 15, False),
    "notch_gap_mm": ("Notch spacing", 10, 200, False),
    "foot_mm": ("Foot", 0, 40, False),
    "bump_r_mm": ("Alignment bumps", 0, 8, False),
}

BUSY_LOCK = threading.Lock()  # one job at a time; checked and taken in one step
STATE = {"latex": None, "name": None, "folder": None, "progress": "", "busy": False,
         "last_ping": None, "bye_at": None, "quit": False, "job_end": 0.0}
JOBS = queue.Queue()


# ------------------------------------------------------------ helpers

def bad_setting(k, v):
    """Why a setting's value can't be used, or None if it's fine."""
    if k not in LIMITS:
        return None
    name, lo, hi, whole = LIMITS[k]
    try:
        x = float(v)
    except (TypeError, ValueError):
        return f"{name} needs a number."
    if not math.isfinite(x) or x < lo or x > hi or (whole and x != int(x)):
        unit = " mm" if k.endswith("_mm") else "°" if k.endswith("_deg") else ""
        return f"{name} must be {'a whole number ' if whole else ''}from {lo:g} to {hi:g}{unit}."
    return None


def check_settings(s):
    """Refuse settings that would build nonsense, saying which one is off."""
    problems = [m for m in (bad_setting(k, s.get(k)) for k in LIMITS) if m]
    if str(s.get("shell_style", "BOX")).upper() not in SHELL_STYLES:
        problems.append("Shell style must be Box or Contour.")
    if problems:
        raise RuntimeError(" ".join(problems))
    return s


def load_settings():
    s = dict(DEFAULT_SETTINGS)
    try:
        with open(SETTINGS_FILE, encoding="utf-8") as f:
            s.update({k: v for k, v in json.load(f).items() if k in DEFAULT_SETTINGS})
    except (OSError, ValueError):
        pass
    for k in LIMITS:  # a value saved by an older version that it shouldn't have taken
        if bad_setting(k, s.get(k)):
            s[k] = DEFAULT_SETTINGS[k]
    if str(s.get("shell_style")).upper() not in SHELL_STYLES:
        s["shell_style"] = "BOX"
    s["shell_style"] = str(s["shell_style"]).upper()
    return s


def save_settings(s):
    os.makedirs(OUT_ROOT, exist_ok=True)
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump({k: s[k] for k in DEFAULT_SETTINGS if k in s}, f, indent=2)


def safe_name(name):
    base = os.path.splitext(os.path.basename(name or "scan"))[0]
    keep = "".join(c if c.isalnum() or c in " -_()." else "_" for c in base).strip(" .")
    return keep or "scan"


def progress(msg):
    STATE["progress"] = msg
    print("[mold shell]", msg, flush=True)


def _read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def recent():
    out = []
    if not os.path.isdir(OUT_ROOT):
        return out
    for d in os.listdir(OUT_ROOT):
        folder = os.path.join(OUT_ROOT, d)
        if not os.path.isfile(os.path.join(folder, "scan.stl")):
            continue
        info = _read_json(os.path.join(folder, "info.json"), {}) or {}
        lay = _read_json(os.path.join(folder, "layouts.json"), {}) or {}
        auto = lay.get("auto") or {}
        if not info and not auto:
            continue
        r = {"name": info.get("name", d), "built_at": info.get("built_at", ""), "pieces": info.get("pieces"),
             "scan_dims": info.get("scan_dims") or auto.get("dims"), "saved_at": auto.get("at", ""),
             "layouts": len(lay.get("saved") or []), "slices_only": bool(info.get("slices_only"))}
        r["when"] = max(r["built_at"], r["saved_at"])
        out.append(r)
    out.sort(key=lambda r: r["when"], reverse=True)
    return out[:8]


# ------------------------------------------------------- geometry jobs
# These run on Blender's main thread only (see main loop at the bottom).

MODEL_TYPES = (".stl", ".obj", ".ply", ".blend")


def _as_stl(data, filename):
    """An OBJ, PLY or .blend file turned into STL bytes: every visible mesh in it
    joined into one model, in millimetres. Text, curves and modifiers in a
    .blend come out as they look in Blender."""
    import tempfile
    ext = os.path.splitext(filename or "")[1].lower()
    what = os.path.basename(filename or "That file")
    tmp = tempfile.mkdtemp(prefix="moldshell_")
    path = os.path.join(tmp, "model" + ext)
    with open(path, "wb") as f:
        f.write(data)
    f_mm = 1.0
    try:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        if ext == ".obj":
            bpy.ops.wm.obj_import(filepath=path)
            objs = list(bpy.context.scene.objects)
        elif ext == ".ply":
            bpy.ops.wm.ply_import(filepath=path)
            objs = list(bpy.context.scene.objects)
        else:
            try:
                with bpy.data.libraries.load(path, link=False) as (src, dst):
                    dst.scenes = list(src.scenes)[:1]
            except Exception:
                raise RuntimeError(f"{what} won't open here. If it was saved in a newer Blender, "
                                   "export the model as an STL or OBJ from Blender and load that.")
            if not dst.scenes:
                raise RuntimeError(f"{what} has no scene in it.")
            sc = dst.scenes[0]
            vl = sc.view_layers[0] if sc.view_layers else None
            def shown(o):
                try:
                    return o.visible_get(view_layer=vl) if vl else not o.hide_render
                except Exception:
                    return not o.hide_render
            objs = [o for o in sc.objects if o.type in ("MESH", "CURVE", "SURFACE", "META", "FONT") and shown(o)]
            for o in objs:
                bpy.context.scene.collection.objects.link(o)
            u = sc.unit_settings
            if u.system != "NONE" and u.scale_length > 0:
                f_mm = u.scale_length * 1000.0  # Blender units to mm
        objs = [o for o in objs if o.type in ("MESH", "CURVE", "SURFACE", "META", "FONT")]
        cos, tris, n = [], [], 0
        for o in objs:
            try:
                co, t = ms._world_tris(o)
            except Exception:
                continue
            if len(t):
                cos.append(co)
                tris.append(t + n)
                n += len(co)
        if not tris:
            raise RuntimeError(f"{what} has no 3D model in it that GnomeShell can read.")
        co, t = np.vstack(cos), np.vstack(tris)
        big = float(np.ptp(co, axis=0).max())
        if not 5 <= big * f_mm <= 3000:
            f_mm = 1.0  # the units must have meant mm
        co = co * f_mm
        out = os.path.join(tmp, "model.stl")
        ms._write_stl(out, co, t)
        with open(out, "rb") as f:
            return f.read()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def job_load(stl_bytes, filename, resave=True, prepared=False):
    """Load a file; if it won't open, put back the scan that was open (loading
    starts by clearing Blender, so the screen and the engine would disagree)."""
    before = STATE.get("folder") if STATE.get("latex") else None
    try:
        return _job_load(stl_bytes, filename, resave, prepared)
    except Exception:
        if before and os.path.isfile(os.path.join(before, "scan.stl")):
            try:
                with open(os.path.join(before, "scan.stl"), "rb") as f:
                    _job_load(f.read(), os.path.basename(before) + ".stl", resave=False, prepared=True, quick=True)
            except Exception:
                traceback.print_exc()
        raise


def _job_load(stl_bytes, filename, resave=True, prepared=False, quick=False):
    """Load a scan. A new file starts from the scan as it is; reopening a recent
    scan (prepared=True) brings back how you last sized, turned or trimmed it.
    OBJ, PLY and .blend files are turned into an STL first."""
    progress("Loading scan")
    if resave and os.path.splitext(filename or "")[1].lower() in (".obj", ".ply", ".blend"):
        progress("Reading " + os.path.splitext(filename)[1][1:].upper() + " file")
        stl_bytes = _as_stl(stl_bytes, filename)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    STATE["scan_undo"] = []
    STATE["scan_redo"] = []
    name = safe_name(filename)
    folder = os.path.join(OUT_ROOT, name)
    if resave and not _readable_stl(stl_bytes):
        raise RuntimeError(f"{os.path.basename(filename or 'That file')} isn't a 3D model GnomeShell can read. "
                           "Save the scan as an STL again from your scan software and load that.")
    new_folder = not os.path.isdir(folder)
    os.makedirs(folder, exist_ok=True)
    src = os.path.join(folder, "scan.stl")
    prep_stl = os.path.join(folder, "prepared.stl")
    if resave:
        if os.path.isfile(src):
            shutil.copyfile(src, src + ".last")  # the last good scan, in case this one won't open
        with open(src, "wb") as f:
            f.write(stl_bytes)
    use_prep = prepared and os.path.isfile(prep_stl)
    try:
        bpy.ops.wm.stl_import(filepath=prep_stl if use_prep else src)
        latex = bpy.context.selected_objects[0] if bpy.context.selected_objects else None
        if latex is None or latex.type != "MESH" or not len(latex.data.polygons):
            raise RuntimeError("empty")
    except Exception:
        if new_folder:
            shutil.rmtree(folder, ignore_errors=True)
        elif os.path.isfile(src + ".last"):
            os.replace(src + ".last", src)
        raise RuntimeError(f"{os.path.basename(filename or 'That file')} has no 3D model in it that GnomeShell can read. "
                           "Save the scan as an STL again from your scan software and load that.")
    if os.path.isfile(src + ".last"):
        os.remove(src + ".last")
    if not use_prep and os.path.isfile(prep_stl):
        os.remove(prep_stl)  # starting over from the scan itself
    latex.name = "LATEX"
    bpy.context.view_layer.objects.active = latex
    STATE.update(latex=latex.name, name=name, folder=folder)
    prep = _read_json(os.path.join(folder, "prep.json"), {}) if use_prep else {}
    if prep.get("spouts"):
        latex["spouts"] = json.dumps(prep["spouts"])
    # a scan only millimetres across was saved in other units: bring it up to size
    big = float(max(latex.dimensions))
    grow = _tiny_scale(big)
    if grow != 1:
        _apply_matrix(latex, Matrix.Scale(grow, 4))  # spouts move with it
        if use_prep:
            prep = _read_json(os.path.join(folder, "prep.json"), {}) or {}
            if prep.get("loaded_dims") and max(prep["loaded_dims"]) < TINY_MM:
                prep["loaded_dims"] = [round(x * grow, 2) for x in prep["loaded_dims"]]
                _write_json(os.path.join(folder, "prep.json"), prep)
    _settle(latex)
    if not use_prep:
        prep = {"loaded_dims": [round(x, 2) for x in latex.dimensions]}
        _write_json(os.path.join(folder, "prep.json"), prep)
    if grow != 1 and use_prep:
        co, tris = ms._world_tris(latex)
        ms._write_stl(prep_stl, co, tris)
    info = _scan_info(latex)
    if grow != 1:
        info["grown"] = {"factor": grow, "was": float(f"{big:.3g}")}
    info["file"] = os.path.basename(filename or "scan.stl")
    info["prepared"] = bool(use_prep)
    info["layouts"] = _read_json(os.path.join(folder, "layouts.json"), {}) or {}
    if not quick:
        progress("Finding the best cut")
        info["suggested"] = job_suggest(load_settings().get("max_tilt_deg", 30))
    return info


TINY_MM = 20.0  # a scan smaller than this across was saved in other units (Blender's metres, say)


def _tiny_scale(big):
    """How much to scale a scan that came in far too small, by a power of ten:
    the one that makes it 50 to 1000 mm across, preferring metres (x1000), then
    x100, then cm (x10); failing those, whatever lands nearest 200 mm."""
    if not big or big >= TINY_MM:
        return 1
    for f in (1000, 100, 10):
        if 50 <= big * f <= 1000:
            return f
    return min((10, 100, 1000, 10000, 100000), key=lambda f: abs(math.log(big * f / 200.0)))


def _readable_stl(b):
    """A quick look at the bytes: a binary STL's size, or a text STL with at
    least one facet. Blender has the last word when it reads the file."""
    if len(b) >= 134 and (len(b) - 84) % 50 == 0:
        return True  # binary: 80-byte header, a count, then 50 bytes per triangle
    head = b[:4096].lstrip().lower()
    return head.startswith(b"solid") and b"facet" in b[:200000].lower()


def _open_edge_count(obj):
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    n = sum(1 for e in bm.edges if not e.is_manifold)
    bm.free()
    return n


def _insert_parts(spec, report, folder, bed_mm, latex):
    """The holder and the cup for a silicone insert, saved next to the shell."""
    box = tuple(report["box_frame"])
    R = Matrix(report["frame_R"])
    frame4 = R.to_4x4()
    progress("Making the insert holder")
    holder = ins.make_holder(spec, box, frame4)
    progress("Making the cup for the silicone")
    cup = ins.make_cup(spec, box)
    out = {}
    for obj, name in ((holder, "holder"), (cup, "insert_cup")):
        co, tris = ins.mesh_local(obj)
        co = co - np.array([0, 0, co[:, 2].min()])
        ms._write_stl(os.path.join(folder, name + ".stl"), co, tris)
        ms.write_3mf(os.path.join(folder, name + ".3mf"), [(name, co, tris)], bed_mm, arrange=True)
        span = co.max(0) - co.min(0)
        out[name] = [round(float(x), 1) for x in span]
    # previews in scan coordinates: the holder where it locks on, the cup off to the side
    co, tris = ms._world_tris(holder)
    ms._write_stl(os.path.join(PREVIEW_DIR, "HOLDER.stl"), co, tris)
    ms._remove(cup)
    clear = ins.clearances(spec, box, R, latex)
    info = {"holder_mm": out["holder"], "cup_mm": out["insert_cup"], "silicone_l": round(ins.silicone_ml(spec) / 1000, 2),
            "thinnest_mm": clear["thinnest_mm"], "turning_mm": clear["turning_mm"], "lock_room_mm": clear["lock_room_mm"],
            "air_holes": int(holder.get("air_holes", 0)), "lock_channel_gap_mm": report.get("lock_channel_gap_mm"),
            "fits_plate": bool(max(out["holder"][:2]) <= bed_mm and max(out["insert_cup"][:2]) <= bed_mm)}
    return holder, info


def job_insert_only(spec_in, cuts, settings, frame=None):
    """Just the holder and the cup, without building the shell."""
    latex = _latex()
    check_settings(settings)
    spec = ins.spec_from(spec_in)
    ins.check(spec)
    t0 = time.time()
    progress("Measuring the box")
    p = dict(ms.DEFAULTS)
    p.update(wall_mm=settings["wall_mm"], hole_d_mm=settings["hole_d_mm"], holes_per_corner=int(settings["holes_per_corner"]),
             hole_edge_mm=settings["hole_edge_mm"], channel_pairs=bool(settings.get("channel_pairs")),
             pair_gap_mm=float(settings.get("pair_gap_mm", 10)), bottom_trim_mm=settings["bottom_trim_mm"],
             pour_extend_mm=settings["pour_extend_mm"], pour_flare_deg=settings["pour_flare_deg"], insert=spec)
    planes = [(Vector(c["point"]), Vector(c["normal"]).normalized(), None) for c in cuts]
    report = {"skipped_channels": 0}
    ctx = ms._shell_setup(latex, p, planes, [(c["point"], c["normal"], c.get("scope") or []) for c in cuts], frame, report)
    for k in ("holes", "locks"):
        if ctx.get(k):
            ms._remove(ctx[k])
    if ctx["work"] is not latex:
        ms._remove(ctx["work"])
    report["box_frame"] = list(ctx["box"])
    report["frame_R"] = [list(r) for r in ctx["R"]]
    folder = STATE["folder"]
    for f in ("holder.stl", "holder.3mf", "insert_cup.stl", "insert_cup.3mf"):
        if os.path.isfile(os.path.join(folder, f)):
            os.remove(os.path.join(folder, f))
    holder, info = _insert_parts(spec, report, folder, settings["bed_mm"], latex)
    ms._remove(holder)
    progress("Done")
    files = [{"name": f, "size": os.path.getsize(os.path.join(folder, f))}
             for f in ("holder.3mf", "holder.stl", "insert_cup.3mf", "insert_cup.stl")]
    return {"insert": info, "files": files, "folder": folder, "seconds": round(time.time() - t0),
            "holder_url": f"/api/preview/HOLDER.stl?t={int(time.time())}"}


def job_build(cuts, settings, pieces=None, frame=None, slices_only=False, insert=None):
    """Build the shell and its test slices, or with slices_only, just the slices."""
    latex = bpy.data.objects.get(STATE["latex"] or "")
    if latex is None:
        raise RuntimeError("Load a scan first.")
    check_settings(settings)
    holes = _open_edge_count(latex)
    if holes:
        raise RuntimeError(f"The scan has holes in its surface ({holes} open edges), so the shell can't be carved "
                           "around it properly. Press Repair mesh on the Scan tab, then build again.")
    for o in [o for o in bpy.data.objects if o.name.upper().startswith(ms.CUT_PREFIX)]:
        ms._remove(o)
    cut_list = [(c["point"], c["normal"], c.get("scope") or []) for c in cuts]

    # report progress from inside the build
    steps = {"n": 0}
    real_bool = ms._apply_booleans

    n_pieces = len(pieces) if pieces else 0
    contour = str(settings.get("shell_style", "BOX")).upper() == "CONTOUR"

    def counted(target, cutters, op="DIFFERENCE"):
        steps["n"] += 1
        if slices_only:
            if steps.get("planes", 0) > 1:
                progress(f"Cutting the test slices, part {steps['plane']} of {steps['planes']}")
            else:
                progress("Cutting the test slices")
            return real_bool(target, cutters, op)
        label = ("Carving out the latex" if contour else "Carving the cavity and bungee channels") if steps["n"] == 1 else \
            f"Cutting piece {steps['piece']} of {n_pieces}" if steps.get("piece") else \
            "Splitting the pieces" if any(c.name.startswith("ms_tmp_half") for c in cutters) else \
            "Cutting the test slices"
        progress(label)
        return real_bool(target, cutters, op)

    def on_piece(k, n):
        steps["piece"] = k
        steps["of"] = n

    def on_plane(g, n):
        steps["plane"], steps["planes"] = g, n

    ms._apply_booleans = counted
    ms.on_piece = on_piece
    ms.on_plane = on_plane
    t0 = time.time()
    try:
        progress("Shaping the shell round the latex, with its strips and cord notches" if contour and not slices_only else "Building the box")
        kw = dict(
            shell_style="CONTOUR" if contour else "BOX", spouts=_spouts(latex),
            contour_mm=float(settings["contour_mm"]), strip_w_mm=float(settings["strip_w_mm"]),
            strip_t_mm=float(settings["strip_t_mm"]), notch_gap_mm=float(settings["notch_gap_mm"]),
            foot_mm=float(settings["foot_mm"]), bump_r_mm=float(settings["bump_r_mm"]),
            wall_mm=settings["wall_mm"], hole_d_mm=settings["hole_d_mm"],
            holes_per_corner=int(settings["holes_per_corner"]), hole_edge_mm=settings["hole_edge_mm"],
            channel_pairs=bool(settings.get("channel_pairs")), pair_gap_mm=float(settings.get("pair_gap_mm", 10)),
            test_slice_mm=settings["test_slice_mm"], test_slice_style=settings["test_slice_style"],
            test_slice_at=settings["test_slice_at"], bottom_trim_mm=settings["bottom_trim_mm"],
            pour_extend_mm=settings["pour_extend_mm"], pour_flare_deg=settings["pour_flare_deg"],
            insert=ins.spec_from(insert) if insert and not slices_only else None)
        if slices_only:
            pieces, report = ms.build_test_slices(latex, units="MM", explode_mm=0, cuts=cut_list, pieces=pieces, frame=frame, **kw)
            if not pieces:
                raise RuntimeError("None of the slices reached the shell. Check the cuts and try again.")
        else:
            pieces, report = ms.build_shell(latex, auto_cut=False, units="MM", explode_mm=0, cuts=cut_list, pieces=pieces, frame=frame, **kw)
    finally:
        ms._apply_booleans = real_bool
        ms.on_piece = None
        ms.on_plane = None
    # a piece too big for the printer is cut into parts that fit, pegged together
    split_pieces = []
    if not slices_only and settings.get("split_big_pieces", True):
        vol = _printer(settings)
        for o in list(ms._pieces()):
            co, _ = ms._world_tris(o)
            fx, fy = sp._footprint(co[::max(1, len(co) // 20000)], vol=vol)
            if sp.fits((fx, fy, float(np.ptp(co[:, 2]))), vol)[0]:
                continue
            progress(f"Splitting {o.name.replace('SHELL_', 'piece ')} to fit your printer")
            cuts = sp.suggest(o, vol, float(settings["peg_d_mm"]))
            if not cuts:
                continue
            rep = {}
            parts = sp.split_regrouped(o, cuts, vol, float(settings["peg_d_mm"]), float(settings["peg_len_mm"]), float(settings["peg_clear_mm"]),
                                       report=rep, progress=progress)
            parts.sort(key=lambda q: float(ms._world_tris(q)[0][:, 2].min()))
            # plain copies: values still tied to the piece would crash once it's removed
            props = {k: (o[k].to_list() if hasattr(o[k], "to_list") else o[k].to_dict() if hasattr(o[k], "to_dict") else o[k])
                     for k in o.keys()}
            base = o.name
            ms._remove(o)
            for k, q in enumerate(parts):
                q.name = q.data.name = f"{base}{chr(65 + k)}"
                for kk, vv in props.items():
                    q[kk] = vv
            split_pieces.append({"piece": base, "parts": len(parts), "pegs": rep.get("pegs", 0)})
        if split_pieces:
            pieces = ms._pieces()
    # every piece should come out closed; say so if one didn't, before anyone prints it
    open_pieces = [o.name for o in ms._pieces() + ms._pieces(tests=True) if _open_edge_count(o)]

    progress("Saving files")
    folder = STATE["folder"]
    holder = insert_info = None
    for f in os.listdir(folder):
        if f.lower().endswith((".stl", ".3mf")) and f not in ("scan.stl", "prepared.stl") and not f.endswith(" - model.stl") and " - part " not in f and " - seam card" not in f:
            os.remove(os.path.join(folder, f))
    paths = ms.export_pieces(folder, units="MM", latex_obj=None, bed_mm=settings["bed_mm"])
    if kw.get("insert"):
        holder, insert_info = _insert_parts(kw["insert"], report, folder, settings["bed_mm"], latex)
    # a viewing copy with the latex in place
    mm = 1.0
    angle = pieces[0].get("box_angle", 0.0) if pieces else 0.0
    if not slices_only:
        assembly = [("Latex scan",) + ms._mm_mesh(latex, mm, angle)] + \
                   [(o.name,) + ms._mm_mesh(o, mm, angle) for o in ms._pieces()]
        ms.write_3mf(os.path.join(folder, "preview_with_latex.3mf"), assembly, settings["bed_mm"])

    # every printed piece set out on printer plates, as many as it takes; a file for each plate
    plates, plate_files = [], []
    if not slices_only and ms._pieces():
        W, D, Hh = _printer(settings)
        meshes = {o.name: ms._mm_mesh(o, mm, angle) for o in ms._pieces()}
        plan = ms.plan_plates([(n, m[0]) for n, m in meshes.items()], W, D, Hh)
        Rb = ms._turn_z(-math.degrees(angle))  # the box lined up with the plate, as _mm_mesh turns it
        for k, pl in enumerate(plan, 1):
            named = []
            for it in pl:
                R = ms._turn_z(it["turn"])
                co, tris = meshes[it["name"]]
                named.append((it["name"], co @ R.T + np.array(it["off"]), tris))
                M = np.eye(4)
                M[:3, :3] = R @ Rb
                M[:3, 3] = it["off"]
                it["matrix"] = [float(x) for x in M.reshape(-1)]  # scan coordinates to the plate, row by row
            fname = f"plate {k}.3mf" if len(plan) > 1 else "shell.3mf"  # one plate: shell.3mf is laid out the same way
            ms.write_3mf(os.path.join(folder, fname), named, W, arrange=False, keep=True)
            if len(plan) > 1:
                plate_files.append(fname)
            plates.append({"items": pl, "file": fname})

    # previews for the browser, in scan coordinates
    for f in os.listdir(PREVIEW_DIR):
        if f.startswith(ms.PIECE_PREFIX):
            os.remove(os.path.join(PREVIEW_DIR, f))
    prev = []
    if holder is not None:
        prev.append({"name": "HOLDER", "test": False, "holder": True, "url": f"/api/preview/HOLDER.stl?t={int(time.time())}",
                     "pull": [0, 0, -1], "order": 0, "piece_id": ""})
        ms._remove(holder)
    for o in ms._pieces() + ms._pieces(tests=True):
        co, tris = ms._world_tris(o)
        ms._write_stl(os.path.join(PREVIEW_DIR, o.name + ".stl"), co, tris)
        prev.append({"name": o.name, "test": o.name.endswith(ms.TEST_SUFFIX),
                     "url": f"/api/preview/{o.name}.stl?t={int(time.time())}", "pull": list(o.get("pull_direction", (0, 0, 0))),
                     "order": int(o.get("order", 0)), "piece_id": o.get("piece_id", "")})

    # box size in mm, along the box's own axes
    dims = report.get("box_mm") if slices_only else None
    if pieces and not slices_only:
        allco = np.vstack([ms._mm_mesh(o, mm, angle)[0] for o in pieces])
        dims = [round(float(x), 1) for x in allco.max(0) - allco.min(0)]
    files = sorted(
        ({"name": f, "size": os.path.getsize(os.path.join(folder, f))}
         for f in os.listdir(folder) if f.lower().endswith((".stl", ".3mf")) and f not in ("scan.stl", "prepared.stl") and not f.endswith(" - model.stl") and " - part " not in f and " - seam card" not in f),
        key=lambda f: (not (f["name"].startswith("test_slices") or "_TEST" in f["name"]), f["name"]))
    if not insert_info:
        files = [f for f in files if not f["name"].startswith(("holder", "insert_cup"))]
    seconds = round(time.time() - t0)
    summary = {
        "name": STATE["name"], "folder": folder, "seconds": seconds,
        "pieces": len(pieces), "channels": report.get("channels", 0),
        "skipped_channels": report.get("skipped_channels", 0),
        "loose_bits_removed": report.get("loose_bits_removed", 0),
        "bits_joined": report.get("bits_joined", 0), "bits_own_piece": report.get("bits_own_piece", 0),
        "shell_style": "CONTOUR" if contour else "BOX",
        "notches": report.get("notches", 0), "bumps": report.get("bumps", 0),
        "split_pieces": split_pieces,
        "plates": plates, "plate_bed": list(_printer(settings)),
        "box_mm": dims, "fits_plate": bool(dims and (sp.fits(dims, _printer(settings))[0] or (not slices_only and pieces and all(
            sp.fits([float(x) for x in np.ptp(ms._mm_mesh(o, mm, angle)[0], axis=0)], _printer(settings))[0] for o in pieces)))),
        "files": files, "previews": prev,
        "order": [] if slices_only else [{"name": o.name, "order": int(o.get("order", 0))} for o in pieces],
        "slices_only": slices_only, "slice_mm": settings["test_slice_mm"],
        "slices": [{"name": o.name, "through": o.get("slice_through", "")} for o in ms._pieces(tests=True)],
        "open_pieces": open_pieces,
        "insert": insert_info,
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "scan_dims": [round(x, 1) for x in latex.dimensions],
    }
    with open(os.path.join(folder, "info.json"), "w", encoding="utf-8") as f:
        json.dump({k: summary[k] for k in ("name", "folder", "pieces", "box_mm", "built_at", "scan_dims", "slices_only")}, f, indent=2)
    progress("Done")
    return summary


def job_load_recent(name):
    folder = os.path.join(OUT_ROOT, safe_name(name))
    src = os.path.join(folder, "scan.stl")
    if not os.path.isfile(src):
        raise RuntimeError("That scan's file is gone from its folder.")
    with open(src, "rb") as f:
        data = f.read()
    return job_load(data, safe_name(name) + ".stl", resave=False, prepared=True)


# ------------------------------------------------------------ scan prep

def _latex():
    latex = bpy.data.objects.get(STATE["latex"] or "")
    if latex is None:
        raise RuntimeError("Load a scan first.")
    return latex


def _spouts(latex):
    try:
        return json.loads(latex.get("spouts", "[]"))
    except (TypeError, ValueError):
        return []


def _set_spouts(latex, spouts):
    latex["spouts"] = json.dumps(spouts)
    if STATE.get("folder"):
        prep = _read_json(os.path.join(STATE["folder"], "prep.json"), {}) or {}
        prep["spouts"] = spouts
        _write_json(os.path.join(STATE["folder"], "prep.json"), prep)


def _apply_matrix(latex, mat):
    latex.data.transform(mat)
    latex.data.update()
    sps = _spouts(latex)
    if sps:  # a spout moves and turns with the model
        rot = mat.to_3x3()
        for s in sps:
            s["top"] = list(mat @ Vector(s["top"]))
            s["dir"] = list((rot @ Vector(s["dir"])).normalized())
        _set_spouts(latex, sps)


def _settle(latex):
    """Base on the floor (z = 0), centred over the origin."""
    co, _ = ms._world_tris(latex)
    lo, hi = co.min(0), co.max(0)
    _apply_matrix(latex, Matrix.Translation((-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2])))


def _scan_info(latex):
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(latex.data)
    open_edges = sum(1 for e in bm.edges if not e.is_manifold)
    bm.free()
    co, _ = ms._world_tris(latex)
    path = os.path.join(PREVIEW_DIR, "LATEX.stl")
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    co_, tris = ms._world_tris(latex)
    ms._write_stl(path, co_, tris)
    STATE["latex_rev"] = STATE.get("latex_rev", 0) + 1
    return {
        "name": STATE["name"],
        "dims": [round(x, 1) for x in latex.dimensions],
        "triangles": len(latex.data.polygons),
        "watertight": open_edges == 0,
        "open_edges": open_edges,
        "center": [float(x) for x in (co.min(0) + co.max(0)) / 2],
        "size": [round(float(x), 3) for x in latex.dimensions],
        "loaded_dims": (_read_json(os.path.join(STATE["folder"], "prep.json"), {}) or {}).get("loaded_dims"),
        "stl_url": f"/api/preview/LATEX.stl?rev={STATE['latex_rev']}",
    }


def _open_count(me):
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(me)
    n = sum(1 for e in bm.edges if not e.is_manifold) + sum(1 for v in bm.verts if not v.is_manifold)
    bm.free()
    return n


def _volume(me):
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(me)
    v = abs(bm.calc_volume())
    bm.free()
    return v


def _dims(me):
    import numpy as np
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    return tuple(co.max(0) - co.min(0)) if len(co) else (0.0, 0.0, 0.0)


def _repair(latex):
    """Repair the scan in place and say what was done. First the surface is
    fixed bit by bit (see ms.repair_scan). If anything is still open after
    that, the whole surface is rebuilt from a fine grid of tiny cubes (a voxel
    remesh), which always comes out closed, then thinned back to about the
    triangle count it had. Returns a sentence for the person."""
    import bmesh
    tris0 = len(latex.data.polygons)
    bm = bmesh.new()
    bm.from_mesh(latex.data)
    did = ms.repair_scan(bm)
    bm.to_mesh(latex.data)
    bm.free()
    latex.data.update()
    said = []
    if did["welded"]:
        said.append(f"joined {did['welded']} loose points")
    if did["doubles"]:
        said.append(f"removed {did['doubles']} doubled triangles")
    if did["crumbs"]:
        said.append(f"removed {did['crumbs']} loose crumb{'s' if did['crumbs'] != 1 else ''}")
    if did["trimmed"]:
        said.append("cut back and refilled a few tangled spots")
    if did["holes"]:
        said.append(f"filled {did['holes']} hole{'s' if did['holes'] != 1 else ''}")
    if _open_count(latex.data):
        span = max(latex.dimensions) or 1.0
        size = max(0.15, span / 700.0)
        dims0, vol0 = tuple(latex.dimensions), _volume(latex.data)
        me = None
        for attempt in range(2):
            m = latex.modifiers.new("remesh", "REMESH")
            m.mode = "VOXEL"
            m.voxel_size = size
            m.adaptivity = 0.0
            bpy.context.view_layer.update()
            dg = bpy.context.evaluated_depsgraph_get()
            me = bpy.data.meshes.new_from_object(latex.evaluated_get(dg))
            latex.modifiers.clear()
            # keep it only if it closed and is still the same shape: a scan that's
            # still badly open comes out of this as scraps, which would be worse
            same = len(me.polygons) and abs(_volume(me) - vol0) <= 0.05 * vol0 and all(
                abs(a - b) <= 0.03 * span for a, b in zip(_dims(me), dims0))
            if same and not _open_count(me):
                break
            bpy.data.meshes.remove(me)
            me = None
            size *= 1.6
        if me is not None:
            old = latex.data
            latex.data = me
            bpy.data.meshes.remove(old)
            target = max(0.05, tris0 * 1.1 / len(me.polygons))
            for ratio in (target, target * 1.5, target * 2.2):  # thin it back, but only keep that if it stays closed
                if ratio > 0.77:
                    break
                d = latex.modifiers.new("thin", "DECIMATE")
                d.ratio = ratio
                bpy.context.view_layer.update()
                dg = bpy.context.evaluated_depsgraph_get()
                me2 = bpy.data.meshes.new_from_object(latex.evaluated_get(dg))
                latex.modifiers.clear()
                bm = bmesh.new()  # thinning can leave a few tangled spots; tidy them
                bm.from_mesh(me2)
                ms.repair_scan(bm)
                bm.to_mesh(me2)
                bm.free()
                if len(me2.polygons) and not _open_count(me2):
                    latex.data = me2
                    bpy.data.meshes.remove(me)
                    break
                bpy.data.meshes.remove(me2)
            said.append(f"rebuilt the surface on a {size:.2g} mm grid to close the rest")
    left = _open_count(latex.data)
    if left:
        said.append(f"but {left} spot{'s are' if left != 1 else ' is'} still open")
    if not said:
        return "Nothing needed fixing."
    note = ", ".join(said)
    return note[0].upper() + note[1:] + "."


SCAN_STEPS = 15  # how many scan changes Ctrl+Z can take back


def _scan_snap(latex):
    """The scan's mesh and spouts as plain arrays, so a later Ctrl+Z can put
    them back (Blender's own data is wiped when a scan is reloaded)."""
    co, tris = ms._world_tris(latex)
    return (co.copy(), tris.copy(), latex.get("spouts", "[]"))


def _scan_hist(op):
    src, dst = ("scan_undo", "scan_redo") if op == "undo" else ("scan_redo", "scan_undo")
    if not STATE.get(src):
        raise RuntimeError("There's no scan change to " + op + ".")
    latex = _latex()
    STATE.setdefault(dst, []).append(_scan_snap(latex))
    co, tris, spouts = STATE[src].pop()
    me = bpy.data.meshes.new("LATEX")
    me.from_pydata(co.tolist(), [], tris.tolist())
    me.update()
    old = latex.data
    latex.data = me
    latex.matrix_world = Matrix.Identity(4)
    if old.users == 0:
        bpy.data.meshes.remove(old)
    try:
        _set_spouts(latex, json.loads(spouts or "[]"))
    except (TypeError, ValueError):
        _set_spouts(latex, [])
    ms._write_stl(os.path.join(STATE["folder"], "prepared.stl"), co, tris)
    return _scan_info(latex)


def _scan_push(snap):
    STATE["scan_undo"] = (STATE.get("scan_undo") or [])[-(SCAN_STEPS - 1):] + [snap]
    STATE["scan_redo"] = []


def job_prep(op, value=None):
    import bmesh
    if op in ("undo", "redo"):
        return _scan_hist(op)
    latex = _latex()
    snap = _scan_snap(latex)
    if op == "rotate":
        axis, deg = value["axis"], float(value["deg"])
        co, _ = ms._world_tris(latex)
        c = Vector(((co.min(0) + co.max(0)) / 2).tolist())
        _apply_matrix(latex, Matrix.Translation(c) @ Matrix.Rotation(math.radians(deg), 4, axis.upper()) @ Matrix.Translation(-c))
    elif op == "lay_flat":
        # put the biggest flat face of the outline (usually the mold opening) on the floor
        bm = bmesh.new()
        bm.from_mesh(latex.data)
        hull = bmesh.ops.convex_hull(bm, input=bm.verts[:])
        faces = [g for g in hull["geom"] if isinstance(g, bmesh.types.BMFace)]
        groups = {}
        for f in faces:
            key = tuple(round(x, 2) for x in f.normal)
            groups[key] = groups.get(key, 0.0) + f.calc_area()
        bm.free()
        if not groups:
            raise RuntimeError("Couldn't find a flat base.")
        n = Vector(max(groups, key=groups.get)).normalized()
        _apply_matrix(latex, n.rotation_difference(Vector((0, 0, -1))).to_matrix().to_4x4())
    elif op == "scale":
        f = [float(v) for v in value] if isinstance(value, (list, tuple)) else [float(value)] * 3
        if not all(0.05 <= v <= 50 for v in f):
            raise RuntimeError("That size is too far from the scan's.")
        _apply_matrix(latex, Matrix.Diagonal((f[0], f[1], f[2], 1.0)))
    elif op == "trim_base":
        mm_ = float(value)
        co, _ = ms._world_tris(latex)
        zc = float(co[:, 2].min()) + mm_
        bm = bmesh.new()
        bm.from_mesh(latex.data)
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
                               plane_co=(0, 0, zc), plane_no=(0, 0, 1), clear_inner=True)
        rim = [e for e in bm.edges if e.is_boundary]
        if rim:
            bmesh.ops.holes_fill(bm, edges=rim, sides=0)
        bm.to_mesh(latex.data)
        bm.free()
    elif op == "add_base":
        v = value or {}
        obj = ms.make_base(latex, float(v.get("height", 0)), float(v.get("flare", 0)),
                           v.get("shape", "outline"), float(v.get("margin", 5)), reach=float(v.get("reach", 0)),
                           widen=float(v.get("widen", 0)))
        old = latex.data
        latex.data = obj.data
        ms._remove(obj)
        if old.users == 0:
            bpy.data.meshes.remove(old)
    elif op == "add_spout":
        v = value or {}
        obj, rec = ms.add_spout(latex, v["point"], v.get("dir") or (0, 0, 1), float(v.get("d", 20)), float(v.get("h", 30)))
        old = latex.data
        latex.data = obj.data
        ms._remove(obj)
        if old.users == 0:
            bpy.data.meshes.remove(old)
        _set_spouts(latex, _spouts(latex) + [rec])
    elif op == "add_webs":
        for k, (w, t) in enumerate(_web_list((value or {}).get("webs")), 1):
            progress(f"Joining gap web {k} onto the model")
            obj, _ = gapweb.add_web(latex, w["point"], float(w["az"]), float(w["tilt"]), t)
            old = latex.data
            latex.data = obj.data
            ms._remove(obj)
            if old.users == 0:
                bpy.data.meshes.remove(old)
    elif op == "repair":
        STATE["repair_note"] = _repair(latex)
    elif op == "simplify":
        ratio = max(0.05, min(1.0, float(value)))
        m = latex.modifiers.new("simplify", "DECIMATE")
        m.ratio = ratio
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(latex.evaluated_get(dg))
        latex.modifiers.clear()
        old = latex.data
        latex.data = me
        bpy.data.meshes.remove(old)
    elif op == "reset":
        src = os.path.join(STATE["folder"], "scan.stl")
        with open(src, "rb") as f:
            data = f.read()
        keep = STATE.get("scan_undo") or []
        info = job_load(data, STATE["name"] + ".stl", resave=False)
        STATE["scan_undo"] = keep
        _scan_push(snap)
        return info
    else:
        raise RuntimeError(f"Unknown tool: {op}")
    _settle(latex)
    # keep the prepared scan, so it opens this way next time
    co, tris = ms._world_tris(latex)
    ms._write_stl(os.path.join(STATE["folder"], "prepared.stl"), co, tris)
    info = _scan_info(latex)
    _scan_push(snap)
    if op == "repair":
        info["repair_note"] = STATE.pop("repair_note", "")
    return info


def layouts_op(data):
    """The cut layouts for the open scan: the one you're working on ("auto",
    brought back when you open the scan again) and any you saved by name."""
    folder = STATE["folder"]
    if not folder:
        raise RuntimeError("Load a scan first.")
    path = os.path.join(folder, "layouts.json")
    lay = _read_json(path, {}) or {}
    lay.setdefault("saved", [])
    op = data.get("op")
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    if op == "auto":
        lay["auto"] = dict(data["layout"], at=now)
    elif op == "save":
        name = (str(data.get("name") or "").strip() or "Layout")[:60]
        lay["saved"] = [x for x in lay["saved"] if x.get("name") != name]
        lay["saved"].insert(0, {"name": name, "at": now, "layout": data["layout"]})
    elif op == "delete":
        lay["saved"] = [x for x in lay["saved"] if x.get("name") != data.get("name")]
    elif op != "list":
        raise RuntimeError("Unknown layout request.")
    if op != "list":
        _write_json(path, lay)
    return lay


def job_suggest(max_tilt):
    latex = _latex()
    progress("Finding the best cut")
    res = ms.suggest_cut(latex, max_tilt_deg=float(max_tilt), verbose=False)
    return {"point": list(res["point"]), "normal": list(res["normal"]), "overhang_pct": round(res["overhang_pct"], 2)}


def job_autosplit(pieces, next_id, frame, settings):
    latex = _latex()
    progress("Looking for more cuts")
    return ms.suggest_more_cuts(latex, pieces, next_id, max_pieces=int(settings.get("auto_max_pieces", 6)),
                                draft_deg=float(settings.get("draft_deg", 2.0)), frame=frame)


def job_base_preview(v):
    """The base on its own, for display while you set it up."""
    latex = _latex()
    path = os.path.join(PREVIEW_DIR, "BASE.stl")
    h = float(v.get("height", 0))
    if h <= 0:
        return {"url": None}
    auto = v.get("reach") == "auto"
    slab = v.get("shape") == "slab"
    if auto and slab:
        key = (STATE.get("latex_rev"), STATE.get("name"))
        if STATE.get("reach_key") != key:
            STATE["reach_auto"], STATE["reach_key"] = ms.auto_reach(latex), key
        reach = STATE["reach_auto"]
    else:
        reach = 0.0 if auto else float(v.get("reach") or 0)
    obj = ms.make_base(latex, h, float(v.get("flare", 0)), v.get("shape", "outline"), float(v.get("margin", 5)), preview=True, reach=reach,
                       widen=float(v.get("widen", 0)), reach_auto=auto and not slab)
    if not slab:
        reach = round(float(obj.get("reach", reach)), 1)
    co, tris = ms._world_tris(obj)
    ms._remove(obj)
    ms._write_stl(path, co, tris)
    STATE["base_rev"] = STATE.get("base_rev", 0) + 1
    return {"url": f"/api/preview/BASE.stl?rev={STATE['base_rev']}", "reach": reach, "auto": auto,
            "cover": None if auto else round(ms.base_cover(latex, reach), 3)}


def _show_in_folder(path):
    """Open Explorer at the file's folder with the file picked out."""
    if os.name == "nt":
        subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])


def job_save_model():
    """The model as it is now (sized, turned, with its base) as an STL in the
    scan's folder, to print or use somewhere else."""
    latex = _latex()
    co, tris = ms._world_tris(latex)
    path = os.path.join(STATE["folder"], STATE["name"] + " - model.stl")
    ms._write_stl(path, co, tris)
    return {"path": path, "file": os.path.basename(path)}


def _printer(settings):
    return (float(settings["bed_mm"]), float(settings.get("bed_d_mm") or settings["bed_mm"]), float(settings["bed_h_mm"]))


def _parts_report(co, cuts, vol):
    parts = sp.part_sizes(co, cuts, vol)
    for p in parts:
        p["fits"], p["over"] = sp.fits(p["dims"], vol)
    return parts


def _seam_cards(cards):
    latex = _latex()
    s = load_settings()
    out = []
    for c in cards or []:
        card, info = seam.card_solid(latex, c["point"], c["out"], float(c["top"]), width=float(s["seam_w_mm"]),
                                     thick=float(s["seam_t_mm"]), gap=float(s["seam_gap_mm"]),
                                     rim_w=float(s["seam_rim_w_mm"]), rim_t=float(s["seam_rim_t_mm"]))
        out.append((card, info, c))
    return out


def job_seam_preview(cards):
    """The seam cards in place against the model, for the view."""
    made = _seam_cards(cards)
    co_all, tri_all, infos, off = [], [], [], 0
    for card, info, _ in made:
        co, tris = ms._world_tris(card)
        co_all.append(co)
        tri_all.append(tris + off)
        off += len(co)
        infos.append(info)
        ms._remove(card)
    STATE["seam_rev"] = STATE.get("seam_rev", 0) + 1
    if not co_all:
        return {"url": None, "cards": []}
    ms._write_stl(os.path.join(PREVIEW_DIR, "SEAM.stl"), np.vstack(co_all), np.vstack(tri_all))
    return {"url": f"/api/preview/SEAM.stl?rev={STATE['seam_rev']}", "cards": infos}


def job_seam_suggest():
    progress("Checking whether the skin needs a seam card")
    return seam.suggest(_latex())


def job_seam_save(cards, open_folder=False):
    """Each card laid flat for printing, as "<name> - seam card N.stl"."""
    made = _seam_cards(cards)
    if not made:
        raise RuntimeError("Place a seam card first.")
    folder = STATE["folder"]
    for f in os.listdir(folder):
        if " - seam card" in f and f.lower().endswith(".stl"):
            os.remove(os.path.join(folder, f))
    files = []
    for k, (card, info, c) in enumerate(made, 1):
        pts, tris = seam.lay_flat(card, info["out"])
        name = f"{STATE['name']} - seam card {k}.stl" if len(made) > 1 else f"{STATE['name']} - seam card.stl"
        ms._write_stl(os.path.join(folder, name), pts, tris)
        files.append({"file": name, "size": [round(float(x), 1) for x in pts.max(0)], "closed": not ms._open_edges(card.data)})
        ms._remove(card)
    if open_folder:
        _show_in_folder(os.path.join(folder, files[0]["file"]))
    return {"files": files, "folder": folder}


def _web_list(webs):
    t = float(load_settings().get("web_t_mm", 1.0))
    return [(w, float(w.get("thick") or t)) for w in (webs or [])]


def job_web_find():
    progress("Looking for gaps")
    return {"webs": gapweb.find(_latex(), progress)}


def job_web_click(point, look):
    progress("Finding the best angle for the gap")
    r = gapweb.best_for_point(_latex(), point, look)
    if not r:
        raise RuntimeError("There's no closed-in gap there to fill. Click in the middle of a gap you can see through, "
                           "like between the legs, with the model turned so you look straight through it.")
    return r


def job_web_preview(webs):
    """The webs in place, for the view (each one on its own, not joined yet)."""
    latex = _latex()
    co_all, tri_all, infos, off = [], [], [], 0
    for w, t in _web_list(webs):
        try:
            obj, info = gapweb.web_solid(latex, w["point"], float(w["az"]), float(w["tilt"]), t)
        except RuntimeError as e:
            infos.append({"error": str(e)})
            continue
        co, tris = ms._world_tris(obj)
        ms._remove(obj)
        co_all.append(co)
        tri_all.append(tris + off)
        off += len(co)
        infos.append(info)
    STATE["web_rev"] = STATE.get("web_rev", 0) + 1
    if not co_all:
        return {"url": None, "webs": infos}
    ms._write_stl(os.path.join(PREVIEW_DIR, "WEB.stl"), np.vstack(co_all), np.vstack(tri_all))
    return {"url": f"/api/preview/WEB.stl?rev={STATE['web_rev']}", "webs": infos}


def job_spout_preview(v):
    latex = _latex()
    obj, top = ms.spout_solid(latex, v["point"], v.get("dir") or (0, 0, 1), float(v.get("d", 20)), float(v.get("h", 30)))
    co, tris = ms._world_tris(obj)
    ms._remove(obj)
    ms._write_stl(os.path.join(PREVIEW_DIR, "SPOUT.stl"), co, tris)
    STATE["spout_rev"] = STATE.get("spout_rev", 0) + 1
    return {"url": f"/api/preview/SPOUT.stl?rev={STATE['spout_rev']}"}


def job_split_plan(cuts=None, suggest=False):
    """How the model sits in the printer, and the parts these cuts (or the
    suggested ones) would make."""
    latex = _latex()
    settings = load_settings()
    vol = _printer(settings)
    co, _ = ms._world_tris(latex)
    if suggest:
        progress("Finding cuts that fit your printer")
        cuts = sp.suggest(latex, vol, float(settings["peg_d_mm"]))
    cuts = cuts or []
    dims = [round(float(x), 1) for x in np.ptp(co, axis=0)]
    fit, over = sp.fits(dims, vol)
    return {"cuts": cuts, "parts": _parts_report(co, cuts, vol) if cuts else [], "dims": dims, "fits": fit, "over": over,
            "printer": list(vol), "lo": [round(float(x), 1) for x in co.min(0)], "hi": [round(float(x), 1) for x in co.max(0)]}


def job_split(cuts, open_folder=False):
    """Cut the model into the parts, with pegs and holes, and save each one."""
    latex = _latex()
    settings = load_settings()
    if not cuts:
        raise RuntimeError("Add a cut first, or press Suggest cuts.")
    t0 = time.time()
    progress("Splitting the model")
    report = {}
    parts = sp.split(latex, cuts, float(settings["peg_d_mm"]), float(settings["peg_len_mm"]), float(settings["peg_clear_mm"]),
                     report=report, progress=progress)
    folder = STATE["folder"]
    for f in os.listdir(folder):
        if " - part " in f and f.lower().endswith(".stl"):
            os.remove(os.path.join(folder, f))
    # bottom part first, then up
    parts.sort(key=lambda o: (round(float(ms._world_tris(o)[0][:, 2].min()) / 5), float(ms._world_tris(o)[0][:, 0].min())))
    vol = _printer(settings)
    out = []
    for f in os.listdir(PREVIEW_DIR):
        if f.startswith("PART_"):
            os.remove(os.path.join(PREVIEW_DIR, f))
    STATE["split_rev"] = STATE.get("split_rev", 0) + 1
    for k, o in enumerate(parts, 1):
        co, tris = ms._world_tris(o)
        name = f"{STATE['name']} - part {k}.stl"
        ms._write_stl(os.path.join(folder, name), co, tris)
        ms._write_stl(os.path.join(PREVIEW_DIR, f"PART_{k}.stl"), co, tris)
        dims = [round(float(x), 1) for x in np.ptp(co, axis=0)]
        fx, fy = sp._footprint(co[::max(1, len(co) // 20000)], vol=vol)
        fit, over = sp.fits((fx, fy, dims[2]), vol)
        out.append({"file": name, "dims": [round(fx, 1), round(fy, 1), dims[2]], "fits": fit, "over": over,
                    "closed": not ms._open_edges(o.data), "url": f"/api/preview/PART_{k}.stl?rev={STATE['split_rev']}"})
        ms._remove(o)
    if open_folder and out:
        _show_in_folder(os.path.join(folder, out[0]["file"]))
    progress("Done")
    return {"parts": out, "pegs": report.get("pegs", 0), "no_room": report.get("no_room", []),
            "too_thin": report.get("too_thin", []), "folder": folder, "seconds": round(time.time() - t0)}


def job_pour(extend_mm, flare_deg):
    latex = _latex()
    path = os.path.join(PREVIEW_DIR, "POUR.stl")
    if float(extend_mm) <= 0:
        return {"url": None}
    obj = ms.make_pour_extension(latex, float(extend_mm), float(flare_deg), 1.0)
    co, tris = ms._world_tris(obj)
    ms._remove(obj)
    keep = co[tris].min(axis=1)[:, 2] < float(ms._world_tris(latex)[0][:, 2].min()) + 0.5
    ms._write_stl(path, co, tris[keep])  # only the collar, for display
    STATE["pour_rev"] = STATE.get("pour_rev", 0) + 1
    return {"url": f"/api/preview/POUR.stl?rev={STATE['pour_rev']}"}


def run_job(fn, *args):
    """Hand work to Blender's main thread and wait for it."""
    box = {"done": threading.Event()}
    JOBS.put((fn, args, box))
    box["done"].wait()
    if "error" in box:
        raise RuntimeError(box["error"])
    return box["result"]


# ----------------------------------------------------------------- updates
# New versions go to the public GitHub repo's main branch, with version.json
# saying which version it is. The app checks that file once when it opens;
# installing downloads the branch as a zip, unpacks it over this folder and
# starts the new engine in this one's place.
UPDATE_REPO = "physare/gnomeshell"
UPDATE_BRANCH = "main"
APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPDATE = {"checked": 0, "info": None}
SKIP_ON_UPDATE = {"README.md", "version.json", ".gitattributes", ".gitignore"}


def _ver(v):
    try:
        return tuple(int(x) for x in str(v).lstrip("vV").split("."))
    except ValueError:
        return (0,)


def _fetch(url, timeout=8):
    req = urllib.request.Request(url, headers={"User-Agent": "GnomeShell-updater", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def update_check(force=False):
    # a found update is remembered for an hour; "nothing new" only for a minute, so a reopened window looks again
    keep = 3600 if (UPDATE["info"] or {}).get("newer") else 60
    if not force and UPDATE["info"] and time.time() - UPDATE["checked"] < keep:
        return UPDATE["info"]
    info = {"current": APP_VERSION, "newer": False}
    try:
        v = json.loads(_fetch(f"https://raw.githubusercontent.com/{UPDATE_REPO}/{UPDATE_BRANCH}/version.json?t={int(time.time())}") or b"{}")
        latest = str(v.get("version") or "")
        tag = str(v.get("tag") or "")
        info.update(latest=latest, notes=str(v.get("notes") or "")[:2000], newer=_ver(latest) > _ver(APP_VERSION),
                    tag=tag if re.fullmatch(r"v[0-9][0-9.]*", tag) else "")
    except Exception as e:  # offline, or GitHub didn't answer: no update, no fuss
        info["error"] = str(e)
    UPDATE.update(checked=time.time(), info=info)
    print(f"  Update check: running {APP_VERSION}, latest {info.get('latest', '?')}" + (f" ({info['error']})" if info.get("error") else ""), flush=True)
    return info


def update_install():
    info = update_check(force=True)
    if not info.get("newer"):
        raise RuntimeError("There's no newer version to install." if not info.get("error") else
                           "Couldn't reach GitHub to download the update. Check the internet connection and try again.")
    import io
    import zipfile
    # the release's own tag when version.json names one, so a half-finished push to main never reaches anyone
    ref = f"tags/{info['tag']}" if info.get("tag") else f"heads/{UPDATE_BRANCH}"
    try:
        data = _fetch(f"https://codeload.github.com/{UPDATE_REPO}/zip/refs/{ref}", timeout=180)
    except urllib.error.HTTPError as e:  # the tag isn't up yet: the main branch has the same release
        if e.code != 404 or not info.get("tag"):
            raise
        data = _fetch(f"https://codeload.github.com/{UPDATE_REPO}/zip/refs/heads/{UPDATE_BRANCH}", timeout=180)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        files = {}
        for n in z.namelist():
            parts = n.replace("\\", "/").split("/")[1:]  # drop the "gnomeshell-main/" (or tag) folder
            if not parts or not parts[-1] or ".." in parts or parts[0] in SKIP_ON_UPDATE:
                continue
            files["/".join(parts)] = n
        if "engine/server.py" not in files or "web/index.html" not in files:
            raise RuntimeError("The update download doesn't look like GnomeShell. Nothing was changed.")
        changed = 0
        for rel, n in files.items():
            new = z.read(n)
            dest = os.path.join(APP_DIR, *rel.split("/"))
            if os.path.isfile(dest):
                with open(dest, "rb") as f:
                    if f.read() == new:
                        continue  # unchanged; leaves the running launcher alone too
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            tmp = dest + ".new"
            with open(tmp, "wb") as f:
                f.write(new)
            os.replace(tmp, dest)
            changed += 1
    if not os.environ.get("GNOMESHELL_NO_RESTART"):
        threading.Timer(1.0, _restart_engine).start()
    return {"ok": True, "version": info["latest"], "changed": changed}


def _restart_engine():
    """Start the new engine without a window of its own; it asks this one to
    quit and takes its port, and the open window reloads onto it."""
    env = dict(os.environ, MOLDSHELL_NO_BROWSER="1")
    # its own log: GnomeShell.log is still held open by the launcher that started this engine
    log = os.path.join(tempfile.gettempdir(), "GnomeShell-restart.log")
    flags = (0x00000008 | 0x00000200) if os.name == "nt" else 0  # detached, own process group
    cmd = [bpy.app.binary_path, "-b", "--factory-startup", "--python", os.path.join(APP_DIR, "engine", "server.py")]
    try:
        try:
            out = open(log, "wb")
        except OSError:
            out = subprocess.DEVNULL
        subprocess.Popen(cmd, env=env, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                         creationflags=flags, cwd=APP_DIR, close_fds=True, start_new_session=os.name != "nt")
        print("  Started the updated engine:", " ".join(cmd), flush=True)
    except Exception as e:
        traceback.print_exc()
        STATE["restart_error"] = str(e)


# ----------------------------------------------------------------- web

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
        ".stl": "model/stl", ".woff2": "font/woff2", ".json": "application/json"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path):
        if not os.path.isfile(path):
            return self._send(404, {"error": "not found"})
        with open(path, "rb") as f:
            self._send(200, f.read(), MIME.get(os.path.splitext(path)[1].lower(), "application/octet-stream"))

    def _local_only(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost")

    def _own_page(self):
        """A command must come from GnomeShell's own window (or a tool with no
        Origin, like a newer engine asking for the port), never another site."""
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        port = self.server.server_address[1]
        return origin in (f"http://127.0.0.1:{port}", f"http://localhost:{port}")

    def do_GET(self):
        if not self._local_only():
            return self._send(403, {"error": "local only"})
        p = unquote(self.path.split("?")[0])
        if p == "/api/ping":
            STATE["last_ping"] = time.time()
            STATE["bye_at"] = None
            return self._send(200, {"ok": True, "version": APP_VERSION, "boot": BOOT, "restart_error": STATE.get("restart_error")})
        if p == "/api/status":
            return self._send(200, {"busy": STATE["busy"], "progress": STATE["progress"]})
        if p == "/api/settings":
            return self._send(200, load_settings())
        if p == "/api/recent":
            return self._send(200, recent())
        if p.startswith("/api/preview/"):
            return self._file(os.path.join(PREVIEW_DIR, os.path.basename(p)))
        if p == "/api/info":
            return self._send(200, {"out_root": OUT_ROOT, "blender": bpy.app.version_string,
                                    "version": APP_VERSION, "boot": BOOT})
        if p.startswith("/api/scan/"):
            return self._file(os.path.join(OUT_ROOT, safe_name(p.rsplit("/", 1)[1]), "scan.stl"))
        rel = "index.html" if p in ("/", "") else p.lstrip("/")
        full = os.path.normpath(os.path.join(WEB, rel))
        if not (full == WEB or full.startswith(WEB + os.sep)):
            return self._send(403, {"error": "no"})
        return self._file(full)

    def do_POST(self):
        if not self._local_only() or not self._own_page():
            return self._send(403, {"error": "local only"})
        p = self.path.split("?")[0]
        if p == "/api/bye":
            STATE["bye_at"] = time.time()
            return self._send(200, {"ok": True})
        if p == "/api/quit":  # a newer GnomeShell is starting and wants this port
            STATE["quit"] = True
            return self._send(200, {"ok": True})
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        try:
            if p == "/api/load":
                res = self._busy(job_load, body, unquote(self.headers.get("X-Filename", "scan.stl")))
                return self._send(200, res)
            data = json.loads(body or b"{}")
            if p == "/api/update_check":
                return self._send(200, update_check(bool(data.get("force"))))
            if p == "/api/update_install":
                if STATE["busy"]:
                    raise RuntimeError("Wait for GnomeShell to finish what it's doing, then update.")
                return self._send(200, update_install())
            if p == "/api/load_recent":
                return self._send(200, self._busy(job_load_recent, data["name"]))
            if p == "/api/prep":
                return self._send(200, self._busy(job_prep, data["op"], data.get("value")))
            if p == "/api/suggest":
                return self._send(200, self._busy(job_suggest, data.get("max_tilt", 30)))
            if p == "/api/base":
                return self._send(200, self._busy(job_base_preview, data))
            if p == "/api/save_model":
                res = self._busy(job_save_model)
                if data.get("open"):
                    _show_in_folder(res["path"])
                return self._send(200, res)
            if p == "/api/seam":
                return self._send(200, self._busy(job_seam_preview, data.get("cards") or []))
            if p == "/api/web_find":
                return self._send(200, self._busy(job_web_find))
            if p == "/api/web_click":
                return self._send(200, self._busy(job_web_click, data["point"], data["look"]))
            if p == "/api/web_preview":
                return self._send(200, self._busy(job_web_preview, data.get("webs") or []))
            if p == "/api/seam_suggest":
                return self._send(200, self._busy(job_seam_suggest))
            if p == "/api/seam_save":
                return self._send(200, self._busy(job_seam_save, data.get("cards") or [], bool(data.get("open"))))
            if p == "/api/spout":
                return self._send(200, self._busy(job_spout_preview, data))
            if p == "/api/split_plan":
                return self._send(200, self._busy(job_split_plan, data.get("cuts"), bool(data.get("suggest"))))
            if p == "/api/split":
                return self._send(200, self._busy(job_split, data.get("cuts") or [], bool(data.get("open"))))
            if p == "/api/show_model":
                path = os.path.join(STATE["folder"] or "", (STATE["name"] or "") + " - model.stl")
                if not os.path.isfile(path):
                    raise RuntimeError("There's no saved model for this scan yet. Press Save model STL first.")
                _show_in_folder(path)
                return self._send(200, {"path": path})
            if p == "/api/pour":
                return self._send(200, self._busy(job_pour, data.get("extend", 0), data.get("flare", 0)))
            if p == "/api/build":
                settings = load_settings()
                settings.update({k: data.get("settings", {}).get(k, v) for k, v in settings.items()})
                check_settings(settings)
                save_settings(settings)
                return self._send(200, self._busy(job_build, data["cuts"], settings, data.get("pieces"), data.get("frame"),
                                                  bool(data.get("slices_only")), data.get("insert")))
            if p == "/api/insert":
                settings = load_settings()
                settings.update({k: data.get("settings", {}).get(k, v) for k, v in settings.items()})
                return self._send(200, self._busy(job_insert_only, data["insert"], data.get("cuts") or [], settings, data.get("frame")))
            if p == "/api/autosplit":
                settings = load_settings()
                settings.update({k: data.get("settings", {}).get(k, v) for k, v in settings.items()})
                return self._send(200, self._busy(job_autosplit, data["pieces"], data["next_id"], data.get("frame"), settings))
            if p == "/api/layouts":
                return self._send(200, layouts_op(data))
            if p == "/api/settings/reset":
                save_settings(dict(DEFAULT_SETTINGS))
                return self._send(200, load_settings())
            if p == "/api/settings":
                s = load_settings()
                s.update({k: data[k] for k in DEFAULT_SETTINGS if k in data})
                save_settings(check_settings(s))
                return self._send(200, s)
            if p == "/api/open":
                folder = STATE["folder"] or OUT_ROOT
                target = os.path.join(folder, "shell.3mf") if data.get("what") == "bambu" else \
                    os.path.join(folder, "test_slices.3mf") if data.get("what") == "slices" else folder
                if hasattr(os, "startfile"):
                    os.startfile(target)  # Windows: opens with the program set for .3mf, or Explorer
                return self._send(200, {"opened": target})
        except (ValueError, RuntimeError) as e:  # a bad value, or a job that can't run now: say why
            print("  Refused:", e, flush=True)
            return self._send(400, {"error": str(e)})
        except Exception as e:  # report to the screen instead of dying
            traceback.print_exc()
            return self._send(500, {"error": str(e)})
        return self._send(404, {"error": "old_engine"})

    def _busy(self, fn, *args):
        if not BUSY_LOCK.acquire(blocking=False):
            raise RuntimeError("Still working on the last request.")
        STATE["busy"] = True
        try:
            return run_job(fn, *args)
        finally:
            STATE["busy"] = False
            BUSY_LOCK.release()


def _app_browser():
    """Edge (always on Windows 10/11) or Chrome, to show the app in its own window."""
    env = os.environ.get
    candidates = [
        os.path.join(env("ProgramFiles(x86)", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(env("ProgramFiles", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(env("ProgramFiles", ""), "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(env("ProgramFiles(x86)", ""), "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(env("LOCALAPPDATA", ""), "Google", "Chrome", "Application", "chrome.exe"),
    ]
    return next((c for c in candidates if c and os.path.isfile(c)), None)


def open_window(url):
    """Open the app in its own window: no tabs or address bar, its own
    taskbar button. Returns the window's process so we can tell when it closes."""
    if os.environ.get("MOLDSHELL_NO_BROWSER") or os.environ.get("GNOMESHELL_SPLASH"):
        return None  # GNOMESHELL_SPLASH: the shortcut already opened the window, on the loading screen
    exe = _app_browser()
    if exe:
        profile = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "GnomeShell", "window")  # its own window profile, so Edge shows the GnomeShell icon
        os.makedirs(profile, exist_ok=True)
        flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
        return subprocess.Popen([exe, f"--app={url}", f"--user-data-dir={profile}", "--start-fullscreen",
                                 "--no-first-run", "--no-default-browser-check", "--disable-features=Translate"],
                                creationflags=flags)
    webbrowser.open(url)
    return None


def _engine_at(port):
    """What a GnomeShell engine already running on this port says about itself, or None."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/info", timeout=1) as r:
            info = json.loads(r.read() or b"{}")
            return info if r.status == 200 and "out_root" in info else None
    except Exception:
        return None


def _ask_to_quit(port):
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/quit", data=b"{}", method="POST")
        urllib.request.urlopen(req, timeout=2).close()
        return True
    except Exception:
        return False  # engines before 0.4.1 can't be asked; they quit on their own once their window closes


def main():
    os.makedirs(OUT_ROOT, exist_ok=True)
    # already running? open another window onto it, but only if it's this same version.
    # An older engine left running (say, from before an update) gets asked to quit, and
    # if it can't be, this one starts on the next free port instead.
    for port in range(PORT, PORT + 10):
        info = _engine_at(port)
        if info is None:
            continue
        if info.get("version") == APP_VERSION:
            open_window(f"http://127.0.0.1:{port}/")
            os._exit(0)
        print(f"  An older GnomeShell engine ({info.get('version', 'before 0.4.1')}) is running on port {port}.", flush=True)
        if _ask_to_quit(port):
            for _ in range(40):  # it finishes any job first
                if _engine_at(port) is None:
                    break
                time.sleep(0.25)
    httpd = None
    for port in range(PORT, PORT + 10):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    if httpd is None:
        print("  No free port for GnomeShell. Close other GnomeShell windows, or end blender.exe in Task Manager.", flush=True)
        os._exit(1)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/"
    print(f"\n  GnomeShell is running at {url}\n  Files are saved in {OUT_ROOT}\n", flush=True)
    window = open_window(url)
    started = time.time()
    while True:  # Blender work happens here, on the main thread
        now = time.time()
        if window is not None and window.poll() is not None and now - started < 10:
            window = None  # handed straight to an Edge window that was already open; go by the page's pings
        closed = window is not None and window.poll() is not None
        # A long job holds up the window's check-ins, so quiet time counts from the end of the last job.
        since = lambda t: now - max(t, STATE["job_end"])  # noqa: E731
        said_bye = STATE["bye_at"] and since(STATE["bye_at"]) > 15        # page closed and no window checked in since
        gone_quiet = STATE["last_ping"] and since(STATE["last_ping"]) > 180  # no window has checked in for 3 min
        never_came = not STATE["last_ping"] and now - started > 300         # the window never opened
        if (closed or said_bye or gone_quiet or never_came or STATE["quit"]) and not STATE["busy"]:
            print("  Window closed, quitting." if not STATE["quit"] else "  A newer GnomeShell took over, quitting.", flush=True)
            shutil.rmtree(PREVIEW_DIR, ignore_errors=True)
            os._exit(0)  # closing the app window quits the engine too
        try:
            fn, args, box = JOBS.get(timeout=0.5)
        except queue.Empty:
            continue
        try:
            box["result"] = fn(*args)
        except Exception as e:
            traceback.print_exc()
            box["error"] = str(e)
            STATE["progress"] = ""
        STATE["job_end"] = time.time()
        box["done"].set()


if __name__ == "__main__":
    main()
