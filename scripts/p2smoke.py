"""Phase 2 smoke test: the whole boundary lifecycle in one run.

Clicks the real buttons and then asks Windows what is under the cursor. Nothing
here reads the DOM or the app's internal state -- only pixels and Win32 hit
tests, because that is what a user actually experiences.

Coordinates come from GetClientRect, so the numbers do not depend on where the
window sits, on the DPI scale, or on the desktop wallpaper.

The fish is frozen with the pause button before the click-through checks: a
moving glyph would make "is the cursor on the fish" a race rather than a test.
"""

import ctypes
import os
import subprocess
import sys
import tempfile
import time
from ctypes import wintypes as wt

import numpy as np
from PIL import Image, ImageGrab

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from p2test import activate, click, describe, find_fish_fast, hit, overlay, tank, u  # noqa: E402
from p3drive import ensure_dev_server  # noqa: E402

ROOT = os.path.dirname(HERE)
EXE = os.path.join(ROOT, "src-tauri", "target", "debug", "text-aquarium.exe")
# Screenshots are evidence, not deliverables: keep them out of docs/.
SHOTS = os.path.join(tempfile.gettempdir(), "text-aquarium-shots")
DARK = 96
CSS_W = 760  # the window width declared in tauri.conf.json

u.GetClientRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
u.ClientToScreen.argtypes = [wt.HWND, ctypes.POINTER(wt.POINT)]
results = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  ' + extra if extra else ''}", flush=True)
    return ok


def work_area():
    r = wt.RECT()
    u.SystemParametersInfoW(0x0030, 0, ctypes.byref(r), 0)
    return (r.left, r.top, r.right, r.bottom)


def client(hwnd):
    r = wt.RECT()
    u.GetClientRect(hwnd, ctypes.byref(r))
    p = wt.POINT(0, 0)
    u.ClientToScreen(hwnd, ctypes.byref(p))
    return p.x, p.y, r.right - r.left, r.bottom - r.top


def grab(path=None):
    img = ImageGrab.grab(all_screens=True)
    if path:
        img.save(path)
    return img


def grey(img):
    return np.asarray(img.convert("L"), dtype=np.uint8)


def park():
    """Keep the cursor out of the window so no tooltip lands in a screenshot."""
    u.SetCursorPos(1400, 1560)
    time.sleep(0.35)


def runs_of(row, minw=1):
    out, start = [], None
    for i, on in enumerate(row):
        if on and start is None:
            start = i
        elif not on and start is not None:
            if i - start >= minw:
                out.append((start, i - 1, i - start))
            start = None
    if start is not None and len(row) - start >= minw:
        out.append((start, len(row) - 1, len(row) - start))
    return out


def find_frame(img, hwnd):
    """The aquarium frame: the widest unbroken ink line inside the client area.

    Returns (top, left, width, scale) in physical pixels.
    """
    cx, cy, cw, ch = client(hwnd)
    ink = grey(img)[cy : cy + ch, cx : cx + cw] < DARK
    best = (0, 0, 0)
    for y in range(ink.shape[0]):
        for s, _e, w in runs_of(ink[y]):
            if w > best[0]:
                best = (w, y, s)
    if not best[0]:
        return None
    return cy + best[1], cx + best[2], best[0], cw / CSS_W


