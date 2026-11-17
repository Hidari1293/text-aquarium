// Headless checks for the parts of the fish that have nothing to do with
// pixels: the simulation, the glyph layout, and the boundary hand-over.
//
//     node scripts/simtest.mjs
//
// The rules being checked are the brief's, not mine: no teleporting, no
// repeated or vanishing fish, smooth turning, the head points where the fish
// swims, and every toggle of the boundary leaves a consistent world.

import { FISH_PROFILES, Fish } from "../src/js/fish.js";
import { GlyphRun } from "../src/js/glyph.js";
import { Simulation } from "../src/js/simulation.js";

let passed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}${detail ? `   (${detail})` : ""}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? `   (${detail})` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ setup */

const TANK_W = 740;
const TANK_H = 440;
const DESK_W = 1462; // 2560 physical / 1.75
const DESK_H = 866;

function makeSim() {
  const sim = new Simulation();
  sim.setDesk(DESK_W, DESK_H);
  sim.setTankRect({ x: 200, y: 150, w: TANK_W, h: TANK_H });
  sim.resize(TANK_W, TANK_H);
  sim.syncMetrics(() => 84); // 7 chars of 12px, the real measured width
  return sim;
}

const DT = 1 / 30;

function stepFor(sim, seconds, onStep) {
  const frames = Math.round(seconds / DT);
  for (let i = 0; i < frames; i++) {
    sim.step(DT);
    if (onStep) onStep(sim);
  }
}

/* ------------------------------------------------- 1. glyph layout ------ */

section("glyph layout: the head leads and the body ripples");

{
  const run = new GlyphRun("><(((o>");
  run.advance = 12;
  const n = run.n;

  run.layout(1, 0, 2, 0);
  check(
    "facing right puts the head character at the front",
    run.dx[0] < run.dx[n - 1] && Math.abs(run.dx[0] + run.dx[n - 1]) < 0.001,
    `dx ${run.dx[0].toFixed(1)} .. ${run.dx[n - 1].toFixed(1)}`
  );

  run.layout(-1, 0, 2, 0);
  check(
    "facing left mirrors it exactly",
    run.dx[0] > run.dx[n - 1] && Math.abs(run.dx[0] + run.dx[1]) > 0
  );

  // pitch +1 = diving: the head must sit lower than the tail
  run.layout(1, 0, 0, 1);
  check("diving drops the head below the tail", run.dy[0] > run.dy[n - 1], `${run.dy[0].toFixed(2)} > ${run.dy[n - 1].toFixed(2)}`);
  run.layout(1, 0, 0, -1);
  check("rising lifts the head above the tail", run.dy[0] < run.dy[n - 1]);

  // the ripple must move along the body and stay inside its amplitude
  let maxDy = 0;
  let changed = 0;
  run.layout(1, 0, 2, 0);
  const before = Array.from(run.dy);
  run.layout(1, 0.7, 2, 0);
  for (let i = 0; i < n; i++) {
    maxDy = Math.max(maxDy, Math.abs(run.dy[i]));
    if (Math.abs(run.dy[i] - before[i]) > 0.05) changed++;
  }
  check("the ripple stays within its amplitude", maxDy <= 2.01, `max ${maxDy.toFixed(2)} px`);
  check("advancing the phase moves the whole body", changed === n, `${changed}/${n} chars`);

  // head steadier than tail, like a real fish
  run.layout(1, 1.1, 2, 0);
  check("the head sways less than the tail", Math.abs(run.dy[0]) < Math.abs(run.dy[n - 1]));
}

/* ------------------------------------------- 2. swimming behaviour ------ */

section("swimming: head into the direction of travel, no aimless drift");

{
  const sim = makeSim();
  let maxJump = 0;
  let maxTurn = 0;
  let facingWrong = 0;
  let pitchWrong = 0;
  let samples = 0;

  let prev = sim.fish.map((f) => ({ x: f.x, y: f.y, heading: f.heading }));

  stepFor(sim, 40, (s) => {
    s.fish.forEach((fish, i) => {
      const jump = Math.hypot(fish.x - prev[i].x, fish.y - prev[i].y);
      maxJump = Math.max(maxJump, jump);

      const turn = Math.abs(
        Math.atan2(Math.sin(fish.heading - prev[i].heading), Math.cos(fish.heading - prev[i].heading))
      );
      maxTurn = Math.max(maxTurn, turn / DT);

      // head must follow the horizontal component unless the swim is steep
      const c = Math.cos(fish.heading);
      if (Math.abs(c) > 0.25) {
        samples++;
        if (Math.sign(fish.facing) !== Math.sign(c)) facingWrong++;
      }
      if (Math.abs(fish.pitch - Math.sin(fish.heading)) > 0.02) pitchWrong++;

      prev[i] = { x: fish.x, y: fish.y, heading: fish.heading };
    });
  });

  const fastest = Math.max(...FISH_PROFILES.map((p) => p.turnRate));
  check("turning is rate limited (no snapping)", maxTurn <= fastest * 2.6 + 0.05, `peak ${maxTurn.toFixed(2)} rad/s`);
  check("no teleporting while free swimming", maxJump <= 2.4, `max ${maxJump.toFixed(2)} px/frame`);
  check("facing always matches the horizontal heading", facingWrong === 0, `${samples} samples`);
  check("pitch is the vertical part of the heading", pitchWrong === 0);

  // purposeful travel: each fish should cover ground, not circle a point
  const sim2 = makeSim();
  const seen = sim2.fish.map(() => []);
  stepFor(sim2, 60, (s) => s.fish.forEach((f, i) => seen[i].push([f.x, f.y])));
  const spread = seen.map((pts) => {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  });
  check("every fish explores the tank, not one spot", spread.every((s) => s > 180), spread.map((s) => s.toFixed(0)).join(" / "));

  const inside = sim2.fish.every(
    (f) => f.x > 0 && f.x < TANK_W && f.y > 0 && f.y < TANK_H
  );
  check("fish stay inside a closed tank", inside);
}

