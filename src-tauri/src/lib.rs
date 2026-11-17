// Text Aquarium — Tauri entry point (Rust side).
//
// The Rust side owns *windows and system integration only*:
//   - the tank window (declared in tauri.conf.json)
//   - the transparent desktop overlay window (created on demand)
//   - always-on-top / click-through / work-area geometry
//   - the Phase 0 technical self-check
//
// All fish logic lives in the frontend (plain JS modules).

mod debug;
mod overlay;
mod settings;
mod techcheck;
mod win32;

use tauri::Manager;

pub fn run() {
    // One tank, one ocean: a second copy would mean two sets of fish and two
    // desktop layers fighting over the same screen.
    #[cfg(target_os = "windows")]
    if !win32::claim_single_instance("Local\\TextAquarium.SingleInstance") {
        win32::focus_window(win32::find_window("Text Aquarium"));
        return;
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            overlay::overlay_show,
            overlay::overlay_hide,
            overlay::overlay_click_through,
            overlay::tank_placement,
            overlay::cursor_pos,
            overlay::screen_pixel,
            overlay::work_area,
            techcheck::tech_check,
            debug::debug_log,
            debug::debug_read,
            debug::debug_write,
            debug::debug_write_png,
            debug::debug_windows,
            settings::settings_load,
            settings::settings_save,
        ])
        .setup(|app| {
            // The desktop layer is a second window: if the tank closes while it
            // is up, it would keep the process alive with no visible UI. Tear it
            // down first so the app really exits.
            if let Some(tank) = app.get_webview_window("tank") {
                let handle = app.handle().clone();
                tank.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        if let Some(overlay) = handle.get_webview_window(overlay::OVERLAY_LABEL) {
                            let _ = overlay.destroy();
                        }
                    }
                });
            }

            let handle = app.handle().clone();
            let requested = std::env::args().any(|a| a == "--tech-check")
                || std::env::var("TA_TECH_CHECK").map(|v| v != "0").unwrap_or(false);
            if requested {
                // Phase 0 mode: show the overlay right away, then run the
                // automated probes and dump the report to a file + stdout.
                let _ = overlay::ensure_overlay(&handle, true);
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2200));
                    let report = techcheck::run(&handle);
                    let path = std::env::temp_dir().join("text-aquarium-techcheck.txt");
                    let _ = std::fs::write(&path, &report);
                    println!("{report}");
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Text Aquarium");
}
