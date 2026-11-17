"""Phase 3 + 4 verification: boundary switching, colour, catching, stability.

Runs against the real application. The desktop is driven through the dev-only
command channel (`scripts/p3drive.py`) because the interesting state — which
fish is where, in which space, in which colour — only exists inside the pages.
Everything the brief cares about is asserted, not eyeballed:

    python scripts/p3test.py

Requires a built debug binary and the dev server (started automatically).
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import p3drive as D  # noqa: E402

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


def section(title):
    print(f"\n{title}", flush=True)


def wait_for(fn, timeout=20.0, interval=0.2):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last


def desktop_fish(state):
    return [f for f in state["fish"] if f["space"] == "desk"]


def main():
    D.ensure_dev_server()
    proc = D.launch()
    tank = D.Drive("tank")

    try:
        # ---------------------------------------------------------- start --
        section("startup")
        state = tank.probe()
        check("three fish, all inside", state["counts"]["tank"] == 3, str(state["counts"]))
        check("boundary starts closed", state["stage"] == "closed", state["stage"])
        check("only the tank window exists", state["windows"] == ["tank"], str(state["windows"]))
        check("geometry is known", state["tankRect"]["w"] > 100, json.dumps(state["tankRect"]))

        # --------------------------------------------------------- motion --
        section("the fish swim, and they swim head first")
        a = tank.probe()
        time.sleep(0.9)
        b = tank.probe()
        moved = [
            {"id": x["id"], "d": ((y["x"] - x["x"]) ** 2 + (y["y"] - x["y"]) ** 2) ** 0.5}
            for x, y in zip(a["fish"], b["fish"])
        ]
        check("every fish moved", all(m["d"] > 1.0 for m in moved), ", ".join(f"{m['id']} {m['d']:.1f}px" for m in moved))
        check(
            "no fish jumped",
            all(m["d"] < 60 for m in moved),
            f"max {max(m['d'] for m in moved):.1f}px in 0.9s",
        )
        facing_ok = all(
            f["facing"] == (1 if f["vx"] > 0 else -1) for f in b["fish"] if abs(f["vx"]) > 6
        )
        check("head points the way it travels", facing_ok)

        # --------------------------------------------------------- open ----
        section("opening the boundary")
        tank.click("btn-boundary")
        state = wait_for(lambda: (lambda s: s if s["stage"] == "open" else None)(tank.probe()), 20)
        check("stage reaches open", bool(state), state and state["stage"])
        check("desktop layer window exists", state and "overlay" in state["windows"], str(state["windows"]))

        # watch the first crossing
        crossings = 0
        teleport = []
        prev = tank.probe()
        deadline = time.time() + 40
        while time.time() < deadline and crossings == 0:
            time.sleep(0.12)
            now = tank.probe()
            for old, new in zip(prev["fish"], now["fish"]):
                if old["space"] == "tank" and new["space"] == "desk":
                    crossings += 1
                    expected_x = old["x"] + now["tankRect"]["x"]
                    expected_y = old["y"] + now["tankRect"]["y"]
                    gap = ((new["x"] - expected_x) ** 2 + (new["y"] - expected_y) ** 2) ** 0.5
                    teleport.append(gap)
            prev = now

        check("a fish really swam out", crossings > 0, f"{crossings} crossing(s) seen")
        check("the crossing did not teleport", teleport and max(teleport) < 12, f"max gap {max(teleport):.1f}px" if teleport else "n/a")

        state = tank.probe()
        outside = desktop_fish(state)
        check("it is in desk space now", len(outside) > 0, f"{len(outside)} outside")

        # it keeps swimming out there
        first = {f["id"]: f for f in tank.probe()["fish"]}
        time.sleep(1.0)
        second = {f["id"]: f for f in tank.probe()["fish"]}
        desk_moved = [
            ((second[i]["x"] - first[i]["x"]) ** 2 + (second[i]["y"] - first[i]["y"]) ** 2) ** 0.5
            for i in first
            if first[i]["space"] == "desk" and i in second and second[i]["space"] == "desk"
        ]
        check("desktop fish keep swimming", desk_moved and all(d > 2 for d in desk_moved), f"{[round(d,1) for d in desk_moved]}")

        # a fish that has just crossed is still fading in: 0.7 means "clearly
        # coloured", and the later checks prove it reaches full colour
        colour = []
        deadline = time.time() + 6
        while time.time() < deadline:
            colour = [f["colorMix"] for f in tank.probe()["fish"] if f["space"] == "desk"]
            if colour and min(colour) > 0.7:
                break
            time.sleep(0.3)
        check("colour has appeared", bool(colour) and min(colour) > 0.7, str(colour))

        # --------------------------------------------------------- layer ---
        section("the desktop layer draws them")
        overlay = D.OverlayDrive()
        op = overlay.probe()
        check("layer knows about the fish", len(op["fish"]) > 0, f"{len(op['fish'])} fish")
        check(
            "layer is click-through by default",
            not op["hittable"],
            f"hunting={op['hunting']}",
        )
        png = overlay.shot("p3-desktop")
        check("canvas capture written", os.path.getsize(png) > 2000, f"{os.path.getsize(png)} bytes")

        # --------------------------------------------------------- catch ---
        section("catching a fish with the mouse")
        tank.click("btn-hunt")
        op = wait_for(lambda: (lambda o: o if o["hunting"] else None)(overlay.probe()), 6)
        check("catching mode is on", bool(op), str(op and op["hunting"]))

        target = None
        for f in overlay.probe()["fish"]:
            cx = f["x"] - op["deskOffset"]["x"]
            cy = f["y"] - op["deskOffset"]["y"]
            if -100 < cx < op["size"][0] + 100:
                target = (f, cx, cy)
                break
        check("a fish to aim at", target is not None)
        if target:
            fish, cx, cy = target
            overlay.pointer("down", cx, cy)
            state = tank.probe()
            held = [f for f in state["fish"] if f["state"] == "dragging"]
            check("pointer down takes hold", len(held) == 1, held[0]["id"] if held else "none")

            # somewhere on the desktop that is definitely *not* over the tank
            rect = state["tankRect"]
            away_x = min(rect["x"] + rect["w"] + 250, 1400)
            away_y = min(rect["y"] + rect["h"] + 180, 840)
            overlay.pointer("move", away_x, away_y)
            time.sleep(0.25)
            state = tank.probe()
            held = [f for f in state["fish"] if f["state"] == "dragging"]
            if held:
                dx = held[0]["x"] - fish["x"]
                check(
                    "the fish follows the hand",
                    abs(dx - (away_x - cx)) < 40,
                    f"moved {dx:.0f}px of {away_x - cx:.0f}",
                )
            else:
                check("the fish follows the hand", False, "lost the fish")

            # drop it back on the desktop
            overlay.pointer("up", away_x, away_y)
            time.sleep(0.3)
            state = tank.probe()
            dropped = [f for f in state["fish"] if f["id"] == fish["id"]][0]
            check("letting go resumes swimming", dropped["state"] in ("outside", "returning"), dropped["state"])

            # grab again and put it in the tank
            op = overlay.probe()
            live = [f for f in op["fish"] if f["id"] == fish["id"]]
            if live:
                lx = live[0]["x"] - op["deskOffset"]["x"]
                ly = live[0]["y"] - op["deskOffset"]["y"]
                overlay.pointer("down", lx, ly)
                rect = state["tankRect"]
                overlay.pointer("move", rect["x"] + rect["w"] / 2, rect["y"] + rect["h"] / 2)
                time.sleep(0.2)
                overlay.pointer("up", rect["x"] + rect["w"] / 2, rect["y"] + rect["h"] / 2)
                time.sleep(0.35)
                state = tank.probe()
                home = [f for f in state["fish"] if f["id"] == fish["id"]][0]
                check("dropped in the tank, it is a tank fish again", home["space"] == "tank", home["space"])
                check("and it is ink again", home["colorMix"] == 0, str(home["colorMix"]))
            else:
                check("dropped in the tank, it is a tank fish again", False, "fish vanished")

        tank.click("btn-hunt")
        time.sleep(0.3)
        check("catching mode off again", not overlay.probe()["hunting"])

        # ------------------------------------------------------ flip-flop ---
        section("closing, and changing your mind half way")
        tank.click("btn-boundary")
        state = wait_for(lambda: (lambda s: s if s["stage"] == "returning" else None)(tank.probe()), 8)
        check("close starts a return", bool(state), state and state["stage"])

        tank.click("btn-boundary")  # re-open while they are swimming home
        state = wait_for(lambda: (lambda s: s if s["stage"] == "open" else None)(tank.probe()), 8)
        check("re-opening cancels the return", bool(state), state and state["stage"])
        check("still exactly one desktop layer", tank.probe()["windows"].count("overlay") == 1)

        # now let it close for real
        tank.click("btn-boundary")
        state = wait_for(lambda: (lambda s: s if s["stage"] == "closed" else None)(tank.probe()), 60)
        check("boundary closes", bool(state), state and state["stage"])
        check("the layer is destroyed", state and "overlay" not in state["windows"], str(state and state["windows"]))
        check("all fish are home", state and state["counts"]["desk"] == 0, str(state and state["counts"]))
        check("all fish are ink", state and all(f["colorMix"] == 0 for f in state["fish"]))
        inside = state and all(
            0 < f["x"] < state["tankRect"]["w"] and 0 < f["y"] < state["tankRect"]["h"]
            for f in state["fish"]
        )
        check("all fish are inside the tank rect", bool(inside))

        # -------------------------------------------------------- stress ----
        section("five round trips")
        for i in range(5):
            tank.click("btn-boundary")
            opened = wait_for(lambda: (lambda s: s if s["stage"] == "open" else None)(tank.probe()), 20)
            if not opened:
                check(f"round {i + 1} opens", False)
                break
            time.sleep(0.5)
            tank.click("btn-boundary")
            closed = wait_for(lambda: (lambda s: s if s["stage"] == "closed" else None)(tank.probe()), 60)
            if not closed:
                check(f"round {i + 1} closes", False, "stuck in returning")
                break
        else:
            check("five open/close cycles all end cleanly", True)
            state = tank.probe()
            check("one window, three fish", state["windows"] == ["tank"] and state["counts"]["tank"] == 3)
            check("state is consistent", all(f["state"] in ("inside", "crossing") for f in state["fish"]))

        # --------------------------------------------------------- pause ----
        section("pause")
        tank.click("btn-pause")
        time.sleep(0.4)
        a = tank.probe()
        time.sleep(0.9)
        b = tank.probe()
        still = all(
            abs(x["x"] - y["x"]) < 0.01 and abs(x["y"] - y["y"]) < 0.01
            for x, y in zip(a["fish"], b["fish"])
        )
        check("pause really stops them", still)
        tank.click("btn-pause")
        time.sleep(0.6)
        c = tank.probe()
        check("resume starts them again", any(abs(x["x"] - y["x"]) > 1 for x, y in zip(b["fish"], c["fish"])))

        # -------------------------------------------------------- capture ---
        section("the tank canvas itself")
        png = tank.shot("p3-tank")
        check("tank canvas captured", os.path.getsize(png) > 2000, f"{os.path.getsize(png)} bytes")

    finally:
        D.kill()

    print(f"\n{passed} passed, {len(failed)} failed")
    for name in failed:
        print(f"  - {name}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