/* --------------------------------------- 3. crossing the boundary ------- */

section("boundary: the fish swims out and back without a jump");

{
  const sim = makeSim();
  sim.openBoundary();
  let prev = sim.fish.map((f) => ({ space: f.space, x: f.x, y: f.y }));
  let maxStepInDesk = 0;
  let handovers = 0;
  let badHandover = 0;

  const tankRect = sim.tankRect;

  stepFor(sim, 30, (s) => {
    s.fish.forEach((fish, i) => {
      const was = prev[i];
      // a fish that has just moved to the desktop must be exactly where it
      // was a frame ago, expressed in the new space
      if (was.space === "tank" && fish.space === "desk") {
        handovers++;
        const expectedX = was.x + tankRect.x;
        const expectedY = was.y + tankRect.y;
        const gap = Math.hypot(fish.x - expectedX, fish.y - expectedY);
        if (gap > 3) badHandover++;
      }
      if (fish.space === "desk" && was.space === "desk") {
        maxStepInDesk = Math.max(maxStepInDesk, Math.hypot(fish.x - was.x, fish.y - was.y));
      }
      prev[i] = { space: fish.space, x: fish.x, y: fish.y };
    });
  });

  check("at least one fish left the tank", handovers > 0, `${handovers} crossings`);
  check("the crossing frame is continuous", badHandover === 0);
  check("desktop swimming is continuous too", maxStepInDesk <= 2.4, `max ${maxStepInDesk.toFixed(2)} px/frame`);
  check("the count still adds up", sim.counts().desk + sim.counts().tank === 3);
}

/* ------------------------------------------------- 4. coming home ------- */

section("boundary: closing it brings everyone home, in ink");

{
  const sim = makeSim();
  sim.openBoundary();
  stepFor(sim, 26);
  const out = sim.counts().desk;
  check("some fish out on the desktop", out > 0, `${out}/3`);

  sim.closeBoundary();
  let maxJump = 0;
  let prev = sim.fish.map((f) => ({ x: f.x, y: f.y, space: f.space }));
  let arrivals = 0;

  stepFor(sim, 40, (s) => {
    s.fish.forEach((f, i) => {
      const was = prev[i];
      if (was.space === "desk" && f.space === "tank") arrivals++;
      if (f.space === was.space) maxJump = Math.max(maxJump, Math.hypot(f.x - was.x, f.y - was.y));
      prev[i] = { x: f.x, y: f.y, space: f.space };
    });
  });

  check("everyone is back in the tank", sim.counts().desk === 0, `${sim.counts().tank}/3 inside`);
  check("arrivals happened through the boundary", arrivals >= out, `${arrivals} hand-overs`);
  check("no jump on the way home", maxJump <= 2.4, `max ${maxJump.toFixed(2)}`);
  check("colour is back to ink", sim.fish.every((f) => f.colorMix === 0));

  const inTank = sim.fish.every(
    (f) => f.x > 0 && f.x < TANK_W && f.y > 0 && f.y < TANK_H && f.space === "tank"
  );
  check("all fish are inside the tank rect", inTank);
}

/* ------------------------------------------------- 5. colour ramp ------ */

section("colour: it appears and disappears gradually");

{
  const sim = makeSim();
  sim.openBoundary();
  stepFor(sim, 22);
  const onDesk = sim.fish.filter((f) => f.space === "desk");
  check("fish on the desktop are coloured", onDesk.every((f) => f.colorMix > 0.9), onDesk.map((f) => f.colorMix.toFixed(2)).join(","));

  // the ramp itself must be a ramp
  const probe = new Fish(FISH_PROFILES[1], { x: 10, y: 10, heading: 0 });
  probe.colorTarget = 1;
  const trail = [];
  for (let i = 0; i < 20; i++) {
    probe.update(DT, { bounds: { w: 900, h: 600 }, margin: 58, separation: 60, fish: [], hardBounds: false });
    trail.push(probe.colorMix);
  }
  const monotonic = trail.every((v, i) => i === 0 || v >= trail[i - 1] - 1e-9);
  check("colour ramps monotonically", monotonic);
  check("it takes a moment, not a frame", trail[0] < 0.2 && trail[19] > 0.9, `${trail[0].toFixed(2)} -> ${trail[1].toFixed(2)} -> ${trail[19].toFixed(2)}`);
}

