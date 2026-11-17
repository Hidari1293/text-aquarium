// One fish: its own glyph, colour, speed and mood.
//
// Two independent things describe a fish:
//
//   space  — which coordinate system x/y live in
//            "tank" = tank-local css px (moves with the window)
//            "desk" = desktop layer css px (stays put on the monitor)
//
//   state  — what it is doing
//            "inside"    swimming in the tank
//            "crossing"  on its way out through the open boundary
//            "outside"   swimming on the desktop
//            "returning" heading back to the tank
//
// Motion is deliberate, never aimless: a fish always swims *towards* a point
// (a cruise target, the way out, or home) and turns towards it at a limited
// rate. Nothing ever changes heading by more than `turnRate` per second, so
// there is no snapping, and the glyph is laid out along that same heading —
// the head points where the fish is going.
//
// The cursor is part of the world too, and fish react to it on top of their
// missions (only while free-swimming; a fish with a task is not distracted):
//
//   mood "cruise"  the default
//   mood "dodge"   the cursor came too close: a quick dart away
//   mood "curious" the cursor has been idle for a while: swim over
//   mood "nibble"  reached it: a couple of quick pecks at the cursor,
//                  then back to cruising (and it won't be back soon)
//
// `colorMix` ramps 0 -> 1 once the fish is on the desktop (the brief asks for
// colour to *appear*, not to switch on), and back down before it re-enters.

import {
  angleDelta,
  boundarySteer,
  clamp,
  normalizeAngle,
  separationSteer,
} from "./fish-behavior.js";

/**
 * The three starting fish from the brief.
 * speed: px/s · turnRate: rad/s · wildness: how far a new heading may drift
 * wander: seconds between heading decisions.
 */
export const FISH_PROFILES = [
  {
    id: "fish-a",
    glyph: "><(((*>",
    speed: 17,
    turnRate: 0.78,
    wildness: 0.6,
    wander: [2.8, 5.4],
    accel: 8,
    breathe: 0.5,
    bobAmp: 1.0,
    bobSpeed: 1.5,
    tankColor: "#111111",
    oceanColor: "#D98B4B",
  },
  {
    id: "fish-b",
    glyph: "><(((o>",
    speed: 26,
    turnRate: 1.1,
    wildness: 1.0,
    wander: [1.8, 3.8],
    accel: 12,
    breathe: 0.72,
    bobAmp: 1.2,
    bobSpeed: 2.0,
    tankColor: "#111111",
    oceanColor: "#5B8FB9",
  },
  {
    id: "fish-c",
    glyph: "<°)))彡",
    speed: 33,
    turnRate: 1.7,
    wildness: 1.9,
    wander: [0.8, 1.9],
    accel: 18,
    breathe: 1.0,
    bobAmp: 1.4,
    bobSpeed: 2.6,
    tankColor: "#111111",
    oceanColor: "#4FA39A",
  },
];

/**
 * Extra fish share the three glyphs but get their own shade and tempo.
 * Vivid on purpose: the fish swim over anything, so they must read on a
 * light wallpaper as well as a dark one.
 */
const COLOR_FAMILIES = [
  ["#E8823C", "#D96F2B", "#F2964F"], // orange
  ["#3E8CDC", "#2E7CC9", "#63A5E4"], // blue
  ["#2CA894", "#239689", "#4CBBA8"], // teal
];

/**
 * The nth fish: species cycles a/b/c, each with a slightly different tint,
 * its own tempo, and — important — its own id, because the sim, the tests
 * and the net all address fish by id.
 */
export function fishProfile(index) {
  const base = FISH_PROFILES[index % FISH_PROFILES.length];
  const family = COLOR_FAMILIES[index % FISH_PROFILES.length];
  const shade = family[Math.floor(index / FISH_PROFILES.length) % family.length];
  return {
    ...base,
    id: `${base.id}-${index + 1}`,
    oceanColor: shade,
    speed: base.speed * (0.92 + Math.random() * 0.16),
  };
}

/**
 * A fish the user typed themselves. The text reads nose-first; `facing` says
 * which way it swims as written (1 = right, the default). Its colour comes
 * from the next free family slot.
 */
