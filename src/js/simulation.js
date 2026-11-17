// The world: three fish, some bubbles, some seaweed, and a clock.
// Pure simulation — it knows nothing about canvases or DOM.
//
// This one object is the single source of truth for both worlds. Fish inside
// the tank live in tank-local pixels; fish on the desktop live in desk pixels
// (the desktop layer's client space). Crossing the boundary converts a fish
// from one to the other in a single frame at the exact edge — which is why
// nothing ever teleports or gets drawn twice.

import { Bubbles } from "./bubbles.js";
import { nearestPointInside, nearestPointOutside, rectHas } from "./coordinates.js";
import { FISH_PROFILES, Fish } from "./fish.js";
import { clamp } from "./fish-behavior.js";
import { SeaweedBed } from "./seaweed.js";

/** Distance from the wall at which a fish starts to turn away. */
export const TURN_MARGIN = 58;
/** Distance under which two fish start pushing each other apart. */
export const SEPARATION = 62;
/** How far from the screen edge a desktop fish starts turning back. */
export const DESK_MARGIN = 64;

const SPAWNS = [
  { fx: 0.3, fy: 0.36 },
  { fx: 0.64, fy: 0.62 },
  { fx: 0.46, fy: 0.22 },
];

export class Simulation {
  constructor() {
    this.bounds = { w: 0, h: 0 }; // tank canvas, css px
    this.desk = { w: 0, h: 0 }; // desktop layer, css px
    /** Tank canvas rect in desk space — owned by main.js, which has the windows. */
    this.tankRect = { x: 0, y: 0, w: 0, h: 0 };

    this.boundary = "closed"; // "closed" | "open"

    this.fish = [];
    this.bubbles = new Bubbles();
    this.seaweed = new SeaweedBed();
    this.margin = TURN_MARGIN;
    this.separation = SEPARATION;
    this.time = 0;

    // scratch objects, reused every frame (no per-frame allocation)
    this._tankWorld = {
      bounds: this.bounds,
      margin: TURN_MARGIN,
      separation: SEPARATION,
      fish: this.fish,
      hardBounds: true,
    };
    this._deskWorld = {
      bounds: { w: 0, h: 0 },
      margin: DESK_MARGIN,
      separation: SEPARATION + 24,
      fish: this.fish,
      hardBounds: true,
    };
    this._frame = [];
  }

  /* ---------------------------------------------------------- geometry */

  setDesk(width, height) {
    this.desk.w = Math.max(1, width);
    this.desk.h = Math.max(1, height);
    this._deskWorld.bounds.w = this.desk.w;
    this._deskWorld.bounds.h = this.desk.h;
  }

  setTankRect(rect) {
    this.tankRect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  }

  /** Does the tank sit on the desktop layer at all? (primary monitor guard) */
  get placementValid() {
    const cx = this.tankRect.x + this.tankRect.w / 2;
    const cy = this.tankRect.y + this.tankRect.h / 2;
    return (
      this.desk.w > 200 &&
      this.desk.h > 200 &&
      this.tankRect.w > 40 &&
      this.tankRect.h > 40 &&
      cx > 0 &&
      cx < this.desk.w &&
      cy > 0 &&
      cy < this.desk.h
    );
  }

  resize(width, height) {
    const prev = { ...this.bounds };
    this.bounds = { w: Math.max(1, width), h: Math.max(1, height) };
    this._tankWorld.bounds = this.bounds;

    if (this.fish.length === 0) {
      this.spawn();
    } else if (prev.w > 4 && prev.h > 4) {
      // keep tank fish where they *were*, relative to the tank; desktop fish
      // are not ours to move when the tank window is resized
      const sx = this.bounds.w / prev.w;
      const sy = this.bounds.h / prev.h;
      for (const fish of this.fish) {
        if (fish.space !== "tank") continue;
        fish.x *= sx;
        fish.y *= sy;
        fish.clampToBounds(this.bounds);
      }
    }

    this.seaweed.layout(this.bounds.w, this.bounds.h);
  }

  spawn() {
    const { w, h } = this.bounds;
    this.fish = FISH_PROFILES.map((profile, i) => {
      const spot = SPAWNS[i % SPAWNS.length];
      return new Fish(profile, {
        x: w * spot.fx,
        y: h * spot.fy,
        heading: Math.random() * Math.PI * 2,
      });
    });
    this._tankWorld.fish = this.fish;
    this._deskWorld.fish = this.fish;
    for (const fish of this.fish) fish.clampToBounds(this.bounds);
  }

  /** The renderer knows the font, so it tells us how wide each glyph is. */
  syncMetrics(measure) {
    for (const fish of this.fish) {
      const width = measure(fish.glyph);
      fish.halfW = width / 2 + 2;
      fish.halfH = 8;
    }
  }

  /* ---------------------------------------------------------- boundary */

