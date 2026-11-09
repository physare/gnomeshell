"""
Phone scans: photos from the GnomeShell Scan app turned into a 3D model.

The phone app finds this computer on the home Wi-Fi, sends the photos here,
and this module rebuilds the object from them with two free photogrammetry
programs that run on the processor (no special graphics card needed):

- COLMAP works out where each photo was taken from,
- OpenMVS turns that into a dense surface (a mesh).

Then the printed scan sheet (marker_sheet.py) sets the real size and which
way is up, the sheet and the table are cut away, and what's left is saved as
an STL in millimetres that GnomeShell opens like any other scan.

Both programs are downloaded the first time they're needed, into
%LOCALAPPDATA%\\GnomeShell\\photoscan-tools (about 150 MB).

No Blender in here: server.py starts it and talks to it, and the tests run
it on its own.
"""

import json
import os
import random
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

import marker_sheet as sheet

PHONE_PORT = int(os.environ.get("GNOMESHELL_PHONE_PORT", "8770"))  # photos come in here, over Wi-Fi
FIND_PORT = PHONE_PORT + 1                                         # the app asks "where's GnomeShell?" on this (UDP)
FIND_ASK = b"GNOMESHELL_SCAN_FIND"
TEMPLATE_PPM = 6.0       # template picture pixels per mm
MAX_PHOTO = 40 * 1024 * 1024
WIN = os.name == "nt"

COLMAP_URL = "https://github.com/colmap/colmap/releases/download/4.2.1/colmap-x64-windows-nocuda.zip"
OPENMVS_URL = "https://github.com/cdcseacave/openMVS/releases/download/v2.4.0/OpenMVS_Windows_x64.zip"
TOOLS_DIR = os.environ.get("GNOMESHELL_PHOTOSCAN_TOOLS") or os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "GnomeShell", "photoscan-tools")

DETAIL = {  # OpenMVS: how far to scale the photos down for the dense surface
    "quick": {"level": 2, "max": 1600, "label": "Quick"},
    "normal": {"level": 1, "max": 2400, "label": "Normal"},
    "fine": {"level": 0, "max": 3200, "label": "Fine (slow)"},
}

STEPS = [  # (key, what the screen says, rough share of the time)
    ("tools", "Getting the photo tools ready", 2),
    ("features", "Finding details in the photos", 10),
    ("match", "Matching the photos to each other", 14),
    ("cameras", "Working out where each photo was taken", 14),
    ("sheet", "Measuring the scan sheet", 2),
    ("undistort", "Straightening the photos", 4),
    ("dense", "Building the dense surface", 40),
    ("mesh", "Making the mesh", 10),
    ("clean", "Cutting away the sheet and table", 4),
]


class Cancelled(Exception):
    pass


# ================================================================ the scans

