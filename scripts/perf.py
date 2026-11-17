"""Measure what the tank actually costs, in the two modes that matter.

    python scripts/perf.py

CPU is a percentage of ONE core (a task manager showing "% of all cores" would
divide it by the core count). The whole process tree is summed — the app plus
every WebView2 child it owns — because leaving out the renderer processes would
be exactly the kind of number that looks good and means nothing.
"""

import ctypes
import os
import sys
import time
from ctypes import wintypes as wt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import p3drive as D  # noqa: E402

k32 = ctypes.windll.kernel32
psapi = ctypes.windll.psapi

TH32CS_SNAPPROCESS = 0x00000002
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wt.DWORD),
        ("cntUsage", wt.DWORD),
        ("th32ProcessID", wt.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wt.DWORD),
        ("cntThreads", wt.DWORD),
        ("th32ParentProcessID", wt.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wt.DWORD),
        ("szExeFile", ctypes.c_wchar * 260),
    ]


class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("cb", wt.DWORD),
        ("PageFaultCount", wt.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
    """Same as above plus PrivateUsage — commit charge, which the OS cannot trim.

    Working set is what Task Manager shows by default and it goes down when
    Windows decides to trim it, so a slow rise in working set can be caching
    rather than a leak. Private bytes only goes up when the process really
    allocates, which makes it the honest number for "does it leak".
    """

    _fields_ = PROCESS_MEMORY_COUNTERS._fields_ + [
        ("PrivateUsage", ctypes.c_size_t),
    ]


def process_table():
    """{pid: (parent_pid, exe_name)} for every process we can see."""
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == -1:
        return {}
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
    table = {}
    ok = k32.Process32FirstW(snap, ctypes.byref(entry))
    while ok:
        table[entry.th32ProcessID] = (entry.th32ParentProcessID, entry.szExeFile)
        ok = k32.Process32NextW(snap, ctypes.byref(entry))
    k32.CloseHandle(snap)
    return table


def ours(table):
    """The app's own processes: the exe plus anything descending from it."""
    roots = {pid for pid, (_, name) in table.items() if name.lower() == "text-aquarium.exe"}
    if not roots:
        return set()
    owned = set(roots)
    changed = True
    while changed:
        changed = False
        for pid, (parent, _) in table.items():
            if pid not in owned and parent in owned:
                owned.add(pid)
                changed = True
    return owned


def cpu_and_mem(pids, table):
    total_cpu = 0
    total_mem = 0
    for pid in pids:
        handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            continue
        times = [wt.FILETIME() for _ in range(4)]
        if k32.GetProcessTimes(handle, *[ctypes.byref(t) for t in times]):
            for t in times[2:]:  # kernel + user
                total_cpu += (t.dwHighDateTime << 32) | t.dwLowDateTime
        counters = PROCESS_MEMORY_COUNTERS()
        counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
        if psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
            total_mem += counters.WorkingSetSize
        k32.CloseHandle(handle)
    return total_cpu / 1e7, total_mem / 1048576.0  # seconds, MB


def commit(pids):
    """Private bytes (commit) of the tree in MB — the number a leak shows up in."""
    total = 0
    for pid in pids:
        handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            continue
        counters = PROCESS_MEMORY_COUNTERS_EX()
        counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS_EX)
        if psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
            total += counters.PrivateUsage
        k32.CloseHandle(handle)
    return total / 1048576.0


def memory(pids):
    """(working set MB, private MB) for the whole tree."""
    return cpu_and_mem(pids, None)[1], commit(pids)


def sample(seconds, label):
    table = process_table()
    pids = ours(table)
    if not pids:
        print(f"  {label}: process is gone", flush=True)
        return 0.0, 0.0
    cpu0, _ = cpu_and_mem(pids, table)
    t0 = time.time()
    time.sleep(seconds)
    cpu1, mem = cpu_and_mem(ours(process_table()), process_table())
    wall = time.time() - t0
    pct = (cpu1 - cpu0) / wall * 100.0
    print(
        f"  {label}: {pct:5.1f}% of one core, {mem:6.1f} MB, {len(pids)} process(es)",
        flush=True,
    )
    return pct, mem


def main():
    D.ensure_dev_server()
    D.kill()
    time.sleep(1.0)
    D.launch()
    tank = D.Drive("tank")
    for _ in range(20):
        try:
            tank.probe()
            break
        except Exception:
            time.sleep(0.5)
    time.sleep(3.0)

    print("tank mode (boundary closed)", flush=True)
    tank_cpu, tank_mem = sample(20, "tank")
    state = tank.probe()
    print(f"  {state['fps']} fps, {state['counts']['tank']} fish inside", flush=True)

    print("\ndesktop mode (boundary open, fish on the desktop)", flush=True)
    tank.click("btn-boundary")
    deadline = time.time() + 40
    outside = 0
    while time.time() < deadline:
        state = tank.probe()
        outside = state["counts"]["desk"]
        if state["stage"] == "open" and outside > 0:
            break
        time.sleep(0.5)
    time.sleep(2.0)
    desk_cpu, desk_mem = sample(25, "desktop")
    state = tank.probe()
    print(f"  {state['fps']} fps, {outside} outside / {state['counts']['tank']} inside", flush=True)

    D.kill()
    print(
        f"\ndesktop mode costs +{desk_cpu - tank_cpu:.1f}% of a core and "
        f"+{desk_mem - tank_mem:.0f} MB over the tank alone",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
