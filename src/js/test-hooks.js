// Dev-only harness channel.
//
// The app has no remote control surface, and a desktop pet is awkward to drive
// from the outside: the state that matters lives inside two webviews. When a
// page is served by the local dev server, it installs two things:
//
//   * a command channel — a script drops a snippet of JS in
//     %TEMP%\text-aquarium-dump\cmd-<page>.js and the page runs it
//   * probe / shot helpers, so those snippets can write state or a canvas
//     capture back to the same folder
//
// A packaged build is never served from 127.0.0.1, so none of this exists in
// the installed app.

const DIR_NAME = "text-aquarium-dump";

export function installTestHooks(page, { probe, shot, pointer, cursor }) {
  const tauri = window.__TAURI__;
  if (!tauri || location.hostname !== "127.0.0.1") return;

  if (probe) window.__probe = probe;
  if (shot) window.__shot = shot;
  if (pointer) window.__pointer = pointer;
  if (cursor) window.__cursor = cursor;
  window.__dumpDir = DIR_NAME;

  const channel = `cmd-${page}.js`;
  let busy = false;

  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      const text = await tauri.core.invoke("debug_read", { name: channel });
      if (text) {
        // clear first: the harness waits for the channel to empty, and a slow
        // command must not be run twice
        await tauri.core.invoke("debug_write", { name: channel, text: "" });
        try {
          (0, eval)(text);
        } catch (error) {
          await tauri.core.invoke("debug_write", {
            name: `error-${page}.txt`,
            text: String((error && error.stack) || error),
          });
        }
      }
    } catch {
      /* the app is closing, or the command is not available */
    } finally {
      busy = false;
    }
  };

  setInterval(poll, 200);
}
