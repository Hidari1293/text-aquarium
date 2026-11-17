// Tank window bootstrap: DOM wiring, one animation loop, one simulation.
//
// Loop rules (they matter for a pet that runs all day):
//   * motion is derived from real elapsed time, never from a frame count
//   * the tank is redrawn only when something actually moved
//   * paused / hidden => the loop is stopped, not just skipped
//   * a frame budget keeps an idle tank at 30 fps instead of 60
//
// The boundary is a tiny state machine (CLOSED -> OPENING -> OPEN ->
// RETURNING -> CLOSED). Every transition goes through `setStage`, so the two
// windows can never disagree about what is happening.

import { TankRenderer } from "./aquarium.js";
import { tankRectInDesk } from "./coordinates.js";
import { DesktopLayer } from "./desktop-overlay.js";
import { DEFAULTS, loadSettings, saveSettings } from "./settings.js";
import { Simulation } from "./simulation.js";
import { installTestHooks } from "./test-hooks.js";

const TARGET_SEGMENTS = { high: 60, focused: 30, idle: 24 };

const BOUNDARY = {
  CLOSED: "closed",
  OPENING: "opening",
  OPEN: "open",
  RETURNING: "returning",
};

const el = {
  tank: document.getElementById("tank"),
  canvas: document.getElementById("scene"),
  btnPause: document.getElementById("btn-pause"),
  btnBoundary: document.getElementById("btn-boundary"),
  btnHunt: document.getElementById("btn-hunt"),
  btnSettings: document.getElementById("btn-settings"),
  panel: document.getElementById("settings-panel"),
  setSeaweed: document.getElementById("set-seaweed"),
  setBubbles: document.getElementById("set-bubbles"),
  setFps: document.getElementById("set-fps"),
  setCount: document.getElementById("set-count"),
  setCountVal: document.getElementById("set-count-val"),
  setSize: document.getElementById("set-size"),
  setSizeVal: document.getElementById("set-size-val"),
  setLiveliness: document.getElementById("set-liveliness"),
  setLivelinessVal: document.getElementById("set-liveliness-val"),
  customInput: document.getElementById("set-custom"),
  btnCustomAdd: document.getElementById("btn-custom-add"),
  btnCustomDir: document.getElementById("btn-custom-dir"),
  btnCustomRemove: document.getElementById("btn-custom-remove"),
  customLive: document.getElementById("custom-live"),
  customGlyphOut: document.getElementById("custom-glyph"),
  btnTech: document.getElementById("btn-tech"),
  techOut: document.getElementById("tech-out"),
  statusMode: document.getElementById("status-mode"),
  statusPerf: document.getElementById("status-perf"),
};

function log(text) {
  const tauri = window.__TAURI__;
  if (!tauri) return;
  tauri.core.invoke("debug_log", { text: `[tank] ${text}` }).catch(() => {});
}

const state = {
  sim: new Simulation(),
  renderer: new TankRenderer(el.canvas),
  layer: new DesktopLayer(),
  settings: { ...DEFAULTS },
  paused: false,
  stage: BOUNDARY.CLOSED,
  hunt: false,
  note: "",
  noteUntil: 0,
  rafId: 0,
  lastTs: 0,
  fpsEma: 0,
  fpsStamp: 0,
  statusStamp: 0,
  work: null, // work-area origin + scale, filled by syncPlacement
};

/* ------------------------------------------------------------------ loop */

function frame(ts) {
  state.rafId = requestAnimationFrame(frame);

  if (state.lastTs === 0) state.lastTs = ts;
  const elapsed = (ts - state.lastTs) / 1000;
  // an unfocused tank is scenery — 24 fps is plenty and keeps the GPU quiet
  const focused = document.hasFocus();
  const target = focused
    ? state.settings.highFps
      ? TARGET_SEGMENTS.high
      : TARGET_SEGMENTS.focused
    : TARGET_SEGMENTS.idle;
  const budget = 1 / target;

  // tolerate a little jitter: a 60 Hz display must not be halved to 30
  if (elapsed < budget * 0.85) return; // too early: skip this frame entirely

  state.lastTs = ts;
  const dt = Math.min(elapsed, 0.1); // never jump after a stall

  state.sim.step(dt);
  state.renderer.render(state.sim);

  if (state.stage !== BOUNDARY.CLOSED) {
    state.layer.frame(ts, state.sim.snapshot(), state.sim.fishSize);
    if (state.stage === BOUNDARY.RETURNING && state.sim.counts().desk === 0) {
      finishReturn();
    }
  }

  if (ts - state.statusStamp > 280) {
    state.statusStamp = ts;
    refreshStatus();
  }
  updatePerf(ts, dt);
}

