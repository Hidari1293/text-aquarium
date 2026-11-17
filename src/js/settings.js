// Settings: a handful of switches, remembered between runs.
//
// The file is the source of truth (%APPDATA%\TextAquarium\settings.json, written
// by Rust) so a reinstall does not forget how the tank was set up. localStorage
// is still written as a fallback for the browser preview, and as a cache for
// the first frame.

const KEY = "text-aquarium.settings.v1";

export const DEFAULTS = {
  seaweed: true,
  bubbles: true,
  /** false = 30 fps while focused (default), true = 60 fps */
  highFps: false,
  /** how many fish live in the tank (3–8) */
  count: 5,
  /** glyph size in css px (12–22) */
  size: 15,
  /** speed and curiosity in one knob (0.5–2.0) */
  liveliness: 1,
  /** a user-typed fish swimming next to the standard school ("" = none) */
  customGlyph: "",
  /** which way the custom text faces as written: 1 = right (head first) */
  customFacing: 1,
};

function merge(raw) {
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  return { ...DEFAULTS, ...(parsed && typeof parsed === "object" ? parsed : {}) };
}

export async function loadSettings() {
  const tauri = window.__TAURI__;
  if (tauri) {
    try {
      const raw = await tauri.core.invoke("settings_load");
      if (raw && raw.length > 1) return merge(raw);
    } catch {
      /* fall through to the local cache */
    }
  }
  try {
    return merge(localStorage.getItem(KEY));
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  const text = JSON.stringify(settings);
  try {
    localStorage.setItem(KEY, text);
  } catch {
    /* private mode / quota - the tank still works, it just forgets */
  }
  const tauri = window.__TAURI__;
  if (tauri) {
    tauri.core.invoke("settings_save", { text }).catch(() => {});
  }
}
