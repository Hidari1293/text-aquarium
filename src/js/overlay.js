// Desktop layer page.
//
// It owns no fish state. The tank window is the single brain: it pushes a
// snapshot of every fish that is currently *outside* the tank, in desk
// coordinates, and this page only draws them.
//
// Input policy (the brief's hard requirement): the layer must never sit on top
// of other software and eat its clicks. It is created click-through and stays
// that way — with one deliberate exception: while catching mode is on, the
// user has taken the net out, so the layer owns the mouse for the duration of
// the hunt. Dragging then draws a box; the fish inside it swim home. Esc or a
// right click puts the net away (and the layer goes back to click-through).
//
// Drawing policy: only the rectangles that held ink last frame and the ones
// that hold ink now are cleared, and the animation loop stops completely when
// there is nothing to move. A full-screen transparent canvas repainted 30
// times a second is exactly the kind of cost a desktop pet cannot afford.

import { blend } from "./coordinates.js";
import { FISH_SIZE, GlyphRun } from "./glyph.js";
import { installTestHooks } from "./test-hooks.js";

const FONT_STACK =
  'ui-monospace, "Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", "DejaVu Sans Mono", monospace';

const tauri = window.__TAURI__;
const canvas = document.getElementById("overlay-canvas");
const ctx = canvas.getContext("2d");

let width = 0;
let height = 0;
let dpr = 1;

/** Latest snapshot from the tank: { seq, fish: [...], size }. */
let fish = [];
let size = FISH_SIZE;
let dirty = true;
let rafId = 0;
/** Rects painted last frame, so only they need clearing. */
let painted = [];
/** The UI chrome (hint / lasso box) footprint, cleared the same way. */
let chromeRect = null;

/** Overlay client origin in desk space (normally 0,0; measured, not assumed). */
let deskOffset = { x: 0, y: 0 };
let innerPos = { x: 0, y: 0 };
let scale = 1;

let hunting = false;
let hittable = false;
/** The lasso being dragged, in client coordinates; null when idle. */
let lasso = null;

const runs = new Map(); // "glyph@size" -> GlyphRun

function run(glyph, cf) {
  const key = `${glyph}@${size}@${cf ?? "auto"}`;
  let r = runs.get(key);
  if (r === undefined) {
    ctx.font = `${size}px ${FONT_STACK}`;
    r = new GlyphRun(glyph, cf);
    r.measure(ctx);
    runs.set(key, r);
  }
  return r;
}

/** Half the glyph's vertical reach, for paint rects and the lasso pad. */
function halfH() {
  return size * 0.55 + 4;
}

/* ------------------------------------------------------------- geometry */

function resizeCanvas() {
  // 15px glyphs on a 175% display: 1.5x is indistinguishable from native and
  // costs a third less to composite than full 2x.
  dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  width = window.innerWidth;
  height = window.innerHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  painted = [];
  chromeRect = null;
  dirty = true;
}

async function measureOrigin() {
  if (!tauri) return;
  try {
    const win = tauri.window.getCurrentWindow();
    const pos = await win.innerPosition();
    const factor = await win.scaleFactor();
    const work = await tauri.core.invoke("work_area");
    innerPos = { x: pos.x, y: pos.y };
    scale = factor || 1;
    deskOffset = {
      x: (innerPos.x - work.x) / scale,
      y: (innerPos.y - work.y) / scale,
    };
  } catch (error) {
    console.error("[overlay] cannot measure origin", error);
  }
}

/* ------------------------------------------------------------ rendering */

function rectOf(x, y, w) {
  const padX = 8;
  return {
    x: Math.floor(x - w / 2 - padX),
    y: Math.floor(y - halfH() - 4),
    w: Math.ceil(w + padX * 2),
    h: Math.ceil(halfH() * 2 + 20),
  };
}

function schedule() {
  dirty = true;
  if (!rafId) rafId = requestAnimationFrame(draw);
}

