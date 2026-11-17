// The one shared space both worlds live in.
//
// "desk" coordinates = CSS pixels of the desktop layer's client area, whose
// origin sits on the primary monitor work area. Everything outside the tank
// is expressed there; the tank keeps its own local space (so a fish inside
// travels with the window when you drag it around).
//
//   desk = (physical - overlayInner) / scale
//   tankRect.x = desk position of the tank canvas, top-left
//
// Phase 2 supports the primary monitor only: both windows share one scale
// factor there, which is what makes the conversion exact.

export const INK = [17, 17, 17];

/** "#D98B4B" -> [217, 139, 75]. Cached: profiles never change colour. */
const rgbCache = new Map();

export function rgb(hex) {
  let value = rgbCache.get(hex);
  if (!value) {
    const n = parseInt(hex.slice(1), 16);
    value = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    rgbCache.set(hex, value);
  }
  return value;
}

/** Ink -> colour blend. mix = 0 is the ink, 1 the full colour. */
export function blend(color, mix, ink = INK) {
  if (mix <= 0) return `rgb(${ink[0]},${ink[1]},${ink[2]})`;
  const to = Array.isArray(color) ? color : rgb(color);
  const r = Math.round(ink[0] + (to[0] - ink[0]) * mix);
  const g = Math.round(ink[1] + (to[1] - ink[1]) * mix);
  const b = Math.round(ink[2] + (to[2] - ink[2]) * mix);
  return `rgb(${r},${g},${b})`;
}

/**
 * The ocean colour, adjusted for whatever the fish is swimming over.
 * A dark desktop lightens the fish (towards white), a bright one darkens it
 * slightly — a fish must read on a wallpaper of any shade.
 */
export function adaptRgb(hex, lum) {
  const base = rgb(hex);
  let [r, g, b] = base;
  if (lum < 90) {
    const k = ((90 - lum) / 90) * 0.55;
    r = r + (255 - r) * k;
    g = g + (255 - g) * k;
    b = b + (255 - b) * k;
  } else if (lum > 210) {
    const k = ((lum - 210) / 45) * 0.2;
    r = r * (1 - k);
    g = g * (1 - k);
    b = b * (1 - k);
  }
  return [Math.round(r), Math.round(g), Math.round(b)];
}

/**
 * The desk "ink" (what a fish fades to while returning home). It follows the
 * background: near-white on a dark desktop, near-black on a light one — the
 * fade-out that used to make fish vanish on dark wallpapers stays visible.
 */
export function adaptiveInk(lum) {
  const t = lum < 0 ? 0 : lum > 140 ? 1 : lum / 140;
  const v = Math.round(225 - 208 * t);
  return [v, v, v];
}

/** Point inside an x/y/w/h rect (optionally grown by `pad`). */
export function rectHas(rect, x, y, pad = 0) {
  return (
    x >= rect.x - pad &&
    x <= rect.x + rect.w + pad &&
    y >= rect.y - pad &&
    y <= rect.y + rect.h + pad
  );
}

/** The point of `rect` nearest to (x, y), pushed `inset` pixels inwards. */
export function nearestPointInside(rect, x, y, inset) {
  const ix = Math.min(inset, rect.w / 2 - 2);
  const iy = Math.min(inset, rect.h / 2 - 2);
  return {
    x: Math.min(Math.max(x, rect.x + ix), rect.x + rect.w - ix),
    y: Math.min(Math.max(y, rect.y + iy), rect.y + rect.h - iy),
  };
}

/** A point just outside the nearest edge of `rect`, in the same space. */
export function nearestPointOutside(rect, x, y, gap = 46) {
  const left = x - rect.x;
  const right = rect.x + rect.w - x;
  const top = y - rect.y;
  const bottom = rect.y + rect.h - y;
  const edge = Math.min(left, right, top, bottom);

  if (edge === left) return { x: rect.x - gap, y };
  if (edge === right) return { x: rect.x + rect.w + gap, y };
  if (edge === top) return { x, y: rect.y - gap };
  return { x, y: rect.y + rect.h + gap };
}

/**
 * Tank canvas rect expressed in desk coordinates.
 *
 * `tankInner` = client rect of the tank window (physical px, from Rust),
 * `deskOrigin` = client origin of the desktop layer (== work area origin),
 * `canvas` = getBoundingClientRect() of the tank canvas (css px).
 * Both windows sit on the same monitor, so one scale factor converts both.
 */
export function tankRectInDesk(tankInner, deskOrigin, canvas) {
  const scale = tankInner.scale || 1;
  return {
    x: (tankInner.x - deskOrigin.x) / scale + canvas.left,
    y: (tankInner.y - deskOrigin.y) / scale + canvas.top,
    w: canvas.width,
    h: canvas.height,
  };
}