function startLoop() {
  if (state.rafId) return;
  state.lastTs = 0;
  state.rafId = requestAnimationFrame(frame);
}

function stopLoop() {
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = 0;
  state.lastTs = 0;
}

function updatePerf(ts, dt) {
  state.fpsEma = state.fpsEma ? state.fpsEma * 0.9 + (1 / dt) * 0.1 : 1 / dt;
  if (ts - state.fpsStamp < 500) return;
  state.fpsStamp = ts;
  el.statusPerf.textContent = `${Math.round(state.fpsEma)} fps`;
}

/* ---------------------------------------------------------------- layout */

function relayout() {
  const width = el.tank.clientWidth;
  const height = el.tank.clientHeight;
  if (width < 8 || height < 8) return;

  state.renderer.resize(width, height);
  state.sim.resize(width, height);
  state.sim.syncMetrics((glyph) => state.renderer.measure(glyph));
  state.renderer.render(state.sim);
  queuePlacement();
}

let placementTimer = 0;
let placementBusy = false;

/** Where the tank canvas sits in desk space. Cheap, but not free: debounce. */
function queuePlacement() {
  if (placementTimer) clearTimeout(placementTimer);
  placementTimer = setTimeout(() => {
    placementTimer = 0;
    syncPlacement();
  }, 120);
}

async function syncPlacement() {
  if (!state.layer.available || placementBusy) return;
  placementBusy = true;
  try {
    const tauri = state.layer.tauri;
    // a minimised window reports a junk position (-32000, -32000): syncing
    // now would point every returning fish at a clamped desk corner. Keep
    // the last honest rect instead.
    try {
      const win = tauri.window.getCurrentWindow();
      if (win && (await win.isMinimized())) return;
    } catch {
      /* older API surface: carry on with the measurement */
    }
    const [tank, work] = await Promise.all([
      tauri.core.invoke("tank_placement"),
      tauri.core.invoke("work_area"),
    ]);
    const scale = tank.scale || work.scale || 1;
    const canvas = el.canvas.getBoundingClientRect();
    state.work = { x: work.x, y: work.y, scale };
    state.sim.setDesk(work.width / scale, work.height / scale);
    state.sim.setTankRect(tankRectInDesk({ ...tank, scale }, { x: work.x, y: work.y }, canvas));
  } catch (error) {
    console.error("[tank] placement failed", error);
  } finally {
    placementBusy = false;
  }
}

/* ---------------------------------------------------------------- cursor */

/**
 * Where the mouse is, per space. The tank sees its own cursor through real
 * pointer events; the desk cursor is polled through Rust while the boundary
 * is open (10 Hz is plenty for a fish to notice). Both feed the simulation,
 * which turns a near cursor into a dart and a long-idle one into a curiosity.
 */
function trackTankCursor(event) {
  const rect = el.canvas.getBoundingClientRect();
  state.sim.setCursor("tank", event.clientX - rect.left, event.clientY - rect.top);
}

function untrackTankCursor() {
  state.sim.clearCursor("tank");
}

let cursorTimer = 0;
let bgTick = 0;

function pollDeskCursor() {
  if (
    state.paused ||
    state.stage === BOUNDARY.CLOSED ||
    !state.layer.available ||
    !state.work
  ) {
    cursorTimer = 0;
    return;
  }
  const tauri = state.layer.tauri;
  tauri.core
    .invoke("cursor_pos")
    .then((point) => {
      if (!point) return;
      state.sim.setCursor(
        "desk",
        (point[0] - state.work.x) / state.work.scale,
        (point[1] - state.work.y) / state.work.scale
      );
    })
    .catch(() => {});
  // every 4th tick (~400ms) sample what one desk fish is swimming over, so
  // its colour adapts to the wallpaper beneath it
  if (bgTick++ % 4 === 0) sampleFishBackground();
  cursorTimer = setTimeout(pollDeskCursor, 100);
}

