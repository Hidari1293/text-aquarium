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
    "facing right draws the glyph as written, nose at the left end",
    run.drawChars.join("") === "><(((o>" &&
      run.dx[0] < run.dx[n - 1] &&
      Math.abs(run.dx[0] + run.dx[n - 1]) < 0.001,
    `"${run.drawChars.join("")}" dx ${run.dx[0].toFixed(1)} .. ${run.dx[n - 1].toFixed(1)}`
  );

  run.layout(-1, 0, 2, 0);
  check(
    "facing left turns the whole fish around, characters included",
    run.drawChars.join("") === "<o)))><",
    `"${run.drawChars.join("")}" (must be the reversed, mirrored fish, not "><(((o<")`
  );
  check(
    "turned around, the nose leads on the right end",
    run.drawChars[n - 1] === "<" && run.dx[n - 1] > run.dx[0],
    `nose char "${run.drawChars[n - 1]}" at dx ${run.dx[n - 1].toFixed(1)}`
  );

  // the ripple and the lean follow the nose in both directions
  run.layout(-1, 1.1, 2, 0);
  check(
    "mirrored: the nose sways less than the tail",
    Math.abs(run.dy[n - 1]) < Math.abs(run.dy[0]),
    `nose ${run.dy[n - 1].toFixed(2)} tail ${run.dy[0].toFixed(2)}`
  );
  run.layout(-1, 0, 0, 1);
  check("mirrored: diving still drops the nose below the tail", run.dy[n - 1] > run.dy[0]);

  // a glyph that faces left as written (fish-c) must work the same way
  const leftRun = new GlyphRun("<°)))彡");
  leftRun.advance = 12;
  leftRun.layout(-1, 0, 1, 0);
  check(
    "a left-faced glyph swims left as written",
    leftRun.drawChars.join("") === "<°)))彡",
    `"${leftRun.drawChars.join("")}"`
  );
  leftRun.layout(1, 0, 1, 0);
  check(
    "and turns around when it swims right",
    leftRun.drawChars.join("") === "ミ(((°>",
    `"${leftRun.drawChars.join("")}"`
  );
  check(
    "swimming right, its nose leads on the right end",
    leftRun.drawChars[leftRun.n - 1] === ">",
    `nose char "${leftRun.drawChars[leftRun.n - 1]}"`
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
  // the frame right after a hand-over still carries the exit hurry (2.1x):
  // the legit ceiling is ~2.7px/frame for the fastest fish
  check("desktop swimming is continuous too", maxStepInDesk <= 3.0, `max ${maxStepInDesk.toFixed(2)} px/frame`);
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
  // the homeward hurry is 2.1x now: the fastest fish covers ~2.7px/frame
  check("no jump on the way home", maxJump <= 3.2, `max ${maxJump.toFixed(2)}`);
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
  // a fish that crossed in the last half second is still fading in (the
  // ramp takes ~0.6s): give every fresh arrival a moment to colour up.
  // (Fish already going home fade out on purpose — that is the other test.)
  for (let i = 0; i < 20; i++) {
    const pending = sim.fish.some(
      (f) => f.space === "desk" && f.state !== "returning" && f.colorMix < 0.9
    );
    if (!pending) break;
    stepFor(sim, 0.5);
  }
  const onDesk = sim.fish.filter((f) => f.space === "desk" && f.state !== "returning");
  check("fish on the desktop are coloured", onDesk.every((f) => f.colorMix > 0.9), onDesk.map((f) => f.colorMix.toFixed(2)).join(","));

  // the ramp itself must be a ramp
  const probe = new Fish(FISH_PROFILES[1], { x: 10, y: 10, heading: 0 });
  probe.colorTarget = 1;
  const trail = [];
  for (let i = 0; i < 20; i++) {
    probe.update(DT, {
      bounds: { w: 900, h: 600 },
      margin: 58,
      separation: 60,
      fish: [],
      hardBounds: false,
      time: i * DT,
      liveliness: 1,
      cursor: { x: -500, y: -500, active: false, idle: 0 },
      dodgeRadius: 46,
      curiousIdle: 4,
      curiousRadius: 70,
    });
    trail.push(probe.colorMix);
  }
  const monotonic = trail.every((v, i) => i === 0 || v >= trail[i - 1] - 1e-9);
  check("colour ramps monotonically", monotonic);
  check("it takes a moment, not a frame", trail[0] < 0.2 && trail[19] > 0.9, `${trail[0].toFixed(2)} -> ${trail[1].toFixed(2)} -> ${trail[19].toFixed(2)}`);
}

