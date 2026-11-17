// Phase 0 technical self-check.
//
// Everything here is *measured*, not asserted: window styles are read back from
// the OS, the click-through behaviour is verified with the real hit test used by
// Windows (WindowFromPoint), and transparency is verified by sampling the same
// screen pixel with the overlay shown and hidden.

use tauri::{AppHandle, Emitter, Manager};

struct Reporter {
    out: String,
    pass: u32,
    fail: u32,
}

impl Reporter {
    fn new() -> Self {
        Self {
            out: String::new(),
            pass: 0,
            fail: 0,
        }
    }

    fn line(&mut self, ok: bool, name: &str, detail: String) {
        if ok {
            self.pass += 1;
            self.out
                .push_str(&format!("[PASS] {name} :: {detail}\n"));
        } else {
            self.fail += 1;
            self.out
                .push_str(&format!("[FAIL] {name} :: {detail}\n"));
        }
    }

    fn note(&mut self, text: &str) {
        self.out.push_str(&format!("       {text}\n"));
    }

    fn finish(mut self) -> String {
        self.out.push_str(&format!(
            "\n=== {} passed, {} failed ===\n",
            self.pass, self.fail
        ));
        self.out
    }
}

/// Run every probe against the *currently visible* overlay window.
pub fn run(app: &AppHandle) -> String {
    #[cfg(target_os = "windows")]
    {
        run_windows(app)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        "Phase 0 self-check is implemented for Windows only.\n".to_string()
    }
}

#[cfg(target_os = "windows")]
fn run_windows(app: &AppHandle) -> String {
    use crate::overlay::{ensure_overlay, OVERLAY_TITLE};
    use crate::win32;
    use std::thread::sleep;
    use std::time::Duration;

    let mut r = Reporter::new();
    r.out.push_str(&format!(
        "Text Aquarium :: Phase 0 self-check\nplatform: windows / {} / tauri {}\n\n",
        std::env::consts::ARCH,
        tauri::VERSION
    ));

    let win = match ensure_overlay(app, true) {
        Ok(w) => w,
        Err(e) => return format!("cannot create the overlay window: {e}"),
    };
    // Start from the product default: clicks pass through.
    let _ = win.set_ignore_cursor_events(true);
    sleep(Duration::from_millis(900));

    let hwnd = win32::find_window(OVERLAY_TITLE);
    r.line(
        !hwnd.is_null(),
        "overlay window exists",
        format!("hwnd = {:#x}", hwnd as usize),
    );
    if hwnd.is_null() {
        return r.finish();
    }

    r.line(
        win32::is_visible(hwnd),
        "overlay is visible",
        "IsWindowVisible".to_string(),
    );

    // ---- geometry -------------------------------------------------------
    let work: Option<(i32, i32, i32, i32)> = win32::work_area_rect()
        .map(|(x, y, w, h)| (x, y, w as i32, h as i32));
    let rect = win32::window_rect(hwnd);
    match (rect, work) {
        (Some(rect), Some(work)) => {
            r.line(
                rect == work,
                "overlay covers the work area exactly",
                format!("overlay = {rect:?}, work area = {work:?}"),
            );
            r.line(
                rect.1 + rect.3 <= work.1 + work.3,
                "taskbar is not covered",
                format!(
                    "overlay bottom = {}, work area bottom = {}",
                    rect.1 + rect.3,
                    work.1 + work.3
                ),
            );
        }
        _ => r.line(
            false,
            "work area resolvable",
            "GetWindowRect / SPI_GETWORKAREA failed".into(),
        ),
    }

    // ---- window styles --------------------------------------------------
    r.line(
        win32::has_ex_style(hwnd, win32::WS_EX_TOPMOST),
        "always on top",
        format!("exstyle = {:#x}", win32::ex_style(hwnd)),
    );
    r.line(
        win32::has_ex_style(hwnd, win32::WS_EX_TRANSPARENT),
        "click-through style set by default",
        "WS_EX_TRANSPARENT present".to_string(),
    );
    let dpi = win32::dpi_for(hwnd);
    r.line(
        dpi >= 96,
        "dpi awareness readable",
        format!("window dpi = {dpi} (scale {:.2})", dpi as f64 / 96.0),
    );
    r.note(&format!(
        "extra ex-styles: layered={} noactivate={}",
        win32::has_ex_style(hwnd, win32::WS_EX_LAYERED),
        win32::has_ex_style(hwnd, win32::WS_EX_NOACTIVATE)
    ));

    // ---- transparency (A/B pixel probe) ---------------------------------
    let probe = match work {
        Some(w) => (w.0 + 80, w.1 + 80),
        None => (100, 100),
    };    let shown = win32::pixel_at(probe.0, probe.1);
    let _ = win.hide();
    sleep(Duration::from_millis(420));
    let hidden = win32::pixel_at(probe.0, probe.1);
    let _ = win.show();
    sleep(Duration::from_millis(420));
    let shown_again = win32::pixel_at(probe.0, probe.1);

    let transparent = match (shown, hidden, shown_again) {
        (Some(a), Some(b), Some(c)) => a == b && b == c,
        _ => false,
    };
    r.line(
        transparent,
        "overlay background is really transparent",
        format!(
            "at {:?}: shown={:?}, hidden={:?}, shown again={:?}",
            probe, shown, hidden, shown_again
        ),
    );
    r.note("overlay shown == overlay hidden means nothing is painted there");

    // ---- hit test A: click-through ON -----------------------------------
    let center = match rect {
        Some(r0) => (r0.0 + r0.2 as i32 / 2, r0.1 + r0.3 as i32 / 2),
        None => (200, 200),
    };
    sleep(Duration::from_millis(180));
    let hit_on = win32::root_window(win32::window_from_point(center.0, center.1));
    r.line(
        hit_on != hwnd,
        "clicks pass through to the app below",
        format!(
            "WindowFromPoint{:?} -> {:#x} (overlay is {:#x})",
            center, hit_on as usize, hwnd as usize
        ),
    );

    // ---- hit test B: click-through OFF (catching-fish mode) -------------
    let _ = win.set_ignore_cursor_events(false);
    sleep(Duration::from_millis(260));
    let hit_off = win32::root_window(win32::window_from_point(center.0, center.1));
    r.line(
        hit_off == hwnd,
        "overlay can receive the mouse when the mode is switched on",
        format!(
            "WindowFromPoint{:?} -> {:#x}",
            center, hit_off as usize
        ),
    );

    // restore the product default
    let _ = win.set_ignore_cursor_events(true);
    sleep(Duration::from_millis(260));
    let hit_restored = win32::root_window(win32::window_from_point(center.0, center.1));
    r.line(
        hit_restored != hwnd,
        "click-through restored after the mode is switched off",
        format!("WindowFromPoint{:?} -> {:#x}", center, hit_restored as usize),
    );

    // ---- second window / IPC --------------------------------------------
    let windows: Vec<String> = app.webview_windows().keys().cloned().collect();
    r.line(
        windows.len() >= 2,
        "two webview windows coexist",
        format!("labels = {windows:?}"),
    );

    r.finish()
}

