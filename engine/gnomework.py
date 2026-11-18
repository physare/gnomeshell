"""
Talking to GnomeWork's Print Queue, for the Send test slices button.

GnomeShell signs in with its own token (made in GnomeWork with
`php artisan gnomeshell:token --user=...`), which reaches two things and
nothing else: the list of printers (which are free), and putting a sliced
file in one printer's queue. GnomeWork never starts a print from here: a
person presses Start there, ticks "Bed is clear" and picks the AMS slots.
"""

import json
import os
import ssl
import urllib.error
import urllib.request
import uuid

DEFAULT_URL = "https://gnomework.gnomeandgarden.store"


class GnomeWorkError(RuntimeError):
    pass


def _ctx():
    return ssl.create_default_context()


def _call(base, token, method, path, body=None, headers=None, timeout=30):
    base = (base or DEFAULT_URL).strip().rstrip("/")
    if not token:
        raise GnomeWorkError("GnomeShell isn't signed in to GnomeWork. Paste the GnomeWork token under Settings, Printing.")
    h = {"Authorization": f"Bearer {token.strip()}", "Accept": "application/json", "User-Agent": "GnomeShell"}
    h.update(headers or {})
    req = urllib.request.Request(base + "/api/gnomeshell" + path, data=body, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ctx()) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            msg = (json.loads(e.read() or b"{}").get("error") or {}).get("message")
        except ValueError:
            msg = None
        if e.code == 401:
            msg = "GnomeWork didn't accept the token. Make a new one in GnomeWork and paste it under Settings, Printing."
        elif e.code == 403 and not msg:
            msg = "GnomeWork said no. The token's account needs the Print Queue permission."
        raise GnomeWorkError(msg or f"GnomeWork answered {e.code}.")
    except (urllib.error.URLError, OSError) as e:
        raise GnomeWorkError(f"Couldn't reach GnomeWork at {base}. Is the internet on? ({getattr(e, 'reason', e)})")


def printers(base, token):
    """Every printer: id, name, model, model_code, state (free, busy or
    blocked), problem and queued."""
    return _call(base, token, "GET", "/printers").get("printers", [])


def queue_file(base, token, printer_id, path, title):
    """Put a plate sliced file in that printer's queue. Returns GnomeWork's
    answer: id, printer, ahead (prints before it) and ready (Start shows now)."""
    boundary = "----gnomeshell" + uuid.uuid4().hex
    parts = []
    for k, v in (("printer_id", str(printer_id)), ("title", title)):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode("utf-8"))
    name = os.path.basename(path).replace('"', "")
    with open(path, "rb") as f:
        data = f.read()
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
                 f"Content-Type: model/3mf\r\n\r\n".encode("utf-8") + data + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    return _call(base, token, "POST", "/prints", b"".join(parts),
                 {"Content-Type": f"multipart/form-data; boundary={boundary}"}, timeout=120)


def pick_printer(rows, can_slice, rank=None):
    """The printer to send to: a free one first, else the one with the
    shortest queue that is only busy (not switched off or unwatched).
    can_slice(model) says whether Bambu Studio has a profile for it (and, when
    the slices are cut, whether they fit its plate). rank(row) orders printers
    that are equally free: fewest plates, then the smallest plate, so a free A1
    takes test slices that fit it and an A2L keeps its big plate free.
    Returns (row, why) or (None, reason in words)."""
    ok = [r for r in rows if r.get("model") and can_slice(r["model"])]
    if not ok:
        names = ", ".join(r.get("name", "?") for r in rows) or "none"
        return None, f"None of GnomeWork's printers ({names}) is a model Bambu Studio can slice for that the test slices fit."
    order = (lambda r: (tuple(rank(r)), rows.index(r))) if rank else (lambda r: (rows.index(r),))
    free = [r for r in ok if r.get("state") == "free"]
    if free:
        return min(free, key=order), "free"
    busy = [r for r in ok if r.get("state") == "busy"]
    if busy:
        return min(busy, key=lambda r: (int(r.get("queued") or 0),) + order(r)), "queued"
    why = "; ".join(f"{r['name']}: {r.get('problem')}" for r in ok if r.get("problem"))
    return None, "No printer can take it now. " + why
