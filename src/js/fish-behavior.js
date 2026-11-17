// Steering helpers for the fish. Pure functions only — no rendering, no state.
//
// The goal is "calm, never mechanical":
//   * a wander target that is only re-rolled every few seconds
//   * every change goes through a turn-rate limit (no snapping)
//   * walls push the heading away *before* the fish touches them
//   * neighbours push slightly so two fish rarely overlap

export const TAU = Math.PI * 2;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function normalizeAngle(a) {
  let x = a % TAU;
  if (x > Math.PI) x -= TAU;
  if (x < -Math.PI) x += TAU;
  return x;
}

/** Shortest signed rotation from `from` to `to`, in radians. */
export function angleDelta(from, to) {
  return normalizeAngle(to - from);
}

/**
 * How strongly the fish should steer away from the walls.
 * Returns a vector in [-1, 1] per axis; the renderer never needs it.
 */
export function boundarySteer(fish, bounds, margin) {
  const minX = fish.halfW + margin;
  const maxX = bounds.w - fish.halfW - margin;
  const minY = fish.halfH + margin;
  const maxY = bounds.h - fish.halfH - margin;

  let x = 0;
  let y = 0;

  if (fish.x < minX) x += (minX - fish.x) / margin;
  else if (fish.x > maxX) x -= (fish.x - maxX) / margin;

  if (fish.y < minY) y += (minY - fish.y) / margin;
  else if (fish.y > maxY) y -= (fish.y - maxY) / margin;

  return { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
}

/** Push away from nearby fish so they never sit on top of each other. */
export function separationSteer(fish, others, radius) {
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < others.length; i++) {
    const other = others[i];
    if (other === fish) continue;
    const dx = fish.x - other.x;
    const dy = fish.y - other.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > radius * radius || d2 < 0.0001) continue;
    const d = Math.sqrt(d2);
    const weight = 1 - d / radius;
    sx += (dx / d) * weight;
    sy += (dy / d) * weight;
  }
  return { x: sx, y: sy };
}
