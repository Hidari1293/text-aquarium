// How a line of characters becomes a fish.
//
// A glyph string cannot rotate, but it can bend. Every character gets its own
// vertical offset, which buys two things at once:
//
//   * undulation — the body ripples from head to tail while it swims, so the
//     fish looks alive instead of sliding across the screen like a decal
//   * pitch — the head leans up or down by the vertical part of its heading,
//     so the nose really does point the way the fish is going
//
// Both canvases (tank and desktop layer) lay fish out with this module, so a
// fish that crosses the boundary keeps exactly the same shape on either side.
//
// Turning around: a fish is NOT a string of independent characters. The whole
// fish turns — read the characters back to front and mirror each one, so
// "><)))o>" becomes "<o(((><" and the nose / tail swap ends. (Flipping every
// character in place would leave a fish that still has its tail where its
// head should be — the glyph falls apart.)

export const FISH_SIZE = 15;

/** Radians of phase per body length. More = a tighter ripple. */
const WAVE_RATE = 3.1;
/** Head-to-tail tilt (px) when the fish is swimming straight up or down. */
const PITCH = 3.2;

/** How each character reads when the fish faces the other way. */
const MIRROR = {
  ">": "<",
  "<": ">",
  "(": ")",
  ")": "(",
  "彡": "ミ",
};

export class GlyphRun {
  constructor(glyph, canonFacing) {
    this.glyph = glyph;
    this.chars = Array.from(glyph);
    this.n = this.chars.length;

    // Every built-in glyph starts with its nose: ">" faces right as written,
    // "<" left. Custom fish bring their own direction (their text may not
    // start with a bracket at all).
    this.canonFacing =
      canonFacing !== undefined
        ? canonFacing
        : this.chars[0] === "<"
          ? -1
          : 1;

    // The same fish facing the other way: reversed order, mirrored characters.
    const mirrored = [];
    for (let i = this.n - 1; i >= 0; i--) {
      mirrored.push(MIRROR[this.chars[i]] ?? this.chars[i]);
    }
    this.mirrorChars = mirrored;
    /** The character sequence the last layout() chose, ready for fillText. */
    this.drawChars = this.chars;

    this.advance = FISH_SIZE * 0.6; // replaced by measure()
    this.dx = new Float32Array(this.n);
    this.dy = new Float32Array(this.n);
  }

  /** Width of the run in css px. The caller has already set ctx.font. */
  measure(ctx) {
    this.advance = ctx.measureText(this.glyph).width / this.n;
    return this.advance * this.n;
  }

  get width() {
    return this.advance * this.n;
  }

  get halfW() {
    return (this.advance * this.n) / 2;
  }

  /**
   * Fill dx/dy and pick the character sequence for one frame.
   *
   * @param {number} facing 1 = swimming right, -1 = swimming left
   * @param {number} phase  undulation phase in radians, advanced by the sim
   * @param {number} amp    ripple amplitude at the tail, px
   * @param {number} pitch  -1..1; +1 dives (head low), -1 rises (head high)
   * @param {number} tiltPx how far the nose rises/dips (scaled with fish size)
   */
  layout(facing, phase, amp, pitch, tiltPx = PITCH) {
    const n = this.n;
    const mid = (n - 1) / 2;
    const tilt = pitch * tiltPx;
    const mirrored = facing !== this.canonFacing;
    this.drawChars = mirrored ? this.mirrorChars : this.chars;

    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0; // 0 at the left end, 1 at the right
      const u = mirrored ? 1 - t : t; // 0 at the nose, 1 at the tail
      const wave = Math.sin(phase - u * WAVE_RATE) * amp * (0.25 + 0.75 * u);
      this.dx[i] = (i - mid) * this.advance;
      this.dy[i] = wave + (0.5 - u) * 2 * tilt;
    }
  }

  /** Vertical reach of the shape, for hit boxes and dirty rects. */
  get reach() {
    return PITCH + 6; // glyph box is ~8px on either side of the baseline
  }
}
