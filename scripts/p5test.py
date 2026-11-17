"""Phase 5 checks: settings survive a restart, and the installer behaves.

    python scripts/p5test.py            # parts 1 and 2
    python scripts/p5test.py --no-install

Part 1 uses the dev build: change a switch in the real UI, confirm the file on
disk, restart, confirm it came back.
Part 2 uses the built NSIS installer: silent install, launch the installed copy,
check it is *not* the dev build (packaged page = no test hooks), silent
uninstall, and confirm the settings file outlived it.

Both parts report "skipped" rather than "failed" when their preconditions are
missing, so the script stays useful on a machine without the release build.
"""

import glob
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import p3drive as D  # noqa: E402
from p2test import tank as find_tank  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETTINGS = os.path.join(os.environ["APPDATA"], "TextAquarium", "settings.json")
BUNDLE = os.path.join(ROOT, "src-tauri", "target", "release", "bundle", "nsis")
UNINSTALL_KEY = r"Software\Microsoft\Windows\CurrentVersion\Uninstall"

passed = 0
failed = []


def check(name, ok, detail=""):
    global passed
    if ok:
        passed += 1
        print(f"  ok   {name}{f'   ({detail})' if detail else ''}", flush=True)
    else:
        failed.append(name)
        print(f"  FAIL {name}{f'   ({detail})' if detail else ''}", flush=True)
    return ok


def skip(what, why):
    print(f"  skip {what}   ({why})", flush=True)


def section(title):
    print(f"\n{title}", flush=True)


def read_settings():
    if not os.path.exists(SETTINGS):
        return None
    with open(SETTINGS, encoding="utf-8") as handle:
        return json.load(handle)


def checkbox(drive, element_id):
    """Read a checkbox's checked flag through the page channel."""
    name = f"{drive.label}-check.json"
    target = os.path.join(D.DUMP, name)
    if os.path.exists(target):
        os.remove(target)
    drive.run(
        "window.__TAURI__.core.invoke('debug_write', {name: "
        + json.dumps(name)
        + ", text: String(document.getElementById("
        + json.dumps(element_id)
        + ").checked)});"
    )
    with open(drive.wait_file(name), encoding="utf-8") as handle:
        return handle.read().strip() == "true"


def slider(drive, element_id, value):
    """Set a range input the way the UI does: value + input event."""
    drive.run(
        "const e = document.getElementById("
        + json.dumps(element_id)
        + "); e.value = "
        + json.dumps(str(value))
        + "; e.dispatchEvent(new Event('input'));"
    )


def start():
    """Launch and wait until the page answers."""
    D.launch()
    drive = D.Drive("tank")
    for _ in range(24):
        try:
            return drive, drive.probe()
        except Exception:
            time.sleep(0.5)
    raise TimeoutError("the tank page never answered")


# --------------------------------------------------------------------------
# part 1: the settings file
# --------------------------------------------------------------------------


def part_one():
    section("settings: written by the app, read back on the next start")
    D.ensure_dev_server()
    D.kill()
    time.sleep(1.0)
    if os.path.exists(SETTINGS):
        os.remove(SETTINGS)

    try:
        tank, state = start()
    except TimeoutError as err:
        check("app starts", False, str(err))
        return

    check("defaults are in memory", state["settings"]["bubbles"] is True, str(state["settings"]))
    check("the checkbox starts ticked", checkbox(tank, "set-bubbles") is True)
    check("five fish is the default school", state["fishCount"] == 5, str(state["fishCount"]))
    check("no file is written before anything changes", not os.path.exists(SETTINGS), SETTINGS)

    tank.click("set-bubbles")
    time.sleep(1.2)
    saved = read_settings()
    check(
        "turning bubbles off writes the file",
        saved is not None and saved.get("bubbles") is False,
        json.dumps(saved),
    )
    check("the in-memory state agrees", tank.probe()["settings"]["bubbles"] is False)

    D.kill()
    time.sleep(1.0)
    try:
        tank, state = start()
    except TimeoutError as err:
        check("restart", False, str(err))
        return
    check("a restart remembers it", state["settings"]["bubbles"] is False, str(state["settings"]))
    check("the checkbox is drawn unchecked", checkbox(tank, "set-bubbles") is False)

    tank.click("set-bubbles")
    time.sleep(1.0)
    restored = read_settings() or {}
    check("and it can be switched back", restored.get("bubbles") is True, json.dumps(restored))
    check(
        "the file holds every documented key",
        set(restored)
        == {"seaweed", "bubbles", "highFps", "count", "size", "liveliness", "customGlyph", "customFacing"},
        json.dumps(restored),
    )

    # the school size slider round-trips too: 5 -> 6 fish, restart, count
    slider(tank, "set-count", 6)
    time.sleep(1.2)
    saved = read_settings() or {}
    check("growing the school writes the file", saved.get("count") == 6, json.dumps(saved))
    check("and the school follows at once", tank.probe()["fishCount"] == 6, str(tank.probe()["fishCount"]))

    D.kill()
    time.sleep(1.0)
    try:
        tank, state = start()
    except TimeoutError as err:
        check("restart after the slider", False, str(err))
        return
    check("a restart remembers six fish", state["fishCount"] == 6, str(state["fishCount"]))
    check("all six are inside", state["counts"]["tank"] == 6, str(state["counts"]))

    slider(tank, "set-count", 5)
    time.sleep(1.0)
    check("and it can be set back", (read_settings() or {}).get("count") == 5)
    D.kill()
    time.sleep(0.8)


