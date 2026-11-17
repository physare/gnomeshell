"""
Slicing with Bambu Studio's own slicer, in the background.

GnomeShell hands Bambu Studio a plain 3MF and gets back a plate sliced file
(the same as "Export plate sliced file"), using Bambu Studio's own printer,
process and filament profiles. That keeps each printer's own start code (bed
levelling, purge line, nozzle moves): GnomeShell never writes G-code itself.

The profiles ship with Bambu Studio (resources/profiles/BBL). Each one names
the profile it builds on ("inherits"), so this resolves that chain itself and
hands the command line complete profiles, with only the layer height changed.

Nothing here needs Blender, so it can be tested on its own.
"""

import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

CANDIDATES = [
    r"C:\Program Files\Bambu Studio\bambu-studio.exe",
    r"C:\Program Files (x86)\Bambu Studio\bambu-studio.exe",
    os.path.expanduser(r"~\AppData\Local\Programs\Bambu Studio\bambu-studio.exe"),
    "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio",
    "/usr/bin/bambu-studio",
]


class SliceError(RuntimeError):
    pass


def find_studio(path=""):
    """bambu-studio.exe: the one named in Settings, or where it installs."""
    path = (path or "").strip().strip('"')
    if path:
        if os.path.isdir(path):
            path = os.path.join(path, "bambu-studio.exe")
        if os.path.isfile(path):
            return path
        raise SliceError(f"Bambu Studio isn't at {path}. Fix the path under Settings, Printing, or leave it empty to find it.")
    for c in CANDIDATES:
        if os.path.isfile(c):
            return c
    raise SliceError("Couldn't find Bambu Studio on this computer. Install it, or put where bambu-studio.exe is "
                     "under Settings, Printing.")


def profiles_dir(studio):
    """resources/profiles/BBL next to the program (or inside the Mac app)."""
    here = os.path.dirname(studio)
    for d in (os.path.join(here, "resources", "profiles", "BBL"),
              os.path.join(here, "..", "Resources", "profiles", "BBL")):
        if os.path.isfile(os.path.join(d, "..", "BBL.json")) or os.path.isdir(d):
            return os.path.normpath(d)
    raise SliceError("Bambu Studio's printer profiles aren't where they should be. Reinstalling Bambu Studio fixes that.")


def _norm(model):
    """'Bambu Lab A2L', 'bambu lab a2l' and 'A2L' are one model; 'A1 mini' is not an A1."""
    m = re.sub(r"^bambu\s*lab\s*", "", str(model or "").strip(), flags=re.I)
    return re.sub(r"[^a-z0-9]+", "", m.lower())


class Profiles:
    """Bambu Studio's system profiles, by name, with inheritance resolved."""

    def __init__(self, bbl_dir):
        self.dir = bbl_dir
        self.index = {"machine": {}, "process": {}, "filament": {}}
        top = os.path.join(bbl_dir, "..", "BBL.json")
        listed = False
        if os.path.isfile(top):
            with open(top, encoding="utf-8") as f:
                data = json.load(f)
            for kind in self.index:
                for row in data.get(f"{kind}_list", []):
                    if row.get("name") and row.get("sub_path"):
                        self.index[kind][row["name"]] = os.path.normpath(os.path.join(bbl_dir, row["sub_path"]))
                        listed = True
        if not listed:  # no index: read every file
            for kind in self.index:
                for p in glob.glob(os.path.join(bbl_dir, kind, "*.json")):
                    try:
                        with open(p, encoding="utf-8") as f:
                            name = json.load(f).get("name")
                    except (OSError, ValueError):
                        continue
                    if name:
                        self.index[kind][name] = p
        self._cache = {}

    def raw(self, kind, name):
        p = self.index[kind].get(name)
        if not p or not os.path.isfile(p):
            raise SliceError(f"Bambu Studio has no {kind} profile called \"{name}\".")
        with open(p, encoding="utf-8") as f:
            return json.load(f)

    def full(self, kind, name, _depth=0):
        """The profile with everything it inherits filled in."""
        key = (kind, name)
        if key in self._cache:
            return dict(self._cache[key])
        if _depth > 20:
            raise SliceError(f"Bambu Studio's {kind} profile \"{name}\" inherits from itself.")
        me = self.raw(kind, name)
        parent = me.get("inherits")
        out = self.full(kind, parent, _depth + 1) if parent else {}
        out.update(me)
        out.pop("inherits", None)
        self._cache[key] = dict(out)
        return out

    def usable(self, kind):
        """The profiles a person can pick (not the hidden base ones)."""
        out = []
        for name in self.index[kind]:
            try:
                p = self.full(kind, name)
            except (SliceError, OSError, ValueError):
                continue
            if str(p.get("instantiation", "true")).lower() == "true":
                out.append(p)
        return out

    def machine(self, model, nozzle="0.4"):
        """The printer profile for a printer model with this nozzle."""
        want = _norm(model)
        for p in self.usable("machine"):
            noz = p.get("nozzle_diameter") or [""]
            noz = noz[0] if isinstance(noz, list) else noz
            if _norm(p.get("printer_model")) == want and str(noz).rstrip("0").rstrip(".") == nozzle.rstrip("0").rstrip("."):
                return p
        raise SliceError(f"Bambu Studio has no profile for a {model} with a {nozzle} mm nozzle. "
                         "Update Bambu Studio, then try again.")

    def process(self, machine_name, layer_mm):
        """The process profile for this printer whose layer height is nearest."""
        best = None
        for p in self.usable("process"):
            if machine_name not in (p.get("compatible_printers") or []):
                continue
            try:
                lh = float(p.get("layer_height"))
            except (TypeError, ValueError):
                continue
            score = (abs(lh - layer_mm), "Standard" not in p.get("name", ""))
            if best is None or score < best[0]:
                best = (score, p)
        if best is None:
            raise SliceError(f"Bambu Studio has no process profile for {machine_name}.")
        return best[1]

    def filament(self, machine_name, wanted="Bambu PLA Basic"):
        """The filament profile whose name starts with `wanted`, for this printer."""
        fits, loose = [], []
        for p in self.usable("filament"):
            name = p.get("name", "")
            if not name.lower().startswith(wanted.lower().strip()):
                continue
            compat = p.get("compatible_printers") or []
            (fits if machine_name in compat else loose if not compat else []).append(p)
        got = fits or loose
        if not got:
            raise SliceError(f"Bambu Studio has no filament profile called \"{wanted}\" for {machine_name}. "
                             "Check the filament name under Settings, Printing.")
        return sorted(got, key=lambda p: len(p.get("name", "")))[0]


