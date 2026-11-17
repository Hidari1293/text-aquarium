// Tank rendering. Characters on a canvas — nothing else.
//
// Canvas (not DOM) because a fish moves every frame and DOM nodes would mean
// layout work for every character; three fish + a dozen glyphs at 60 fps is
// nothing for a 2D context.

import { FISH_SIZE, GlyphRun } from "./glyph.js";

const FONT_STACK =
  'ui-monospace, "Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", "DejaVu Sans Mono", monospace';

const PLANT_SIZE = 13;
const PLANT_LINE = 13;
const BUBBLE_SIZE = 12;
const GRAVEL_SIZE = 11;

/** Half-pixel snapping keeps the glyphs crisp without making motion steppy. */
function snap(v) {
  return Math.round(v * 2) / 2;
}

export class TankRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true });
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.currentFont = "";
    /** glyph -> layout, measured once; fish keep their shape for life */
    this.runs = new Map();

    // Plants and bubbles are ~100 glyphs. Repainting them 30 times a second is
    // most of the tank's CPU bill for movement nobody can see, so they get
    // their own canvas that is refreshed a few times a second and blitted.
    this.backdrop = document.createElement("canvas");
    this.backdropCtx = this.backdrop.getContext("2d", { alpha: true });
    this.backdropAt = -1;
    /** Footprints of last frame's fish, so only they need erasing. */
    this.ink = [];
  }

  run(glyph) {
    let run = this.runs.get(glyph);
    if (run === undefined) {
      this.useFont(FISH_SIZE);
      run = new GlyphRun(glyph);
      run.measure(this.ctx);
      this.runs.set(glyph, run);
    }
    return run;
  }

  font(size) {
    return `${size}px ${FONT_STACK}`;
  }

  /** Assigning `ctx.font` re-parses the CSS shorthand, so only do it on change. */
  useFont(size) {
    const font = this.font(size);
    if (this.currentFont !== font) {
      this.ctx.font = font;
      this.currentFont = font;
    }
  }

  resize(cssWidth, cssHeight) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.width = Math.max(1, cssWidth);
    this.height = Math.max(1, cssHeight);

    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // assigning canvas.width resets *all* context state, including the font —
    // the cache below must not keep claiming the old one is still set
    this.currentFont = "";

    this.backdrop.width = this.canvas.width;
    this.backdrop.height = this.canvas.height;
    this.backdropAt = -1;
    this.ink.length = 0;
  }

  measure(glyph, size = FISH_SIZE) {
    return this.run(glyph).width;
  }

  render(sim) {
    const ctx = this.ctx;

    // Plants and bubbles sway slowly: 14 Hz of backdrop is indistinguishable
    // from 60 and leaves the per-frame budget to the fish.
    const repaintAll =
      this.backdropAt < 0 || sim.time - this.backdropAt > 0.07;

    if (repaintAll) {
      this.backdropAt = sim.time;
      this.paintBackdrop(sim);
      ctx.clearRect(0, 0, this.width, this.height);
      ctx.drawImage(this.backdrop, 0, 0, this.width, this.height);
      this.ink.length = 0;
    } else {
      // erase only where fish were last frame, and put the water back under
      // them — a full-canvas clear + blit 30 times a second is the single
      // most expensive thing this window could do
      for (let i = 0; i < this.ink.length; i++) {
        const r = this.ink[i];
        ctx.clearRect(r.x, r.y, r.w, r.h);
        this.blitBackdrop(r);
      }
      this.ink.length = 0;
    }

    // fish that left the tank are drawn by the desktop layer, never here —
    // drawing them in both places would double the ink at the seam
    for (const fish of sim.fish) {
      if (fish.space === "tank") this.drawFish(fish);
    }
  }

  blitBackdrop(rect) {
    const dpr = this.dpr;
    this.ctx.drawImage(
      this.backdrop,
      rect.x * dpr,
      rect.y * dpr,
      rect.w * dpr,
      rect.h * dpr,
      rect.x,
      rect.y,
      rect.w,
      rect.h
    );
  }

  paintBackdrop(sim) {
    const main = this.ctx;
    const mainFont = this.currentFont;
    this.ctx = this.backdropCtx;
    this.currentFont = "";

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.clearRect(0, 0, this.width, this.height);

    this.drawGravel();
    this.drawSeaweed(sim.seaweed);
    this.drawBubbles(sim.bubbles);

    this.ctx = main;
    this.currentFont = mainFont;
  }

  drawGravel() {
    const ctx = this.ctx;
    const y = this.height - 5;
    if (y < 12) return;
    this.useFont(GRAVEL_SIZE);
    ctx.fillStyle = "rgba(17, 17, 17, 0.14)";
    for (let x = 14; x < this.width - 8; x += 26) {
      ctx.fillText("·", x, y);
    }
  }

  drawSeaweed(bed) {
    if (!bed.enabled || bed.stalks.length === 0) return;
    const ctx = this.ctx;
    this.useFont(PLANT_SIZE);
    ctx.fillStyle = "rgba(17, 17, 17, 0.45)";

    for (const stalk of bed.stalks) {
      const count = stalk.segments;
      let prevX = stalk.x;

      for (let i = 0; i < count; i++) {
        const u = count > 1 ? i / (count - 1) : 1;
        const sway =
          Math.sin(bed.time * stalk.speed + stalk.phase + u * 1.4) *
          stalk.amp *
          u *
          u;
        const x = stalk.x + stalk.bend * u * u + sway;
        const y = stalk.baseY - i * PLANT_LINE;

        let ch = "│";
        if (i > 0) {
          const dx = x - prevX;
          ch = dx > 2.1 ? "╱" : dx < -2.1 ? "╲" : "│";
        }
        if (i === count - 1) ch = "♧";

        ctx.fillText(ch, snap(x), y);
        prevX = x;
      }
    }
  }

  drawBubbles(bubbles) {
    if (!bubbles.enabled || bubbles.items.length === 0) return;
    const ctx = this.ctx;
    this.useFont(BUBBLE_SIZE);
    for (const b of bubbles.items) {
      ctx.fillStyle = `rgba(17, 17, 17, ${b.alpha})`;
      ctx.fillText(b.ch, snap(b.x + Math.sin(b.wob) * b.wobAmp), snap(b.y));
    }
  }

  drawFish(fish) {
    const ctx = this.ctx;
    const run = this.run(fish.glyph);
    this.useFont(FISH_SIZE);
    ctx.fillStyle = fish.tankColor;

    // one vertical offset per character: the body ripples and the head leans
    // into the heading, which is what makes it swim instead of drift
    run.layout(fish.facing, fish.wavePhase, fish.waveAmp, fish.pitch);

    const bx = snap(fish.x);
    const by = snap(fish.y);
    const { chars, dx, dy, n } = run;
    for (let i = 0; i < n; i++) {
      ctx.fillText(chars[i], bx + dx[i], by + dy[i]);
    }

    // remember the footprint so the next frame can erase just this much
    this.ink.push({
      x: Math.floor(bx - run.halfW - 4),
      y: Math.floor(by - 20),
      w: Math.ceil(run.width + 8),
      h: 40,
    });
  }
}
