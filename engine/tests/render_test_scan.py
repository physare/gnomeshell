"""
Makes a fake phone scan for testing the photo pipeline: a textured "gnome"
(a cylinder with a ball on top, 60 mm across and 116 mm tall) standing on
the printed scan sheet, on a wooden table, photographed from three rings of
angles like the phone app asks for. Ray-traced in numpy, saved as JPEGs.

python engine/tests/render_test_scan.py <out folder>/photos [views]
"""
import math
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import marker_sheet as ms  # noqa: E402

W, H, F = 1600, 1200, 1350.0
SS = 2
BODY_R, BODY_H, HEAD_R, HEAD_Z = 30.0, 60.0, 28.0, 88.0
TRUE_DIMS = (60.0, 60.0, HEAD_Z + HEAD_R)

rng = np.random.default_rng(7)
LAT = rng.random((64, 64, 64))
LAT2 = rng.random((64, 64, 64))
PAL = rng.random((64, 3)) * 0.8 + 0.15


def noise(p, cell, lat):
    g = p / cell
    i = np.floor(g).astype(int)
    f = g - i
    f = f * f * (3 - 2 * f)
    out = 0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                out = out + w * lat[(i[:, 0] + dx) % 64, (i[:, 1] + dy) % 64, (i[:, 2] + dz) % 64]
    return out


def obj_color(p):
    a = noise(p, 4.0, LAT)
    b = noise(p + 100, 13.0, LAT2)
    idx = (np.floor(b * 8) * 8 + np.floor(a * 8)).astype(int) % 64
    c = PAL[idx]
    spots = noise(p * 1.0 + 50, 2.2, LAT) > 0.72
    c[spots] = c[spots] * 0.15
    return c


TEX = ms.template(10.0, ss=2).astype(np.float32) / 255.0


def floor_color(x, y):
    c = np.empty((len(x), 3))
    # the paper: white past the pattern, the pattern inside
    on_page = (np.abs(x) < ms.PAGE_W / 2) & (y > ms.PAT_H / 2 - (ms.PAGE_H - ms.PAT_TOP)) & (y < ms.PAT_H / 2 + ms.PAT_TOP)
    wood = 0.5 + 0.5 * np.sin(x * 0.05 + 3 * noise(np.column_stack([x, y, np.zeros_like(x)]), 25.0, LAT))
    grain = noise(np.column_stack([x * 0.3, y * 3, np.zeros_like(x)]), 6.0, LAT2)
    c[:] = np.column_stack([0.45 + 0.2 * wood + 0.15 * grain, 0.3 + 0.12 * wood + 0.1 * grain, 0.18 + 0.06 * wood])
    c[on_page] = 0.95
    u = (x + ms.PAT_W / 2) * 10.0 - 0.5
    v = (ms.PAT_H / 2 - y) * 10.0 - 0.5
    inside = (u >= 0) & (v >= 0) & (u < TEX.shape[1] - 1) & (v < TEX.shape[0] - 1)
    ui, vi = np.floor(u[inside]).astype(int), np.floor(v[inside]).astype(int)
    fu, fv = (u[inside] - ui)[:, None], (v[inside] - vi)[:, None]
    t = (TEX[vi, ui] * (1 - fu) * (1 - fv) + TEX[vi, ui + 1] * fu * (1 - fv) +
         TEX[vi + 1, ui] * (1 - fu) * fv + TEX[vi + 1, ui + 1] * fu * fv)
    c[inside] = t * 0.95
    return c


def render(cam, look):
    fwd = look - cam
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, [0, 0, 1.0])
    right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    w, h, f = W * SS, H * SS, F * SS
    u, v = np.meshgrid(np.arange(w) + 0.5 - w / 2, np.arange(h) + 0.5 - h / 2)
    d = (fwd[None] * f + right[None] * u.reshape(-1, 1) - up[None] * v.reshape(-1, 1))
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    o = cam[None]
    n = len(d)
    T = np.full(n, np.inf)
    N = np.zeros((n, 3))
    kind = np.zeros(n, int)
    # floor
    t = -o[0, 2] / d[:, 2]
    m = (t > 0)
    T[m], kind[m] = t[m], 1
    N[m] = [0, 0, 1]
    # cylinder side
    a = d[:, 0] ** 2 + d[:, 1] ** 2
    b = 2 * (o[0, 0] * d[:, 0] + o[0, 1] * d[:, 1])
    c = o[0, 0] ** 2 + o[0, 1] ** 2 - BODY_R ** 2
    disc = b * b - 4 * a * c
    ok = disc > 0
    t = np.where(ok, (-b - np.sqrt(np.maximum(disc, 0))) / (2 * a + 1e-12), np.inf)
    z = o[0, 2] + t * d[:, 2]
    m = ok & (t > 0) & (z > 0) & (z < BODY_H) & (t < T)
    T[m], kind[m] = t[m], 2
    P = o + T[:, None] * d
    N[m] = np.column_stack([P[m, 0], P[m, 1], np.zeros(m.sum())]) / BODY_R
    # top cap
    t = (BODY_H - o[0, 2]) / d[:, 2]
    P2 = o + t[:, None] * d
    m = (t > 0) & (P2[:, 0] ** 2 + P2[:, 1] ** 2 < BODY_R ** 2) & (t < T)
    T[m], kind[m] = t[m], 2
    N[m] = [0, 0, 1]
    # head
    oc = o[0] - np.array([0, 0, HEAD_Z])
    b = d @ oc
    c = oc @ oc - HEAD_R ** 2
    disc = b * b - c
    t = -b - np.sqrt(np.maximum(disc, 0))
    m = (disc > 0) & (t > 0) & (t < T)
    T[m], kind[m] = t[m], 2
    P = o + T[:, None] * d
    N[m] = (P[m] - [0, 0, HEAD_Z]) / HEAD_R
    col = np.full((n, 3), 0.2)
    fl = kind == 1
    col[fl] = floor_color(P[fl, 0], P[fl, 1])
    ob = kind == 2
    col[ob] = obj_color(P[ob])
    L = np.array([0.4, -0.5, 0.75])
    L /= np.linalg.norm(L)
    shade = 0.45 + 0.55 * np.clip(N @ L, 0, 1)
    # a soft shadow of the object on the floor
    sh = fl & (np.hypot(P[:, 0] - 0.4 * 70, P[:, 1] + 0.5 * 70) < 40)
    shade[sh] *= 0.8
    col = col * shade[:, None]
    img = col.reshape(h, w, 3).reshape(H, SS, W, SS, 3).mean(axis=(1, 3))
    img += rng.normal(0, 0.012, img.shape)
    return (np.clip(img, 0, 1) * 255).astype(np.uint8)


def main(out, views=60):
    os.makedirs(out, exist_ok=True)
    rings = [(25, 0.4), (45, 0.35), (68, 0.25)]
    k = 0
    for el, share in rings:
        n = max(6, round(views * share))
        for i in range(n):
            az = 2 * math.pi * i / n + el * 0.01
            dist = 330 + 20 * math.sin(i)
            e = math.radians(el)
            cam = np.array([dist * math.cos(e) * math.cos(az), dist * math.cos(e) * math.sin(az), dist * math.sin(e)])
            look = np.array([8 * math.sin(i * 1.3), 8 * math.cos(i * 0.7), 45.0])
            Image.fromarray(render(cam, look)).save(os.path.join(out, f"IMG_{k:03d}.jpg"), quality=92)
            k += 1
            print(k, end=" ", flush=True)
    print()


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 60)
