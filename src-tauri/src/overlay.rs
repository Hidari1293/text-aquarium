// Transparent desktop overlay window: creation, geometry, click-through.
//
// Windows specifics that matter for the product:
//   * the overlay must be transparent  -> WebView2 transparent background
//   * it must float above normal apps   -> always_on_top + WS_EX_TOPMOST
//   * it must NOT cover the taskbar     -> geometry = SPI_GETWORKAREA
//   * it must NOT eat mouse clicks      -> set_ignore_cursor_events(true)
//                                          (WS_EX_TRANSPARENT), toggled off
//                                          only while "catching fish" mode
//                                          is active.

use serde::Serialize;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

pub const OVERLAY_LABEL: &str = "overlay";
pub const OVERLAY_TITLE: &str = "Text Aquarium Overlay";

/// Chromium stops painting a window it believes nobody can see, which would
/// freeze the fish the moment another app is maximised over the tank. A pet
/// that stops swimming behind a browser is broken, so backgrounding and
/// occlusion throttling are turned off for both windows. (Tauri replaces its
/// default arguments when this is set, so the defaults are repeated here.)
pub const WEBVIEW_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
     --disable-backgrounding-occluded-windows --disable-renderer-backgrounding";

/// Rectangle in *physical* pixels, virtual-screen coordinates.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

/// Create the overlay if it does not exist yet. Never creates it twice:
/// a duplicated overlay would duplicate every fish drawn on the desktop.
pub fn ensure_overlay(app: &AppHandle, show: bool) -> tauri::Result<WebviewWindow> {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        if show && !win.is_visible().unwrap_or(false) {
            win.show()?;
        }
        return Ok(win);
    }

    let win = WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("overlay.html".into()))
        .title(OVERLAY_TITLE)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .shadow(false)
        .focused(false)
        .visible(false)
        .additional_browser_args(WEBVIEW_ARGS)
        .build()?;

    if let Some(rect) = system_work_area(&win) {
        win.set_position(PhysicalPosition::new(rect.x, rect.y))?;
        win.set_size(PhysicalSize::new(rect.width, rect.height))?;
    }

    // Default desktop behaviour: the overlay never swallows a mouse click.
    let _ = win.set_ignore_cursor_events(true);

    if show {
        win.show()?;
    }
    Ok(win)
}

/// Primary monitor work area (taskbar excluded) in physical pixels.
fn system_work_area(win: &WebviewWindow) -> Option<Rect> {
    let scale = win.scale_factor().unwrap_or(1.0);

    #[cfg(target_os = "windows")]
    {
        if let Some(r) = crate::win32::work_area_rect() {
            return Some(Rect {
                x: r.0,
                y: r.1,
                width: r.2,
                height: r.3,
                scale,
            });
        }
    }

    // Fallback (and non-Windows): full primary monitor.
    if let Ok(Some(monitor)) = win.primary_monitor() {
        let pos = monitor.position();
        let size = monitor.size();
        return Some(Rect {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            scale,
        });
    }
    None
}

/// The client area of a window in physical pixels — the reference frame for
/// all coordinate maths between the tank and the desktop layer.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct InnerRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

fn inner_rect(win: &WebviewWindow) -> Result<InnerRect, String> {
    let pos = win.inner_position().map_err(|e| e.to_string())?;
    let size = win.inner_size().map_err(|e| e.to_string())?;
    Ok(InnerRect {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        scale: win.scale_factor().unwrap_or(1.0),
    })
}

/// Show the desktop layer, re-anchored to the current work area (the screen
/// may have been resized or the taskbar moved since the window was built).
/// Returns the overlay's client rect so the tank can convert coordinates.
///
/// Async on purpose: `WebviewWindowBuilder::build()` posts to the event loop and
/// waits for it, so creating a window from a synchronous command (main thread)
/// deadlocks. Awaiting `spawn_blocking` puts the build on a worker thread.
#[tauri::command]
pub async fn overlay_show(app: AppHandle) -> Result<InnerRect, String> {
    let creator = app.clone();
    let win = tauri::async_runtime::spawn_blocking(move || ensure_overlay(&creator, false))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    if let Some(rect) = system_work_area(&win) {
        let _ = win.set_position(PhysicalPosition::new(rect.x, rect.y));
        let _ = win.set_size(PhysicalSize::new(rect.width, rect.height));
    }

    win.show().map_err(|e| e.to_string())?;
    let _ = win.set_always_on_top(true);
    // Every show starts safe: input goes straight through to the app below.
    let _ = win.set_ignore_cursor_events(true);

    inner_rect(&win)
}

/// Destroy the layer instead of hiding it: a hidden WebView2 keeps a renderer
/// process alive (~70 MB) for something that is only needed a few times a day.
#[tauri::command]
pub fn overlay_hide(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = win.set_ignore_cursor_events(true);
        if win.destroy().is_err() {
            let _ = win.hide();
        }
    }
    Ok(())
}

/// Client rect of the tank window, for tank-local -> desk coordinate maths.
#[tauri::command]
pub fn tank_placement(app: AppHandle) -> Result<InnerRect, String> {
    let win = app
        .get_webview_window("tank")
        .ok_or_else(|| "tank window not found".to_string())?;
    inner_rect(&win)
}

/// Screen cursor position in physical pixels. The overlay polls this to decide
/// whether a click near a fish should be intercepted.
#[tauri::command]
pub fn cursor_pos() -> Option<(i32, i32)> {
    crate::win32::cursor_pos()
}

/// true  -> mouse events pass through the overlay to the app below
/// false -> the overlay receives mouse events (catching-fish mode)
///
/// Acts on the existing window only — creating one here would deadlock.
#[tauri::command]
pub fn overlay_click_through(app: AppHandle, enabled: bool) -> Result<(), String> {
    match app.get_webview_window(OVERLAY_LABEL) {
        Some(win) => win
            .set_ignore_cursor_events(enabled)
            .map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn work_area(app: AppHandle) -> Result<Rect, String> {
    let win = app
        .get_webview_window("tank")
        .or_else(|| app.get_webview_window(OVERLAY_LABEL))
        .ok_or_else(|| "no window available".to_string())?;
    system_work_area(&win).ok_or_else(|| "cannot resolve work area".to_string())
}