/* ------------------------------------------------------- 6. lasso ------- */

section("catching: a box around a fish sends it home");

{
  const sim = makeSim();
  sim.openBoundary();
  stepFor(sim, 26);
  // the net only catches free-swimming fish: wait for one that is outside
  // and not already on its way home
  let target = null;
  for (let i = 0; i < 30 && !target; i++) {
    target = sim.fish.find((f) => f.space === "desk" && f.state === "outside");
    if (!target) stepFor(sim, 1);
  }
  check("a fish out on the desktop", Boolean(target), target && target.id);

  // a box drawn around the fish catches it
  const caught = sim.lassoFish(target.x - 30, target.y - 20, target.x + 30, target.y + 20);
  check("the net reported a catch", caught === 1, `${caught}`);
  check("the fish is on its way home", target.state === "returning" && target.space === "desk");
  check("a mission overrides any cursor mood", target.mood === "cruise");

  // a box somewhere empty catches nothing
  const empty = sim.lassoFish(50, 50, 90, 90);
  check("an empty box catches nothing", empty === 0);
  const others = sim.counts().desk;
  check("the other fish keep swimming", others > 0, `${others} still out`);

  // and the caught one really swims home, no teleporting — then close the
  // boundary so an open-world re-exit cannot undo the arrival. The boundary
  // hand-over changes the coordinate space; measure both frames in desk space.
  let maxJump = 0;
  let prev = { x: target.x, y: target.y, space: target.space };
  let arrived = false;
  for (let i = 0; i < 30 * 45 && !arrived; i++) {
    sim.step(DT);
    let jump = 0;
    if (target.space === prev.space) {
      jump = Math.hypot(target.x - prev.x, target.y - prev.y);
    } else {
      jump = Math.hypot(
        target.x + sim.tankRect.x - prev.x,
        target.y + sim.tankRect.y - prev.y
      );
    }
    maxJump = Math.max(maxJump, jump);
    prev = { x: target.x, y: target.y, space: target.space };
    if (target.space === "tank") arrived = true;
  }
  check("the caught fish made it home", arrived && target.state === "inside");
  // a hand-over frame carries at most the entry clamp (~2px) plus one frame
  // of motion (~2px); anything bigger is a real teleport
  check("the journey was continuous", maxJump <= 6, `max ${maxJump.toFixed(2)} px/frame`);
  sim.closeBoundary();
  stepFor(sim, 10);
  check("and it is ink again", target.colorMix === 0);
  check("the count still adds up", sim.counts().desk + sim.counts().tank === sim.fishCount);
}

/* --------------------------------------------------- 7. cursor moods ---- */

section("cursor: a live one gets a dart, an idle one gets a peck");

