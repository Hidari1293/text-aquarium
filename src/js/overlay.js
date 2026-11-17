// Desktop layer page.
//
// It owns no fish state. The tank window is the single brain: it pushes a
// snapshot of every fish that is currently *outside* the tank, in desk
// coordinates, and this page only draws them (and handles the mouse while
// catching mode is on).
//
// Input policy (the brief's hard requirement): the layer must never sit on top
// of other software and eat its clicks. It is created click-through and stays
// that way; while catching mode is on we poll the cursor and only become
// hittable when the cursor is actually within a fish's glyph box. Everything
// else on the screen keeps working.
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
const CURSOR_HZ = 55; // ms between cursor probes while catching
/** Half the glyph box, plus room for the ripple and the lean. */
const HALF_H = 13;

const tauri = window.__TAURI__;
const canvas = document.getElementById("overlay-canvas");
const ctx = canvas.getContext("2d");

let width = 0;
let height = 0;
let dpr = 1;

/** Latest snapshot from the tank: [{ id, g, x, y, f, m, c, w, p, a }]. */
let fish = [];
let dirty = true;
let rafId = 0;
/** Rects painted last frame, so only they need clearing. */
let painted = [];

/** Overlay client origin in desk space (normally 0,0; measured, not assumed). */
let deskOffset = { x: 0, y: 0 };
/** Overlay client origin in physical pixels, for cursor maths. */
let innerPos = { x: 0, y: 0 };
let scale = 1;

let hunting = false;
let hittable = false;
let hoverId = null;

let dragId = null;
let dragPos = null;
let dragSent = 0;

let pollTimer = 0;
let workArea = null;

const runs = new Map(); // glyph -> GlyphRun

function run(glyph) {
  let r = runs.get(glyph);
  if (r === undefined) {
    ctx.font = `${FISH_SIZE}px ${FONT_STACK}`;
    r = new GlyphRun(glyph);
    r.measure(ctx);
    runs.set(glyph, r);
  }
  return r;
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
  dirty = true;
}

async function measureOrigin() {
  if (!tauri) return;
  try {
    const win = tauri.window.getCurrentWindow();
    const pos = await win.innerPosition();
    const factor = await win.scaleFactor();
    if (!workArea) workArea = await tauri.core.invoke("work_area");
    innerPos = { x: pos.x, y: pos.y };
    scale = factor || 1;
    deskOffset = {
      x: (innerPos.x - workArea.x) / scale,
      y: (innerPos.y - workArea.y) / scale,
    };
  } catch (error) {
    console.error("[overlay] cannot measure origin", error);
  }
}

/* ------------------------------------------------------------ rendering */

/** Where a fish sits this frame: the hand wins while it is being held. */
function spotOf(f) {
  if (f.id === dragId && dragPos) return dragPos;
  return { x: f.x - deskOffset.x, y: f.y - deskOffset.y };
}