/** One screen pixel behind one desk fish, round-robin across the school. */
function sampleFishBackground() {
  const desk = state.sim.fish.filter((f) => f.space === "desk");
  if (desk.length === 0) return;
  const fish = desk[bgTick % desk.length];
  const px = Math.round(fish.x * state.work.scale + state.work.x);
  const py = Math.round(fish.y * state.work.scale + state.work.y);
  state.layer.tauri.core
    .invoke("screen_pixel", { x: px, y: py })
    .then((c) => {
      if (!c) return;
      const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
      state.sim.noteBackground(fish.id, lum);
    })
    .catch(() => {});
}

function startCursorPolling() {
  if (cursorTimer) return;
  cursorTimer = setTimeout(pollDeskCursor, 0);
}

function stopCursorPolling() {
  if (cursorTimer) clearTimeout(cursorTimer);
  cursorTimer = 0;
  state.sim.clearCursor("desk");
}

/* ---------------------------------------------------------------- status */

function note(text, ms = 2400) {
  state.note = text;
  state.noteUntil = performance.now() + ms;
  refreshStatus();
}

function livelinessLabel(value) {
  if (value <= 0.6) return "安静";
  if (value >= 1.6) return "闹腾";
  return "普通";
}

function refreshStatus() {
  const { tank, desk } = state.sim.counts();

  if (state.note && performance.now() < state.noteUntil) {
    el.statusMode.textContent = state.note;
    return;
  }

  if (state.paused) {
    el.statusMode.textContent =
      desk > 0 ? `已暂停 · 鱼缸 ${tank} · 桌面 ${desk}` : `已暂停 · ${tank} 条鱼`;
    el.statusPerf.textContent = "— fps";
    return;
  }

  switch (state.stage) {
    case BOUNDARY.OPENING:
      el.statusMode.textContent = "正在打开桌面…";
      break;
    case BOUNDARY.OPEN:
      el.statusMode.textContent = `边界开启 · 鱼缸 ${tank} · 桌面 ${desk}${
        state.hunt ? " · 捞鱼模式" : ""
      }`;
      break;
    case BOUNDARY.RETURNING:
      el.statusMode.textContent = `正在回缸 · 还剩 ${desk} 条`;
      break;
    default:
      el.statusMode.textContent = `鱼缸模式 · 边界关闭 · ${tank} 条鱼`;
  }
}

/* -------------------------------------------------------------- controls */

function setPaused(paused) {
  state.paused = paused;
  el.btnPause.textContent = paused ? "继续" : "暂停";
  el.btnPause.setAttribute("aria-pressed", String(paused));
  if (paused && state.hunt) setHunt(false);
  refreshStatus();

  if (paused) {
    stopLoop();
    stopCursorPolling();
  } else if (!document.hidden) {
    startLoop();
    if (state.stage !== BOUNDARY.CLOSED) startCursorPolling();
  }
}

function setSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  saveSettings(state.settings);
  state.sim.bubbles.enabled = state.settings.bubbles;
  state.sim.seaweed.enabled = state.settings.seaweed;
  applyFishSettings();
  refreshCustomRow();
  if (!state.paused && !document.hidden) {
    stopLoop();
    startLoop();
  }
  state.renderer.render(state.sim);
}

/** Count / size / liveliness / custom fish reach the school via the sim. */
function applyFishSettings() {
  const sim = state.sim;
  sim.setFishCount(state.settings.count);
  sim.setFishSize(state.settings.size);
  sim.setLiveliness(state.settings.liveliness);
  sim.setCustomFish(state.settings.customGlyph || "", state.settings.customFacing ?? 1);
  sim.syncMetrics((glyph) => state.renderer.measure(glyph, sim.fishSize));
}

/** The custom-fish row mirrors the setting (and the fish in the tank). */
function refreshCustomRow() {
  const glyph = (state.settings.customGlyph || "").trim();
  const has = Boolean(glyph && state.sim.customFish);
  el.customLive.hidden = !has;
  if (has) {
    el.customGlyphOut.textContent = glyph;
    el.btnCustomDir.textContent =
      (state.settings.customFacing ?? 1) >= 0 ? "头朝右" : "头朝左";
  }
}

