"""Who grows: the frames, the drawing, or the window itself?

    python scripts/memwatch_parts.py

Three phases with the same measurement:
  A  running normally            (frames + drawing)
  B  paused                      (no frames at all — the loop is stopped)
  C  running, but drawing stubbed (frames arrive, nothing is painted)

If A grows and B does not, the frames are responsible. If C still grows, the
cost is in receiving snapshots, not painting them.
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import p3drive as D  # noqa: E402
import perf as P  # noqa: E402

PHASE = 3.0


def total_mb():
    table = P.process_table()
    pids = P.ours(table)
    _, mem = P.cpu_and_mem(pids, table)
    return mem


def heap(drive, name):
    import json

    marker = os.path.join(D.DUMP, name)
    if os.path.exists(marker):
        os.remove(marker)
    drive.run(
        "window.__TAURI__.core.invoke('debug_write', {name: %s, text: JSON.stringify("
        "{u: performance.memory.usedJSHeapSize/1048576})});" % json.dumps(name)
    )
    with open(drive.wait_file(name), encoding="utf-8") as handle:
        return json.load(handle)["u"]


def phase(label, minutes, tank, overlay):
    print(f"\n{label}", flush=True)
    start = time.time()
    first = last = None
    while time.time() - start < minutes * 60:
        mem = total_mb()
        js = heap(overlay, "ov-heap.json") if overlay else 0.0
        elapsed = (time.time() - start) / 60
        print(f"  {elapsed:4.1f} min  ws {mem:6.1f} MB   overlay js {js:5.2f} MB", flush=True)
        if first is None:
            first = mem
        last = mem
        time.sleep(20)
    print(f"  -> {first:.0f} -> {last:.0f} MB ({(last - first) / minutes:+.2f} MB/min)", flush=True)


def open_boundary(tank):
    tank.click("btn-boundary")
    for _ in range(60):
        state = tank.probe()
        if state["stage"] == "open" and state["counts"]["desk"] > 0:
            return
        time.sleep(0.5)
    raise TimeoutError("no fish reached the desktop")


def main():
    D.ensure_dev_server()
    D.kill()
    time.sleep(1.0)
    D.launch()
    tank = D.Drive("tank")
    for _ in range(30):
        try:
            tank.probe()
            break
        except Exception:
            time.sleep(0.5)
    open_boundary(tank)
    overlay = D.OverlayDrive()
    time.sleep(3)

    phase("A: running", PHASE, tank, overlay)

    tank.click("btn-pause")
    time.sleep(2)
    phase("B: paused (no frames at all)", PHASE, tank, overlay)
    tank.click("btn-pause")
    time.sleep(2)

    # stub the paint calls: frames keep arriving, nothing is drawn
    overlay.run(
        "(() => { const c = document.getElementById('overlay-canvas').getContext('2d');"
        " c.fillText = () => {}; c.clearRect = () => {}; c.strokeText = () => {};"
        " return 1; })()"
    )
    phase("C: frames arrive, drawing stubbed", PHASE, tank, overlay)

    D.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