{
  // dodge: put the cursor next to a cruising fish and watch it flee
  const sim = makeSim();
  const fish = sim.fish[0];
  const cur = { x: fish.x + 12, y: fish.y };
  sim.setCursor("tank", cur.x, cur.y);
  sim.setHunting(false);
  stepFor(sim, 0.2);
  check("a cursor that close triggers a dodge", fish.mood === "dodge", fish.mood);
  check("the dodge has somewhere to go", fish.goal !== null);
  const d0 = Math.hypot(fish.x - cur.x, fish.y - cur.y);
  stepFor(sim, 0.9);
  const d1 = Math.hypot(fish.x - cur.x, fish.y - cur.y);
  check("and the fish puts real distance behind it", d1 > d0 + 6, `${d0.toFixed(0)} -> ${d1.toFixed(0)} px`);
  sim.clearCursor("tank");

  // direction matters: a mouse right in front of the nose gets a C-start —
  // the body whips around and bolts back the way it came
  const sim4 = makeSim();
  const frontFish = sim4.fish[0];
  const hx = Math.cos(frontFish.heading);
  const hy = Math.sin(frontFish.heading);
  const before4 = frontFish.heading;
  sim4.setCursor("tank", frontFish.x + hx * 16, frontFish.y + hy * 16);
  stepFor(sim4, 0.1);
  check(
    "a mouse in front: the fish whips around and flees back",
    Math.cos(before4 - frontFish.heading) < -0.5 && frontFish.mood === "dodge",
    `heading ${((before4 * 180) / Math.PI).toFixed(0)} -> ${((frontFish.heading * 180) / Math.PI).toFixed(0)}°`
  );
  sim4.clearCursor("tank");

  // ... and a mouse sneaking up from behind gets pure forward acceleration
  const sim5 = makeSim();
  const backFish = sim5.fish[0];
  const bx = Math.cos(backFish.heading);
  const by = Math.sin(backFish.heading);
  const before5 = backFish.heading;
  sim5.setCursor("tank", backFish.x - bx * 16, backFish.y - by * 16);
  stepFor(sim5, 0.1);
  const goalDir = backFish.goal
    ? Math.atan2(backFish.goal.y - backFish.y, backFish.goal.x - backFish.x)
    : NaN;
  check(
    "a mouse behind: it bolts straight ahead",
    backFish.mood === "dodge" &&
      Math.cos(before5 - backFish.heading) > 0.5 &&
      Math.cos(goalDir - before5) > 0.9,
    `goal ${((goalDir * 180) / Math.PI).toFixed(0)}° vs heading ${((before5 * 180) / Math.PI).toFixed(0)}°`
  );
  sim5.clearCursor("tank");

  // curiosity: an idle cursor within reach is worth a visit and a peck.
  // The fish aims so its NOSE lands on the cursor, not its belly: the
  // centre stops `halfW` short of it.
  const sim2 = makeSim();
  const guest = sim2.fish[2]; // the fastest: it gets there, and leaves
  const cur2 = { x: Math.min(guest.x + 60, TANK_W - 70), y: guest.y };
  sim2.setCursor("tank", cur2.x, cur2.y);
  sim2._cursor.lastMove = sim2.time - 60; // long idle
  let approached = false;
  let nibbled = false;
  let left = false;
  let noseOnCursor = false;
  let nibbleEnd = -1;
  stepFor(sim2, 40, (s) => {
    const d = Math.hypot(guest.x - cur2.x, guest.y - cur2.y);
    const noseX = guest.x - guest.facing * guest.halfW;
    const noseGap = Math.hypot(noseX - cur2.x, guest.y - cur2.y);
    if (guest.mood === "nibble") {
      nibbled = true;
      nibbleEnd = s.time;
      if (noseGap < 14) noseOnCursor = true;
    } else if (d < guest.halfW + 10) {
      approached = true;
    }
    if (nibbleEnd > 0 && s.time > nibbleEnd + 4 && d > 70) left = true;
  });
  check("the fish came over to look", approached, `within ${guest.halfW + 10}px of the cursor`);
  check("and gave it a peck", nibbled);
  check("nose first: the pointy end kisses the cursor", noseOnCursor);
  check("and leaves once the snack is over", left);

  // a mission is never distracted: a returning fish ignores the cursor
  const sim3 = makeSim();
  sim3.openBoundary();
  stepFor(sim3, 24);
  const returnee = sim3.fish.find((f) => f.space === "desk");
  check("there is a fish on the desk to come home", Boolean(returnee));
  sim3.closeBoundary();
  // the staggered returnAt (0–1.6s) fires, then the fish swims: catch it
  // mid-journey before it reaches the door
  let midJourney = false;
  for (let i = 0; i < 30 * 6 && !midJourney; i++) {
    sim3.step(DT);
    if (returnee && returnee.state === "returning") midJourney = true;
    else if (returnee && returnee.space === "tank") break; // already home
  }
  if (midJourney) {
    sim3.setCursor("desk", returnee.x + 5, returnee.y);
    stepFor(sim3, 0.3);
    check("a returning fish is not distracted", returnee.mood === "cruise" && returnee.state === "returning", returnee.mood);
  } else if (returnee && returnee.space === "tank") {
    check("a returning fish is not distracted", true, "it was already home, nothing to distract");
  } else {
    check("a returning fish is not distracted", false, `state ${returnee && returnee.state}`);
  }
}

/* ------------------------------------------- 6b. the open ocean --------- */

section("the ocean: a fish that got out stays out");