function togglePanel(open) {
  const next = open ?? el.panel.hidden;
  el.panel.hidden = !next;
  el.btnSettings.setAttribute("aria-pressed", String(next));
}

/* -------------------------------------------------------------- boundary */

function setStage(stage) {
  state.stage = stage;
  const open = stage === BOUNDARY.OPEN;
  el.tank.classList.toggle("is-open", stage !== BOUNDARY.CLOSED);
  // only "opening" is a moment the user must wait out; returning can be
  // cancelled by opening again, which is what people try first
  el.btnBoundary.disabled = stage === BOUNDARY.OPENING;
  el.btnBoundary.textContent =
    stage === BOUNDARY.CLOSED
      ? "打开边界"
      : stage === BOUNDARY.RETURNING
        ? "重新打开"
        : "合上边界";
  el.btnBoundary.setAttribute("aria-pressed", String(stage !== BOUNDARY.CLOSED));
  el.btnHunt.disabled = !open;
  if (!open && state.hunt) setHunt(false);
  refreshStatus();
}

let opening = false;

async function openBoundary() {
  // the first await happens while the stage is still CLOSED: without this
  // guard a double click would ask for two overlays
  if (opening || state.stage !== BOUNDARY.CLOSED) return;
  opening = true;
  try {
    if (!state.layer.available) {
      note("边界需要桌面程序，浏览器预览里不可用");
      return;
    }

    await syncPlacement();
    if (!state.sim.placementValid) {
      note("边界只在主显示器上可用");
      return;
    }

    setStage(BOUNDARY.OPENING);
    let ready = false;
    try {
      ready = await state.layer.show();
      if (!ready) log("overlay page did not answer the handshake");
    } catch (error) {
      log(`overlay failed: ${error}`);
      console.error("[tank] overlay failed to open", error);
    }
    if (!ready) {
      await state.layer.hide().catch(() => {});
      setStage(BOUNDARY.CLOSED);
      note("桌面层没有就绪，边界保持关闭");
      return;
    }

    state.sim.openBoundary();
    setStage(BOUNDARY.OPEN);
    startCursorPolling();
  } finally {
    opening = false;
  }
}

function beginReturn() {
  if (state.stage !== BOUNDARY.OPEN) return;
  setHunt(false);
  state.sim.closeBoundary();
  setStage(BOUNDARY.RETURNING);
}

async function finishReturn() {
  if (state.stage !== BOUNDARY.RETURNING) return;
  setStage(BOUNDARY.CLOSED);
  stopCursorPolling();
  try {
    await state.layer.hide();
  } catch (error) {
    console.error("[tank] overlay did not hide", error);
  }
}

/** Changed my mind while the fish were swimming home: let them stay out. */
function reopenDuringReturn() {
  if (state.stage !== BOUNDARY.RETURNING) return;
  state.sim.openBoundary();
  setStage(BOUNDARY.OPEN);
  note("边界重新打开");
}

function toggleBoundary() {
  if (state.paused) {
    note("暂停中：先继续，再开关边界");
    return;
  }
  if (state.stage === BOUNDARY.CLOSED) openBoundary();
  else if (state.stage === BOUNDARY.OPEN) beginReturn();
  else if (state.stage === BOUNDARY.RETURNING) reopenDuringReturn();
}

function setHunt(on) {
  const next = Boolean(on) && state.stage === BOUNDARY.OPEN;
  state.hunt = next;
  el.btnHunt.setAttribute("aria-pressed", String(next));
  state.layer.setHunt(next);
  state.sim.setHunting(next);
  refreshStatus();
  if (next) note("捞鱼模式：按住拖动框住小鱼，它们就会游回鱼缸");
}

/* ----------------------------------------------------------- phase 0 UI */

let unlistenTech = null;

async function runTechCheck() {
  const tauri = window.__TAURI__;
  el.techOut.hidden = false;
  if (!tauri) {
    el.techOut.textContent = "透明层自检需要在桌面程序内运行。";
    return;
  }
  if (state.stage !== BOUNDARY.CLOSED) {
    el.techOut.textContent = "请先合上边界再运行自检：自检会重建桌面层。";
    return;
  }
  el.techOut.textContent = "正在检测…桌面上会出现一层彩色小鱼（约 3 秒）";
  try {
    if (!unlistenTech) {
      unlistenTech = await tauri.event.listen("tech-report", (event) => {
        el.techOut.textContent = event.payload;
        el.techOut.scrollTop = 0;
      });
    }
    await tauri.core.invoke("tech_check");
  } catch (error) {
    el.techOut.textContent = `自检调用失败：${error}`;
  }
}