export function fishProfileCustom(glyph, facing, index) {
  const base = FISH_PROFILES[index % FISH_PROFILES.length];
  const family = COLOR_FAMILIES[index % FISH_PROFILES.length];
  const shade = family[Math.floor(index / FISH_PROFILES.length) % family.length];
  return {
    ...base,
    id: "fish-custom",
    glyph,
    canonFacing: facing,
    oceanColor: shade,
  };
}

const TAU = Math.PI * 2;
const NO_STEER = { x: 0, y: 0 };
/** One peck takes this long; the fish does a glide plus 2–4 of them. */
const NIBBLE_CYCLE = 0.26;

function rand(lo, hi) {
  return lo + Math.random() * (hi - lo);
}

export class Fish {
  constructor(profile, spawn) {
    this.id = profile.id;
    this.profile = profile;
    this.glyph = profile.glyph;

    this.x = spawn.x;
    this.y = spawn.y;
    this.heading = spawn.heading;
    this.speed = profile.speed;

    this.space = "tank";
    this.state = "inside";
    this.facing = Math.cos(spawn.heading) >= 0 ? 1 : -1;
    this.targetHeading = spawn.heading;
    this.turnTimer = rand(0.3, 1.8);

    /** Destination in the fish's own space, or null for free swimming. */
    this.goal = null;
    /** Somewhere to swim to when there is no goal: this is what keeps a fish
     *  from drifting in circles with no intention. */
    this.cruise = null;

    /** Which way the glyph faces as written (custom fish bring their own). */
    this.canonFacing = profile.canonFacing;

    /** Cursor moods: cruise | dodge | curious | nibble. */
    this.mood = "cruise";
    this.moodUntil = 0;
    this.dodgeCd = 0;
    this.curiousCd = 0;
    this.nibbles = 0;
    this.nibbleT = 0;
    this.nibbleFrom = { x: 0, y: 0 };

    /** Background luminance where the fish is right now (0..255, lerped by the
     *  sim from sampled screen pixels): the desk colour and ink both adapt so
     *  the fish stays visible on any wallpaper. */
    this.bgLum = 200;

    /** 0 = ink, 1 = full desktop colour. */
    this.colorMix = 0;
    this.colorTarget = 0;

    /** Simulation timestamps (seconds) for the next decision. */
    this.exitAt = Infinity;
    this.returnAt = Infinity;

    this.speedPhase = rand(0, TAU);
    /** Phase of the body ripple; shared by both renderers. */
    this.wavePhase = rand(0, TAU);
    // The fish should read as swimming *forward*, not bobbing: the ripple is
    // a hint of life, kept well below the forward motion. Scaled with size.
    this.waveAmp = profile.bobAmp * 1.2;
    /** Vertical part of the heading, -1..1. Read by the renderer as a tilt. */
    this.pitch = 0;

    // glyph metrics, filled in by the renderer once the font is known
    this.halfW = 24;
    this.halfH = 8;

    this.tankColor = profile.tankColor;
    this.oceanColor = profile.oceanColor;
  }

  get vx() {
    return Math.cos(this.heading) * this.speed;
  }

  get vy() {
    return Math.sin(this.heading) * this.speed;
  }

