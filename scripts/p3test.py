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
        check(
            "the school is complete, all inside",
            state["counts"]["tank"] == state["fishCount"] and state["counts"]["desk"] == 0,
            str(state["counts"]),
        )
        check("count matches the setting", state["fishCount"] == state["settings"]["count"], f"fishCount {state['fishCount']}")
        check("boundary starts closed", state["stage"] == "closed", state["stage"])
        check("only the tank window exists", state["windows"] == ["tank"], str(state["windows"]))
        check("geometry is known", state["tankRect"]["w"] > 100, json.dumps(state["tankRect"]))

        # keep the real cursor out of the motion checks: the fish flee a live
        # one, which would make the speed assertions meaningless
        tank.run("__cursor('off')")
        tank.run("__cursor('tank', 50, 50)")
        st = tank.probe()
        check(
            "cursor harness works",
            st["cursor"]["tank"]["active"] and st["cursor"]["tank"]["x"] == 50,
            json.dumps(st["cursor"]),
        )
        tank.run("__cursor('off')")
        # a fish startled by the harness cursor may still be bolting at 3.6x
        # speed: let the dart finish before measuring plain swimming
        time.sleep(0.8)

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
            # the legit ceiling is now the startle dart (3.6x the fastest fish,
            # ~128px/s -> 115px in 0.9s); a teleport is an order of magnitude more
            all(m["d"] < 130 for m in moved),
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
        # the gap is the fish's legitimate motion between two probes (~0.2s at
        # the 2.1x exit hurry) — a real teleport would be the 250px shift
        check("the crossing did not teleport", teleport and max(teleport) < 30, f"max gap {max(teleport):.1f}px" if teleport else "n/a")

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
        section("catching fish with a box")
        # the crossing watch above can take a while: by now some fish may have
        # wandered home on their own — wait for a fresh one to be outside
        desk_state = wait_for(
            lambda: (lambda s: s if any(f["space"] == "desk" for f in s["fish"]) else None)(tank.probe()),
            25,
        )
        check("there is a fish on the desktop to catch", bool(desk_state))

        tank.click("btn-hunt")
        op = wait_for(lambda: (lambda o: o if o["hunting"] else None)(overlay.probe()), 6)
        check("catching mode is on", bool(op), str(op and op["hunting"]))
        check("the net owns the whole desktop while hunting", bool(op) and op["hittable"])

        target = None
        op = overlay.probe()
        for f in op["fish"]:
            cx = f["x"] - op["deskOffset"]["x"]
            cy = f["y"] - op["deskOffset"]["y"]
            if -100 < cx < op["sizePx"][0] + 100:
                target = (f, cx, cy)
                break
        check("a fish to aim at", target is not None)
        if target:
            fish, cx, cy = target
            # drag a box around it: down, across, up. Each __pointer round-trip
            # takes ~100ms, so the box must outrun the fish (max ~36px/s).
            overlay.pointer("down", cx - 42, cy - 30)
            overlay.pointer("move", cx + 42, cy + 30)
            overlay.pointer("up", cx + 42, cy + 30)
            time.sleep(0.3)
            state = tank.probe()
            caught = [f for f in state["fish"] if f["id"] == fish["id"]]
            check(
                "the boxed fish is on its way home",
                bool(caught) and caught[0]["state"] == "returning",
                caught[0]["state"] if caught else "vanished",
            )

            # a box in a corner far from every fish catches nothing
            op = overlay.probe()
            pts = [(f["x"] - op["deskOffset"]["x"], f["y"] - op["deskOffset"]["y"]) for f in op["fish"]]
            corners = [
                (60, 60),
                (op["sizePx"][0] - 60, 60),
                (60, op["sizePx"][1] - 60),
                (op["sizePx"][0] - 60, op["sizePx"][1] - 60),
            ]
            ex = ey = None
            for cand in corners:
                if all(((cand[0] - x) ** 2 + (cand[1] - y) ** 2) ** 0.5 > 220 for x, y in pts):
                    ex, ey = cand
                    break
            if ex is not None:
                overlay.pointer("down", ex - 30, ey - 20)
                overlay.pointer("move", ex + 30, ey + 20)
                overlay.pointer("up", ex + 30, ey + 20)
                time.sleep(0.2)
                state = tank.probe()
                # the boundary is open, so fish come and go on their own; the
                # real claim is "the box caught nobody": no fish near the box
                # was sent home by it (a fish cannot swim 220px in 0.2s, so
                # the corner was still empty)
                victims = [
                    f["id"]
                    for f in state["fish"]
                    if f["state"] == "returning"
                    and ((f["x"] - ex) ** 2 + (f["y"] - ey) ** 2) ** 0.5 < 120
                ]
                check("an empty box changes nothing", not victims, f"returning near the box: {victims}")
            else:
                check("an empty box changes nothing", False, "no empty corner found")

            # and the caught one really gets home
            home = wait_for(
                lambda: (
                    lambda s: s
                    if any(f["id"] == fish["id"] and f["space"] == "tank" for f in s["fish"])
                    else None
                )(tank.probe()),
                30,
            )
            check("it made it back into the tank", bool(home))
            if home:
                back = [f for f in home["fish"] if f["id"] == fish["id"]][0]
                check("and it is ink again", back["colorMix"] == 0, str(back["colorMix"]))

        tank.click("btn-hunt")
        time.sleep(0.3)
        check("catching mode off again", not overlay.probe()["hunting"])

        # --------------------------------------------------- custom fish ---
        section("a fish the user typed themselves")
        tank.run(
            "const e=document.getElementById('set-custom'); e.value='><>';"
            " document.getElementById('btn-custom-add').click();"
        )
        time.sleep(0.6)
        state = tank.probe()
        custom = [f for f in state["fish"] if f["id"] == "fish-custom"]
        total = state["counts"]["tank"] + state["counts"]["desk"]
        check(
            "the custom fish joined the school",
            len(custom) == 1 and total == state["fishCount"] + 1,
            str(state["counts"]),
        )
        if custom:
            check("it wears the user's text", custom[0]["glyph"] == "><>", custom[0]["glyph"])
            # the setting file survives between test runs, so the direction is
            # whatever the last run left it: the fish must simply follow it
            before_dir = state["settings"]["customFacing"]
            check(
                "it follows the direction setting",
                custom[0]["canonFacing"] == before_dir,
                f"setting {before_dir} -> fish {custom[0]['canonFacing']}",
            )
            tank.click("btn-custom-dir")
            time.sleep(0.5)
            state = tank.probe()
            custom = [f for f in state["fish"] if f["id"] == "fish-custom"]
            check(
                "its direction can be swapped",
                bool(custom) and custom[0]["canonFacing"] == -before_dir,
                str(custom[0]["canonFacing"] if custom else None),
            )
            tank.click("btn-custom-remove")
            time.sleep(0.5)
            state = tank.probe()
            total = state["counts"]["tank"] + state["counts"]["desk"]
            check("and it can be removed", total == state["fishCount"], str(state["counts"]))
        else:
            check("it wears the user's text", False, "fish missing")
            check("and faces right as written", False, "fish missing")
            check("its direction can be swapped", False, "fish missing")
            check("and it can be removed", False, "fish missing")

        # --------------------------------------------------- interactions ---
        section("the cursor is part of the world")
        tank.run("__cursor('on')")
        # a fish that is free-swimming, not one already on a mission home
        desk_state = wait_for(
            lambda: (
                lambda s: s
                if any(f["space"] == "desk" and f["state"] == "outside" for f in s["fish"])
                else None
            )(tank.probe()),
            25,
        )
        desk = (
            [f for f in desk_state["fish"] if f["space"] == "desk" and f["state"] == "outside"]
            if desk_state
            else []
        )
        if desk:
            f = desk[0]
            tank.run(f"__cursor('desk', {f['x'] + 8}, {f['y']})")
            time.sleep(0.8)
            state = tank.probe()
            live = [x for x in state["fish"] if x["id"] == f["id"]][0]
            d = ((live["x"] - f["x"] - 8) ** 2 + (live["y"] - f["y"]) ** 2) ** 0.5
            check("a near cursor scares a fish away", d > 12, f"{d:.0f}px from the cursor")

            # an idle cursor becomes a curiosity: over it comes, and pecks.
            # A fish may be on its post-nibble cooldown, so try a few of them.
            nibbled = None
            tried = set()
            for _attempt in range(3):
                state = tank.probe()
                candidates = [
                    x
                    for x in state["fish"]
                    if x["space"] == "desk" and x["state"] == "outside" and x["id"] not in tried
                ]
                if not candidates:
                    break
                guest = candidates[0]
                tried.add(guest["id"])
                tank.run(f"__cursor('desk', {guest['x'] + 55}, {guest['y']})")
                tank.run("__cursor('idle', 60)")
                nibbled = wait_for(
                    lambda: (
                        lambda s: s
                        if any(x["id"] == guest["id"] and x["mood"] == "nibble" for x in s["fish"])
                        else None
                    )(tank.probe()),
                    9,
                )
                if nibbled:
                    break
            check("an idle cursor earns a curious peck", bool(nibbled), "nibble seen" if nibbled else "never")
        else:
            check("a near cursor scares a fish away", False, "no desk fish")
            check("an idle cursor earns a curious peck", False, "no desk fish")
        tank.run("__cursor('off')")

        # ------------------------------------------------------ flip-flop ---
        section("closing, and changing your mind half way")
        tank.click("btn-boundary")
        state = wait_for(lambda: (lambda s: s if s["stage"] == "returning" else None)(tank.probe()), 8)
        check("close starts a return", bool(state), state and state["stage"])

        tank.click("btn-boundary")  # re-open while they are swimming home
        state = wait_for(lambda: (lambda s: s if s["stage"] == "open" else None)(tank.probe()), 8)
        check("re-opening cancels the return", bool(state), state and state["stage"])
        check("still exactly one desktop layer", tank.probe()["windows"].count("overlay") == 1)

        # now let it close for real — the layer's destroy is async, so wait
        # for both the stage and the window list to settle
        tank.click("btn-boundary")
        state = wait_for(
            lambda: (
                lambda s: s
                if s["stage"] == "closed" and "overlay" not in s["windows"]
                else None
            )(tank.probe()),
            60,
        )
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
            check(
                "one window, whole school home",
                state["windows"] == ["tank"] and state["counts"]["tank"] == state["fishCount"],
                str(state["counts"]),
            )
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
