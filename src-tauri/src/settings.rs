// Settings on disk, in %APPDATA%\TextAquarium\settings.json.
//
// Three switches do not need a database, but they do need to survive a
// reinstall: the tank is meant to be left running for months, so it should come
// back the way it was left.

use std::path::PathBuf;

fn settings_path() -> PathBuf {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("TextAquarium").join("settings.json")
}

#[tauri::command]
pub fn settings_load() -> Result<String, String> {
    match std::fs::read_to_string(settings_path()) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn settings_save(text: String) -> Result<(), String> {
    // a handful of booleans: anything larger is not ours to write
    if text.len() > 4096 {
        return Err("settings payload too large".into());
    }
    let path = settings_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // write-then-rename, so a crash mid-write cannot leave a half file
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}