{
  const sim = makeSim();
  sim.openBoundary();
  let voluntaryReturn = false;
  stepFor(sim, 90, (s) => {
    if (s.boundary !== "open") return;
    for (const f of s.fish) {
      if (f.state === "returning") voluntaryReturn = true;
    }
  });
  check("fish made it out", sim.counts().desk > 0, `${sim.counts().desk} on the desk`);
  check(
    "and none came home on their own (only the net or the door brings them back)",
    !voluntaryReturn,
    voluntaryReturn ? "someone returned voluntarily" : ""
  );
  sim.closeBoundary();
  stepFor(sim, 45);
  check("closing the boundary still brings everyone home", sim.counts().desk === 0);
}

/* ---------------------------------------------- 7. panic toggling ------- */

section("toggling the boundary again and again");

{
  const sim = makeSim();
  let bad = 0;
  let maxJump = 0;
  let prev = sim.fish.map((f) => ({ space: f.space, x: f.x, y: f.y }));

  // Both frames of a boundary hand-over must be compared in one space: the
  // tank-rect offset that comes with it is a coordinate change, not motion.
  const sample = (s) => {
    s.fish.forEach((f, i) => {
      const was = prev[i];
      let jump = 0;
      if (f.space === was.space) {
        jump = Math.hypot(f.x - was.x, f.y - was.y);
      } else if (was.space === "tank") {
        jump = Math.hypot(f.x - (was.x + sim.tankRect.x), f.y - (was.y + sim.tankRect.y));
      } else {
        jump = Math.hypot(f.x + sim.tankRect.x - was.x, f.y + sim.tankRect.y - was.y);
      }
      maxJump = Math.max(maxJump, jump);
      prev[i] = { space: f.space, x: f.x, y: f.y };
    });
  };

  for (let round = 0; round < 12; round++) {
    sim.openBoundary();
    stepFor(sim, 1.2 + (round % 4) * 0.9, sample);
    sim.closeBoundary();
    stepFor(sim, 0.8 + (round % 3) * 0.7, sample);
    for (const f of sim.fish) {
      const okSpace = f.space === "tank" || f.space === "desk";
      const okState = ["inside", "crossing", "outside", "returning"].includes(f.state);
      const consistent =
        (f.space === "tank" && (f.state === "inside" || f.state === "crossing")) ||
        (f.space === "desk" && ["outside", "returning"].includes(f.state));
      if (!okSpace || !okState || !consistent) bad++;
    }
  }

  check("no inconsistent fish state after 24 toggles", bad === 0, `${bad} violations`);
  // a hand-over frame carries at most the entry clamp (~2px) plus one frame
  // of motion (~2px); anything bigger is a real teleport
  check("no teleporting through all of it", maxJump <= 6, `max ${maxJump.toFixed(2)} px/frame`);

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
  // a fish may have wandered to the far corner of the desk: 90s of sim time
  // covers the slowest fish (17 px/s * 1.7 hurry) crossing the whole desk,
  // plus the turn-around at the start and the rescue's 2.5s grace
  for (let i = 0; i < 30 * 90 && !done; i++) {
    sim.step(DT);
    if (sim.counts().desk === 0) done = true;
  }
  check(
    "they still get home (rescued instead of waiting for ever)",
    done,
    `${((Date.now() - timer) / 1000).toFixed(1)}s of simulation`
  );
}

/* ------------------------------------- 9. exits go through the sides ----- */

section("exits: fish leave through the side they face, never top or bottom");

{
  const sim = makeSim();
  sim.openBoundary();
  let prev = sim.fish.map((f) => ({ space: f.space, x: f.x, y: f.y }));
  let handovers = 0;
  let badSide = 0;
  let badFacing = 0;

  stepFor(sim, 50, (s) => {
    s.fish.forEach((f, i) => {
      const was = prev[i];
      if (was.space === "tank" && f.space === "desk") {
        handovers++;
        // the hand-over fires when the *leading end* clears the border, so
        // the centre is still up to halfW inside the tank at that moment
        const tankX = f.x - s.tankRect.x;
        const sideExit = tankX > s.bounds.w - f.halfW - 8 || tankX < f.halfW + 8;
        if (!sideExit) badSide++;
        if (sideExit && (tankX > s.bounds.w / 2) !== (f.facing === 1)) badFacing++;
      }
      // while swimming out, the exit point must sit beyond a side edge
      if (f.state === "crossing" && f.goal) {
        const g = f.goal;
        const beyondSide = g.x < -20 || g.x > s.bounds.w + 20;
        const horizontal = g.y >= 30 && g.y <= s.bounds.h - 30;
        if (!beyondSide || !horizontal) badSide++;
      }
      prev[i] = { space: f.space, x: f.x, y: f.y };
    });
  });

  check("fish left the tank", handovers > 0, `${handovers} crossings`);
  check("every exit went through a side edge", badSide === 0, `${badSide} top/bottom leaks`);
  check("and towards the direction they were facing", badFacing === 0, `${badFacing} against the facing`);
}

