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
//            "dragging"  held by the mouse
//
// Motion is deliberate, never aimless: a fish always swims *towards* a point
// (a cruise target, the way out, or home) and turns towards it at a limited
// rate. Nothing ever changes heading by more than `turnRate` per second, so
// there is no snapping, and the glyph is laid out along that same heading —
// the head points where the fish is going.
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

const TAU = Math.PI * 2;
const NO_STEER = { x: 0, y: 0 };

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
    /** Last time a drag event arrived (seconds), used to rescue stuck drags. */
    this.dragAt = 0;

    /** 0 = ink, 1 = full desktop colour. */
    this.colorMix = 0;
    this.colorTarget = 0;

    /** Simulation timestamps (seconds) for the next decision. */
    this.exitAt = Infinity;
    this.returnAt = Infinity;

    this.speedPhase = rand(0, TAU);
    /** Phase of the body ripple; shared by both renderers. */
    this.wavePhase = rand(0, TAU);
    this.waveAmp = profile.bobAmp * 2.1;
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
   *          fish:Fish[], hardBounds:boolean}} world
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

    // 1. the body keeps rippling even while held by the mouse
    this.wavePhase += dt * (p.bobSpeed * 1.6 + this.speed * 0.05);

    // A held fish goes exactly where the hand goes; no steering, no physics.
    if (this.state === "dragging") {
      this.pitch = Math.sin(this.heading);
      return;
    }

    // 2. pick a direction: a goal if we have one, otherwise somewhere to go
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
      // a ruler — this is the "randomness" rather than random teleporting
      const sway = Math.sin(this.speedPhase * 0.7 + this.turnTimer) * 0.35;
      this.targetHeading = normalizeAngle(base + sway * Math.min(1, p.wildness));
    }

    // 3. blend the intention with wall and neighbour avoidance
    //    (a fish with a goal is allowed to swim into the boundary on purpose)
    const avoid = this.goal
      ? NO_STEER
      : boundarySteer(this, world.bounds, world.margin);
    const sep = separationSteer(this, world.fish, world.separation);
    const avoidMag = Math.min(1, Math.hypot(avoid.x, avoid.y));

    const dx = Math.cos(this.targetHeading) + avoid.x * 3.0 + sep.x * 2.4;
    const dy = Math.sin(this.targetHeading) + avoid.y * 3.0 + sep.y * 2.4;
    const desired = Math.atan2(dy, dx);

    // 4. turn towards it — never faster than turnRate
    const maxTurn = p.turnRate * (1 + avoidMag * 0.9) * dt;
    this.heading = normalizeAngle(
      this.heading + clamp(angleDelta(this.heading, desired), -maxTurn, maxTurn)
    );

    // the lean belongs to the heading the fish ended up with this frame, not
    // the one it had before it turned
    this.pitch = Math.sin(this.heading);

    // 5. hold a steady cruising speed: a fish that keeps changing speed reads
    //    as drifting, so the breathing is subtle and the hurry is purposeful
    this.speedPhase += dt * p.breathe;
    const hurry = this.goal ? 1.7 : 1;
    const targetSpeed =
      p.speed * hurry * (1 + 0.07 * Math.sin(this.speedPhase)) * (1 - 0.35 * avoidMag);
    const accel = p.accel * (this.goal ? 1.6 : 1);
    this.speed += clamp(targetSpeed - this.speed, -accel * dt, accel * dt);

    // 6. move
    this.x += Math.cos(this.heading) * this.speed * dt;
    this.y += Math.sin(this.heading) * this.speed * dt;

    // 7. safety net — skipped while the boundary is open, because then leaving
    //    the tank is the whole point
    if (world.hardBounds) this.keepInside(world.bounds);

    // 8. face the way we swim (with hysteresis, so we do not flicker)
    const c = Math.cos(this.heading);
    if (c > 0.25) this.facing = 1;
    else if (c < -0.25) this.facing = -1;
  }

  /** Somewhere worth swimming to: far enough away to be a real journey. */
  pickCruise(bounds) {
    const padX = Math.min(this.halfW + 46, Math.max(this.halfW + 8, bounds.w / 2));
    const padY = Math.min(this.halfH + 46, Math.max(this.halfH + 8, bounds.h / 2));
    const far = Math.min(240, bounds.w * 0.4);
    let spot = null;

    for (let i = 0; i < 6; i++) {
      const x = rand(padX, Math.max(padX + 1, bounds.w - padX));
      const y = rand(padY, Math.max(padY + 1, bounds.h - padY));
      spot = { x, y };
      if (Math.hypot(x - this.x, y - this.y) > far) break;
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
