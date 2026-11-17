"""Shared Win32 helpers for driving the real app from a test.

Everything here talks to the same thing the user does: window handles, screen
pixels, and WindowFromPoint (what Windows itself uses to decide who gets a
click). p2smoke.py is the runnable check; this file is the toolbox.
"""

import ctypes
import time
from ctypes import wintypes as wt

ctypes.windll.shcore.SetProcessDpiAwareness(2)
u = ctypes.WinDLL("user32", use_last_error=True)
u.FindWindowW.restype = wt.HWND
u.FindWindowW.argtypes = [wt.LPCWSTR, wt.LPCWSTR]
u.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
u.WindowFromPoint.restype = wt.HWND
u.WindowFromPoint.argtypes = [wt.POINT]
u.GetAncestor.restype = wt.HWND
u.GetAncestor.argtypes = [wt.HWND, wt.UINT]
u.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
u.GetForegroundWindow.restype = wt.HWND
u.AttachThreadInput.argtypes = [wt.DWORD, wt.DWORD, wt.BOOL]
u.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]


def tank():
    return u.FindWindowW(None, "Text Aquarium")


def overlay():
    return u.FindWindowW(None, "Text Aquarium Overlay")


def activate(hwnd):
    """Bring the tank to the front as a *normal* window (no TOPMOST)."""
    fg = u.GetForegroundWindow()
    tf = u.GetWindowThreadProcessId(fg, None)
    tt = u.GetWindowThreadProcessId(hwnd, None)
    u.AttachThreadInput(tf, tt, True)
    u.SetWindowPos(hwnd, wt.HWND(-2), 0, 0, 0, 0, 0x0001 | 0x0002)  # NOTOPMOST
    u.BringWindowToTop(hwnd)
    u.SetForegroundWindow(hwnd)
    u.AttachThreadInput(tf, tt, False)


def click(x, y):
    u.SetCursorPos(int(x), int(y))
    time.sleep(0.09)
    u.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.09)
    u.mouse_event(0x0004, 0, 0, 0, 0)
    time.sleep(0.12)


def hit(x, y):
    h = u.WindowFromPoint(wt.POINT(int(x), int(y)))
    root = u.GetAncestor(h, 2) if h else 0
    return h, root


def describe(hwnd):
    if not hwnd:
        return "none"
    buf = ctypes.create_unicode_buffer(128)
    u.GetWindowTextW(hwnd, buf, 128)
    pid = wt.DWORD()
    u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return f"'{buf.value}' pid={pid.value}"


# The fish colours adapt to the background (lightened on dark desktops,
# darkened on bright ones), so a single RGB target would miss them. Match a
# set of reference points along that adaptation line instead, with a tight
# tolerance — tight enough that VSCode's syntax colours stay out.
def _refs(base):
    out = []
    for k in (-0.2, 0, 0.15, 0.3, 0.45, 0.6):
        if k >= 0:
            out.append(tuple(round(c + (255 - c) * k) for c in base))
        else:
            out.append(tuple(round(c * (1 + k)) for c in base))
    return out


OCEAN_REFS = {
    "orange": _refs((232, 130, 60)),
    "blue": _refs((62, 140, 220)),
    "teal": _refs((44, 168, 148)),
}


def find_fish_fast(img, tol=16, min_px=100, shape=True):
    """Coloured clusters that look like a fish glyph, in image pixels.

    Vectorised, because the caller runs this on a 2560x1600 grab and a pure
    Python pixel walk takes seconds.

    `shape` keeps only clusters whose bounding box matches a 7-character
    monospace glyph (wide, short). Without it, any blue icon on the desktop
    reads as a fish.
    """
    import numpy as np

    a = np.asarray(img.convert("RGB"), dtype=np.int16)
    raw = []
    for name, refs in OCEAN_REFS.items():
        mask = np.zeros(a.shape[:2], dtype=bool)
        for target in refs:
            mask |= (np.abs(a - np.array(target, dtype=np.int16)) <= tol).all(axis=2)
        ys, xs = np.nonzero(mask)
        if len(xs) == 0:
            continue
        # coarse grid bucketing, then merge neighbours
        buckets = {}
        for x, y in zip(xs.tolist(), ys.tolist()):
            buckets.setdefault((x // 90, y // 50), []).append((x, y))
        for pts in buckets.values():
            if len(pts) < min_px:
                continue
            xs2 = [p[0] for p in pts]
            ys2 = [p[1] for p in pts]
            raw.append(
                {
                    "name": name,
                    "n": len(pts),
                    "cx": sum(xs2),
                    "cy": sum(ys2),
                    "x0": min(xs2),
                    "x1": max(xs2),
                    "y0": min(ys2),
                    "y1": max(ys2),
                }
            )
    # a glyph spans several buckets: merge clusters of the same colour
    merged = []
    for c in sorted(raw, key=lambda c: -c["n"]):
        for m in merged:
            if m["name"] != c["name"]:
                continue
            if abs(m["cx"] / m["n"] - c["cx"] / c["n"]) < 130 and abs(m["cy"] / m["n"] - c["cy"] / c["n"]) < 45:
                m["n"] += c["n"]
                m["cx"] += c["cx"]
                m["cy"] += c["cy"]
                m["x0"] = min(m["x0"], c["x0"])
                m["x1"] = max(m["x1"], c["x1"])
                m["y0"] = min(m["y0"], c["y0"])
                m["y1"] = max(m["y1"], c["y1"])
                break
        else:
            merged.append(dict(c))
    if not shape:
        return merged
    out = []
    for c in merged:
        w = c["x1"] - c["x0"] + 1
        h = c["y1"] - c["y0"] + 1
        if 60 <= w <= 230 and 8 <= h <= 50 and w / h >= 1.8:
            out.append(c)
    return out