class Scans:
    """Every phone scan lives in a folder under `<Mold Shells>/Phone scans`,
    with photos/, a status.json and, once built, model.stl."""

    def __init__(self, root):
        self.root = os.path.join(root, "Phone scans")
        self.settings_file = os.path.join(root, "phone.json")
        os.makedirs(self.root, exist_ok=True)
        self.lock = threading.RLock()
        self.queue = []
        self.wake = threading.Event()
        self.current = None       # id being built
        self.cancel = threading.Event()
        self.proc = None
        self.worker = None
        self.settings = self._load_settings()

    # ---- settings: the pairing code and the detail level
    def _load_settings(self):
        try:
            with open(self.settings_file, encoding="utf-8") as f:
                s = json.load(f)
        except (OSError, ValueError):
            s = {}
        if not re.fullmatch(r"\d{6}", str(s.get("code", ""))):
            s["code"] = "%06d" % random.SystemRandom().randrange(10 ** 6)
        if s.get("detail") not in DETAIL:
            s["detail"] = "normal"
        s.setdefault("auto_build", True)
        self._save_settings(s)
        return s

    def _save_settings(self, s):
        tmp = self.settings_file + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(s, f, indent=1)
        os.replace(tmp, self.settings_file)

    def set(self, **kw):
        with self.lock:
            if kw.get("new_code"):
                self.settings["code"] = "%06d" % random.SystemRandom().randrange(10 ** 6)
            if kw.get("detail") in DETAIL:
                self.settings["detail"] = kw["detail"]
            if "auto_build" in kw:
                self.settings["auto_build"] = bool(kw["auto_build"])
            self._save_settings(self.settings)
            return dict(self.settings)

    # ---- folders
    def folder(self, sid):
        sid = os.path.basename(str(sid))
        if not sid or sid.startswith("."):
            raise ValueError("No such scan.")
        f = os.path.join(self.root, sid)
        if not os.path.isdir(f):
            raise ValueError("No such scan.")
        return f

    def status(self, sid):
        try:
            with open(os.path.join(self.folder(sid), "status.json"), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def put_status(self, sid, **kw):
        with self.lock:
            s = self.status(sid)
            s.update(kw)
            s["updated"] = time.strftime("%Y-%m-%d %H:%M:%S")
            path = os.path.join(self.folder(sid), "status.json")
            with open(path + ".tmp", "w", encoding="utf-8") as f:
                json.dump(s, f, indent=1)
            os.replace(path + ".tmp", path)
            return s

    def new(self, name, device=""):
        name = re.sub(r"[^\w\- ]+", "", str(name or "")).strip()[:40] or "Phone scan"
        stamp = time.strftime("%Y-%m-%d %H%M%S")
        sid = f"{name} {stamp}"
        with self.lock:
            k = 2
            while os.path.exists(os.path.join(self.root, sid)):
                sid = f"{name} {stamp} {k}"
                k += 1
            os.makedirs(os.path.join(self.root, sid, "photos"))
            self.put_status(sid, name=name, state="receiving", photos=0, device=str(device)[:60],
                            created=time.strftime("%Y-%m-%d %H:%M:%S"))
        return sid

    def add_photo(self, sid, filename, data):
        if not data.startswith(b"\xff\xd8"):
            raise ValueError("That isn't a JPEG photo.")
        fn = re.sub(r"[^\w\-.]+", "_", os.path.basename(filename or "photo.jpg"))
        if not fn.lower().endswith((".jpg", ".jpeg")):
            fn += ".jpg"
        d = os.path.join(self.folder(sid), "photos")
        with open(os.path.join(d, fn), "wb") as f:
            f.write(data)
        n = len([x for x in os.listdir(d) if x.lower().endswith((".jpg", ".jpeg"))])
        self.put_status(sid, photos=n)
        return n

    def list(self):
        out = []
        for d in sorted(os.listdir(self.root), reverse=True):
            if not os.path.isdir(os.path.join(self.root, d)):
                continue
            s = self.status(d)
            if not s:
                continue
            s["id"] = d
            s["has_model"] = os.path.isfile(os.path.join(self.root, d, "model.stl"))
            if d in self.queue:
                s["queued"] = self.queue.index(d) + 1
            out.append(s)
        out.sort(key=lambda s: s.get("created", ""), reverse=True)
        return out[:30]

    # ---- building, one at a time, on a thread of its own
    def build(self, sid):
        self.folder(sid)
        with self.lock:
            if sid == self.current or sid in self.queue:
                return
            self.queue.append(sid)
            self.put_status(sid, state="queued", message="Waiting its turn", error=None)
            if self.worker is None or not self.worker.is_alive():
                self.worker = threading.Thread(target=self._work, daemon=True)
                self.worker.start()
            self.wake.set()

    def stop(self, sid):
        with self.lock:
            if sid in self.queue:
                self.queue.remove(sid)
                self.put_status(sid, state="stopped", message="Stopped")
            elif sid == self.current:
                self.cancel.set()
                p = self.proc
                if p and p.poll() is None:
                    _kill(p)

    def busy(self):
        return self.current is not None or bool(self.queue)

    def shutdown(self):
        self.cancel.set()
        p = self.proc
        if p and p.poll() is None:
            _kill(p)

    def _work(self):
        while True:
            with self.lock:
                if not self.queue:
                    self.current = None
                    self.wake.clear()
                    return
                sid = self.queue.pop(0)
                self.current = sid
                self.cancel.clear()
            t0 = time.time()
            try:
                res = reconstruct(self.folder(sid), dict(self.settings), self._reporter(sid), self.cancel, self._set_proc)
                self.put_status(sid, state="done", step=None, percent=100, message=res["message"], result=res,
                                seconds=round(time.time() - t0))
            except Cancelled:
                self.put_status(sid, state="stopped", message="Stopped", percent=None)
            except Exception as e:  # say why on the screen; the details go in the log
                traceback.print_exc()
                self.put_status(sid, state="failed", error=str(e), message=str(e), seconds=round(time.time() - t0))
            finally:
                self.proc = None
                with self.lock:
                    self.current = None

    def _set_proc(self, p):
        self.proc = p

    def _reporter(self, sid):
        total = sum(w for _, _, w in STEPS)

        def report(step, message=None, frac=0.0):
            done = 0
            for k, _, w in STEPS:
                if k == step:
                    done += w * max(0.0, min(1.0, frac))
                    break
                done += w
            label = dict((k, t) for k, t, _ in STEPS).get(step, step)
            self.put_status(sid, state="building", step=step, percent=round(100.0 * done / total),
                            message=message or label)
            print("[phone scan]", sid, "-", message or label, flush=True)
        return report


def _kill(p):
    try:
        if WIN:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)], capture_output=True)
        else:
            p.kill()
    except Exception:
        pass


# ================================================================ the tools

def _exe(name):
    return name + ".exe" if WIN else name


def find_tool(name):
    """Where a program is: an override (GNOMESHELL_COLMAP / GNOMESHELL_OPENMVS
    folders), the downloaded tools, or the PATH."""
    exe = _exe(name)
    for env in ("GNOMESHELL_COLMAP", "GNOMESHELL_OPENMVS"):
        d = os.environ.get(env)
        if d and os.path.isfile(os.path.join(d, exe)):
            return os.path.join(d, exe)
    if os.path.isdir(TOOLS_DIR):
        for base, _dirs, files in os.walk(TOOLS_DIR):
            if exe in files:
                return os.path.join(base, exe)
    return shutil.which(exe)


def _download(url, dest, report, what):
    req = urllib.request.Request(url, headers={"User-Agent": "GnomeShell"})
    with urllib.request.urlopen(req, timeout=60) as r:
        total = int(r.headers.get("Content-Length") or 0)
        got = 0
        with open(dest, "wb") as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                if total:
                    report("tools", f"Downloading {what}: {got // (1 << 20)} of {total // (1 << 20)} MB", got / total)