function draw() {
  rafId = 0;
  if (!dirty) return;
  dirty = false;

  ctx.font = `${size}px ${FONT_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // 1. work out what will be drawn, clearing the old ink as we go
  const next = [];
  for (let i = 0; i < fish.length; i++) {
    const f = fish[i];
    const pos = { x: f.x - deskOffset.x, y: f.y - deskOffset.y };
    if (
      pos.x < -140 ||
      pos.y < -60 ||
      pos.x > width + 140 ||
      pos.y > height + 60
    ) {
      continue;
    }
    const r = run(f.g);
    next.push({ f, x: pos.x, y: pos.y, w: r.width, rect: rectOf(pos.x, pos.y, r.width) });
  }

  for (let i = 0; i < painted.length; i++) {
    const r = painted[i];
    ctx.clearRect(r.x, r.y, r.w, r.h);
  }
  if (chromeRect) {
    ctx.clearRect(chromeRect.x, chromeRect.y, chromeRect.w, chromeRect.h);
    chromeRect = null;
  }
  for (let i = 0; i < next.length; i++) {
    const r = next[i].rect;
    ctx.clearRect(r.x, r.y, r.w, r.h);
  }
  painted = next.map((item) => item.rect);

  // 2. ink
  const tiltPx = 5.5 * (size / 15);
  for (let i = 0; i < next.length; i++) {
    const { f, x, y } = next[i];
    const r = run(f.g, f.cf);
    r.layout(f.f, f.w, f.a, f.p, tiltPx);

    ctx.fillStyle = blend(f.c, f.m, f.i);
    const { drawChars, dx, dy, n } = r;
    for (let k = 0; k < n; k++) ctx.fillText(drawChars[k], x + dx[k], y + dy[k]);

    // Coloured fish read bolder and fatter: as the colour comes in, a bold
    // pass fades in over the regular one, plus four nudged copies that give
    // the glyph real thickness — so the weight follows the colour instead of
    // popping, and a fish going home is plain ink again by the time the tank
    // canvas takes over.
    if (f.m > 0.01) {
      ctx.globalAlpha = f.m;
      ctx.font = `bold ${size}px ${FONT_STACK}`;
      for (let k = 0; k < n; k++) ctx.fillText(drawChars[k], x + dx[k], y + dy[k]);
      ctx.globalAlpha = f.m * 0.55;
      for (let k = 0; k < n; k++) ctx.fillText(drawChars[k], x + dx[k] + 0.6, y + dy[k]);
      for (let k = 0; k < n; k++) ctx.fillText(drawChars[k], x + dx[k] - 0.6, y + dy[k]);
      for (let k = 0; k < n; k++) ctx.fillText(drawChars[k], x + dx[k], y + dy[k] + 0.55);
      for (let k = 0; k < n; k++) ctx.fillText(drawChars[k], x + dx[k], y + dy[k] - 0.55);
      ctx.globalAlpha = 1;
      ctx.font = `${size}px ${FONT_STACK}`;
    }
  }

  // 3. net UI: the lasso box while dragging, a hint while hunting
  if (hunting) {
    if (lasso) {
      chromeRect = drawLasso();
    } else {
      chromeRect = drawHint();
    }
  }
}

/** The selection box: a white band with a black edge, visible on any desktop. */
function drawLasso() {
  const x = Math.min(lasso.x1, lasso.x2);
  const y = Math.min(lasso.y1, lasso.y2);
  const w = Math.abs(lasso.x2 - lasso.x1);
  const h = Math.abs(lasso.y2 - lasso.y1);
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 3;
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  ctx.strokeStyle = "rgba(17,17,17,0.9)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  return { x: x - 4, y: y - 4, w: w + 8, h: h + 8 };
}

/** One line of help so the hunt needs no manual. */
function drawHint() {
  const text = "按住拖动，框住小鱼就会游回鱼缸 · Esc 或右键收起渔网";
  ctx.font = `${size}px ${FONT_STACK}`;
  const w = ctx.measureText(text).width + 28;
  const h = size + 12;
  const x = Math.round(width / 2 - w / 2);
  const y = Math.round(height - h - 18);
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "rgba(17,17,17,0.55)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  ctx.fillStyle = "rgba(17,17,17,0.9)";
  ctx.fillText(text, width / 2, y + h / 2 + 1);
  return { x: x - 3, y: y - 3, w: w + 6, h: h + 6 };
}

/* --------------------------------------------------------------- input */

async function setHittable(next) {
  if (hittable === next) return;
  hittable = next;
  document.body.classList.toggle("can-grab", next);
  try {
    await tauri.window.getCurrentWindow().setIgnoreCursorEvents(!next);
  } catch (error) {
    console.error("[overlay] click-through toggle failed", error);
  }
}

/** Esc / right click / leaving the window: put the net away. */
function exitHunt() {
  if (!hunting) return;
  setHunting(false);
  if (tauri) tauri.event.emit("overlay-hunt-off", null).catch(() => {});
}

async function setHunting(next) {
  if (hunting === next) return;
  hunting = next;
  document.body.classList.toggle("hunting", next);
  lasso = null;
  if (next) {
    await setHittable(true); // the net is out: the layer owns the mouse
  } else {
    await setHittable(false);
  }
  schedule();
}

function emitLasso(clientRect) {
  // a stray click still counts as a tiny net: expand it so tapping a fish
  // catches it, like the old grab used to
  const min = 16;
  let x1 = Math.min(clientRect.x1, clientRect.x2);
  let y1 = Math.min(clientRect.y1, clientRect.y2);
  let x2 = Math.max(clientRect.x1, clientRect.x2);
  let y2 = Math.max(clientRect.y1, clientRect.y2);
  if (x2 - x1 < min) {
    const cx = (x1 + x2) / 2;
    x1 = cx - min / 2;
    x2 = cx + min / 2;
  }
  if (y2 - y1 < min) {
    const cy = (y1 + y2) / 2;
    y1 = cy - min / 2;
    y2 = cy + min / 2;
  }
  tauri.event
    .emit("overlay-lasso", {
      x1: x1 + deskOffset.x,
      y1: y1 + deskOffset.y,
      x2: x2 + deskOffset.x,
      y2: y2 + deskOffset.y,
    })
    .catch(() => {});
}

function onPointerDown(event) {
  if (!hunting) return;
  if (event.button === 2) {
    // right click: put the net away
    exitHunt();
    return;
  }
  if (event.button !== 0) return;
  lasso = { x1: event.clientX, y1: event.clientY, x2: event.clientX, y2: event.clientY };
  schedule();
}

function onPointerMove(event) {
  if (!hunting || !lasso) return;
  lasso.x2 = event.clientX;
  lasso.y2 = event.clientY;
  schedule();
}

function onPointerUp(event) {
  if (!hunting || !lasso) return;
  const box = lasso;
  lasso = null;
  emitLasso(box);
  schedule();
}

function onPointerCancel() {
  if (!lasso) return;
  lasso = null;
  schedule();
}

/* --------------------------------------------------------------- wiring */

function testProbe() {
  return tauri.core.invoke("debug_write", {
    name: "overlay.json",
    text: JSON.stringify({
      hunting,
      hittable,
      lasso: lasso !== null,
      size,
      fish,
      deskOffset,
      sizePx: [width, height],
      rafRunning: Boolean(rafId),
    }),
  });
}

function testShot(name = "overlay") {
  const url = canvas.toDataURL("image/png");
  const binary = atob(url.split(",")[1]);
  let hex = "";
  for (let i = 0; i < binary.length; i++) {
    hex += binary.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return tauri.core.invoke("debug_write_png", { name: `${name}.png`, hex });
}

/** Drive the pointer handlers with client coordinates. */
function testPointer(kind, x, y, button = 0) {
  if (kind === "down") onPointerDown({ clientX: x, clientY: y, button });
  else if (kind === "move") onPointerMove({ clientX: x, clientY: y });
  else if (kind === "up") onPointerUp({ clientX: x, clientY: y });
  else if (kind === "cancel") onPointerCancel();
}

async function boot() {
  if (!tauri) return;
  await measureOrigin();
  resizeCanvas();

  await tauri.event.listen("tank-frame", (event) => {
    const payload = event.payload || {};
    fish = payload.fish || [];
    size = payload.size || FISH_SIZE;
    schedule();
  });

  await tauri.event.listen("hunt", (event) => {
    setHunting(Boolean(event.payload));
  });

  await tauri.event.listen("overlay-ping", () => {
    tauri.event.emit("overlay-ready", null);
  });

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);
  window.addEventListener("contextmenu", (event) => event.preventDefault());
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") exitHunt();
  });
  // a window the user left behind should not keep the whole screen hostage
  window.addEventListener("blur", exitHunt);
  window.addEventListener("resize", async () => {
    resizeCanvas();
    await measureOrigin();
    schedule();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      exitHunt();
    } else {
      // a window that was created hidden never ran a frame: restart cleanly
      painted = [];
      chromeRect = null;
      schedule();
    }
  });

  schedule();
  tauri.event.emit("overlay-ready", null);
  installTestHooks("overlay", { probe: testProbe, shot: testShot, pointer: testPointer });
}

boot();