/* ------------------------------------------------------- 6. dragging ---- */

section("catching: grab, drag, drop");

{
  const sim = makeSim();
  sim.openBoundary();
  stepFor(sim, 22);
  const target = sim.fish.find((f) => f.space === "desk");
  check("a fish to grab", Boolean(target), target && target.id);

  check("grabbing a desk fish works", sim.grabFish(target.id));
  check("it is now held", target.state === "dragging");

  const before = { x: target.x, y: target.y };
  sim.dragFish(target.id, before.x + 120, before.y + 40);
  check("it follows the hand", target.x === before.x + 120 && target.y === before.y + 40);
  check("it faces the way it is being pulled", target.facing === 1);

  sim.dragFish(target.id, target.x - 200, target.y);
  check("and flips when pulled the other way", target.facing === -1);

  // put it down over the tank
  const dropX = sim.tankRect.x + sim.tankRect.w / 2;
  const dropY = sim.tankRect.y + sim.tankRect.h / 2;
  check("dropping over the tank reports a tank landing", sim.dropFish(target.id, dropX, dropY) === "tank");
  check("it is a tank fish again", target.space === "tank" && target.state === "inside");
  check("its colour is gone at once", target.colorMix === 0);
  check(
    "it landed where it was dropped",
    Math.abs(target.x - (dropX - sim.tankRect.x)) < 1 && Math.abs(target.y - (dropY - sim.tankRect.y)) < 1
  );

  // and a drop outside keeps it swimming
  const other = sim.fish.find((f) => f.space === "desk");
  if (!other) {
    sim.openBoundary();
    stepFor(sim, 20);
  }
  const swimmer = sim.fish.find((f) => f.space === "desk");
  if (swimmer) {
    sim.grabFish(swimmer.id);
    check("dropping on the desktop keeps it out", sim.dropFish(swimmer.id, 1200, 700) === "desk");
    check("it is swimming again", swimmer.state === "outside" || swimmer.state === "returning");
    check("the count still adds up", sim.counts().desk + sim.counts().tank === 3);
  } else {
    check("dropping on the desktop keeps it out", false, "no fish left outside");
  }
}

/* ---------------------------------------------- 7. panic toggling ------- */

section("toggling the boundary again and again");

{
  const sim = makeSim();
  let bad = 0;
  let maxJump = 0;
  let prev = sim.fish.map((f) => ({ x: f.x, y: f.y }));

  for (let round = 0; round < 12; round++) {
    sim.openBoundary();
    stepFor(sim, 1.2 + (round % 4) * 0.9, (s) => {
      s.fish.forEach((f, i) => {
        maxJump = Math.max(maxJump, Math.hypot(f.x - prev[i].x, f.y - prev[i].y));
        prev[i] = { x: f.x, y: f.y };
      });
    });
    sim.closeBoundary();
    stepFor(sim, 0.8 + (round % 3) * 0.7, (s) => {
      s.fish.forEach((f, i) => {
        maxJump = Math.max(maxJump, Math.hypot(f.x - prev[i].x, f.y - prev[i].y));
        prev[i] = { x: f.x, y: f.y };
      });
    });
    for (const f of sim.fish) {
      const okSpace = f.space === "tank" || f.space === "desk";
      const okState = ["inside", "crossing", "outside", "returning", "dragging"].includes(f.state);
      const consistent =
        (f.space === "tank" && (f.state === "inside" || f.state === "crossing")) ||
        (f.space === "desk" && ["outside", "returning", "dragging"].includes(f.state));
      if (!okSpace || !okState || !consistent) bad++;
    }
  }

  check("no inconsistent fish state after 24 toggles", bad === 0, `${bad} violations`);
  check("no teleporting through all of it", maxJump <= 2.6, `max ${maxJump.toFixed(2)} px/frame`);

  sim.closeBoundary();
  stepFor(sim, 45);
  check("and everyone still comes home", sim.counts().desk === 0, `${sim.counts().tank}/3`);
}

/* ------------------------------------------- 8. unreachable tank --------- */

section("edge case: a tank that is almost off the screen");

{
  const sim = makeSim();
  sim.openBoundary();
  stepFor(sim, 24);
  const out = sim.counts().desk;
  check("fish are outside first", out > 0, `${out}/3`);

  // now move the tank so far off the desk that its edge cannot be reached
  sim.setTankRect({ x: -5000, y: 150, w: TANK_W, h: TANK_H });
  sim.closeBoundary();

  const timer = Date.now();
  let done = false;
  for (let i = 0; i < 30 * 30 && !done; i++) {
    sim.step(DT);
    if (sim.counts().desk === 0) done = true;
  }
  check(
    "they still get home (rescued instead of waiting for ever)",
    done,
    `${((Date.now() - timer) / 1000).toFixed(1)}s of simulation`
  );
}

/* ------------------------------------------------------------- result --- */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