/* ------------------------------------------------------------------ init */

/** Dev-only: expose the state a test script needs to see. */
function testProbe() {
  const tauri = window.__TAURI__;
  const fish = state.sim.fish.map((f) => ({
    id: f.id,
    glyph: f.glyph,
    canonFacing: f.canonFacing,
    space: f.space,
    state: f.state,
    mood: f.mood,
    x: Math.round(f.x * 100) / 100,
    y: Math.round(f.y * 100) / 100,
    heading: Math.round(f.heading * 1000) / 1000,
    vx: Math.round(f.vx * 100) / 100,
    vy: Math.round(f.vy * 100) / 100,
    facing: f.facing,
    colorMix: Math.round(f.colorMix * 100) / 100,
    wave: Math.round(f.wavePhase * 100) / 100,
    pitch: Math.round(f.pitch * 100) / 100,
    amp: f.waveAmp,
    goal: f.goal
      ? { x: Math.round(f.goal.x * 10) / 10, y: Math.round(f.goal.y * 10) / 10 }
      : null,
  }));
  return tauri.core
    .invoke("debug_windows")
    .then((windows) =>
      tauri.core.invoke("debug_write", {
        name: "tank.json",
        text: JSON.stringify({
          stage: state.stage,
          hunt: state.hunt,
          paused: state.paused,
          counts: state.sim.counts(),
          fishCount: state.sim.fishCount,
          fishSize: state.sim.fishSize,
          liveliness: state.sim.liveliness,
          placementValid: state.sim.placementValid,
          tankRect: state.sim.tankRect,
          desk: state.sim.desk,
          cursor: {
            tank: state.sim._cursor.tank,
            desk: state.sim._cursor.desk,
            idle: state.sim.time - state.sim._cursor.lastMove,
          },
          fish,
          windows,
          fps: Math.round(state.fpsEma),
          settings: state.settings,
        }),
      })
    );
}

/**
 * Dev-only cursor control, so tests are deterministic without touching the
 * real mouse: __cursor("tank"|"desk", x, y) places it and holds it there
 * (the real-mouse polling is ignored until __cursor("on")),
 * __cursor("idle", s) ages it, __cursor("off") clears and freezes.
 */
function testCursor(kind, x, y) {
  const sim = state.sim;
  if (kind === "off") {
    sim.clearCursor("tank");
    sim.clearCursor("desk");
    sim.setCursorLock(true);
    return "locked";
  }
  if (kind === "on") {
    sim.setCursorLock(false);
    return "unlocked";
  }
  if (kind === "idle") {
    sim._cursor.lastMove = sim.time - (Number(x) || 100);
    return `idle ${Number(x) || 100}s`;
  }
  const c = sim._cursor[kind];
  if (!c) return "unknown space";
  c.x = x;
  c.y = y;
  c.active = true;
  sim._cursor.lastMove = sim.time;
  sim.setCursorLock(true); // the synthetic cursor stays until released
  return "set";
}

