// Tank-side controller for the desktop layer.
//
// The tank is the single brain: it owns the simulation and pushes a snapshot
// of every fish that is currently outside the tank to the transparent window.
// This module is the only place that talks to that window, so the rules live
// in one spot:
//
//   * the layer is created when the boundary opens and destroyed when the last
//     fish is home — a hidden WebView2 keeps a renderer alive for nothing
//   * clicks pass through unless catching mode is on, and even then the layer
//     only becomes hittable near a fish (decided inside the layer page)
//   * frames are throttled, and stop entirely when no fish is outside
//   * grab / drag / drop are forwarded as intent, never as position: the tank
//     decides where the fish actually ends up

export class DesktopLayer {
  constructor() {
    this.tauri = window.__TAURI__;
    this.rect = null; // overlay client rect, physical px
    this.visible = false;
    this.ready = false;
    this.hunting = false;
    this.lastSent = 0;
    this.lastCount = 0;
    this.seq = 0;
    this.onGrab = null;
    this.onDrag = null;
    this.onDrop = null;
    this._inputBound = false;
    this._readyBound = false;
    this._readyWaiters = [];
  }

  get available() {
    return Boolean(this.tauri);
  }

  async show() {
    if (!this.available) return false;
    // the previous layer was destroyed, so its page is gone: start clean
    this.ready = false;
    this.lastCount = 0;
    this.bindReady();
    this.bindInput();
    this.rect = await this.tauri.core.invoke("overlay_show");
    this.visible = true;
    return this.handshake();
  }

  async hide() {
    if (!this.available) return;
    if (!this.visible) return;
    this.hunting = false;
    this.visible = false;
    this.ready = false;
    this.lastCount = 0;
    await this.tauri.core.invoke("overlay_hide");
  }

  /** One listener for the app's lifetime; the page comes and goes. */
  bindReady() {
    if (this._readyBound) return;
    this._readyBound = true;
    this.tauri.event.listen("overlay-ready", () => {
      this.ready = true;
      const waiters = this._readyWaiters;
      this._readyWaiters = [];
      for (const resolve of waiters) resolve(true);
    });
  }

  /** The page may boot before or after us; the ping covers both orders. */
  handshake(timeout = 3000) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeout);
      this._readyWaiters.push((ok) => {
        clearTimeout(timer);
        finish(ok);
      });
      this.tauri.event.emit("overlay-ping", null);
    });
  }

  bindInput() {
    if (this._inputBound) return;
    this._inputBound = true;

    const forward = (name, handler) =>
      this.tauri.event.listen(name, (event) => {
        const payload = event.payload || {};
        if (!handler) return;
        handler(payload.id, payload.x, payload.y);
      });

    forward("overlay-grab", (id, x, y) => this.onGrab && this.onGrab(id, x, y));
    forward("overlay-drag", (id, x, y) => this.onDrag && this.onDrag(id, x, y));
    forward("overlay-drop", (id, x, y) => this.onDrop && this.onDrop(id, x, y));
  }

  setHunt(on) {
    if (!this.available) return;
    this.hunting = Boolean(on) && this.visible;
    this.tauri.event.emit("hunt", this.hunting);
  }

  /** Push the outside-fish snapshot at ~30 Hz, never more often. */
  frame(stamp, snapshot) {
    if (!this.visible || !this.ready) return;
    // nothing outside, and nothing was outside last time either: the layer has
    // already been cleared, so there is nothing to send
    if (snapshot.length === 0 && this.lastCount === 0) return;
    if (stamp - this.lastSent < 28) return;
    this.lastSent = stamp;
    this.lastCount = snapshot.length;
    const payload = { seq: ++this.seq, fish: snapshot.slice() };
    this.tauri.event.emit("tank-frame", payload);
  }
}