# --------------------------------------------------------------------------
# part 2: the installer
# --------------------------------------------------------------------------


def find_setup():
    found = sorted(glob.glob(os.path.join(BUNDLE, "*setup.exe")))
    return found[0] if found else None


def installed_location():
    """Where NSIS put it, per the uninstall entry it wrote."""
    try:
        import winreg
    except ImportError:
        return None
    try:
        root = winreg.OpenKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY)
    except OSError:
        return None
    try:
        for index in range(winreg.QueryInfoKey(root)[0]):
            name = winreg.EnumKey(root, index)
            try:
                key = winreg.OpenKey(root, name)
                display = winreg.QueryValueEx(key, "DisplayName")[0]
            except OSError:
                continue
            if "Aquarium" not in str(display):
                continue
            for field in ("InstallLocation", "DisplayIcon", "UninstallString"):
                try:
                    value = winreg.QueryValueEx(key, field)[0]
                except OSError:
                    continue
                path = str(value).strip('"').split(",")[0]
                if os.path.isdir(path):
                    return path
                parent = os.path.dirname(path)
                if parent and os.path.isdir(parent):
                    return parent
    finally:
        root.Close()
    return None


def dump_newest():
    """Newest reply the pages have written (probe JSON / canvas PNG).

    Command files are excluded on purpose: this script writes those itself, so
    they would look like a reply from the app.
    """
    if not os.path.isdir(D.DUMP):
        return 0
    return max(
        (
            os.path.getmtime(os.path.join(D.DUMP, name))
            for name in os.listdir(D.DUMP)
            if os.path.isfile(os.path.join(D.DUMP, name))
            and (name.endswith(".json") or name.endswith(".png"))
        ),
        default=0,
    )


def part_two():
    section("installer: install, launch, uninstall")
    setup = find_setup()
    if not setup:
        skip("installer exists", f"no *setup.exe under {BUNDLE}")
        return

    check("installer exists", True, f"{os.path.basename(setup)}, {os.path.getsize(setup) / 1048576:.1f} MB")

    install = subprocess.run([setup, "/S"], capture_output=True)
    time.sleep(5)
    check("silent install exits cleanly", install.returncode == 0, f"rc={install.returncode}")

    where = installed_location()
    check("the installer registered an uninstall entry", where is not None, str(where))
    if not where:
        return

    exe = os.path.join(where, "text-aquarium.exe")
    check("program files are in place", os.path.exists(exe), where)
    check("an uninstaller came with it", os.path.exists(os.path.join(where, "uninstall.exe")), where)
    if not os.path.exists(exe):
        return

    D.kill()
    time.sleep(0.8)
    before = dump_newest()
    probe_marker = os.path.join(D.DUMP, "installed-probe.json")
    if os.path.exists(probe_marker):
        os.remove(probe_marker)
    channel = os.path.join(D.DUMP, "cmd-tank.js")
    with open(channel, "w", encoding="utf-8") as handle:
        handle.write(
            "window.__TAURI__.core.invoke('debug_write', {name: 'installed-probe.json', text: 'hooked'});"
        )

    subprocess.Popen([exe], cwd=where)
    time.sleep(7)
    hwnd = find_tank()
    check("the installed app opens its window", hwnd is not None, f"hwnd={hwnd}")

    time.sleep(2.0)
    after = dump_newest()
    replied = os.path.exists(probe_marker)
    check(
        "the installed build ignores the dev command channel",
        not replied and after <= before,
        "the page answered the probe" if replied
        else f"newest reply {time.strftime('%H:%M:%S', time.localtime(after))} vs {time.strftime('%H:%M:%S', time.localtime(before))}",
    )
    if os.path.exists(channel) and os.path.getsize(channel) > 0:
        os.remove(channel)  # nobody consumed it — that is the point

    subprocess.run(["taskkill", "/F", "/IM", "text-aquarium.exe"], capture_output=True)
    time.sleep(1.5)

    uninst = os.path.join(where, "uninstall.exe")
    subprocess.run([uninst, "/S"], capture_output=True)
    time.sleep(6)
    check("uninstall removes the program", not os.path.exists(exe), where)
    check(
        "uninstall deregisters itself",
        installed_location() is None or not os.path.isdir(where),
        str(installed_location()),
    )
    check("the settings file outlived the uninstall", os.path.exists(SETTINGS), SETTINGS)

    left = subprocess.run(["tasklist", "/FI", "IMAGENAME eq text-aquarium.exe"], capture_output=True)
    check("nothing is left running", b"text-aquarium.exe" not in left.stdout)


def main():
    part_one()
    if "--no-install" not in sys.argv:
        part_two()
    print(f"\n{passed} passed, {len(failed)} failed", flush=True)
    for name in failed:
        print(f"  - {name}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
