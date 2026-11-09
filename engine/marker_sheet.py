"""
The printed scan sheet that phone scans stand on.

The sheet is a fixed random pattern of dark dots, rings and shapes. The same
pattern is drawn two ways from one list of shapes:

- as a PDF to print (vector, Letter paper, landscape), and
- as a picture (`template()`) that the photo pipeline matches against the
  photos. Each matched feature in the picture has a known spot on the paper
  in millimetres, so the scan comes out at its real size, standing upright on
  the sheet, with the sheet's middle at (0, 0).

Sheet coordinates: millimetres, origin at the middle of the pattern, x to the
right and y toward the top edge of the page as you read it, z up off the paper.

Pure Python + numpy, no Blender, so the pipeline and its tests can use it
anywhere.
"""

import math
import random
import struct
import zlib

import numpy as np

SHEET_VERSION = 1
SEED = 20261109
PAGE_W, PAGE_H = 279.4, 215.9          # US Letter, landscape, mm
PAT_W, PAT_H = 250.0, 168.0            # the matched pattern, mm
PAT_X0 = (PAGE_W - PAT_W) / 2          # its left edge on the page
PAT_TOP = 12.0                         # its top edge, from the top of the page
SPOT_R = 45.0                          # the "stand it here" ring

INK = (0.07, 0.07, 0.08)
COLORS = [INK, INK, INK, (0.10, 0.22, 0.55), (0.62, 0.12, 0.10), (0.08, 0.38, 0.22)]
WHITE = (1.0, 1.0, 1.0)


def shapes():
    """The pattern, in drawing order: dicts with kind 'circle' (c, r) or 'poly'
    (pts), and a fill colour. Always the same list (fixed seed)."""
    rnd = random.Random(SEED)
    out = []

    def pt(margin):
        return (rnd.uniform(-PAT_W / 2 + margin, PAT_W / 2 - margin),
                rnd.uniform(-PAT_H / 2 + margin, PAT_H / 2 - margin))

    def poly(c, r, n, rot):
        return [(c[0] + r * math.cos(rot + 2 * math.pi * k / n), c[1] + r * math.sin(rot + 2 * math.pi * k / n))
                for k in range(n)]

    # big rings and blobs: many sizes so the photos match from near and far
    for _ in range(46):
        c, r = pt(9), rnd.uniform(5.5, 10.0)
        out.append({"kind": "circle", "c": c, "r": r, "fill": rnd.choice(COLORS)})
        if rnd.random() < 0.7:
            out.append({"kind": "circle", "c": (c[0] + rnd.uniform(-1.5, 1.5), c[1] + rnd.uniform(-1.5, 1.5)),
                        "r": r * rnd.uniform(0.35, 0.6), "fill": WHITE})
        else:
            out.append({"kind": "poly", "pts": poly(c, r * 0.55, rnd.choice((3, 4, 5)), rnd.uniform(0, 6.3)),
                        "fill": WHITE})
    for _ in range(260):
        c, r = pt(4), rnd.uniform(2.2, 4.8)
        kind = rnd.random()
        if kind < 0.5:
            out.append({"kind": "circle", "c": c, "r": r, "fill": rnd.choice(COLORS)})
        else:
            out.append({"kind": "poly", "pts": poly(c, r, rnd.choice((3, 4, 4, 5, 6)), rnd.uniform(0, 6.3)),
                        "fill": rnd.choice(COLORS)})
        if rnd.random() < 0.25:
            out.append({"kind": "circle", "c": (c[0] + rnd.uniform(-r / 3, r / 3), c[1] + rnd.uniform(-r / 3, r / 3)),
                        "r": r * 0.3, "fill": WHITE})
    for _ in range(950):
        c, r = pt(2), rnd.uniform(0.9, 2.0)
        if rnd.random() < 0.6:
            out.append({"kind": "circle", "c": c, "r": r, "fill": rnd.choice(COLORS)})
        else:
            out.append({"kind": "poly", "pts": poly(c, r * 1.2, rnd.choice((3, 4)), rnd.uniform(0, 6.3)),
                        "fill": rnd.choice(COLORS)})
    # the ring that shows where to stand the object (part of the pattern too)
    out.append({"kind": "ring", "c": (0.0, 0.0), "r": SPOT_R, "w": 1.6, "fill": (0.55, 0.55, 0.58)})
    # an arrow pointing to the top edge, so the sheet is easy to put down the same way
    out.append({"kind": "poly", "pts": [(-4, SPOT_R + 3), (4, SPOT_R + 3), (0, SPOT_R + 10)], "fill": INK})
    return out