/// Invoked from the frontend (settings panel). Non blocking: the report arrives
/// as the `tech-report` event after the probe finishes.
///
/// The overlay is created through `run_on_main_thread` — window creation from a
/// command thread hangs on Windows, which is exactly the bug this dispatch
/// avoids.
#[tauri::command]
pub fn tech_check(app: AppHandle) -> Result<(), String> {
    eprintln!("[tech] command entered");

    // Window creation must NOT happen on the main thread: `build()` internally
    // posts to the event loop and waits for it, so doing it from a main-thread
    // closure deadlocks. A worker thread gets the dispatch it needs.
    let handle = app.clone();
    std::thread::spawn(move || {
        eprintln!("[tech] worker up, creating overlay");
        match crate::overlay::ensure_overlay(&handle, true) {
            Ok(_) => eprintln!("[tech] overlay ready"),
            Err(e) => eprintln!("[tech] overlay error: {e}"),
        }
        std::thread::sleep(std::time::Duration::from_millis(1200));
        eprintln!("[tech] running probes");
        let report = run(&handle);
        eprintln!("[tech] probes done");
        let path = std::env::temp_dir().join("text-aquarium-techcheck.txt");
        let _ = std::fs::write(&path, &report);
        println!("{report}");
        let _ = handle.emit("tech-report", &report);
        eprintln!("[tech] report emitted");
        std::thread::sleep(std::time::Duration::from_millis(1400));
        // Destroy (not just hide) the overlay: a hidden WebView2 keeps its
        // renderer process alive and keeps compositing every frame. The next
        // check (or the real ocean mode) creates it again on demand.
        if let Ok(win) = crate::overlay::ensure_overlay(&handle, false) {
            let _ = win.destroy();
        }
        eprintln!("[tech] overlay destroyed");
    });
    Ok(())
}
