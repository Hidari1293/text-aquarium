"""Regenerate the two delivery screenshots from the live canvases.

    python scripts/shots.py

Why not a screen capture: this machine is locked, and `ImageGrab` would return
the lock screen. Each window hands out its own canvas instead (`toDataURL`), so
what you see in `docs/screenshot-*.png` is exactly what the page painted. The
desktop shot is that canvas composited onto a plain backdrop, because the
overlay canvas is transparent by design.
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import p3drive as D  # noqa: E402
from PIL import Image  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")


def wait_for(predicate, timeout, label, step=0.5):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = predicate()
            if last:
                return last
        except Exception:
            pass
        time.sleep(step)
    raise TimeoutError(f"timed out waiting for {label} (last={last})")


def backdrop(size, fill=(243, 244, 245)):
    """A flat, neutral desktop stand-in: no fake wallpaper, no banding."""
    return Image.new("RGB", size, fill)


def framed(box, size, margin=260, ratio=16 / 9):
    """A 16:9 window around `box`, kept inside the canvas."""
    width, height = size
    left, top, right, bottom = box
    centre_x, centre_y = (left + right) / 2, (top + bottom) / 2
    span_w = max(right - left + 2 * margin, 1100)
    span_h = max(bottom - top + 2 * margin, span_w / ratio)
    span_w = max(span_w, span_h * ratio)
    if span_h > height:
        span_h = height
        span_w = min(width, span_h * ratio)
    if span_w > width:
        span_w = width
        span_h = min(height, span_w / ratio)

    left = min(max(0, centre_x - span_w / 2), width - span_w)
    top = min(max(0, centre_y - span_h / 2), height - span_h)
    return (round(left), round(top), round(left + span_w), round(top + span_h))


def eval_json(drive, js, name):
    """Ask a page to evaluate an expression and write the result back."""
    import json

    marker = os.path.join(D.DUMP, name)
    if os.path.exists(marker):
        os.remove(marker)
    drive.run(
        "window.__TAURI__.core.invoke('debug_write', {name: "
        + json.dumps(name)
        + ", text: JSON.stringify(" + js + ")});"
    )
    with open(drive.wait_file(name), encoding="utf-8") as handle:
        return json.load(handle)


def closest_pair(fish):
    """The two fish nearest each other: a crop that keeps them legible."""
    best = None
    for i in range(len(fish)):
        for j in range(i + 1, len(fish)):
            dx = fish[i]["x"] - fish[j]["x"]
            dy = fish[i]["y"] - fish[j]["y"]
            d = dx * dx + dy * dy
            if best is None or d < best[0]:
                best = (d, i, j)
    return None if best is None else (best[1], best[2])


def main():
    D.ensure_dev_server()
    D.kill()
    time.sleep(1.0)
    D.launch()
    tank = D.Drive("tank")
    wait_for(lambda: tank.probe()["counts"]["tank"] >= 1, 30, "the tank page")
    time.sleep(3.0)  # let the fish settle into a cruise

    state = tank.probe()
    path = tank.shot("shot-tank")
    layer = Image.open(path).convert("RGBA")
    tank_img = Image.new("RGBA", layer.size, (255, 255, 255, 255))
    tank_img.alpha_composite(layer)  # the canvas is transparent; the window is white
    tank_img.convert("RGB").save(os.path.join(DOCS, "screenshot-tank.png"), optimize=True)
    print(f"tank   {tank_img.size}  fps={state['fps']} fish={state['counts']}")

    tank.click("btn-boundary")
    wait_for(
        lambda: (lambda s: s["stage"] == "open" and s["counts"]["desk"] > 0)(tank.probe()),
        60,
        "a fish on the desktop",
    )
    time.sleep(4.5)  # colour fade-in finishes, fish spread out

    overlay = D.OverlayDrive()
    wait_for(lambda: len(overlay.probe()["fish"]) > 0, 45, "the overlay page")
    path = overlay.shot("shot-overlay")
    layer = Image.open(path).convert("RGBA")
    info = eval_json(overlay, "{w: innerWidth, h: innerHeight}", "overlay-size.json")
    scale = layer.width / max(1, info["w"])

    base = backdrop(layer.size).convert("RGBA")
    base.alpha_composite(layer)
    desktop = base.convert("RGB")

    # The work area is 2560x1600: three fish in that frame shrink to specks on a
    # page. The delivered image is a 16:9 crop around the two closest fish.
    fish = overlay.probe()["fish"]
    pair = closest_pair(fish)
    if pair:
        chosen = [fish[i] for i in pair]
        box = (
            min(f["x"] for f in chosen) * scale,
            min(f["y"] for f in chosen) * scale,
            max(f["x"] for f in chosen) * scale,
            max(f["y"] for f in chosen) * scale,
        )
    else:
        box = layer.split()[3].getbbox() or (0, 0, desktop.width, desktop.height)
    desktop = desktop.crop(framed(box, desktop.size, margin=240, ratio=16 / 9))

    desktop.save(os.path.join(DOCS, "screenshot-desktop.png"), optimize=True)
    print(f"desk   {desktop.size}  (overlay canvas on a plain backdrop)")

    D.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