# ------------------------------------------------------------- the picture

def template(px_per_mm=6.0, ss=3):
    """The pattern as an RGB uint8 image (rows top to bottom), `px_per_mm`
    pixels per millimetre. Pixel (u, v)'s centre is at sheet
    x = (u + 0.5) / ppm - PAT_W / 2, y = PAT_H / 2 - (v + 0.5) / ppm."""
    w, h = int(round(PAT_W * px_per_mm)), int(round(PAT_H * px_per_mm))
    k = px_per_mm * ss
    W, H = w * ss, h * ss
    img = np.ones((H, W, 3), np.float32)

    for s in shapes():
        if s["kind"] in ("circle", "ring"):
            cx, cy = s["c"]
            r = s["r"] + (s.get("w", 0) / 2)
            xs, ys = [cx - r, cx + r], [cy - r, cy + r]
        else:
            pts = s["pts"]
            xs, ys = [min(p[0] for p in pts), max(p[0] for p in pts)], [min(p[1] for p in pts), max(p[1] for p in pts)]
        u0 = max(0, int(math.floor((xs[0] + PAT_W / 2) * k)))
        u1 = min(W, int(math.ceil((xs[1] + PAT_W / 2) * k)) + 1)
        v0 = max(0, int(math.floor((PAT_H / 2 - ys[1]) * k)))
        v1 = min(H, int(math.ceil((PAT_H / 2 - ys[0]) * k)) + 1)
        if u1 <= u0 or v1 <= v0:
            continue
        X = (np.arange(u0, u1) + 0.5) / k - PAT_W / 2
        Y = PAT_H / 2 - (np.arange(v0, v1) + 0.5) / k
        X, Y = np.meshgrid(X, Y)
        if s["kind"] == "circle":
            m = (X - s["c"][0]) ** 2 + (Y - s["c"][1]) ** 2 <= s["r"] ** 2
        elif s["kind"] == "ring":
            d = np.sqrt((X - s["c"][0]) ** 2 + (Y - s["c"][1]) ** 2)
            m = np.abs(d - s["r"]) <= s["w"] / 2
        else:
            pts = s["pts"]
            area = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))
            sgn = 1 if area > 0 else -1
            m = np.ones(X.shape, bool)
            for i in range(len(pts)):
                ax, ay = pts[i]
                bx, by = pts[(i + 1) % len(pts)]
                m &= sgn * ((bx - ax) * (Y - ay) - (by - ay) * (X - ax)) >= 0
        img[v0:v1, u0:u1][m] = s["fill"]
    img = img.reshape(h, ss, w, ss, 3).mean(axis=(1, 3))
    return (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)


def template_xy(kx, ky, px_per_mm):
    """Sheet millimetres of a point in the template picture, given in COLMAP's
    image coordinates (the top-left corner of the first pixel is 0, 0)."""
    kx, ky = np.asarray(kx, float), np.asarray(ky, float)
    return np.stack([kx / px_per_mm - PAT_W / 2, PAT_H / 2 - ky / px_per_mm], axis=-1)


def write_png(path, rgb):
    """Write an RGB uint8 array as a PNG (no Pillow needed)."""
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[r].tobytes() for r in range(h))

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(raw, 6)))
        f.write(chunk(b"IEND", b""))


