// Test harness commands.
//
// The app has no remote control surface, and a desktop pet is hard to drive
// from outside: the interesting state lives inside two webviews. These three
// commands are the difference between "it looked fine" and a repeatable check —
// a script can ask a page to evaluate an expression, and the page can write a
// probe or a canvas capture to a file.
//
// They are only reachable from pages served by the local dev server (the
// frontend installs its hooks behind a 127.0.0.1 check), and they write only
// inside %TEMP%\text-aquarium-dump.

use std::path::PathBuf;

use tauri::Manager;

fn dump_dir() -> PathBuf {
    let dir = std::env::temp_dir().join("text-aquarium-dump");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/** Only a plain file name is ever used, so a name can never escape the folder. */
fn safe_name(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect()
}

#[tauri::command]
pub fn debug_log(text: String) {
    use std::io::Write;
    let path = std::env::temp_dir().join("text-aquarium-debug.log");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{text}");
    }
}

#[tauri::command]
pub fn debug_write(name: String, text: String) -> Result<String, String> {
    let path = dump_dir().join(safe_name(&name));
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/** Used by the dev-only command channel: a page polls this for orders. */
#[tauri::command]
pub fn debug_read(name: String) -> Result<String, String> {
    let path = dump_dir().join(safe_name(&name));
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/** `hex` is the payload of a canvas data URL: PNG bytes, written verbatim. */
#[tauri::command]
pub fn debug_write_png(name: String, hex: String) -> Result<String, String> {
    let bytes = decode_hex(&hex)?;
    let path = dump_dir().join(safe_name(&name));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn debug_windows(app: tauri::AppHandle) -> Vec<String> {
    let mut labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    labels.sort();
    labels
}

fn decode_hex(text: &str) -> Result<Vec<u8>, String> {
    let bytes = text.as_bytes();
    if bytes.len() % 2 != 0 {
        return Err("odd hex length".into());
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = (bytes[i] as char).to_digit(16).ok_or("bad hex digit")? as u8;
        let lo = (bytes[i + 1] as char).to_digit(16).ok_or("bad hex digit")? as u8;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Ok(out)
}
