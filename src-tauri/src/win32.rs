// Minimal Win32 FFI used by the window layer and the Phase 0 self-check.
//
// We deliberately declare the few functions we need by hand instead of pulling
// in the `windows`/`windows-sys` crates: it keeps the dependency tree small and
// the signatures exactly as documented on MSDN.

#![allow(non_snake_case)]

use std::ffi::c_void;

pub type HWND = *mut c_void;
pub type HDC = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct POINT {
    pub x: i32,
    pub y: i32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct RECT {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

pub const GWL_EXSTYLE: i32 = -20;

pub const WS_EX_TRANSPARENT: isize = 0x0000_0020;
pub const WS_EX_TOPMOST: isize = 0x0000_0008;
pub const WS_EX_LAYERED: isize = 0x0008_0000;
pub const WS_EX_NOACTIVATE: isize = 0x0800_0000;

const SPI_GETWORKAREA: u32 = 0x0030;

#[link(name = "user32")]
extern "system" {
    fn FindWindowW(lp_class_name: *const u16, lp_window_name: *const u16) -> HWND;
    fn GetWindowLongPtrW(hwnd: HWND, n_index: i32) -> isize;
    fn GetWindowRect(hwnd: HWND, lp_rect: *mut RECT) -> i32;
    fn IsWindowVisible(hwnd: HWND) -> i32;
    fn WindowFromPoint(pt: POINT) -> HWND;
    fn GetAncestor(hwnd: HWND, flags: u32) -> HWND;
    fn SystemParametersInfoW(action: u32, ui_param: u32, pv_param: *mut c_void, win_ini: u32) -> i32;
    fn GetDpiForWindow(hwnd: HWND) -> u32;
    fn GetCursorPos(lp_point: *mut POINT) -> i32;
    fn ShowWindow(hwnd: HWND, cmd: i32) -> i32;
    fn SetForegroundWindow(hwnd: HWND) -> i32;
    fn IsIconic(hwnd: HWND) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateMutexW(attrs: *mut c_void, owner: i32, name: *const u16) -> *mut c_void;
    fn GetLastError() -> u32;
}

#[link(name = "gdi32")]
extern "system" {
    fn GetDC(hwnd: HWND) -> HDC;
    fn ReleaseDC(hwnd: HWND, hdc: HDC) -> i32;
    fn GetPixel(hdc: HDC, x: i32, y: i32) -> u32;
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn find_window(title: &str) -> HWND {
    unsafe { FindWindowW(std::ptr::null(), wide(title).as_ptr()) }
}

pub fn ex_style(hwnd: HWND) -> isize {
    unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) }
}

pub fn has_ex_style(hwnd: HWND, flag: isize) -> bool {
    !hwnd.is_null() && (ex_style(hwnd) & flag) != 0
}

pub fn is_visible(hwnd: HWND) -> bool {
    !hwnd.is_null() && unsafe { IsWindowVisible(hwnd) } != 0
}

/// (left, top, width, height) in physical pixels.
pub fn window_rect(hwnd: HWND) -> Option<(i32, i32, i32, i32)> {
    if hwnd.is_null() {
        return None;
    }
    let mut r = RECT::default();
    let ok = unsafe { GetWindowRect(hwnd, &mut r) };
    if ok == 0 {
        return None;
    }
    Some((r.left, r.top, r.right - r.left, r.bottom - r.top))
}

/// Primary monitor work area (taskbar excluded), physical pixels.
pub fn work_area_rect() -> Option<(i32, i32, u32, u32)> {
    let mut r = RECT::default();
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            &mut r as *mut RECT as *mut c_void,
            0,
        )
    };
    if ok == 0 || r.right <= r.left || r.bottom <= r.top {
        return None;
    }
    Some((
        r.left,
        r.top,
        (r.right - r.left) as u32,
        (r.bottom - r.top) as u32,
    ))
}

/// Which window receives a click at this screen point (the OS hit test).
pub fn window_from_point(x: i32, y: i32) -> HWND {
    unsafe { WindowFromPoint(POINT { x, y }) }
}

/// Top-level owner of a (possibly child) window. GA_ROOT = 2.
pub fn root_window(hwnd: HWND) -> HWND {
    if hwnd.is_null() {
        return hwnd;
    }
    unsafe { GetAncestor(hwnd, 2) }
}

/// Colour of the composited screen at a point, as (r, g, b).
pub fn pixel_at(x: i32, y: i32) -> Option<(u8, u8, u8)> {
    unsafe {
        let dc = GetDC(std::ptr::null_mut());
        if dc.is_null() {
            return None;
        }
        let c = GetPixel(dc, x, y);
        ReleaseDC(std::ptr::null_mut(), dc);
        if c == 0xFFFF_FFFF {
            return None;
        }
        Some((
            (c & 0xFF) as u8,
            ((c >> 8) & 0xFF) as u8,
            ((c >> 16) & 0xFF) as u8,
        ))
    }
}

pub fn dpi_for(hwnd: HWND) -> u32 {
    if hwnd.is_null() {
        return 0;
    }
    unsafe { GetDpiForWindow(hwnd) }
}

/// Screen cursor position in physical pixels (virtual-screen coordinates).
pub fn cursor_pos() -> Option<(i32, i32)> {
    let mut p = POINT::default();
    let ok = unsafe { GetCursorPos(&mut p) };
    if ok == 0 {
        None
    } else {
        Some((p.x, p.y))
    }
}

/// Bring an existing window forward (un-minimise + activate).
pub fn focus_window(hwnd: HWND) {
    if hwnd.is_null() {
        return;
    }
    unsafe {
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, 9); // SW_RESTORE
        }
        SetForegroundWindow(hwnd);
    }
}

const ERROR_ALREADY_EXISTS: u32 = 183;

/// True if this process owns the single-instance mutex. A second copy would
/// mean a second tank and a second desktop layer — two sets of fish.
pub fn claim_single_instance(name: &str) -> bool {
    let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 1, wide(name).as_ptr()) };
    if handle.is_null() {
        return true; // cannot tell: let it run rather than refuse to start
    }
    unsafe { GetLastError() != ERROR_ALREADY_EXISTS }
}