  /**
   * @param {number} dt seconds
   * @param {{bounds:{w:number,h:number}, margin:number, separation:number,
   *          fish:Fish[], hardBounds:boolean, time:number, liveliness:number,
   *          cursor:{x,y,active,idle}|null,
   *          dodgeRadius:number, curiousIdle:number, curiousRadius:number}} world
   */
  update(dt, world) {
    const p = this.profile;

    // 0. colour fades in / out, never jumps
    if (this.colorMix !== this.colorTarget) {
      const step = dt * 1.8;
      this.colorMix = clamp(
        this.colorMix + clamp(this.colorTarget - this.colorMix, -step, step),
        0,
        1
      );
    }

    // 1. the body keeps rippling no matter what the fish is doing
    this.wavePhase += dt * (p.bobSpeed * 1.6 + this.speed * 0.05);

    // 2. the cursor is part of the world: flee a live one, court a resting one
    this.moodStep(dt, world);

    // 3. a pecking fish is all mouth: the nibble owns its position this frame
    if (this.mood === "nibble") {
      this.pitch = Math.sin(this.heading);
      return;
    }

    // 4. pick a direction: a goal if we have one, otherwise somewhere to go
    this.turnTimer -= dt;
    if (this.goal) {
      this.targetHeading = Math.atan2(this.goal.y - this.y, this.goal.x - this.x);
    } else {
      const toTarget =
        this.cruise === null
          ? Infinity
          : Math.hypot(this.cruise.x - this.x, this.cruise.y - this.y);
      if (this.cruise === null || toTarget < 34 || this.turnTimer <= 0) {
        this.pickCruise(world.bounds);
        this.turnTimer = rand(p.wander[0], p.wander[1]);
      }
      const base = Math.atan2(this.cruise.y - this.y, this.cruise.x - this.x);
      // a slow sway around the straight line, so the path is not drawn with
      // a ruler — this is the "randomness" rather than random teleporting.
      // Kept small: the fish should mostly swim straight ahead.
      const sway = Math.sin(this.speedPhase * 0.7 + this.turnTimer) * 0.18;
      this.targetHeading = normalizeAngle(base + sway * Math.min(1, p.wildness));
    }

    // 5. blend the intention with wall and neighbour avoidance
    //    (a fish with a goal is allowed to swim into the boundary on purpose;
    //    one busy with the cursor — darting, approaching or pecking — is
    //    excused from neighbourly shoving, or the crowd circling the cursor
    //    would push it away from its target forever)
    const focused =
      this.mood === "curious" || this.mood === "nibble" || this.mood === "dodge";
    const avoid = this.goal
      ? NO_STEER
      : boundarySteer(this, world.bounds, world.margin);
    const sep = focused ? NO_STEER : separationSteer(this, world.fish, world.separation);
    const avoidMag = Math.min(1, Math.hypot(avoid.x, avoid.y));

    const dx = Math.cos(this.targetHeading) + avoid.x * 3.0 + sep.x * 2.4;
    const dy = Math.sin(this.targetHeading) + avoid.y * 3.0 + sep.y * 2.4;
    const desired = Math.atan2(dy, dx);

    // 6. turn towards it — never faster than turnRate, except a startled fish,
    //    which whips around: the whole point of a startle response is speed
    const turnBoost = this.mood === "dodge" ? 2.5 : 1;
    const maxTurn = p.turnRate * (1 + avoidMag * 0.9) * dt * turnBoost;
    this.heading = normalizeAngle(
      this.heading + clamp(angleDelta(this.heading, desired), -maxTurn, maxTurn)
    );

    // the lean belongs to the heading the fish ended up with this frame, not
    // the one it had before it turned
    this.pitch = Math.sin(this.heading);

    // 7. hold a steady cruising speed: a fish that keeps changing speed reads
    //    as drifting, so the breathing is subtle and the hurry is purposeful.
    //    A dodge is a bolt — 4.2x speed and 3.5x acceleration, gone in 0.4s.
    //    Missions hurry at 2.1x: with the voluntary return gone the fish roam
    //    the whole desk, and coming home must not take a minute.
    this.speedPhase += dt * p.breathe;
    const hurry = this.goal ? (this.mood === "dodge" ? 4.2 : 2.1) : 1;
    let targetSpeed =
      p.speed *
      world.liveliness *
      hurry *
      (1 + 0.07 * Math.sin(this.speedPhase)) *
      (1 - 0.35 * avoidMag);
    if (this.mood === "curious" && this.goal) {
      // arrival braking: a fish at full tilt orbits the cursor instead of
      // reaching it (turn radius > the trigger zone). Slow down on approach,
      // the turn tightens, and the nose lands on target.
      const gd = Math.hypot(this.goal.x - this.x, this.goal.y - this.y);
      const brake = gd < 70 ? 0.3 + 0.7 * (gd / 70) : 1;
      targetSpeed *= brake;
    }
    const accel = p.accel * (this.mood === "dodge" ? 3.5 : this.goal ? 1.6 : 1);
    this.speed += clamp(targetSpeed - this.speed, -accel * dt, accel * dt);

    // 8. move
    this.x += Math.cos(this.heading) * this.speed * dt;
    this.y += Math.sin(this.heading) * this.speed * dt;

    // 9. safety net — skipped while the boundary is open, because then leaving
    //    the tank is the whole point
    if (world.hardBounds) this.keepInside(world.bounds);

    // 10. face the way we swim (with hysteresis, so we do not flicker)
    const c = Math.cos(this.heading);
    if (c > 0.25) this.facing = 1;
    else if (c < -0.25) this.facing = -1;
  }

