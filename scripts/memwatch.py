"""Where does the memory go? Per-process working set, two phases.

    python scripts/memwatch.py [minutes-per-phase]

Phase A keeps the boundary closed (one webview, three fish).
Phase B opens it (two webviews, fish crossing).
Separating the two says whether growth belongs to the simulation or to the
second transparent window.
"""

import ctypes
import os
import sys
import time
from ctypes import wintypes as wt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import p3drive as D  # noqa: E402
import perf as P  # noqa: E402


def rows():
    table = P.process_table()
    pids = P.ours(table)
    out = []
    for pid in sorted(pids):
        handle = P.k32.OpenProcess(P.PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            continue
        counters = P.PROCESS_MEMORY_COUNTERS()
        counters.cb = ctypes.sizeof(P.PROCESS_MEMORY_COUNTERS)
        mb = 0.0
        if P.psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
            mb = counters.WorkingSetSize / 1048576.0
        P.k32.CloseHandle(handle)
        name = table.get(pid, (0, "?"))[1]
        out.append((name, pid, mb))
    return out


def phase(label, minutes, drive):
    print(f"\n{label}", flush=True)
    start = time.time()
    first = None
    while time.time() - start < minutes * 60:
        snapshot = rows()
        total = sum(mb for _, _, mb in snapshot)
        detail = "  ".join(
            f"{name.split('.')[0][:8]}#{pid}:{mb:.0f}"
            for name, pid, mb in sorted(snapshot, key=lambda r: -r[2])[:4]
        )
        elapsed = (time.time() - start) / 60
        print(f"  {elapsed:4.1f} min  total {total:6.1f} MB   {detail}", flush=True)
        if first is None:
            first = total
        time.sleep(30)
    print(f"  -> {first:.0f} MB to {total:.0f} MB in {minutes:g} min", flush=True)
    return first, total


def main():
    minutes = float(sys.argv[1]) if len(sys.argv) > 1 else 4.0
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
    time.sleep(3.0)

    phase("phase A: tank only", minutes, tank)

    tank.click("btn-boundary")
    for _ in range(60):
        state = tank.probe()
        if state["stage"] == "open" and state["counts"]["desk"] > 0:
            break
        time.sleep(0.5)

    phase("phase B: fish on the desktop", minutes, tank)
    D.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