def ensure_tools(report, cancel):
    """COLMAP and OpenMVS, downloaded once."""
    need = []
    if not find_tool("colmap"):
        need.append(("COLMAP", COLMAP_URL, "colmap"))
    if not find_tool("DensifyPointCloud"):
        need.append(("OpenMVS", OPENMVS_URL, "openmvs"))
    for what, url, sub in need:
        if not WIN:
            raise RuntimeError(f"{what} isn't installed. Put it on the PATH (or set GNOMESHELL_COLMAP / GNOMESHELL_OPENMVS).")
        report("tools", f"Downloading {what} (first scan only)")
        os.makedirs(TOOLS_DIR, exist_ok=True)
        tmp = os.path.join(TOOLS_DIR, sub + ".zip.part")
        try:
            _download(url, tmp, report, what)
        except Exception as e:
            raise RuntimeError(f"Couldn't download {what} ({e}). Check the internet connection and press Build again.")
        if cancel.is_set():
            raise Cancelled()
        report("tools", f"Unpacking {what}")
        dest = os.path.join(TOOLS_DIR, sub)
        shutil.rmtree(dest, ignore_errors=True)
        with zipfile.ZipFile(tmp) as z:
            z.extractall(dest)
        os.remove(tmp)
    missing = [n for n in ("colmap", "InterfaceCOLMAP", "DensifyPointCloud", "ReconstructMesh") if not find_tool(n)]
    if missing:
        raise RuntimeError("The photo tools are missing " + ", ".join(missing) + ". Delete the folder " + TOOLS_DIR +
                           " and press Build again to download them fresh.")


_HELP = {}


def colmap_has(cmd, option):
    """Option names moved between COLMAP versions (SiftExtraction.use_gpu became
    FeatureExtraction.use_gpu, say), so ask this copy what it takes."""
    if cmd not in _HELP:
        try:
            r = subprocess.run([find_tool("colmap"), cmd, "-h"], capture_output=True, text=True, timeout=60,
                               creationflags=0x08000000 if WIN else 0)
            _HELP[cmd] = r.stdout + r.stderr
        except Exception:
            _HELP[cmd] = ""
    return ("--" + option) in _HELP[cmd]


def colmap_opt(cmd, names, value):
    for n in names:
        if colmap_has(cmd, n):
            return ["--" + n, str(value)]
    return []


def run(args, log, cancel, set_proc, cwd=None, on_line=None):
    """Run one program, its output going to the scan's log; stop it if asked."""
    log.write("\n$ " + " ".join(f'"{a}"' if " " in str(a) else str(a) for a in args) + "\n")
    log.flush()
    env = dict(os.environ)
    if WIN:  # COLMAP and OpenMVS want their own DLL folders on the PATH
        env["PATH"] = os.pathsep.join({os.path.dirname(args[0]), os.path.join(os.path.dirname(os.path.dirname(args[0])), "lib")}) + os.pathsep + env.get("PATH", "")
    env.setdefault("QT_QPA_PLATFORM", "offscreen")
    p = subprocess.Popen([str(a) for a in args], cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         stdin=subprocess.DEVNULL, env=env, creationflags=0x08000000 if WIN else 0)
    set_proc(p)
    tail = []
    buf = b""
    while True:  # OpenMVS rewrites its progress line with \r, so split on both
        chunk = p.stdout.read1(65536) if hasattr(p.stdout, "read1") else p.stdout.readline()
        if not chunk:
            break
        parts = re.split(rb"[\r\n]", buf + chunk)
        buf = parts.pop()
        for raw in parts:
            line = raw.decode("utf-8", "replace").rstrip()
            if not line:
                continue
            log.write(line + "\n")
            tail = (tail + [line])[-25:]
            if on_line:
                try:
                    on_line(line)
                except Exception:
                    pass
        if cancel.is_set():
            _kill(p)
            break
    if buf.strip():
        log.write(buf.decode("utf-8", "replace") + "\n")
    p.wait()
    log.flush()
    set_proc(None)
    if cancel.is_set():
        raise Cancelled()
    if p.returncode != 0:
        name = os.path.splitext(os.path.basename(str(args[0])))[0]
        hint = next((t for t in reversed(tail) if t.strip()), "")
        raise RuntimeError(f"{name} {args[1] if name == 'colmap' else ''} stopped with an error: {hint[:200]}".replace("  ", " "))


# ================================================================ the pipeline

def reconstruct(folder, settings, report, cancel, set_proc=lambda p: None):
    photos = sorted(f for f in os.listdir(os.path.join(folder, "photos")) if f.lower().endswith((".jpg", ".jpeg")))
    if len(photos) < 12:
        raise RuntimeError(f"Only {len(photos)} photos came through. Take at least 30, all the way round, and send them again.")
    work = os.path.join(folder, "work")
    shutil.rmtree(work, ignore_errors=True)
    images = os.path.join(work, "images")
    os.makedirs(os.path.join(images, "sheet"))
    os.makedirs(os.path.join(images, "photos"))
    log = open(os.path.join(folder, "log.txt"), "a", encoding="utf-8")
    log.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')}  {len(photos)} photos\n")
    try:
        return _reconstruct(folder, work, images, photos, settings, report, cancel, set_proc, log)
    finally:
        log.close()