  /* ----------------------------------------------------------- moods */

  /**
   * The cursor changes everything — but only for a fish that is free to
   * improvise: one with a task (crossing / returning) is left alone.
   * A live cursor inside the dodge radius earns a quick dart away; a cursor
   * that has been idle for a while and is within reach becomes a curiosity,
   * and the fish swims over to peck at it.
   */
  moodStep(dt, world) {
    const t = world.time;
    const cur = world.cursor;

    if (this.mood === "nibble") {
      this.nibbleT += dt;
      if (this.nibbleT >= this.nibbles * NIBBLE_CYCLE) {
        // snack's over: go back to life, and leave the cursor alone for a while
        this.mood = "cruise";
        this.curiousCd = t + 12 + rand(0, 8);
      } else {
        // the nose-stop: centre here puts the pointy end exactly on the cursor
        const stopX = cur.x + this.facing * (this.halfW - 2);
        const stopY = cur.y;
        const cycle = Math.floor(this.nibbleT / NIBBLE_CYCLE);
        const phase = (this.nibbleT % NIBBLE_CYCLE) / NIBBLE_CYCLE;
        if (cycle === 0) {
          // first beat: dart the rest of the way in — one clean lunge that
          // closes whatever gap the approach left, nose on the cursor
          const glide = Math.min(1, phase / 0.55);
          this.x = this.nibbleFrom.x + (stopX - this.nibbleFrom.x) * glide;
          this.y = this.nibbleFrom.y + (stopY - this.nibbleFrom.y) * glide;
        } else {
          // then small pecks: the nose nudges just past the cursor
          const peck = phase < 0.55 ? Math.sin((phase / 0.55) * Math.PI) : 0;
          this.x = stopX - this.facing * peck * 5;
          this.y = stopY;
        }
        this.heading = Math.atan2(cur.y - this.y, cur.x - this.x);
      }
      return;
    }

    if (this.mood === "dodge") {
      if (t >= this.moodUntil) {
        this.mood = "cruise";
        this.goal = null;
        this.cruise = null;
      }
      return;
    }

    if (this.mood === "curious") {
      if (!cur || !cur.active) {
        this.mood = "cruise";
        this.goal = null;
        this.cruise = null;
      } else if (Math.hypot(this.goal.x - this.x, this.goal.y - this.y) < 26) {
        // close enough: the first peck-lunge closes the rest of the gap
        this.goal = null;
        this.mood = "nibble";
        this.nibbleT = 0;
        this.nibbles = 3 + Math.floor(rand(0, 2.99));
        this.nibbleFrom = { x: this.x, y: this.y };
      } else if (t >= this.moodUntil) {
        this.mood = "cruise";
        this.goal = null;
        this.cruise = null;
      }
      return;
    }

    // cruise: moods only engage while the fish is free and has no plan
    if (this.goal !== null || (this.state !== "inside" && this.state !== "outside")) {
      return;
    }
    if (!cur || !cur.active) return;
    const d = Math.hypot(cur.x - this.x, cur.y - this.y);

    if (d < world.dodgeRadius && cur.idle < 2 && t >= this.dodgeCd) {
      // the cursor moved recently: it means trouble — a real fish startles.
      // Direction matters: a mouse right in front of the nose gets a C-start
      // (the body whips around and bolts back the way it came); a mouse
      // sneaking up from behind gets pure acceleration — no time to turn.
      this.mood = "dodge";
      this.moodUntil = t + 0.4;
      this.dodgeCd = t + 1.4;
      const dist = d > 1 ? d : 1;
      const toCursor = { x: (cur.x - this.x) / dist, y: (cur.y - this.y) / dist };
      const ahead =
        Math.cos(this.heading) * toCursor.x + Math.sin(this.heading) * toCursor.y;
      const flee =
        ahead > 0
          ? { x: -toCursor.x, y: -toCursor.y } // head-on: turn around and bolt
          : { x: Math.cos(this.heading), y: Math.sin(this.heading) }; // from behind: bolt forward
      const away = 170 + this.halfH * 4;
      this.goal = { x: this.x + flee.x * away, y: this.y + flee.y * away };
      // the startle whips the body around in a single beat (a real C-start)
      this.heading = Math.atan2(flee.y, flee.x);
      this.targetHeading = this.heading;
    } else if (cur.idle > world.curiousIdle && d < world.curiousRadius && t >= this.curiousCd) {
      // a cursor that has been resting for a while is worth a look. Aim so
      // the *nose* — not the belly — ends up at the cursor: the fish's
      // centre must stop `halfW` short of it.
      this.mood = "curious";
      this.moodUntil = t + 8;
      this.goal = {
        x: cur.x + this.facing * (this.halfW - 5),
        y: cur.y + rand(-2, 2),
      };
    }
  }