function testShot(name = "tank") {
  const tauri = window.__TAURI__;
  const url = el.canvas.toDataURL("image/png");
  const binary = atob(url.split(",")[1]);
  let hex = "";
  for (let i = 0; i < binary.length; i++) {
    hex += binary.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return tauri.core.invoke("debug_write_png", { name: `${name}.png`, hex });
}

async function init() {
  // the settings file is the source of truth; it is a few bytes and one read
  state.settings = await loadSettings();
  el.setSeaweed.checked = state.settings.seaweed;
  el.setBubbles.checked = state.settings.bubbles;
  el.setFps.checked = state.settings.highFps;
  el.setCount.value = state.settings.count;
  el.setCountVal.textContent = String(state.settings.count);
  el.setSize.value = state.settings.size;
  el.setSizeVal.textContent = `${state.settings.size}px`;
  el.setLiveliness.value = state.settings.liveliness;
  el.setLivelinessVal.textContent = livelinessLabel(state.settings.liveliness);
  state.sim.bubbles.enabled = state.settings.bubbles;
  state.sim.seaweed.enabled = state.settings.seaweed;
  state.sim.fishCount = state.settings.count;

  relayout();
  setStage(BOUNDARY.CLOSED);
  applyFishSettings();
  refreshCustomRow();

  state.layer.onLasso = (x1, y1, x2, y2) => {
    const caught = state.sim.lassoFish(x1, y1, x2, y2);
    if (caught > 0) note(`网住了 ${caught} 条，它们正在游回鱼缸`);
  };
  state.layer.onHuntOff = () => {
    if (state.hunt) setHunt(false);
  };

  new ResizeObserver(relayout).observe(el.tank);

  el.btnPause.addEventListener("click", () => setPaused(!state.paused));
  el.btnBoundary.addEventListener("click", toggleBoundary);
  el.btnHunt.addEventListener("click", () => setHunt(!state.hunt));
  el.btnSettings.addEventListener("click", () => togglePanel());
  el.btnTech.addEventListener("click", runTechCheck);

  el.setSeaweed.addEventListener("change", () =>
    setSettings({ seaweed: el.setSeaweed.checked })
  );
  el.setBubbles.addEventListener("change", () =>
    setSettings({ bubbles: el.setBubbles.checked })
  );
  el.setFps.addEventListener("change", () =>
    setSettings({ highFps: el.setFps.checked })
  );
  el.setCount.addEventListener("input", () => {
    el.setCountVal.textContent = el.setCount.value;
    setSettings({ count: Number(el.setCount.value) });
  });
  el.setSize.addEventListener("input", () => {
    el.setSizeVal.textContent = `${el.setSize.value}px`;
    setSettings({ size: Number(el.setSize.value) });
  });
  el.setLiveliness.addEventListener("input", () => {
    const value = Number(el.setLiveliness.value);
    el.setLivelinessVal.textContent = livelinessLabel(value);
    setSettings({ liveliness: value });
  });
  el.btnCustomAdd.addEventListener("click", () => {
    const text = el.customInput.value.trim();
    if (!text) return;
    setSettings({ customGlyph: text });
    el.customInput.value = "";
    note(`来了一条新鱼 ${text}`);
  });
  el.btnCustomDir.addEventListener("click", () =>
    setSettings({ customFacing: (state.settings.customFacing ?? 1) >= 0 ? -1 : 1 })
  );
  el.btnCustomRemove.addEventListener("click", () => {
    el.customInput.value = "";
    setSettings({ customGlyph: "" });
  });

  // the tank cursor is real pointer events; the desk cursor is polled
  el.canvas.addEventListener("pointermove", trackTankCursor);
  el.canvas.addEventListener("pointerleave", untrackTankCursor);

  document.addEventListener("keydown", (event) => {
    if (event.code === "Space") {
      event.preventDefault();
      setPaused(!state.paused);
    } else if (event.code === "Escape") {
      if (state.hunt) setHunt(false);
      else togglePanel(false);
    }
  });

  document.addEventListener("pointerdown", (event) => {
    if (el.panel.hidden) return;
    const target = event.target;
    if (el.panel.contains(target) || el.btnSettings.contains(target)) return;
    togglePanel(false);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      // a minimised tank with the boundary open is still a desktop pet: the
      // fish outside keep swimming (and keep reacting to the cursor) — only
      // a tank with nothing to show anywhere is allowed to sleep
      if (state.stage === BOUNDARY.CLOSED) stopLoop();
    } else if (!state.paused) {
      startLoop();
      if (state.stage !== BOUNDARY.CLOSED) startCursorPolling();
      queuePlacement();
    }
  });

  // The window can be dragged or resized at any time; keep the seam honest.
  const win = state.layer.tauri && state.layer.tauri.window.getCurrentWindow();
  if (win) {
    try {
      win.onMoved(() => queuePlacement());
      win.onResized(() => queuePlacement());
    } catch (error) {
      console.warn("[tank] window move hooks unavailable", error);
    }
  }

  window.addEventListener("beforeunload", () => {
    state.layer.hide().catch(() => {});
  });

  startLoop();
  installTestHooks("tank", { probe: testProbe, shot: testShot, cursor: testCursor });
}

init();