def _reconstruct(folder, work, images, photos, settings, report, cancel, set_proc, log):
    detail = DETAIL.get(settings.get("detail"), DETAIL["normal"])
    report("tools")
    ensure_tools(report, cancel)
    colmap = find_tool("colmap")

    # the photos (hard links where the disk allows, so nothing is copied) and the sheet's picture
    for p in photos:
        src, dst = os.path.join(folder, "photos", p), os.path.join(images, "photos", p)
        try:
            os.link(src, dst)
        except OSError:
            shutil.copyfile(src, dst)
    sheet.write_png(os.path.join(images, "sheet", "sheet.png"), sheet.template(TEMPLATE_PPM))
    with open(os.path.join(work, "photos.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join("photos/" + p for p in photos) + "\n")
    db = os.path.join(work, "database.db")

    def counter(step, pat, total):
        def on(line):
            m = re.search(pat, line)
            if m:
                report(step, None, int(m.group(1)) / max(1, total))
        return on

    report("features")
    run([colmap, "feature_extractor", "--database_path", db, "--image_path", images,
         "--ImageReader.single_camera_per_folder", "1", "--ImageReader.camera_model", "SIMPLE_RADIAL"]
        + colmap_opt("feature_extractor", ["FeatureExtraction.use_gpu", "SiftExtraction.use_gpu"], 0)
        + colmap_opt("feature_extractor", ["FeatureExtraction.max_image_size", "SiftExtraction.max_image_size"], 2000)
        + colmap_opt("feature_extractor", ["SiftExtraction.max_num_features"], 8192),
        log, cancel, set_proc, on_line=counter("features", r"Processed file \[(\d+)/", len(photos) + 1))

    def match_progress(line):  # "Matching block [2/3, 1/3]"
        m = re.search(r"Matching block \[(\d+)/(\d+), (\d+)/(\d+)\]", line)
        if m:
            a, n, b, k = (int(x) for x in m.groups())
            report("match", None, ((a - 1) * k + b) / max(1, n * k))

    report("match")
    run([colmap, "exhaustive_matcher", "--database_path", db]
        + colmap_opt("exhaustive_matcher", ["FeatureMatching.use_gpu", "SiftMatching.use_gpu"], 0),
        log, cancel, set_proc, on_line=match_progress)

    report("cameras")
    sparse = os.path.join(work, "sparse")
    os.makedirs(sparse)
    run([colmap, "mapper", "--database_path", db, "--image_path", images, "--output_path", sparse]
        + (["--image_list_path", os.path.join(work, "photos.txt")] if colmap_has("mapper", "image_list_path") else []),
        log, cancel, set_proc, on_line=counter("cameras", r"Registering image #\d+ \((\d+)\)", len(photos)))
    models = [os.path.join(sparse, d) for d in os.listdir(sparse) if os.path.isdir(os.path.join(sparse, d))]
    if not models:
        raise RuntimeError("The photos couldn't be pieced together. Take them closer together (a small step "
                           "between each), keep the object and sheet sharp and filling most of the picture, and try again.")
    best, best_n, model_txt = None, -1, None
    for m in models:
        txt = m + "_txt"
        os.makedirs(txt, exist_ok=True)
        run([colmap, "model_converter", "--input_path", m, "--output_path", txt, "--output_type", "TXT"],
            log, cancel, set_proc)
        n = sum(1 for im in read_images_txt(os.path.join(txt, "images.txt")).values() if im["name"].startswith("photos/"))
        if n > best_n:
            best, best_n, model_txt = m, n, txt
    used = best_n
    log.write(f"model {best}: {used} of {len(photos)} photos placed\n")
    if used < max(8, len(photos) // 3):
        raise RuntimeError(f"Only {used} of the {len(photos)} photos could be placed. Take them closer together, "
                           "with the whole sheet in view, and try again.")

    report("sheet")
    try:
        frame = sheet_frame(db, model_txt, log)
    except Exception as e:
        traceback.print_exc(file=log)
        frame = {"ok": False, "why": str(e)}
    log.write("sheet: " + json.dumps({k: v for k, v in frame.items() if k != "M"}) + "\n")

    report("undistort")
    dense = os.path.join(work, "dense")
    run([colmap, "image_undistorter", "--image_path", images, "--input_path", best, "--output_path", dense,
         "--output_type", "COLMAP", "--max_image_size", str(detail["max"])], log, cancel, set_proc)

    report("dense")
    mvs = os.path.join(dense, "scene.mvs")
    run([find_tool("InterfaceCOLMAP"), "-i", dense, "-o", mvs, "--image-folder", os.path.join(dense, "images"),
         "-w", dense], log, cancel, set_proc, cwd=dense)

    def dense_progress(line):  # "Estimated depth-maps 4 (6.67%, ...", then the geometric pass, then fusing
        m = re.search(r"\((\d+(?:\.\d+)?)%", line)
        if not m:
            return
        pct = float(m.group(1)) / 100
        if line.startswith("Geometric"):
            report("dense", "Building the dense surface (checking it)", 0.6 + 0.3 * pct)
        elif line.startswith("Estimated depth"):
            report("dense", "Building the dense surface (depth from each photo)", 0.6 * pct)
        elif "use" in line.lower() or "fus" in line.lower():
            report("dense", "Building the dense surface (joining it up)", 0.9 + 0.1 * pct)
    run([find_tool("DensifyPointCloud"), mvs, "-w", dense, "--resolution-level", str(detail["level"]),
         "--max-resolution", str(detail["max"]), "-o", os.path.join(dense, "scene_dense.mvs")],
        log, cancel, set_proc, cwd=dense, on_line=dense_progress)

    report("mesh")
    mesh_ply = os.path.join(dense, "mesh.ply")
    run([find_tool("ReconstructMesh"), os.path.join(dense, "scene_dense.mvs"), "-w", dense, "-o", mesh_ply],
        log, cancel, set_proc, cwd=dense)
    if not os.path.isfile(mesh_ply):
        cands = [os.path.join(dense, f) for f in os.listdir(dense) if f.endswith(".ply") and "mesh" in f]
        if not cands:
            raise RuntimeError("OpenMVS didn't make a mesh. The log has the details.")
        mesh_ply = max(cands, key=os.path.getmtime)

    report("clean")
    co, tris = read_ply(mesh_ply)
    res = clean_mesh(co, tris, frame)
    out = os.path.join(folder, "model.stl")
    write_stl(out + ".tmp", res["co"], res["tris"])
    os.replace(out + ".tmp", out)
    res.pop("co")
    res.pop("tris")
    res["photos"] = len(photos)
    res["placed"] = used
    res["detail"] = settings.get("detail")
    res["sheet"] = {k: v for k, v in frame.items() if k != "M"}
    dims = " × ".join(f"{d:.0f}" for d in res["dims"])
    if frame.get("ok"):
        res["message"] = f"Ready: {dims} mm, {used} of {len(photos)} photos used"
    else:
        res["message"] = (f"Ready, but the scan sheet wasn't found, so the size is a guess ({dims} mm). "
                          "Set the real size in GnomeShell's Scan tab.")
    if not os.environ.get("GNOMESHELL_KEEP_WORK"):
        shutil.rmtree(os.path.join(work, "dense", "images"), ignore_errors=True)  # the big part; the rest helps if asked
    return res


# ================================================================ COLMAP's files

def read_images_txt(path):
    """images.txt: {image_id: {name, points2D: (N, 3) array of x, y, point3D_id}}."""
    out = {}
    with open(path, encoding="utf-8") as f:
        lines = [ln for ln in f.read().splitlines() if ln and not ln.startswith("#")]
    for i in range(0, len(lines) - 1, 2):
        h = lines[i].split()
        iid, name = int(h[0]), " ".join(h[9:])
        vals = lines[i + 1].split()
        pts = np.array(vals, float).reshape(-1, 3) if vals else np.zeros((0, 3))
        out[iid] = {"name": name.replace("\\", "/"), "points2D": pts,
                    "q": np.array(h[1:5], float), "t": np.array(h[5:8], float)}
    return out


def read_points3D_txt(path):
    ids, xyz = [], []
    with open(path, encoding="utf-8") as f:
        for ln in f:
            if ln.startswith("#") or not ln.strip():
                continue
            v = ln.split()
            ids.append(int(v[0]))
            xyz.append([float(v[1]), float(v[2]), float(v[3])])
    return dict(zip(ids, np.array(xyz).reshape(-1, 3)))


def _qmat(q):
    w, x, y, z = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
                     [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
                     [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]])


def _blob(b, dtype, cols):
    a = np.frombuffer(b, dtype)
    return a.reshape(-1, cols) if a.size else np.zeros((0, cols), dtype)


def sheet_frame(db_path, model_txt, log=None):
    """Find the printed sheet in the reconstruction. Every detail matched between
    the sheet's picture and a photo, that's also a 3D point, gives a 3D point
    with a known spot on the paper. The similarity (scale, turn, shift) that
    best puts those points on the paper is the sheet's frame: millimetres, z up."""
    con = sqlite3.connect(db_path)
    try:
        rows = con.execute("SELECT image_id, name FROM images").fetchall()
        tid = next((i for i, n in rows if n.replace("\\", "/").startswith("sheet/")), None)
        if tid is None:
            return {"ok": False, "why": "no sheet picture"}
        kr = con.execute("SELECT rows, cols, data FROM keypoints WHERE image_id=?", (tid,)).fetchone()
        tkp = _blob(kr[2], np.float32, kr[1])[:, :2] if kr and kr[2] else np.zeros((0, 2))
        images = read_images_txt(os.path.join(model_txt, "images.txt"))
        pts3d = read_points3D_txt(os.path.join(model_txt, "points3D.txt"))
        src, dst, seen = [], [], 0
        for iid, im in images.items():
            if iid == tid or not im["name"].startswith("photos/"):
                continue
            a, b = min(iid, tid), max(iid, tid)
            pair_id = a * 2147483647 + b
            r = con.execute("SELECT rows, cols, data FROM two_view_geometries WHERE pair_id=?", (pair_id,)).fetchone()
            if not r or not r[0] or not r[2]:
                continue
            m = _blob(r[2], np.uint32, r[1] or 2)
            ti, pi = (m[:, 0], m[:, 1]) if tid == a else (m[:, 1], m[:, 0])
            P = im["points2D"]
            ok = (pi < len(P)) & (ti < len(tkp))
            ti, pi = ti[ok], pi[ok]
            pid = P[pi, 2].astype(np.int64)
            has = pid >= 0
            if has.sum() >= 4:
                seen += 1
            for t_, p_ in zip(ti[has], pid[has]):
                if p_ in pts3d:
                    src.append(pts3d[p_])
                    dst.append(sheet.template_xy(tkp[t_, 0], tkp[t_, 1], TEMPLATE_PPM))
        cams = []
        for im in images.values():
            if im["name"].startswith("photos/"):
                R = _qmat(im["q"])
                cams.append(-R.T @ im["t"])
    finally:
        con.close()
    if log:
        log.write(f"sheet: {len(src)} matched points from {seen} photos\n")
    if len(src) < 12:
        return {"ok": False, "why": f"only {len(src)} sheet points", "photos": seen}
    src = np.array(src, float)
    dst = np.column_stack([np.array(dst, float), np.zeros(len(dst))])
    M, inl, rms = ransac_similarity(src, dst, thresh_mm=2.5)
    if M is None or inl.sum() < 10:
        return {"ok": False, "why": "the sheet points didn't agree", "photos": seen, "points": len(src)}
    cams = np.array(cams)
    cz = (cams @ M[:3, :3].T + M[:3, 3])[:, 2]
    if np.median(cz) < 0:  # the cameras should look down on the sheet
        return {"ok": False, "why": "sheet seen from underneath", "photos": seen}
    return {"ok": True, "M": M, "points": int(inl.sum()), "of": len(src), "rms_mm": round(float(rms), 2),
            "photos": seen, "scale": round(float(np.cbrt(abs(np.linalg.det(M[:3, :3])))), 5)}


def umeyama(src, dst):
    """Similarity (s, R, t) with dst ≈ s R src + t, as a 4x4 matrix."""
    mu_s, mu_d = src.mean(0), dst.mean(0)
    xs, xd = src - mu_s, dst - mu_d
    C = xd.T @ xs / len(src)
    U, S, Vt = np.linalg.svd(C)
    D = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        D[2, 2] = -1
    R = U @ D @ Vt
    var = (xs ** 2).sum() / len(src)
    s = np.trace(np.diag(S) @ D) / var if var > 0 else 1.0
    M = np.eye(4)
    M[:3, :3] = s * R
    M[:3, 3] = mu_d - s * R @ mu_s
    return M


def ransac_similarity(src, dst, thresh_mm=2.5, iters=1500, seed=1):
    rng = np.random.default_rng(seed)
    n = len(src)
    best_inl, best_M = None, None
    for _ in range(iters):
        idx = rng.choice(n, 3, replace=False)
        d = dst[idx]
        if np.linalg.norm(np.cross(d[1] - d[0], d[2] - d[0])) < 25.0:  # nearly in a line on the paper
            continue
        M = umeyama(src[idx], d)
        err = np.linalg.norm(src @ M[:3, :3].T + M[:3, 3] - dst, axis=1)
        inl = err < thresh_mm
        if best_inl is None or inl.sum() > best_inl.sum():
            best_inl, best_M = inl, M
    if best_inl is None or best_inl.sum() < 4:
        return None, np.zeros(n, bool), 0
    for _ in range(3):  # refine on the inliers
        M = umeyama(src[best_inl], dst[best_inl])
        err = np.linalg.norm(src @ M[:3, :3].T + M[:3, 3] - dst, axis=1)
        inl = err < thresh_mm
        if inl.sum() < best_inl.sum():
            break
        best_inl, best_M = inl, M
    err = np.linalg.norm(src @ best_M[:3, :3].T + best_M[:3, 3] - dst, axis=1)
    return best_M, best_inl, float(np.sqrt((err[best_inl] ** 2).mean()))


# ================================================================ mesh files

_PLY_T = {"char": "i1", "int8": "i1", "uchar": "u1", "uint8": "u1", "short": "i2", "int16": "i2",
          "ushort": "u2", "uint16": "u2", "int": "i4", "int32": "i4", "uint": "u4", "uint32": "u4",
          "float": "f4", "float32": "f4", "double": "f8", "float64": "f8"}


def read_ply(path):
    """Vertices and triangles from a PLY (binary or text), as OpenMVS writes it."""
    with open(path, "rb") as f:
        data = f.read()
    end = data.index(b"end_header") + len(b"end_header")
    while data[end:end + 1] in (b"\r", b"\n"):
        end += 1
        if data[end - 1:end] == b"\n":
            break
    header = data[:end].decode("latin-1").splitlines()
    fmt = next(h.split()[1] for h in header if h.startswith("format"))
    elems, cur = [], None
    for h in header:
        p = h.split()
        if not p:
            continue
        if p[0] == "element":
            cur = {"name": p[1], "n": int(p[2]), "props": []}
            elems.append(cur)
        elif p[0] == "property" and cur is not None:
            if p[1] == "list":
                cur["props"].append(("list", p[2], p[3], p[4]))
            else:
                cur["props"].append((p[1], p[2]))
    body = data[end:]
    co, tris = None, None
    if fmt == "ascii":
        lines = iter(body.decode("latin-1").split("\n"))
        for e in elems:
            rows = [next(lines).split() for _ in range(e["n"])]
            if e["name"] == "vertex":
                names = [p[1] for p in e["props"]]
                a = np.array([[float(r[names.index(k)]) for k in ("x", "y", "z")] for r in rows])
                co = a
            elif e["name"] == "face":
                faces = [list(map(int, r[1:1 + int(r[0])])) for r in rows]
                tris = _triangulate(faces)
        return co, tris
    bo = "<" if fmt == "binary_little_endian" else ">"
    off = 0
    for e in elems:
        if all(p[0] != "list" for p in e["props"]):
            dt = np.dtype([(p[1], bo + _PLY_T[p[0]]) for p in e["props"]])
            arr = np.frombuffer(body, dt, count=e["n"], offset=off)
            off += dt.itemsize * e["n"]
            if e["name"] == "vertex":
                co = np.column_stack([arr["x"], arr["y"], arr["z"]]).astype(np.float64)
        else:
            # faces: try the fast way (every face a triangle), else walk them
            props = e["props"]
            if len(props) == 1 and e["name"] == "face":
                _, ct, it, _n = props[0]
                cdt, idt = np.dtype(bo + _PLY_T[ct]), np.dtype(bo + _PLY_T[it])
                rec = np.dtype([("n", cdt), ("v", idt, (3,))])
                if e["n"] and off + rec.itemsize * e["n"] <= len(body):
                    arr = np.frombuffer(body, rec, count=e["n"], offset=off)
                    if (arr["n"] == 3).all():
                        tris = arr["v"].astype(np.int64)
                        off += rec.itemsize * e["n"]
                        continue
            faces = []
            for _ in range(e["n"]):
                face = None
                for p in props:
                    if p[0] == "list":
                        cdt, idt = np.dtype(bo + _PLY_T[p[1]]), np.dtype(bo + _PLY_T[p[2]])
                        k = int(np.frombuffer(body, cdt, 1, off)[0])
                        off += cdt.itemsize
                        v = np.frombuffer(body, idt, k, off)
                        off += idt.itemsize * k
                        if face is None:
                            face = v.tolist()
                    else:
                        off += np.dtype(_PLY_T[p[0]]).itemsize
                faces.append(face)
            if e["name"] == "face":
                tris = _triangulate(faces)
    if co is None or tris is None:
        raise RuntimeError("The mesh file has no faces in it.")
    return co, tris


def _triangulate(faces):
    out = []
    for f in faces:
        for k in range(1, len(f) - 1):
            out.append((f[0], f[k], f[k + 1]))
    return np.array(out, np.int64).reshape(-1, 3)


def write_stl(path, co, tris):
    co = np.asarray(co, np.float32)
    t = np.asarray(tris)
    a, b, c = co[t[:, 0]], co[t[:, 1]], co[t[:, 2]]
    n = np.cross(b - a, c - a)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    n = np.divide(n, ln, out=np.zeros_like(n), where=ln > 0)
    rec = np.zeros(len(t), np.dtype([("n", "<f4", 3), ("a", "<f4", 3), ("b", "<f4", 3), ("c", "<f4", 3), ("x", "<u2")]))
    rec["n"], rec["a"], rec["b"], rec["c"] = n, a, b, c
    with open(path, "wb") as f:
        f.write(b"GnomeShell phone scan".ljust(80, b" "))
        f.write(np.uint32(len(t)).tobytes())
        f.write(rec.tobytes())


def components(n_verts, tris):
    """Which connected piece each triangle belongs to (piece ids per triangle)."""
    lab = np.arange(n_verts)
    e = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    for _ in range(200):
        m = np.minimum(lab[e[:, 0]], lab[e[:, 1]])
        new = lab.copy()
        np.minimum.at(new, e[:, 0], m)
        np.minimum.at(new, e[:, 1], m)
        new = new[new]
        new = new[new]
        if np.array_equal(new, lab):
            break
        lab = new
    return lab[tris[:, 0]]


def clean_mesh(co, tris, frame, floor_mm=1.0):
    """Put the mesh on the sheet in mm, z up; cut off the sheet and table; keep
    the object (the biggest piece, and any piece nearly as big)."""
    co = np.asarray(co, float)
    tris = np.asarray(tris, np.int64)
    scaled = bool(frame.get("ok"))
    if scaled:
        M = frame["M"]
        co = co @ M[:3, :3].T + M[:3, 3]
        keep = (co[tris][:, :, 2] > floor_mm).all(axis=1)
        tris = tris[keep]
    if not len(tris):
        raise RuntimeError("Nothing was left above the scan sheet. Stand the object on the sheet and scan again.")
    comp = components(len(co), tris)
    ids, counts = np.unique(comp, return_counts=True)
    order = np.argsort(-counts)
    big = counts[order[0]]
    keep_ids = ids[order[counts[order] >= max(200, 0.3 * big)]]
    if scaled:  # among big pieces, the one standing nearest the middle of the sheet wins
        def dist(i):
            v = co[np.unique(tris[comp == i])]
            return np.hypot(*v[:, :2].mean(0))
        main = min(keep_ids, key=dist)
        keep_ids = [i for i in keep_ids if i == main or dist(i) < 150]
    tris = tris[np.isin(comp, keep_ids)]
    used = np.unique(tris)
    remap = np.full(len(co), -1, np.int64)
    remap[used] = np.arange(len(used))
    co, tris = co[used], remap[tris]
    if not scaled:  # no sheet: stand it on its lowest point and make it 200 mm tall-ish so it can be resized
        co = co - co.mean(0)
        _u, _s, vt = np.linalg.svd(co[np.random.default_rng(0).choice(len(co), min(len(co), 20000), replace=False)], full_matrices=False)
        co = co @ vt.T
        co *= 200.0 / max(1e-9, np.ptp(co, axis=0).max())
        co[:, 2] -= co[:, 2].min()
    dims = np.ptp(co, axis=0)
    return {"co": co, "tris": tris, "dims": [round(float(d), 1) for d in dims], "triangles": int(len(tris)),
            "scaled": scaled}


# ================================================================ the phone link (Wi-Fi)

def lan_addresses():
    out = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        out.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for a in socket.gethostbyname_ex(socket.gethostname())[2]:
            if a not in out and not a.startswith("127."):
                out.append(a)
    except OSError:
        pass
    return out


_GUESSES = []  # times of wrong codes in the last 10 minutes
_GUESSES_LOCK = threading.Lock()


def make_phone_handler(scans, app_version):
    class PhoneHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _send(self, code, body):
            b = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def _paired(self):
            """The right code, and not too many wrong guesses lately (it's only 6 digits)."""
            now = time.time()
            with _GUESSES_LOCK:
                _GUESSES[:] = [t for t in _GUESSES if now - t < 600]
                if len(_GUESSES) >= 30:
                    return False
                ok = self.headers.get("X-GnomeShell-Code", "") == scans.settings["code"]
                if not ok and self.headers.get("X-GnomeShell-Code"):
                    _GUESSES.append(now)
                return ok

        def _body(self, limit):
            n = int(self.headers.get("Content-Length") or 0)
            if n > limit:
                raise ValueError("Too big.")
            return self.rfile.read(n) if n else b""

        def do_GET(self):
            p = self.path.split("?")[0].rstrip("/")
            if p == "/phone/hello":
                return self._send(200, {"app": "GnomeShell", "name": socket.gethostname(), "version": app_version,
                                        "paired": self._paired()})
            if not self._paired():
                return self._send(403, {"error": "Wrong code. Type the code shown in GnomeShell under Phone scans."})
            m = re.fullmatch(r"/phone/scans/([^/]+)", p)
            if m:
                from urllib.parse import unquote
                try:
                    s = scans.status(unquote(m.group(1)))
                except ValueError as e:
                    return self._send(404, {"error": str(e)})
                return self._send(200, {k: s.get(k) for k in ("name", "state", "percent", "message", "photos", "error")})
            return self._send(404, {"error": "not found"})

        def do_POST(self):
            self._write("POST")

        def do_PUT(self):
            self._write("PUT")

        def _write(self, how):
            from urllib.parse import unquote
            p = self.path.split("?")[0].rstrip("/")
            if not self._paired():
                self._body(MAX_PHOTO)
                return self._send(403, {"error": "Wrong code. Type the code shown in GnomeShell under Phone scans."})
            try:
                if how == "POST" and p == "/phone/scans":
                    d = json.loads(self._body(10000) or b"{}")
                    return self._send(200, {"id": scans.new(d.get("name"), d.get("device", ""))})
                m = re.fullmatch(r"/phone/scans/([^/]+)/photos/([^/]+)", p)
                if m and how == "PUT":
                    n = scans.add_photo(unquote(m.group(1)), unquote(m.group(2)), self._body(MAX_PHOTO))
                    return self._send(200, {"photos": n})
                m = re.fullmatch(r"/phone/scans/([^/]+)/done", p)
                if m and how == "POST":
                    sid = unquote(m.group(1))
                    d = json.loads(self._body(10000) or b"{}")
                    s = scans.put_status(sid, state="received", message="All photos here", sent=d.get("count"),
                                         capture=d.get("capture"))
                    if scans.settings.get("auto_build", True) and not d.get("hold"):
                        scans.build(sid)
                        s = scans.status(sid)
                    return self._send(200, {k: s.get(k) for k in ("state", "message", "photos")})
                return self._send(404, {"error": "not found"})
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                traceback.print_exc()
                return self._send(500, {"error": str(e)})
    return PhoneHandler


def _finder(stop):
    """Answer the phone app's "where's GnomeShell?" broadcast with our port."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("", FIND_PORT))
        s.settimeout(1.0)
    except OSError as e:
        print("  Phone scans: can't listen for the phone app on UDP", FIND_PORT, e, flush=True)
        return
    while not stop.is_set():
        try:
            data, addr = s.recvfrom(256)
        except socket.timeout:
            continue
        except OSError:
            continue
        if data.strip() == FIND_ASK:
            reply = json.dumps({"app": "GnomeShell", "port": PHONE_PORT, "name": socket.gethostname()}).encode()
            try:
                s.sendto(reply, addr)
            except OSError:
                pass


class PhoneLink:
    def __init__(self, scans, app_version):
        self.scans = scans
        self.stop = threading.Event()
        self.httpd = None
        self.error = None
        try:
            self.httpd = ThreadingHTTPServer(("0.0.0.0", PHONE_PORT), make_phone_handler(scans, app_version))
            self.httpd.daemon_threads = True
        except OSError as e:
            self.error = f"Port {PHONE_PORT} is in use, so the phone app can't send photos ({e})."
            print("  Phone scans:", self.error, flush=True)
            return
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        threading.Thread(target=_finder, args=(self.stop,), daemon=True).start()

    def info(self):
        return {"port": PHONE_PORT, "addresses": lan_addresses(), "code": self.scans.settings["code"],
                "detail": self.scans.settings["detail"], "auto_build": self.scans.settings.get("auto_build", True),
                "details": {k: v["label"] for k, v in DETAIL.items()}, "error": self.error,
                "name": socket.gethostname()}

    def close(self):
        self.stop.set()
        self.scans.shutdown()
        if self.httpd:
            self.httpd.shutdown()


if __name__ == "__main__":  # rebuild one scan folder from the command line: python photoscan.py <folder> [detail]
    folder = sys.argv[1]
    t0 = time.time()

    def rep(step, msg=None, frac=0.0):
        print(f"[{time.time() - t0:6.0f}s] {step}: {msg or ''} {'' if not frac else f'{frac:.0%}'}", flush=True)
    r = reconstruct(folder, {"detail": sys.argv[2] if len(sys.argv) > 2 else "normal"}, rep, threading.Event())
    print(json.dumps(r, indent=1))