  /* --------------------------------------------------------- cruising */

  /**
   * Somewhere worth swimming to: a real journey, mostly straight ahead.
   *
   * A new destination is a modest turn from the current heading, nudged
   * towards the nearest horizontal — the fish keeps going the way it was
   * going instead of re-deciding from scratch. (Uniform random points made
   * every re-roll a U-turn: the fish spent as much time turning through
   * steep angles as swimming, and read as bobbing more than travelling.)
   */
  pickCruise(bounds) {
    const padX = Math.min(this.halfW + 46, Math.max(this.halfW + 8, bounds.w / 2));
    const padY = Math.min(this.halfH + 46, Math.max(this.halfH + 8, bounds.h / 2));
    const far = Math.min(240, bounds.w * 0.4);
    let spot = null;

    for (let i = 0; i < 6; i++) {
      const dev = rand(-0.9, 0.9); // a course correction, not a change of mind
      const a = normalizeAngle(this.heading + dev);
      const horiz = Math.cos(a) >= 0 ? 0 : Math.PI;
      const ang = normalizeAngle(a + normalizeAngle(horiz - a) * 0.35);
      const dist = rand(far, far * 1.6);
      spot = {
        x: this.x + Math.cos(ang) * dist,
        y: this.y + Math.sin(ang) * dist,
      };
      if (spot.x > padX && spot.x < bounds.w - padX && spot.y > padY && spot.y < bounds.h - padY) break;
    }
    this.cruise = spot;
  }

  /**
   * Wall contact is a nudge, not a bounce: the heading is redirected and the
   * turn-rate limit does the rest, so the fish never snaps around.
   */
  keepInside(bounds) {
    const padX = this.halfW;
    const padY = this.halfH;
    let pushed = false;

    if (this.x < padX) {
      this.x = padX;
      this.targetHeading = 0;
      pushed = true;
    } else if (this.x > bounds.w - padX) {
      this.x = bounds.w - padX;
      this.targetHeading = Math.PI;
      pushed = true;
    }

    if (this.y < padY) {
      this.y = padY;
      this.targetHeading = Math.PI / 2;
      pushed = true;
    } else if (this.y > bounds.h - padY) {
      this.y = bounds.h - padY;
      this.targetHeading = -Math.PI / 2;
      pushed = true;
    }

    if (pushed) {
      this.cruise = null;
      this.speed *= 0.92;
      this.turnTimer = Math.max(this.turnTimer, 0.4);
    }
  }

  /** Keep the fish inside after the tank is resized. */
  clampToBounds(bounds) {
    this.x = clamp(this.x, this.halfW, Math.max(this.halfW, bounds.w - this.halfW));
    this.y = clamp(this.y, this.halfH, Math.max(this.halfH, bounds.h - this.halfH));
    this.cruise = null;
  }
}