  openBoundary() {
    if (this.boundary === "open") return;
    this.boundary = "open";

    for (const fish of this.fish) {
      fish.stuckSince = 0;
      if (fish.state === "returning") {
        // change of plan: stay out
        fish.state = "outside";
        fish.goal = null;
        fish.colorTarget = 1;
        fish.returnAt = this.time + 14 + Math.random() * 14;
      } else if (fish.space === "tank" && fish.state === "inside") {
        // staggered on purpose: nobody wants all three to bolt at once
        fish.exitAt = this.time + 1.0 + Math.random() * 6.0;
      }
    }
  }

  closeBoundary() {
    if (this.boundary === "closed") return;
    this.boundary = "closed";

    for (const fish of this.fish) {
      fish.exitAt = Infinity;
      fish.stuckSince = 0;
      if (fish.space === "tank") {
        if (fish.state === "crossing") {
          fish.state = "inside";
          fish.goal = null;
        }
        continue;
      }
      if (fish.state === "dragging") continue;
      // staggered so they do not all pile onto the same point of the frame
      fish.state = "outside";
      fish.goal = null;
      fish.returnAt = this.time + Math.random() * 1.6;
    }
  }

  /* ---------------------------------------------------------- handling */

  /**
   * The mouse has taken hold of a fish. Only a fish that is already on the
   * desktop can be picked up: one inside the tank belongs to the tank.
   */
  grabFish(id) {
    const fish = this.fish.find((f) => f.id === id);
    if (!fish || fish.space !== "desk") return false;
    fish.state = "dragging";
    fish.goal = null;
    fish.cruise = null;
    fish.dragAt = this.time;
    return true;
  }

  /** Follow the hand. Position only — the tank still owns the fish. */
  dragFish(id, x, y) {
    const fish = this.fish.find((f) => f.id === id);
    if (!fish || fish.state !== "dragging") return;
    const nx = clamp(x, 10, this.desk.w - 10);
    const ny = clamp(y, 10, this.desk.h - 10);
    if (nx > fish.x + 0.3) fish.facing = 1;
    else if (nx < fish.x - 0.3) fish.facing = -1;
    fish.x = nx;
    fish.y = ny;
    fish.dragAt = this.time;
  }

  /**
   * Let go. Dropped over the tank it becomes a tank fish again (black at
   * once); dropped anywhere else it simply carries on swimming.
   */
  dropFish(id, x, y) {
    const fish = this.fish.find((f) => f.id === id);
    if (!fish || fish.state !== "dragging") return null;
    fish.dragAt = 0;

    if (rectHas(this.tankRect, x, y)) {
      this.enterTank(fish, x, y);
      return "tank";
    }

    fish.state = this.boundary === "closed" ? "returning" : "outside";
    fish.goal =
      this.boundary === "closed"
        ? nearestPointInside(this.tankRect, fish.x, fish.y, 42)
        : null;
    fish.cruise = null;
    fish.colorTarget = 1;
    if (this.boundary === "open") {
      // a fish that was just put down should not turn straight back
      fish.returnAt = this.time + 18 + Math.random() * 12;
    }
    return "desk";
  }

  /** Desk point -> tank fish, with the colour already back to ink. */
  enterTank(fish, x, y) {
    const padX = Math.max(fish.halfW + 4, 10);
    const padY = Math.max(fish.halfH + 4, 10);
    fish.x = clamp(x - this.tankRect.x, padX, Math.max(padX, this.bounds.w - padX));
    fish.y = clamp(y - this.tankRect.y, padY, Math.max(padY, this.bounds.h - padY));
    fish.space = "tank";
    fish.state = "inside";
    fish.goal = null;
    fish.cruise = null;
    fish.colorMix = 0;
    fish.colorTarget = 0;
    fish.returnAt = Infinity;
    fish.stuckSince = 0;
    fish.exitAt =
      this.boundary === "open" ? this.time + 10 + Math.random() * 14 : Infinity;
  }

  /* ------------------------------------------------------------- clock */

  step(dt) {
    this.time += dt;

    if (this.seaweed.enabled) this.seaweed.update(dt);
    this.bubbles.update(dt, this.bounds);

    const tank = this._tankWorld;
    const desk = this._deskWorld;

    for (const fish of this.fish) {
      // a held fish whose hand went away (the layer died, the mouse left)
      // must not stay frozen in mid-air for ever
      if (fish.state === "dragging" && this.time - fish.dragAt > 2.5) {
        this.dropFish(fish.id, fish.x, fish.y);
      }
      this.decide(fish);
      if (fish.space === "tank") {
        tank.hardBounds = this.boundary === "closed";
        fish.update(dt, tank);
      } else {
        desk.hardBounds = true;
        fish.update(dt, desk);
      }
      this.resolve(fish);
    }
  }