/* ------------------------------------------- 10. adjustable school ------- */

section("settings: count, size and liveliness reach the school");

{
  const sim = new Simulation();
  sim.setDesk(DESK_W, DESK_H);
  sim.setTankRect({ x: 200, y: 150, w: TANK_W, h: TANK_H });
  sim.fishCount = 5;
  sim.resize(TANK_W, TANK_H);
  sim.syncMetrics(() => 84);

  check("five fish now live here", sim.fish.length === 5, `${sim.fish.length}`);
  check("colours repeat within families", new Set(sim.fish.map((f) => f.oceanColor)).size >= 4);

  // shrinking the school prefers tank fish
  sim.setFishCount(3);
  check("trimming works", sim.fish.length === 3, `${sim.fish.length}`);
  sim.setFishCount(8);
  sim.syncMetrics(() => 84);
  check("and growing it back works", sim.fish.length === 8, `${sim.fish.length}`);
  sim.setFishCount(3);

  // size reaches the fish and is clamped
  sim.setFishSize(20);
  sim.syncMetrics(() => 100);
  check("size reaches the school", sim.fishSize === 20 && sim.fish.every((f) => f.halfH > 9), `${sim.fishSize}px`);
  check("a bigger fish swings a bigger tail", sim.fish[0].waveAmp > 1.4, sim.fish[0].waveAmp.toFixed(2));
  sim.setFishSize(99);
  check("sizes are clamped", sim.fishSize === 22);

  // liveliness scales speed and curiosity
  sim.setLiveliness(0.5);
  check("calm is calm", sim._tankWorld.liveliness === 0.5 && sim._tankWorld.curiousIdle > 4, `idle ${sim._tankWorld.curiousIdle.toFixed(1)}s`);
  sim.setLiveliness(2);
  check("lively is lively", sim._tankWorld.liveliness === 2 && sim._tankWorld.curiousIdle < 3, `idle ${sim._tankWorld.curiousIdle.toFixed(1)}s`);
  sim.setLiveliness(1);
}

/* --------------------------------------- 11. a fish the user typed ------ */

section("custom fish: the user's own text joins the school");

{
  const sim = makeSim();
  const before = sim.fish.length;

  sim.setCustomFish("><>", 1);
  sim.syncMetrics(() => 84);
  check("the custom fish joins the school", sim.fish.length === before + 1, `${before} -> ${sim.fish.length}`);
  const custom = sim.customFish;
  check("it keeps the user's text", custom && custom.glyph === "><>");
  check("it faces right as written", custom && custom.canonFacing === 1);

  // the glyph run respects the declared direction, even for bracket-less text
  const run = new GlyphRun("abc", 1);
  check("arbitrary text gets a usable layout", run.drawChars.join("") === "abc");
  const runLeft = new GlyphRun("abc", -1);
  runLeft.layout(1, 0, 1, 0); // swimming right: a left-faced fish mirrors
  check("and mirrors when it swims the other way", runLeft.drawChars.join("") === "cba");

  // swapping direction keeps the same fish
  sim.setCustomFish("><>", -1);
  check("the direction can be changed", sim.customFish && sim.customFish.canonFacing === -1);

  // the count slider manages the standard school only: the custom fish is
  // extra and must survive trimming (this used to eat fish, one by one)
  sim.setFishCount(5);
  sim.setCustomFish("><>", 1);
  sim.setFishCount(3);
  check(
    "the count slider never trims the custom fish",
    sim.fish.length === 4 && sim.customFish !== null,
    `${sim.fish.length} fish (3 standard + custom)`
  );

  // empty text sends it home for good
  sim.setCustomFish("", 1);
  check("and empty text removes it", sim.fish.length === 3, `${sim.fish.length}`);
}

/* ------------------------------------------------------------- result --- */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
