"""Long-run check: does anything grow while the tank is left running?

    python scripts/soak.py [minutes] [--warmup 2]

Opens the boundary, lets the fish come and go, toggles catching mode and pause
along the way, and samples memory / process count / liveness every 20 seconds.

Two things learned the hard way are baked in:

  * a fresh WebView2 allocates its compositor tiles lazily, so the first couple
    of minutes always climb — that is warm-up, not a leak, and it is measured
    separately instead of being counted as growth;
  * the number that matters is the slope *after* warm-up, not the delta from
    the first sample ever taken.

A desktop pet that gains 10 MB an hour would be a problem by the end of a day.
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import p3drive as D  # noqa: E402
import perf as P  # noqa: E402

LIMIT_MB_PER_MIN = 2.0


def sample(drive):
    table = P.process_table()
    pids = P.ours(table)
    working, private = P.memory(pids)
    try:
        state = drive.probe()
        counts = state["counts"]
        stage = state["stage"]
        fps = state["fps"]
    except Exception as error:  # renamed to TimeoutError above; keep it broad
        print(f"  probe failed: {error}", flush=True)
        counts, stage, fps = None, "?", 0
    return working, private, len(pids), counts, stage, fps


def startup(drive, seconds):
    """Fish crossing, catching mode off: the state the soak measures."""
    print(f"warm-up: {seconds / 60:g} min (the first minutes of a WebView2 always climb)", flush=True)
    start = time.time()
    while time.time() - start < seconds:
        working, private, procs, counts, stage, fps = sample(drive)
        print(
            f"  warm {(time.time() - start) / 60:5.1f} min  ws {working:6.1f} MB  "
            f"commit {private:6.1f} MB  {procs} proc  stage={stage} tank={counts} fps={fps}",
            flush=True,
        )
        time.sleep(20)


def main():
    minutes = float(sys.argv[1]) if len(sys.argv) > 1 else 5.0
    warmup = 2.0
    if "--warmup" in sys.argv:
        warmup = float(sys.argv[sys.argv.index("--warmup") + 1])

    D.ensure_dev_server()
    D.kill()
    time.sleep(1.0)
    D.launch()
    tank = D.Drive("tank")
    for _ in range(24):
        try:
            tank.probe()
            break
        except Exception:
            time.sleep(0.5)
    time.sleep(2.0)

    tank.click("btn-boundary")
    for _ in range(60):
        state = tank.probe()
        if state["stage"] == "open" and state["counts"]["desk"] > 0:
            break
        time.sleep(0.5)

    startup(tank, warmup * 60)

    rows = []
    start = time.time()
    round_no = 0
    print(f"\nsoak: {minutes:g} minutes, sampling every 20s", flush=True)
    while time.time() - start < minutes * 60:
        round_no += 1
        if not D.app_running():
            print(
                f"\nthe app disappeared after {rows[-1][0]:.1f} min of measuring"
                if rows
                else "\nthe app disappeared before the first sample",
                flush=True,
            )
            D.crash_notes()
            return 2

        working, private, procs, counts, stage, fps = sample(tank)
        elapsed = (time.time() - start) / 60
        rows.append((elapsed, working, private, procs))
        print(
            f"  {elapsed:5.1f} min  ws {working:6.1f} MB  commit {private:6.1f} MB  "
            f"{procs} proc  stage={stage} tank={counts} fps={fps}",
            flush=True,
        )

        # keep it exercised: catching mode on/off, and a pause every other round
        try:
            if round_no % 3 == 0:
                tank.click("btn-hunt")
                time.sleep(1.5)
                tank.click("btn-hunt")
            if round_no % 5 == 0:
                tank.click("btn-pause")
                time.sleep(1.5)
                tank.click("btn-pause")
        except Exception as error:
            print(f"\nthe page stopped answering after {elapsed:.1f} min: {error}", flush=True)
            D.crash_notes()
            return 2
        time.sleep(18)

    first, last = rows[0][2], rows[-1][2]
    peak = max(row[2] for row in rows)
    span = max(0.01, rows[-1][0] - rows[0][0])
    slope = (last - first) / span
    print(
        f"\ncommit {first:.1f} MB -> {last:.1f} MB over {span:.1f} min "
        f"(peak {peak:.1f} MB, slope {slope:+.2f} MB/min)",
        flush=True,
    )
    print(
        f"working set {rows[0][1]:.1f} MB -> {rows[-1][1]:.1f} MB "
        f"(trimmed by Windows now and then — cache, not commitment)",
        flush=True,
    )
    stable = abs(slope) < LIMIT_MB_PER_MIN and rows[-1][3] == rows[0][3]
    print(
        "stable" if stable else f"NOT STABLE (more than {LIMIT_MB_PER_MIN:g} MB/min of commit)",
        flush=True,
    )
    D.kill()
    return 0 if stable else 1


if __name__ == "__main__":
    sys.exit(main())
