"""Drive a running Text Aquarium through its dev-only command channel.

Why this exists: a desktop pet lives in two webviews, and the interesting
questions ("did the fish leave the tank?", "is the body leaning into its
heading?") are only answerable from inside the page. When the pages are served
by the local dev server they poll `%TEMP%\\text-aquarium-dump\\cmd-<page>.js`
and run whatever they find there; `__probe()` writes the state back and
`__shot()` writes the canvas as a PNG.

Windows' own mouse and pixel checks stay in `p2smoke.py` — this module is for
the things only the page can see.

    proc = launch()          # start the app (dev server must be running)
    proc, drive = proc, Drive(proc)
    state = drive.probe()    # JSON from the tank page
    drive.click("btn-boundary")
"""

import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(ROOT, "src-tauri", "target", "debug", "text-aquarium.exe")
DUMP = os.path.join(os.environ["TEMP"], "text-aquarium-dump")


def _path(*parts):
    return os.path.join(DUMP, *parts)


class Drive:
    def __init__(self, label="tank"):
        self.label = label
        os.makedirs(DUMP, exist_ok=True)

    # ---- channel -------------------------------------------------------

    def send(self, js, timeout=8.0):
        """Hand a snippet to a page and wait until it has been picked up."""
        channel = _path(f"cmd-{self.label}.js")
        with open(channel, "w", encoding="utf-8") as handle:
            handle.write(js)
        deadline = time.time() + timeout
        while time.time() < deadline:
            if os.path.exists(channel) and os.path.getsize(channel) == 0:
                return True
            time.sleep(0.02)
        return False

    def run(self, js, timeout=8.0):
        if not self.send(js, timeout):
            raise TimeoutError(f"page {self.label} did not take: {js[:60]}")

    def wait_file(self, name, timeout=8.0):
        target = _path(name)
        deadline = time.time() + timeout
        while time.time() < deadline:
            if os.path.exists(target) and os.path.getsize(target) > 0:
                time.sleep(0.03)  # let the write finish
                return target
            time.sleep(0.02)
        raise TimeoutError(f"{name} never appeared")

    def probe(self, timeout=8.0):
        target = _path(f"{self.label}.json")
        if os.path.exists(target):
            os.remove(target)
        self.run("__probe()")
        with open(self.wait_file(f"{self.label}.json", timeout), encoding="utf-8") as handle:
            return json.load(handle)

    def shot(self, name, timeout=10.0):
        target = _path(f"{name}.png")
        if os.path.exists(target):
            os.remove(target)
        self.run(f"__shot({json.dumps(name)})")
        return self.wait_file(f"{name}.png", timeout)

    def click(self, element_id):
        self.run(f"document.getElementById({json.dumps(element_id)}).click()")

    def text(self, element_id):
        """Read a piece of DOM text through the same channel."""
        target = _path(f"{self.label}-text.json")
        if os.path.exists(target):
            os.remove(target)
        js = (
            "window.__TAURI__.core.invoke('debug_write', {name: "
            + json.dumps(f"{self.label}-text.json")
            + ", text: document.getElementById("
            + json.dumps(element_id)
            + ").textContent});"
        )
        self.run(js)
        with open(self.wait_file(f"{self.label}-text.json"), encoding="utf-8") as handle:
            return handle.read()

    def wait_stage(self, stage, timeout=20.0):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            last = self.probe()
            if last["stage"] == stage:
                return last
            time.sleep(0.25)
        raise TimeoutError(f"stage never reached {stage}, last {last and last['stage']}")


class OverlayDrive(Drive):
    def __init__(self):
        super().__init__("overlay")

    def pointer(self, kind, x, y):
        self.run(f"__pointer({json.dumps(kind)}, {x}, {y})")


def clear_dump():
    if not os.path.isdir(DUMP):
        return
    for name in os.listdir(DUMP):
        if name.startswith("cmd-") or name.endswith(".json") or name.endswith(".png"):
            try:
                os.remove(os.path.join(DUMP, name))
            except OSError:
                pass


def app_running():
    out = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq text-aquarium.exe"], capture_output=True
    )
    return b"text-aquarium.exe" in out.stdout


def launch(wait=25.0):
    """Start the built debug binary and wait for its command channel."""
    if app_running():
        subprocess.run(["taskkill", "/F", "/IM", "text-aquarium.exe"], capture_output=True)
        time.sleep(0.8)
    clear_dump()
    proc = subprocess.Popen([EXE], cwd=os.path.dirname(EXE))
    deadline = time.time() + wait
    while time.time() < deadline:
        if app_running():
            # the page installs its hooks right after boot; a probe that lands
            # first would sit in the channel until then, so just wait a moment
            time.sleep(2.0)
            return proc
        time.sleep(0.2)
    raise TimeoutError("app did not start")


def kill():
    subprocess.run(["taskkill", "/F", "/IM", "text-aquarium.exe"], capture_output=True)


def crash_notes():
    """Why did it go away? Print whatever Windows recorded, or say nothing did."""
    out = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-Command",
            "Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddMinutes(-10)}"
            " -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'text-aquarium|msedgewebview2' }"
            " | Select-Object -First 4 | ForEach-Object { $_.TimeCreated.ToString('HH:mm:ss') + ' ' +"
            " $_.ProviderName + ' ' + $_.Id + ' ' + ($_.Message -split \"`n\")[0] }",
        ],
        capture_output=True,
        text=True,
    )
    text = (out.stdout or "").strip()
    print(
        f"windows event log: {text}" if text else "windows event log: nothing (no crash was recorded)",
        flush=True,
    )


def ensure_dev_server(port=5183, wait=8.0):
    """The debug binary loads its pages from the dev server; start it if needed."""
    import socket

    def up():
        with socket.socket() as sock:
            sock.settimeout(0.3)
            return sock.connect_ex(("127.0.0.1", port)) == 0

    if up():
        return None
    proc = subprocess.Popen(
        ["node", os.path.join(ROOT, "scripts", "dev-server.mjs")],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + wait
    while time.time() < deadline:
        if up():
            return proc
        time.sleep(0.2)
    proc.kill()
    raise RuntimeError("dev server did not start")


if __name__ == "__main__":
    ensure_dev_server()
    proc = launch()
    drive = Drive()
    print(json.dumps(drive.probe(), indent=2)[:1200])
    kill()
    sys.exit(0)
