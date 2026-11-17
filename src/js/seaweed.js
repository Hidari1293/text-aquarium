// Seaweed: characters rooted at the bottom, bending and swaying very slightly.
//
// A stalk is a smooth curve: its horizontal offset grows with the square of the
// height, so the stem starts vertical and leans out towards the tip. The glyph
// is then chosen from the local slope — `│` for straight, `╱ ╲` for a bend —
// which is what makes a column of characters read as a plant instead of a pin.
//
// Clumps (not an even row) because an even row looks like a fence.

const CLUMPS = [
  { at: 0.085, stems: 3 },
  { at: 0.33, stems: 2 },
  { at: 0.625, stems: 1 },
  { at: 0.885, stems: 3 },
];

const STEM_SPREAD = 7.5;

/** Cheap deterministic jitter so a resize does not reshuffle the garden. */
function pick(seed, lo, hi) {
  const x = Math.sin(seed * 127.1) * 43758.5453;
  return lo + (x - Math.floor(x)) * (hi - lo);
}

export class SeaweedBed {
  constructor() {
    this.stalks = [];
    this.enabled = true;
    this.time = 0;
  }

  layout(width, height) {
    const stalks = [];
    let seed = 0;

    for (const clump of CLUMPS) {
      const centerX = width * clump.at;
      for (let i = 0; i < clump.stems; i++) {
        seed += 1;
        stalks.push({
          x: centerX + (i - (clump.stems - 1) / 2) * STEM_SPREAD,
          baseY: height - 9,
          segments: Math.round(pick(seed * 1.7, 4, 7.4)),
          bend: pick(seed * 2.3, -11, 11),
          amp: pick(seed * 3.7, 1.6, 3.2),
          speed: pick(seed * 4.1, 0.38, 0.62),
          phase: pick(seed * 5.9, 0, Math.PI * 2),
        });
      }
    }

    this.stalks = stalks;
  }

  update(dt) {
    if (!this.enabled) return;
    this.time += dt;
  }
}
