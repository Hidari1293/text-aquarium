<div align="center">

# Text Aquarium

**Three little text-character fish live in a pure-white text tank. Open the boundary, and they swim out into your real desktop.**

`><(((o>`　`<°)))彡`　`><(((*>`

[![Version](https://img.shields.io/badge/version-1.2.1-111111?style=flat)](https://github.com/Hidari1293/text-aquarium/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2B-0078D6?style=flat)](#)
[![License](https://img.shields.io/badge/license-CC%20BY--NC--ND%204.0-888888?style=flat)](LICENSE)
[![Stack](https://img.shields.io/badge/Tauri%202%20%2B%20vanilla%20ES%20modules-FFC131?style=flat)](#)

[简体中文](README.md) | English

<img src="https://cdn.jsdelivr.net/gh/Hidari1293/text-aquarium@main/docs/screenshot-tank.png" alt="The tank" width="640" />

</div>

## Inspiration

I wanted a pet system of my own — not a classic virtual pet: **no feeding, no hunger, no sickness, no death**, no check-ins, quests or achievements. It just needs to exist quietly, move freely, and be looked at from time to time.

So here is a tank: fish made of characters, living in a white text world. And the tank has one special mechanism — **the boundary can open**. When it does, the fish swim out of the text world into the real desktop, turn from ink-black into colour, and wander above your windows. For a moment, the whole desktop becomes their ocean.

> Minimal, unobtrusive, no care required, built to run all day.

## Features

**The tank**

- A 760 × 480 white window you can drag and resize
- Five character fish by default (adjustable 3–8), each with its own glyph, speed and turning habits
- Every fish **swims towards somewhere**: the head points where it goes, turns are smooth, never aimless drifting
- Turning around flips the **whole fish** (characters reversed and mirrored), with a gentle body ripple while swimming
- Seaweed and bubbles drawn in characters, softly swaying; plenty of empty white space
- Pause / resume (space bar) — pausing never resets positions

**The boundary and the desktop**

- Fish leave **only through the left/right sides**, in the direction they face — no seam, no pop
- Outside, fish turn colourful and **grow bolder**; their **colours adapt to the background** — brighter over dark wallpapers, slightly darker over bright ones, always visible
- Once out, fish **stay on the desktop** — only the net or closing the boundary brings them home; they keep swimming even while the tank window is minimised
- The desktop layer is fully transparent, always on top, never covers the taskbar, and is **completely click-through** by default
- The boundary works on the primary monitor only

**Interacting with fish**

- A nearby mouse startles them: **head-on, the fish whips around and bolts back** (a real C-start); sneaking up from behind, it **accelerates straight ahead**
- A mouse left idle for a while becomes a curiosity: fish swim over and give it a few pecks, **nose first**
- **Catching fish**: click the net button, drag a box around fish on the desktop, and they swim home; Esc or right-click puts the net away

**Customisation**

- Settings panel: seaweed, bubbles, 60 fps, **fish count (3–8), size (12–22px), liveliness** (speed & curiosity)
- **A custom fish**: type any characters (up to 16) to keep a fish of your own, head facing left or right

## Screenshots

<div align="center">
  <img src="https://cdn.jsdelivr.net/gh/Hidari1293/text-aquarium@main/docs/screenshot-tank.png" alt="The tank" width="420" />
  <img src="https://cdn.jsdelivr.net/gh/Hidari1293/text-aquarium@main/docs/screenshot-desktop.png" alt="Fish on the desktop" width="420" />
</div>

## Getting started

### Install the release (recommended)

Download `Text Aquarium_x64-setup.exe` from [Releases](https://github.com/Hidari1293/text-aquarium/releases/latest) and double-click to install:

- Installs per user (`%LOCALAPPDATA%\Text Aquarium`), **no administrator rights needed**
- Requires the WebView2 Runtime: built into Windows 10 1803+ / Windows 11
- Settings survive uninstall and reinstall (`%APPDATA%\TextAquarium\settings.json`)
- No network, no account, no server at runtime

### Run from source

Requires **Node.js 20+** and **Rust 1.77+** (MSVC toolchain):

```bash
npm install
npm run dev          # dev mode: built-in static server (port 5183) + hot reload
npm run build        # build the Windows installer (NSIS)
```

The installer lands in `src-tauri/target/release/bundle/nsis/`.

> Packaging downloads the NSIS toolchain from GitHub; if direct access is blocked, use a mirror:
>
> ```bash
> TAURI_BUNDLER_TOOLS_GITHUB_MIRROR="https://ghfast.top/https://github.com/" \
>   npx tauri build --bundles nsis
> ```

## Tests

Five suites, each covering a different concern, all zero-dependency (node / python), all runnable individually:

```bash
node scripts/simtest.mjs       # 81 checks: motion, glyphs, boundary hand-overs,
                               #          lasso, dodge direction, curiosity, custom fish
python scripts/p3test.py       # 49 checks: the real program end-to-end
python scripts/p2smoke.py      # 26 checks: real mouse + screen pixels (needs an unlocked desktop)
python scripts/p5test.py       # 26 checks: settings persistence, install/launch/uninstall
python scripts/perf.py         # CPU / memory measurements
python scripts/soak.py 12      # long-run memory slope check
```

Details and measured numbers live in [`docs/TEST_REPORT.md`](docs/TEST_REPORT.md).

## Project layout

```
src/                  Frontend (vanilla HTML / CSS / ES modules — no framework, no bundler)
  index.html          the tank window
  overlay.html        the transparent desktop layer
  js/                 main · simulation · fish · fish-behavior · glyph ·
                      coordinates · aquarium · desktop-overlay · overlay ·
                      bubbles · seaweed · settings · test-hooks
src-tauri/            Rust: windows, always-on-top, click-through, work-area geometry,
                      cursor & background sampling, settings on disk, self-check
                      (hand-written Win32 FFI, no windows-sys)
scripts/              zero-dependency dev server, icon generation, tests & perf tools
docs/                 architecture, development log, test report, the original brief
```

## Stack & design principles

| | |
|---|---|
| Desktop framework | Tauri 2 |
| Frontend | Vanilla HTML / CSS / JavaScript (ES modules) |
| Backend | Rust (windows & system integration only) |
| Data | Local JSON (`%APPDATA%\TextAquarium\settings.json`) |

- **The tank window is the single brain**: all fish state, coordinates and boundary decisions live there; the desktop layer is a transparent pane that only paints what it is told (30 Hz snapshots)
- Motion is time-based, with capped speed and turn rate — **no teleporting, no duplicates, no vanishing**
- Visually, only paper-white and ink-black: no gradients, no shadows, no sprites; **colour belongs to fish that have reached the desktop**
- No React / Vue / Electron / cloud services / online assets

## Version history

| Version | Date | Highlights |
|---|---|---|
| v1.0.0 | 2026-11-17 | The character tank and the desktop layer (first complete release) |
| v1.1.0 | 2026-11-17 | Fish-mouse interaction, lasso catching, adjustable count/size/liveliness, side-only exits |
| v1.2.0 | 2026-11-17 | Background-adaptive colours, bolder rendering, startle dodges, nose-first pecks, custom fish |
| v1.2.1 | 2026-11-18 | Directional dodges (C-start), fish stay on the desktop, seamless exit through the border |

## License

[CC BY-NC-ND 4.0](LICENSE) — Attribution-NonCommercial-NoDerivatives: personal use is welcome; commercial use and redistribution of modified versions require permission.

---

<div align="center">
  <sub>Fish need no feeding and never die. They just swim.</sub>
</div>