# ----------------------------------------------------------------- the PDF

def pdf_bytes():
    """The sheet to print: Letter, landscape, at actual size."""
    pt = 72 / 25.4

    def P(x, y):  # sheet mm -> PDF points (origin bottom-left of the page)
        px = PAT_X0 + PAT_W / 2 + x
        py_top = PAT_TOP + PAT_H / 2 - y
        return px * pt, (PAGE_H - py_top) * pt

    ops = []

    def fill(c):
        ops.append("%.3f %.3f %.3f rg" % c)

    def circle(cx, cy, r):
        kk = 0.5523 * r
        segs = [((cx + r, cy), (cx + r, cy + kk), (cx + kk, cy + r), (cx, cy + r)),
                (None, (cx - kk, cy + r), (cx - r, cy + kk), (cx - r, cy)),
                (None, (cx - r, cy - kk), (cx - kk, cy - r), (cx, cy - r)),
                (None, (cx + kk, cy - r), (cx + r, cy - kk), (cx + r, cy))]
        out = []
        for i, (a, b, c, d) in enumerate(segs):
            if i == 0:
                out.append("%.3f %.3f m" % P(*a))
            out.append("%.3f %.3f %.3f %.3f %.3f %.3f c" % (P(*b) + P(*c) + P(*d)))
        return " ".join(out) + " h"

    for s in shapes():
        fill(s["fill"])
        if s["kind"] == "circle":
            ops.append(circle(s["c"][0], s["c"][1], s["r"]) + " f")
        elif s["kind"] == "ring":
            ops.append(circle(s["c"][0], s["c"][1], s["r"] + s["w"] / 2) + " " +
                       circle(s["c"][0], s["c"][1], s["r"] - s["w"] / 2) + " f*")
        else:
            p = s["pts"]
            ops.append(" ".join(("%.3f %.3f " % P(*q)) + ("m" if i == 0 else "l") for i, q in enumerate(p)) + " h f")

    # the check bar: 100 mm with a tick every 10 mm, under the pattern
    by = PAGE_H - (PAT_TOP + PAT_H + 9)  # mm from the bottom
    bx = PAT_X0
    fill(INK)
    ops.append("%.3f %.3f %.3f %.3f re f" % (bx * pt, by * pt, 100 * pt, 1.2 * pt))
    for i in range(11):
        ops.append("%.3f %.3f %.3f %.3f re f" % ((bx + i * 10 - 0.2) * pt, by * pt, 0.4 * pt, (4 if i % 5 == 0 else 2.5) * pt))

    def text(x_mm, y_mm, size, s, bold=False):
        s = s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        ops.append("BT /%s %d Tf %.3f %.3f Td (%s) Tj ET" % ("F2" if bold else "F1", size, x_mm * pt, y_mm * pt, s))

    text(bx, by - 5, 8, "This bar should measure exactly 100 mm. If it doesn't, print again at Actual size (100%).")
    text(bx + 112, by + 1, 10, "GnomeShell scan sheet", True)
    text(bx + 112, by - 5, 8, "Lay it flat, stand the object on the ring, arrow pointing away from you. "
                              "Keep the sheet in every photo.")
    text(PAGE_W - PAT_X0 - 18, PAGE_H - PAT_TOP + 3, 6, "sheet v%d" % SHEET_VERSION)

    content = "\n".join(ops).encode("latin-1")
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        ("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.2f %.2f] /Contents 4 0 R "
         "/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>" % (PAGE_W * pt, PAGE_H * pt)).encode(),
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for o in offs:
        out += b"%010d 00000 n \n" % o
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return bytes(out)


if __name__ == "__main__":
    import sys
    dest = sys.argv[1] if len(sys.argv) > 1 else "GnomeShell scan sheet.pdf"
    with open(dest, "wb") as f:
        f.write(pdf_bytes())
    write_png(dest.rsplit(".", 1)[0] + ".png", template())
    print("wrote", dest)