def bed_of(machine):
    """(width, depth, height) in mm from a printer profile."""
    pts = machine.get("printable_area") or []
    try:
        xy = [tuple(float(v) for v in str(p).split("x")) for p in pts]
        W = max(x for x, _ in xy) - min(x for x, _ in xy)
        D = max(y for _, y in xy) - min(y for _, y in xy)
    except ValueError:
        W = D = 0
    try:
        H = float(machine.get("printable_height") or 0)
    except ValueError:
        H = 0
    return W or None, D or None, H or None


def check_sliced(path):
    """The printer model code a plate sliced file was sliced for, or an error
    in words: GnomeWork takes only a file that carries its G-code and names
    its printer."""
    try:
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            info = z.read("Metadata/slice_info.config").decode("utf-8", "replace") \
                if "Metadata/slice_info.config" in names else ""
    except (OSError, zipfile.BadZipFile) as e:
        raise SliceError(f"Bambu Studio's file couldn't be read: {e}")
    if not any(re.fullmatch(r"Metadata/plate_\d+\.gcode", n) for n in names):
        raise SliceError("Bambu Studio didn't slice the plate (no G-code in its file).")
    m = re.search(r'key="printer_model_id"\s+value="([^"]*)"', info)
    if not m or not m.group(1):
        raise SliceError("Bambu Studio's file doesn't say which printer it was sliced for.")
    return m.group(1)


def slice_plate(studio, src_3mf, out_path, model, layer_mm=0.28, filament="Bambu PLA Basic",
                nozzle="0.4", timeout=600, log=None):
    """Slice src_3mf for a printer model into a plate sliced file at out_path.
    Every layer, the first one too, is layer_mm. Returns the printer model
    code the file names (N9 for an A2L, N2S for an A1)."""
    prof = Profiles(profiles_dir(studio))
    machine = prof.machine(model, nozzle)
    process = prof.process(machine["name"], layer_mm)
    fil = prof.filament(machine["name"], filament)
    process.update(layer_height=f"{layer_mm:g}", initial_layer_print_height=f"{layer_mm:g}")
    work = tempfile.mkdtemp(prefix="gs_slice_")
    files = {}
    for kind, p in (("machine", machine), ("process", process), ("filament", fil)):
        p = dict(p, **{"from": "User", "type": kind})
        p.pop("inherits", None)
        files[kind] = os.path.join(work, f"{kind}.json")
        with open(files[kind], "w", encoding="utf-8") as f:
            json.dump(p, f, indent=1)
    out_dir = os.path.dirname(os.path.abspath(out_path))
    os.makedirs(out_dir, exist_ok=True)
    tmp_out = os.path.join(work, "sliced.3mf")
    args = [studio, "--slice", "0", "--arrange", "0", "--orient", "0",
            "--load-settings", f"{files['machine']};{files['process']}",
            "--load-filaments", files["filament"],
            "--export-3mf", tmp_out, src_3mf]
    flags = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW
    try:
        r = subprocess.run(args, cwd=work, capture_output=True, text=True, timeout=timeout, creationflags=flags)
    except subprocess.TimeoutExpired:
        raise SliceError("Bambu Studio took too long to slice the test slices.")
    except OSError as e:
        raise SliceError(f"Bambu Studio wouldn't start: {e}")
    if log is not None:
        log.append({"args": args, "code": r.returncode, "out": (r.stdout or "")[-4000:], "err": (r.stderr or "")[-4000:]})
    if not os.path.isfile(tmp_out):
        tail = ((r.stderr or "") + (r.stdout or "")).strip().splitlines()[-3:]
        raise SliceError("Bambu Studio couldn't slice the test slices" + (": " + " ".join(tail) if tail else "."))
    code = check_sliced(tmp_out)
    shutil.move(tmp_out, out_path)
    return code