  /** Timed intentions: leave the tank, come back home. */
  decide(fish) {
    if (fish.state === "dragging") return;

    if (this.boundary === "open") {
      if (
        fish.space === "tank" &&
        fish.state === "inside" &&
        this.time >= fish.exitAt
      ) {
        fish.state = "crossing";
        fish.goal = nearestPointOutside(
          { x: 0, y: 0, w: this.bounds.w, h: this.bounds.h },
          fish.x,
          fish.y,
          44
        );
      }
      if (
        fish.space === "desk" &&
        fish.state === "outside" &&
        this.time >= fish.returnAt
      ) {
        fish.state = "returning";
        fish.goal = nearestPointInside(this.tankRect, fish.x, fish.y, 42);
      }
    } else if (
      fish.space === "desk" &&
      fish.state === "outside" &&
      this.time >= fish.returnAt
    ) {
      fish.state = "returning";
      fish.goal = nearestPointInside(this.tankRect, fish.x, fish.y, 42);
    }

    if (fish.state === "returning") {
      // keep aiming at the tank even if the window is being dragged around
      const home = nearestPointInside(this.tankRect, fish.x, fish.y, 42);
      // a tank hanging off the screen edge must not pull a fish off-screen
      fish.goal = {
        x: Math.min(Math.max(home.x, 24), this.desk.w - 24),
        y: Math.min(Math.max(home.y, 24), this.desk.h - 24),
      };

      // colour fades out *continuously* as it approaches, instead of flipping
      // at a threshold, so the change is invisible rather than a step
      const dx = Math.max(
        this.tankRect.x - fish.x,
        0,
        fish.x - (this.tankRect.x + this.tankRect.w)
      );
      const dy = Math.max(
        this.tankRect.y - fish.y,
        0,
        fish.y - (this.tankRect.y + this.tankRect.h)
      );
      const away = Math.hypot(dx, dy);
      const t = Math.min(1, Math.max(0, (away - 32) / 110));
      fish.colorTarget = t * t * (3 - 2 * t);

      // last resort: a goal that cannot be reached (tank almost completely
      // off the screen) would leave the fish waiting forever, and the layer
      // open forever with it. If it has been parked next to an unreachable
      // goal, take it home — this only ever happens while the tank itself is
      // out of sight.
      const d = Math.hypot(fish.goal.x - fish.x, fish.goal.y - fish.y);
      if (d < 26) {
        if (!fish.stuckSince) fish.stuckSince = this.time;
        else if (this.time - fish.stuckSince > 2.5) this.rescue(fish);
      } else {
        fish.stuckSince = 0;
      }
    }
  }

  /** Put a fish back in the tank when its way home is physically unreachable. */
  rescue(fish) {
    const padX = fish.halfW + 8;
    const padY = fish.halfH + 8;
    fish.x = Math.min(
      Math.max(this.desk.w / 2 - this.tankRect.x, padX),
      Math.max(padX, this.bounds.w - padX)
    );
    fish.y = Math.min(
      Math.max(this.desk.h / 2 - this.tankRect.y, padY),
      Math.max(padY, this.bounds.h - padY)
    );
    fish.space = "tank";
    fish.state = "inside";
    fish.goal = null;
    fish.cruise = null;
    fish.colorMix = 0;
    fish.colorTarget = 0;
    fish.returnAt = Infinity;
    fish.exitAt =
      this.boundary === "open" ? this.time + 8 + Math.random() * 12 : Infinity;
    fish.stuckSince = 0;
    console.warn("[sim] rescued a fish whose way home was unreachable");
  }

  /** Space hand-over. Called right after the fish moved. */
  resolve(fish) {
    if (fish.space === "tank") {
      if (
        this.boundary === "open" &&
        fish.state === "crossing" &&
        !rectHas({ x: 0, y: 0, w: this.bounds.w, h: this.bounds.h }, fish.x, fish.y)
      ) {
        fish.x += this.tankRect.x;
        fish.y += this.tankRect.y;
        fish.space = "desk";
        fish.state = "outside";
        fish.goal = null;
        fish.colorTarget = 1;
        fish.returnAt = this.time + 14 + Math.random() * 16;
      }
      return;
    }

    if (fish.state === "returning" && rectHas(this.tankRect, fish.x, fish.y)) {
      // the fish is already inside the tank rect: hand it over in place, so
      // there is not a single frame of difference between the two canvases
      this.enterTank(fish, fish.x, fish.y);
    }
  }

  /* ------------------------------------------------------------ output */

  counts() {
    let desk = 0;
    for (const fish of this.fish) if (fish.space === "desk") desk++;
    return { desk, tank: this.fish.length - desk };
  }

  /** What the desktop layer needs to draw. Desk space, rounded to 0.1 px. */
  snapshot() {
    const out = this._frame;
    out.length = 0;
    for (const fish of this.fish) {
      if (fish.space !== "desk") continue;
      out.push({
        id: fish.id,
        g: fish.glyph,
        x: Math.round(fish.x * 10) / 10,
        y: Math.round(fish.y * 10) / 10,
        f: fish.facing,
        m: Math.round(fish.colorMix * 100) / 100,
        c: fish.oceanColor,
        // the body shape travels with the fish: same ripple, same lean
        w: Math.round(fish.wavePhase * 100) / 100,
        p: Math.round(fish.pitch * 100) / 100,
        a: fish.waveAmp,
      });
    }
    return out;
  }
}