function rectOf(x, y, w) {
  const padX = 8;
  return {
    x: Math.floor(x - w / 2 - padX),
    y: Math.floor(y - HALF_H - 4),
    w: Math.ceil(w + padX * 2),
    h: HALF_H * 2 + 20,
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

  ctx.font = `${FISH_SIZE}px ${FONT_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // 1. work out what will be drawn, clearing the old ink as we go
  const next = [];
  for (let i = 0; i < fish.length; i++) {
    const f = fish[i];
    const pos = spotOf(f);
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
  for (let i = 0; i < next.length; i++) {
    const r = next[i].rect;
    ctx.clearRect(r.x, r.y, r.w, r.h);
  }
  painted = next.map((item) => item.rect);

  // 2. ink
  for (let i = 0; i < next.length; i++) {
    const { f, x, y } = next[i];
    const r = run(f.g);
    r.layout(f.f, f.w, f.a, f.p);

    ctx.fillStyle = blend(f.c, f.m);
    const { chars, dx, dy, n } = r;
    for (let k = 0; k < n; k++) ctx.fillText(chars[k], x + dx[k], y + dy[k]);

    if (f.id === dragId) drawBrackets(x, y, r.width, f.c);
    else if (f.id === hoverId) drawPerch(x, y, r.width, f.c);
  }
}

/** Held: a pair of brackets, the lightest possible "this one" marker. */
function drawBrackets(x, y, w, color) {
  const pad = w / 2 + 7;
  ctx.fillStyle = blend(color, 0.85);
  ctx.fillText("[", x - pad, y);
  ctx.fillText("]", x + pad, y);
}

/** Hovered: a dotted perch underneath, like a fish casting a shadow. */
function drawPerch(x, y, w, color) {
  const pad = Math.min(w / 2, 26);
  ctx.fillStyle = blend(color, 0.45);
  for (let i = -2; i <= 2; i++) {
    ctx.fillText("·", x + (i * pad) / 2.4, y + HALF_H + 3);
  }
}

/* --------------------------------------------------------------- input */

function fishAt(cx, cy, pad = 10) {
  for (let i = fish.length - 1; i >= 0; i--) {
    const f = fish[i];
    const pos = spotOf(f);
    if (
      Math.abs(cx - pos.x) <= run(f.g).halfW + pad &&
      Math.abs(cy - pos.y) <= HALF_H + pad
    ) {
      return f;
    }
  }
  return null;
}

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

async function pollCursor() {
  if (!hunting) return;
  try {
    // while a fish is in hand the layer must keep receiving the pointer,
    // wherever it goes
    if (dragId) {
      await setHittable(true);
    } else {
      const point = await tauri.core.invoke("cursor_pos");
      if (point) {
        const cx = (point[0] - innerPos.x) / scale;
        const cy = (point[1] - innerPos.y) / scale;
        await setHittable(fishAt(cx, cy, 14) !== null);
      } else {
        await setHittable(false);
      }
    }
  } catch (error) {
    // a failed probe must not leave the layer eating clicks
    if (!dragId) await setHittable(false);
  }
  if (hunting) pollTimer = setTimeout(pollCursor, CURSOR_HZ);
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setTimeout(pollCursor, 0);
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = 0;
  if (hittable && !dragId) setHittable(false);
}

async function setHunting(next) {
  if (hunting === next) return;
  hunting = next;
  document.body.classList.toggle("hunting", next);
  if (next) {
    startPolling();
  } else {
    stopPolling();
    hoverId = null;
    endDrag(true);
    schedule();
  }
}

function emitDrag(kind, x, y) {
  if (!tauri) return;
  tauri.event
    .emit(kind, { id: dragId, x: x + deskOffset.x, y: y + deskOffset.y })
    .catch(() => {});
}

function onPointerMove(event) {
  if (!hunting) return;
  if (dragId) {
    dragPos = { x: event.clientX, y: event.clientY };
    const now = performance.now();
    // the simulation only needs the position at its own frame rate
    if (now - dragSent > 16) {
      dragSent = now;
      emitDrag("overlay-drag", dragPos.x, dragPos.y);
    }
    schedule();
    return;
  }
  const hit = fishAt(event.clientX, event.clientY, 10);
  const id = hit ? hit.id : null;
  if (id !== hoverId) {
    hoverId = id;
    schedule();
  }
}

function onPointerDown(event) {
  if (!hunting) return;
  const hit = fishAt(event.clientX, event.clientY, 10);
  if (!hit) {
    // clicked empty water: put the net away so the click passes through next time
    setHittable(false);
    return;
  }
  dragId = hit.id;
  dragPos = { x: event.clientX, y: event.clientY };
  dragSent = 0;
  hoverId = hit.id;
  document.body.classList.add("is-dragging");
  emitDrag("overlay-grab", dragPos.x, dragPos.y);
  schedule();
}

function onPointerUp(event) {
  if (!dragId) return;
  const x = dragPos ? dragPos.x : event.clientX;
  const y = dragPos ? dragPos.y : event.clientY;
  const id = dragId;
  // tell the tank where the fish was let go *before* clearing the local one,
  // so the snapshot that comes back is already the right one
  emitDrag("overlay-drop", x, y);
  dragId = null;
  dragPos = null;
  document.body.classList.remove("is-dragging");
  const stillThere = fish.find((f) => f.id === id);
  if (stillThere) {
    const pos = { x: stillThere.x - deskOffset.x, y: stillThere.y - deskOffset.y };
    hoverId = fishAt(pos.x, pos.y, 10) ? id : null;
  } else {
    hoverId = null;
  }
  schedule();
}

/** Dropped without a pointerup: catching mode off, window hidden, etc. */
function endDrag(tell) {
  if (!dragId) return;
  if (tell && dragPos) emitDrag("overlay-drop", dragPos.x, dragPos.y);
  dragId = null;
  dragPos = null;
  document.body.classList.remove("is-dragging");
  schedule();
}

/* --------------------------------------------------------------- wiring */

function testProbe() {
  return tauri.core.invoke("debug_write", {
    name: "overlay.json",
    text: JSON.stringify({
      hunting,
      hittable,
      dragId,
      fish,
      deskOffset,
      size: [width, height],
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
function testPointer(kind, x, y) {
  if (kind === "down") onPointerDown({ clientX: x, clientY: y });
  else if (kind === "move") onPointerMove({ clientX: x, clientY: y });
  else onPointerUp({ clientX: x, clientY: y });
}

async function boot() {
  if (!tauri) return;
  await measureOrigin();
  resizeCanvas();

  await tauri.event.listen("tank-frame", (event) => {
    fish = event.payload.fish || [];
    if (hunting && fish.length === 0) hoverId = null;
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
  window.addEventListener("pointercancel", () => endDrag(true));
  window.addEventListener("blur", () => endDrag(true));
  window.addEventListener("resize", async () => {
    resizeCanvas();
    await measureOrigin();
    schedule();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      stopPolling();
    } else {
      // a window that was created hidden never ran a frame: restart cleanly
      painted = [];
      if (hunting) startPolling();
      schedule();
    }
  });

  schedule();
  tauri.event.emit("overlay-ready", null);
  installTestHooks("overlay", { probe: testProbe, shot: testShot, pointer: testPointer });
}

boot();