def buttons(img, hwnd, frame):
    """Centres of the buttons in the header band, left to right."""
    cx, cy, cw, _ch = client(hwnd)
    scale = frame[3]
    band = (grey(img)[cy + int(12 * scale) : cy + int(34 * scale), cx : cx + cw] < DARK).any(axis=0)
    centre_y = cy + int(23 * scale)
    return [(cx + (s + e) // 2, centre_y) for s, e, _w in runs_of(band, minw=20 * scale)]


def border_fill(img, frame):
    """Fraction of the frame's top edge that is inked: solid means closed."""
    top, left, width, _ = frame
    return float((grey(img)[top, left + 8 : left + width - 8] < DARK).mean())


def fish_on_desk(img):
    """Fish clusters on the desktop, in absolute screen pixels."""
    area = work_area()
    out = []
    for c in find_fish_fast(img.crop(area)):
        out.append({**c, "x": area[0] + c["cx"] / c["n"], "y": area[1] + c["cy"] / c["n"]})
    return out


def wait(fn, seconds, step=0.08):
    start = time.time()
    while time.time() - start < seconds:
        value = fn()
        if value:
            return value, time.time() - start
        time.sleep(step)
    return None, time.time() - start


def is_overlay(x, y, ov):
    return hit(x, y)[1] == ov


def spawn_positions(img):
    return sorted((c["name"], int(c["x"]), int(c["y"])) for c in fish_on_desk(img))


def still():
    """Are the fish holding still? None when there is nothing to compare.

    An empty list is not "frozen": a fish that has faded out near the tank is
    invisible for a moment, and two empty frames must not pass for a pause.
    """
    before = spawn_positions(grab())
    if not before:
        return None
    time.sleep(0.9)
    return spawn_positions(grab()) == before


def tap(hwnd, pt, tries=3):
    """Click a button of the tank window, but only if the tank is really there.

    Two things can stand in the way, and both are real product behaviour: another
    window in front, and the desktop layer still being hittable because the
    cursor was over a fish a moment ago. So: move there, give the layer one poll
    to step aside, then ask Windows who owns the point.
    """
    for _ in range(tries):
        u.SetCursorPos(int(pt[0]), int(pt[1]))
        time.sleep(0.18)
        if hit(pt[0], pt[1])[1] == hwnd:
            click(*pt)
            return True
        bring_to_front(hwnd)
        time.sleep(0.4)
    return False


def set_paused(hwnd, pause_pt, want):
    """Click pause until the fish really stop (or really start) moving.

    A click on a shared desktop can be swallowed; assume nothing, confirm all.
    """
    for _ in range(6):
        state = still()
        if state is None:
            time.sleep(0.6)
            continue
        if state == want:
            return True
        tap(hwnd, pause_pt)
        time.sleep(0.5)
    return False


def hunt_on(hwnd, hunt_pt, ov, tries=3):
    """Click the net button and confirm the layer now owns the whole desktop."""
    for _ in range(tries):
        tap(hwnd, hunt_pt)
        if wait(lambda: is_overlay(hunt_pt[0], hunt_pt[1], ov), 1.6)[0]:
            return True
    return False


def hunt_off(ov, x, y, tries=3):
    """Right click on the layer: the net goes away, clicks flow again."""
    for _ in range(tries):
        u.SetCursorPos(int(x), int(y))
        time.sleep(0.15)
        u.mouse_event(0x0008, 0, 0, 0, 0)  # RIGHTDOWN
        time.sleep(0.1)
        u.mouse_event(0x0010, 0, 0, 0, 0)  # RIGHTUP
        if wait(lambda: not is_overlay(x, y, ov), 1.6)[0]:
            return True
    return False


def drag_box(x1, y1, x2, y2):
    """Press, drag, release — the lasso that catches whatever is inside.

    The press is held a beat before moving: the very first click on the layer
    may hand the window focus, and a real gesture moves through a couple of
    intermediate points anyway.
    """
    u.SetCursorPos(int(x1), int(y1))
    time.sleep(0.25)
    u.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
    time.sleep(0.35)
    for step in (0.4, 0.8):
        u.SetCursorPos(int(x1 + (x2 - x1) * step), int(y1 + (y2 - y1) * step))
        time.sleep(0.12)
    u.SetCursorPos(int(x2), int(y2))
    time.sleep(0.25)
    u.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
    time.sleep(0.25)


def bring_to_front(hwnd, tries=6):
    """Raise the tank until Windows agrees it is the top window.

    Whatever the user is doing in the foreground stays there otherwise, and the
    pixel checks below would happily measure the wrong application.
    """
    cx, cy, cw, ch = client(hwnd)
    for _ in range(tries):
        if hit(cx + cw // 2, cy + ch // 2)[1] == hwnd:
            return True
        u.ShowWindow(hwnd, 9)  # SW_RESTORE
        activate(hwnd)
        time.sleep(0.6)
    return False


def main():
    os.makedirs(SHOTS, exist_ok=True)
    subprocess.run(["taskkill", "/F", "/IM", "text-aquarium.exe"], capture_output=True)
    time.sleep(0.6)
    # The debug-profile exe loads its pages from the dev server (devUrl); this
    # suite asserts pixels and Win32 hit tests, not where the assets came from,
    # so start the server the same way p3test does.
    ensure_dev_server()
    proc = subprocess.Popen([EXE], cwd=os.path.dirname(EXE))
    hwnd, _ = wait(tank, 20)
    if not hwnd:
        check("tank window appears", False)
        proc.kill()
        return 1
    check("tank window appears", True, describe(hwnd))
    check("no stray desktop layer", not overlay(), f"overlay={overlay()}")
    if not check("tank window is in front", bring_to_front(hwnd), f"foreground is {describe(u.GetForegroundWindow())}"):
        proc.kill()
        return 2
    time.sleep(1.4)

    park()
    img = grab(os.path.join(SHOTS, "smoke-1-closed.png"))
    frame = find_frame(img, hwnd)
    for _ in range(3):
        if frame:
            break
        # the window can be covered again between two steps: raise, retry
        if not bring_to_front(hwnd):
            break
        park()
        img = grab(os.path.join(SHOTS, "smoke-1-closed.png"))
        frame = find_frame(img, hwnd)
    if not check("aquarium frame found", frame is not None, f"foreground is {describe(u.GetForegroundWindow())}"):
        proc.kill()
        return 2
    check("layout matches the declared window size", abs(frame[3] - 1.75) < 0.05, f"scale={frame[3]:.3f}")
    solid = border_fill(img, frame)
    check("frame solid while the boundary is closed", solid > 0.99, f"fill={solid:.2f}")

    spots = buttons(img, hwnd, frame)
    if not check("3 live buttons, catch mode still disabled", len(spots) == 3, f"found={len(spots)}"):
        proc.kill()
        return 2
    boundary, pause, _ = spots
    hunt = None

    # ---- open the boundary -------------------------------------------------
    t0 = time.time()
    tap(hwnd, boundary)
    ov, _took = wait(overlay, 15)
    if not check("desktop layer created", bool(ov), describe(ov) if ov else "none"):
        proc.kill()
        return 1
    create_s = time.time() - t0
    # the layer is created hidden, anchored, then shown and re-anchored: give
    # the geometry a moment to settle instead of measuring a mid-flight window
    area = work_area()
    r = wt.RECT()
    box = None
    for _settle in range(50):
        u.GetWindowRect(ov, ctypes.byref(r))
        box = (r.left, r.top, r.right, r.bottom)
        if box == area:
            break
        time.sleep(0.1)
    check("layer covers exactly the work area", box == area, f"{box} vs {area}")
    check("layer stops above the taskbar", r.bottom <= area[3], f"bottom={r.bottom} taskbar@{area[3]}")

    park()
    img = grab()
    dashed = border_fill(img, frame)
    check("frame turns dashed while open", dashed < 0.85, f"fill={dashed:.2f}")
    spots = buttons(img, hwnd, frame)
    if check("catch button becomes clickable", len(spots) == 4, f"found={len(spots)}"):
        hunt = spots[2]

    # ---- fish reach the desktop -------------------------------------------
    # A fish that just crossed is still fading in (colour ramps 0 -> 1 over
    # ~0.6s); its washed-out pixels would read as a tiny cluster. Wait for a
    # solid one, so "fully coloured" is a fact by the time we pause and aim.
    found = []
    deadline = time.time() + 60
    while time.time() < deadline:
        park()
        img = grab()
        found = [c for c in fish_on_desk(img) if c["n"] >= 150]
        if found:
            break
        time.sleep(0.8)
    if not check("fish visible on the desktop", bool(found), f"{len(found)} cluster(s)"):
        proc.kill()
        return 1
    img.save(os.path.join(SHOTS, "smoke-2-desktop.png"))

    # ---- freeze, then test the layer with a still target -------------------
    if not check("pause really stops the fish", set_paused(hwnd, pause, True), "needed for a still target"):
        proc.kill()
        return 2
    park()
    img = grab()
    stills = fish_on_desk(img)
    solid_fish = [c for c in stills if c["n"] >= 150]
    if not check("a fully coloured fish to aim at", bool(solid_fish), f"{[(c['name'], c['n']) for c in stills]}"):
        proc.kill()
        return 1
    cx0, cy0, cw, ch = client(tank())
    cx1, cy1 = cx0 + cw, cy0 + ch
    outside = [
        c
        for c in solid_fish
        if not (cx0 - 40 <= c["x"] <= cx1 + 40 and cy0 - 40 <= c["y"] <= cy1 + 40)
    ]
    target = max(outside or solid_fish, key=lambda c: c["n"])
    fx, fy = target["x"], target["y"]
    over_other_app = bool(outside)
    print(
        f"      target: {target['name']} {target['n']}px at ({fx:.0f},{fy:.0f})"
        f"{' over another app' if over_other_app else ' over the tank window'}",
        flush=True,
    )

    # a point on some other software, far from the fish
    others = [c for c in stills if c is not target]
    mx = int(min(max(fx + 700, 120), area[2] - 120))
    my = int(min(max(fy - 500, 60), area[3] - 60))
    for c in others:  # keep clear of every other fish
        if abs(c["x"] - mx) < 220 and abs(c["y"] - my) < 90:
            my = int(min(max(c["y"] + 260, 60), area[3] - 60))

    # ---- plain pass-through -----------------------------------------------
    u.SetCursorPos(int(fx), int(fy))
    time.sleep(0.5)
    check(
        "cursor on a fish still clicks the app underneath",
        not is_overlay(fx, fy, ov),
        describe(hit(fx, fy)[1]),
    )
    u.SetCursorPos(mx, my)
    time.sleep(0.3)
    check("empty water passes clicks through", not is_overlay(mx, my, ov), describe(hit(mx, my)[1]))

    # ---- catching mode: the net owns the whole desktop ---------------------
    on = hunt_on(hwnd, hunt, ov)
    check("catch mode makes the layer own the fish", on and is_overlay(fx, fy, ov), describe(hit(fx, fy)[1]))
    u.SetCursorPos(mx, my)
    time.sleep(0.2)
    check("the net covers the whole desktop while catching", is_overlay(mx, my, ov), describe(hit(mx, my)[1]))

    # ---- the lasso: a box around the frozen fish ---------------------------
    # the fish is still paused, so the box cannot miss a moving target; the
    # fish hold still for the net anyway (dodge is suspended while hunting)
    drag_box(fx - 45, fy - 22, fx + 45, fy + 22)
    time.sleep(0.4)

    # ---- right click puts the net away -------------------------------------
    off = hunt_off(ov, mx, my)
    check("right click puts the net away", off, describe(hit(mx, my)[1]))
    u.SetCursorPos(int(fx), int(fy))
    time.sleep(0.3)
    check("catch mode off restores pass-through", not is_overlay(fx, fy, ov), describe(hit(fx, fy)[1]))

    # ---- the boxed fish leaves its spot and swims home ---------------------
    # the unpause must be *verified*: a swallowed click here leaves the whole
    # sim paused, and the boundary button politely refuses to close while
    # paused — which is exactly how this test used to lose 80 seconds
    if not set_paused(hwnd, pause, False):
        check("unpause before the close", False, "the fish would not resume")
        proc.kill()
        return 1
    # the caught fish leaves its spot: either the target cluster itself is
    # gone, or the school on the desk has shrunk by one (two independent
    # signals — a same-colour fish can wander through the spot and mask the
    # first one)
    def desk_count():
        return len([c for c in fish_on_desk(grab()) if c["n"] >= 150])

    # the true number of fish outside: sampling noise only ever undercounts
    # (nearby fish merge into one cluster), so take the max over a few looks
    count_before = max(desk_count() for _ in range(3))
    left, took = wait(
        lambda: (
            not any(
                c["name"] == target["name"] and abs(c["x"] - fx) < 150 and abs(c["y"] - fy) < 150
                for c in fish_on_desk(grab())
            )
        )
        or desk_count() < count_before,
        45,
        0.5,
    )
    check("the boxed fish left its spot for home", bool(left), f"{took:.2f}s")

    # ---- close the boundary ------------------------------------------------
    # A swallowed click must not fail the whole run — but a blind retry must
    # not happen either: tapping again mid-return *reopens* the boundary by
    # design. The honest retry test: after the tap, the fish start leaving
    # their spots; if none do, the click never landed.
    t0 = time.time()
    park()
    before_close = [c for c in fish_on_desk(grab()) if c["n"] >= 150]
    tap(hwnd, boundary)
    for _retry in range(2):
        time.sleep(8)
        now = [c for c in fish_on_desk(grab()) if c["n"] >= 150]
        if len(now) < len(before_close):
            break
        tap(hwnd, boundary)
        park()
    # with the voluntary return gone, fish roam the whole desk: the slowest
    # one may need up to ~50s to swim home from the far corner
    gone = wait(lambda: not overlay(), 60, 0.2)[0]
    check("desktop layer destroyed on close", bool(gone), f"{time.time() - t0:.2f}s")
    park()
    img = grab(os.path.join(SHOTS, "smoke-3-back.png"))
    back = border_fill(img, frame)
    check("frame solid again", back > 0.99, f"fill={back:.2f}")
    left = fish_on_desk(img)
    # small matches can be other apps' UI: only a fish-sized cluster counts,
    # and a cluster that was already there before the boundary opened is the
    # user's desktop, not a fish
    base = fish_on_desk(Image.open(os.path.join(SHOTS, "smoke-1-closed.png")))
    left = [
        c
        for c in left
        if c["n"] >= 150
        and not any(
            b["name"] == c["name"] and abs(b["x"] - c["x"]) < 60 and abs(b["y"] - c["y"]) < 60
            for b in base
        )
    ]
    check("no fish left on the desktop", not left, f"{len(left)} cluster(s)")

    print(f"\ndesktop layer appeared in {create_s:.2f}s", flush=True)
    proc.terminate()
    try:
        proc.wait(6)
    except subprocess.TimeoutExpired:
        proc.kill()
    time.sleep(1.0)
    procs = subprocess.run(["tasklist", "/FI", "IMAGENAME eq text-aquarium.exe"], capture_output=True)
    check("process exits cleanly", b"text-aquarium.exe" not in procs.stdout)

    print(f"screenshots in {SHOTS}", flush=True)
    passed = sum(1 for r in results if r[1])
    print(f"\n{passed} passed, {len(results) - passed} failed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
