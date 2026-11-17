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

export const FISH_SIZE = 15;

/** Radians of phase per body length. More = a tighter ripple. */
const WAVE_RATE = 3.1;
/** Head-to-tail tilt (px) when the fish is swimming straight up or down. */
const PITCH = 3.2;

export class GlyphRun {
  constructor(glyph) {
    this.glyph = glyph;
    this.chars = Array.from(glyph);
    this.n = this.chars.length;
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
   * Fill dx/dy for one frame.
   *
   * @param {number} facing 1 = head to the left, -1 = head to the right
   * @param {number} phase  undulation phase in radians, advanced by the sim
   * @param {number} amp    ripple amplitude at the tail, px
   * @param {number} pitch  -1..1; +1 dives (head low), -1 rises (head high)
   */
  layout(facing, phase, amp, pitch) {
    const n = this.n;
    const mid = (n - 1) / 2;
    const tilt = pitch * PITCH;

    for (let i = 0; i < n; i++) {
      const u = n > 1 ? i / (n - 1) : 0; // 0 at the head, 1 at the tail
      const wave = Math.sin(phase - u * WAVE_RATE) * amp * (0.25 + 0.75 * u);
      this.dx[i] = (i - mid) * this.advance * facing;
      this.dy[i] = wave + (0.5 - u) * 2 * tilt;
    }
  }

  /** Vertical reach of the shape, for hit boxes and dirty rects. */
  get reach() {
    return PITCH + 6; // glyph box is ~8px on either side of the baseline
  }
}
