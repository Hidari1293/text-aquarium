// The world: three fish, some bubbles, some seaweed, and a clock.
// Pure simulation — it knows nothing about canvases or DOM.
//
// This one object is the single source of truth for both worlds. Fish inside
// the tank live in tank-local pixels; fish on the desktop live in desk pixels
// (the desktop layer's client space). Crossing the boundary converts a fish
// from one to the other in a single frame at the exact edge — which is why
// nothing ever teleports or gets drawn twice.

import { Bubbles } from "./bubbles.js";
import {
  adaptiveInk,
  adaptRgb,
  nearestPointInside,
  rectHas,
} from "./coordinates.js";
import { Fish, fishProfile, fishProfileCustom } from "./fish.js";
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

/** Shared "no cursor here" value; the worlds point at it by default. */
const NO_CURSOR = { x: 0, y: 0, active: false, idle: 0 };

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

    /** Settings-owned world knobs, applied through the setters below. */
    this.fishCount = 3;
    this.fishSize = 15;
    this.liveliness = 1;
    /** A user-typed fish swimming next to the standard school. */
    this.customGlyph = "";
    this.customFacing = 1;
    this.customFish = null;
    /** While the net (hunt mode) is out, fish hold still for the lasso. */
    this.hunting = false;
    /** Test-only: freeze cursor updates (dev channel sets this). */
    this.cursorLocked = false;

    /** Where the mouse is, per space; lastMove drives the idle curiosity. */
    this._cursor = {
      tank: { x: 0, y: 0, active: false, idle: 0 },
      desk: { x: 0, y: 0, active: false, idle: 0 },
      lastMove: -Infinity,
    };

    // scratch objects, reused every frame (no per-frame allocation)
    this._tankWorld = {
      bounds: this.bounds,
      margin: TURN_MARGIN,
      separation: SEPARATION,
      fish: this.fish,
      hardBounds: true,
      time: 0,
      liveliness: 1,
      cursor: NO_CURSOR,
      dodgeRadius: 46,
      curiousIdle: 4,
      curiousRadius: 70,
    };
    this._deskWorld = {
      bounds: { w: 0, h: 0 },
      margin: DESK_MARGIN,
      separation: SEPARATION + 24,
      fish: this.fish,
      hardBounds: true,
      time: 0,
      liveliness: 1,
      cursor: NO_CURSOR,
      dodgeRadius: 46,
      curiousIdle: 4,
      curiousRadius: 70,
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
    const list = [];
    for (let i = 0; i < this.fishCount; i++) {
      const spot = SPAWNS[i % SPAWNS.length];
      const fish = new Fish(fishProfile(i), {
        x: i < SPAWNS.length ? w * spot.fx : 60 + Math.random() * (w - 120),
        y: i < SPAWNS.length ? h * spot.fy : 60 + Math.random() * (h - 120),
        heading: Math.random() * Math.PI * 2,
      });
      list.push(fish);
    }
    this.fish = list;
    this._tankWorld.fish = this.fish;
    this._deskWorld.fish = this.fish;
    this.applyFishSize();
    for (const fish of this.fish) fish.clampToBounds(this.bounds);
  }

  /** The renderer knows the font, so it tells us how wide each glyph is. */
  syncMetrics(measure) {
    for (const fish of this.fish) {
      const width = measure(fish.glyph);
      fish.halfW = width / 2 + 2;
    }
  }

  /* ---------------------------------------------------------- settings */

  /**
   * Keep the standard school between 3 and 8: extras spawn in the tank.
   * The custom fish swims *next to* the school and is never trimmed by this.
   */
  setFishCount(count) {
    this.fishCount = clamp(Math.round(count), 3, 8);
    const standard = () => this.fish.filter((f) => f !== this.customFish);
    while (standard().length < this.fishCount) this.addFish();
    while (standard().length > this.fishCount) {
      // prefer thinning the tank; a visible desk fish is a worse surprise
      let fish = standard().find((f) => f.space === "tank");
      if (!fish) fish = standard()[standard().length - 1];
      const index = this.fish.indexOf(fish);
      if (index >= 0) this.fish.splice(index, 1);
    }
  }

  addFish() {
    const { w, h } = this.bounds;
    const fish = new Fish(fishProfile(this.fish.length), {
      x: 60 + Math.random() * Math.max(1, w - 120),
      y: 60 + Math.random() * Math.max(1, h - 120),
      heading: Math.random() * Math.PI * 2,
    });
    fish.halfH = this.fishSize * 0.55;
    fish.waveAmp = fish.profile.bobAmp * 1.2 * (this.fishSize / 15);
    fish.clampToBounds(this.bounds);
    this.fish.push(fish);
    // the boundary is open: the newcomer may join the desk world in a while
    if (this.boundary === "open") fish.exitAt = this.time + 6 + Math.random() * 8;
  }

  /* ---------------------------------------------------- custom fish */

  /**
   * A fish the user typed themselves, swimming next to the standard school.
   * Empty text removes it. `facing` = which way the text faces as written.
   */
  setCustomFish(glyph, facing) {
    const text = String(glyph || "").trim().slice(0, 16);
    const dir = facing >= 0 ? 1 : -1;
    if (this.customGlyph === text && this.customFacing === dir && this.customFish) {
      return;
    }
    this.customGlyph = text;
    this.customFacing = dir;
    if (this.customFish) {
      const index = this.fish.indexOf(this.customFish);
      if (index >= 0) this.fish.splice(index, 1);
      this.customFish = null;
    }
    if (!text) return;

    const { w, h } = this.bounds;
    const fish = new Fish(fishProfileCustom(text, dir, this.fish.length), {
      x: 60 + Math.random() * Math.max(1, w - 120),
      y: 60 + Math.random() * Math.max(1, h - 120),
      heading: Math.random() * Math.PI * 2,
    });
    fish.halfH = this.fishSize * 0.55;
    fish.waveAmp = fish.profile.bobAmp * 1.2 * (this.fishSize / 15);
    fish.clampToBounds(this.bounds);
    this.fish.push(fish);
    this.customFish = fish;
    if (this.boundary === "open") fish.exitAt = this.time + 6 + Math.random() * 8;
  }

  /* -------------------------------------------------- background */

  /**
   * A sampled screen pixel behind a desk fish (luminance 0..255). The fish
   * lerps towards it, so the colour adaptation glides instead of popping.
   */
  noteBackground(id, lum) {
    const fish = this.customFish && this.customFish.id === id
      ? this.customFish
      : this.fish.find((f) => f.id === id);
    if (!fish || fish.space !== "desk") return;
    fish.bgLum += (lum - fish.bgLum) * 0.2;
  }

  setFishSize(size) {
    this.fishSize = clamp(Math.round(size), 12, 22);
    this.applyFishSize();
    for (const fish of this.fish) fish.clampToBounds(this.bounds);
    this.applyLiveliness();
  }

  applyFishSize() {
    for (const fish of this.fish) {
      fish.halfH = this.fishSize * 0.55;
      fish.waveAmp = fish.profile.bobAmp * 1.2 * (this.fishSize / 15);
    }
  }

  /** Liveliness = speed and curiosity in one knob. */
  setLiveliness(value) {
    this.liveliness = clamp(Number(value) || 1, 0.5, 2);
    this.applyLiveliness();
  }

  applyLiveliness() {
    const L = this.liveliness;
    for (const world of [this._tankWorld, this._deskWorld]) {
      world.liveliness = L;
      world.dodgeRadius = (this.fishSize / 15) * 46;
      world.curiousIdle = Math.max(1.5, 5.6 - 1.6 * L);
      world.curiousRadius = clamp(70 + 60 * (L - 1), 40, 150);
    }
  }

  /** The net is out (hunt mode): fish hold still for the lasso. */
  setHunting(on) {
    this.hunting = Boolean(on);
  }

  /* ------------------------------------------------------------ cursor */

  /** Report the cursor in one space; movement refreshes the idle clock. */
  setCursor(space, x, y) {
    if (this.cursorLocked) return;
    const c = this._cursor[space];
    if (!c) return;
    // first sight counts as movement, or the idle clock starts at -Infinity
    if (!c.active || Math.hypot(c.x - x, c.y - y) > 0.6) {
      this._cursor.lastMove = this.time;
    }
    c.x = x;
    c.y = y;
    c.active = true;
  }

  /** The cursor left this space; fish there stop reacting to it. */
  clearCursor(space) {
    const c = this._cursor[space];
    if (c) c.active = false;
  }

  /** Dev channel only: keep manual cursor state from being overwritten. */
  setCursorLock(locked) {
    this.cursorLocked = Boolean(locked);
  }

  /* ---------------------------------------------------------- boundary */

  openBoundary() {
    if (this.boundary === "open") return;
    this.boundary = "open";

    for (const fish of this.fish) {
      fish.stuckSince = 0;
      fish.mood = "cruise";
      if (fish.state === "returning") {
        // change of plan: stay out
        fish.state = "outside";
        fish.goal = null;
        fish.colorTarget = 1;
        fish.returnAt = this.time + 14 + Math.random() * 14;
      } else if (fish.space === "tank" && fish.state === "inside") {
        // staggered on purpose: nobody wants the whole school to bolt at once
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
      fish.mood = "cruise";
      if (fish.space === "tank") {
        if (fish.state === "crossing") {
          // a fish already at the door may finish squeezing out and will come
          // straight back — yanking it 40px into the tank would be a teleport
          const padX = fish.halfW;
          const nearEdge =
            fish.x > this.bounds.w - padX ||
            fish.x < padX ||
            fish.y < fish.halfH ||
            fish.y > this.bounds.h - fish.halfH;
          if (nearEdge) continue;
          fish.state = "inside";
          fish.goal = null;
        }
        continue;
      }
      // staggered so they do not all pile onto the same point of the frame
      fish.state = "outside";
      fish.goal = null;
      fish.returnAt = this.time + Math.random() * 1.6;
    }
  }

  /* ---------------------------------------------------------- handling */

  /**
   * The point a returning fish swims to. It must sit *deeper* inside the tank
   * than the entry hand-over (which fires when the whole glyph is inside):
   * a goal short of that line would park the fish 4px from the door until
   * the rescue teleports it — the 487px jump the tests once caught.
   */
  homeGoal(fish) {
    return nearestPointInside(this.tankRect, fish.x, fish.y, fish.halfW + 8);
  }

  /**
   * The net: a box dragged on the desktop. Every free-swimming desk fish
   * inside it starts swimming home — no teleporting, the journey is theirs.
   * Returns how many were caught.
   */
  lassoFish(x1, y1, x2, y2) {
    const rect = {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.abs(x2 - x1),
      h: Math.abs(y2 - y1),
    };
    let caught = 0;
    for (const fish of this.fish) {
      if (fish.space !== "desk" || fish.state !== "outside") continue;
      if (!rectHas(rect, fish.x, fish.y)) continue;
      fish.state = "returning";
      fish.goal = this.homeGoal(fish);
      fish.mood = "cruise";
      fish.stuckSince = 0;
      caught++;
    }
    return caught;
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
    fish.mood = "cruise";
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
    tank.time = this.time;
    desk.time = this.time;

    // cursor state feeds the fish moods; "idle" is what makes them curious
    const idle = this.time - this._cursor.lastMove;
    this._cursor.tank.idle = idle;
    this._cursor.desk.idle = idle;
    const cursorLive = !this.hunting; // the net is out: hold still for it
    tank.cursor = cursorLive ? this._cursor.tank : NO_CURSOR;
    desk.cursor = cursorLive ? this._cursor.desk : NO_CURSOR;

    for (const fish of this.fish) {
      this.decide(fish);
      if (fish.space === "tank") {
        // a fish finishing an interrupted exit must reach the edge, or the
        // hard clamp would bounce it back before resolve() can hand it over
        tank.hardBounds = this.boundary === "closed" && fish.state !== "crossing";
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
    if (this.boundary === "open") {
      if (
        fish.space === "tank" &&
        fish.state === "inside" &&
        this.time >= fish.exitAt
      ) {
        fish.state = "crossing";
        fish.mood = "cruise";
        // the fish leaves through the side it is already swimming towards:
        // an exit over the top or the bottom reads as the tank leaking
        fish.goal = {
          x: fish.facing >= 0 ? this.bounds.w + 30 : -30,
          y: clamp(fish.y, 34, Math.max(34, this.bounds.h - 34)),
        };
      }
      // a fish that made it out stays out: the only ways home are the net
      // or closing the boundary (a voluntary return once took fish to a
      // clamped corner when the tank window was minimised — see v1.2.1 log)
    } else if (
      fish.space === "desk" &&
      fish.state === "outside" &&
      this.time >= fish.returnAt
    ) {
      fish.state = "returning";
      fish.mood = "cruise";
      fish.goal = this.homeGoal(fish);
    }

    if (fish.state === "returning") {
      // keep aiming at the tank even if the window is being dragged around
      const home = this.homeGoal(fish);
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
    fish.mood = "cruise";
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
      // the hand-over happens the moment the *leading end* of the fish clears
      // the border, not when its centre does: the desktop layer then draws
      // the whole glyph (it sits on top of the tank), so the fish slides out
      // in one piece instead of being clipped at the border and popping out.
      const leadingOut =
        fish.facing >= 0
          ? fish.x > this.bounds.w - fish.halfW
          : fish.x < fish.halfW;
      if (fish.state === "crossing" && leadingOut) {
        fish.x += this.tankRect.x;
        fish.y += this.tankRect.y;
        fish.space = "desk";
        fish.goal = null;
        fish.mood = "cruise";
        if (this.boundary === "open") {
          fish.state = "outside";
          fish.colorTarget = 1;
          fish.returnAt = Infinity; // it stays out until netted or called home
        } else {
          // the boundary closed while this fish was already at the door: it
          // finishes the squeeze-out and turns straight back, no teleport
          fish.state = "returning";
          fish.goal = this.homeGoal(fish);
          fish.colorTarget = 0;
        }
      }
      return;
    }

    if (
      fish.state === "returning" &&
      rectHas(this.tankRect, fish.x, fish.y, -fish.halfW - 2)
    ) {
      // the fish is fully inside the tank rect (the whole glyph cleared the
      // frame): hand it over in place, so there is not a single frame of
      // difference between the two canvases — and the entry clamp that keeps
      // glyphs off the border is already satisfied, so no snap either
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
        // which way the text faces as written (custom fish bring their own)
        cf: fish.canonFacing,
        x: Math.round(fish.x * 10) / 10,
        y: Math.round(fish.y * 10) / 10,
        f: fish.facing,
        m: Math.round(fish.colorMix * 100) / 100,
        // colours adapt to the background the fish is swimming over
        c: adaptRgb(fish.oceanColor, fish.bgLum),
        i: adaptiveInk(fish.bgLum),
        // the body shape travels with the fish: same ripple, same lean
        w: Math.round(fish.wavePhase * 100) / 100,
        p: Math.round(fish.pitch * 100) / 100,
        a: fish.waveAmp,
      });
    }
    return out;
  }
}
