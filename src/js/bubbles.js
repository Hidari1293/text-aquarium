// A few slow bubbles. They are scenery: sparse, light, never in the way.

const GLYPHS = [
  { ch: "·", alpha: 0.32 },
  { ch: "°", alpha: 0.3 },
  { ch: "o", alpha: 0.28 },
  { ch: "○", alpha: 0.22 },
];

export class Bubbles {
  constructor() {
    this.items = [];
    this.enabled = true;
    this.spawnIn = 1.6;
  }

  clear() {
    this.items.length = 0;
  }

  update(dt, bounds) {
    if (!this.enabled) {
      if (this.items.length) this.clear();
      return;
    }

    this.spawnIn -= dt;
    if (this.spawnIn <= 0) {
      if (this.items.length < 6) this.spawn(bounds);
      this.spawnIn = 2.4 + Math.random() * 2.8;
    }

    for (let i = this.items.length - 1; i >= 0; i--) {
      const b = this.items[i];
      b.y -= b.vy * dt;
      b.wob += b.wobSpeed * dt;
      if (b.y < -14) this.items.splice(i, 1);
    }
  }

  spawn(bounds) {
    const glyph = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
    const fromBottom = Math.random() < 0.78;
    this.items.push({
      ch: glyph.ch,
      alpha: glyph.alpha,
      x: 16 + Math.random() * Math.max(1, bounds.w - 32),
      y: fromBottom ? bounds.h - 8 : bounds.h * (0.45 + Math.random() * 0.4),
      vy: 8 + Math.random() * 11,
      wob: Math.random() * Math.PI * 2,
      wobSpeed: 0.5 + Math.random() * 0.7,
      wobAmp: 1.2 + Math.random() * 2.4,
    });
  }
}
