//! Device-local export preferences and collision-safe, human-readable names.
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::{Path, PathBuf}};
use tauri::Manager;

#[derive(Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    directory: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Location {
    directory: PathBuf,
    is_default: bool,
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("export-settings.json"))
}

fn load(path: &Path) -> Result<Settings, String> {
    match fs::read(path) {
        Ok(bytes) if bytes.len() <= 16384 => serde_json::from_slice(&bytes)
            .map_err(|_| "导出设置无效，请重新选择文件夹或恢复默认位置".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        _ => Err("无法读取导出设置，请重新选择文件夹或恢复默认位置".into()),
    }
}

fn resolve(settings: Settings, default: impl FnOnce() -> Result<PathBuf, String>) -> Result<Location, String> {
    match settings.directory {
        Some(directory) if directory.is_absolute() => Ok(Location { directory, is_default: false }),
        Some(_) => Err("导出文件夹须为本机绝对路径，请重新选择或恢复默认位置".into()),
        None => Ok(Location { directory: default()?, is_default: true }),
    }
}

fn check_directory(directory: &Path) -> Result<(), String> {
    if !directory.is_absolute() || !directory.is_dir() {
        return Err("导出文件夹不存在或不可用，请重新选择或恢复默认位置".into());
    }
    // Probe with a disposable file; do not accept a folder that cannot be written.
    tempfile::NamedTempFile::new_in(directory)
        .map_err(|_| "无法写入导出文件夹，请检查权限或重新选择".to_string())?;
    Ok(())
}

fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(directory) = &settings.directory { check_directory(directory)?; }
    let parent = path.parent().ok_or("导出配置目录无效")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(settings).map_err(|e| e.to_string())?)
        .and_then(|_| file.as_file().sync_all()).map_err(|e| e.to_string())?;
    file.persist(path).map_err(|_| "无法保存导出设置，原设置保留".to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn export_location_get(app: tauri::AppHandle) -> Result<Location, String> {
    resolve(load(&settings_path(&app)?)?, || app.path().download_dir().map_err(|e| e.to_string()))
}

#[tauri::command]
pub(crate) async fn export_location_choose(app: tauri::AppHandle) -> Result<Option<Location>, String> {
    let Some(directory) = crate::media::choose_folder(&app, "选择导出文件夹").await? else { return Ok(None); };
    let settings = Settings { directory: Some(directory) };
    save(&settings_path(&app)?, &settings)?;
    export_location_get(app).map(Some)
}

#[tauri::command]
pub(crate) fn export_location_reset(app: tauri::AppHandle) -> Result<Location, String> {
    let location = resolve(Settings::default(), || app.path().download_dir().map_err(|e| e.to_string()))?;
    save(&settings_path(&app)?, &Settings::default())?;
    Ok(location)
}

pub(crate) fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let location = export_location_get(app.clone())?;
    if location.is_default { fs::create_dir_all(&location.directory).map_err(|e| e.to_string())?; }
    check_directory(&location.directory)?;
    Ok(location.directory)
}

// Bound UTF-8 bytes, not just characters, to stay below common filename limits.
pub(crate) fn component(value: &str, max_bytes: usize, fallback: &str) -> String {
    let mut name = String::new();
    for character in value.trim().chars() {
        let safe = if character.is_control() || "/\\:*?\"<>|".contains(character) { '_' } else { character };
        if name.len() + safe.len_utf8() > max_bytes { break; }
        name.push(safe);
    }
    let name = name.trim_matches([' ', '.']);
    if name.is_empty() { fallback.into() } else { name.into() }
}

pub(crate) fn name(project: &str, scope: &str, kind: &str) -> String {
    let mut parts = vec![component(project, 66, "未命名项目")];
    if !scope.trim().is_empty() { parts.push(component(scope, 84, "当前范围")); }
    parts.push(component(kind, 32, "导出"));
    parts.push(chrono::Local::now().format("%Y%m%d-%H%M%S").to_string());
    parts.join("_")
}

fn candidate(destination: &Path, stem: &str, extension: &str, number: usize) -> PathBuf {
    let suffix = if number == 1 { String::new() } else { format!(" ({number})") };
    let extension = if extension.is_empty() { String::new() } else { format!(".{extension}") };
    destination.join(format!("{stem}{suffix}{extension}"))
}

pub(crate) fn publish_folder(stage: &Path, destination: &Path, stem: &str) -> Result<PathBuf, String> {
    for number in 1..=10000 {
        let path = candidate(destination, stem, "", number);
        match fs::create_dir(&path) {
            Ok(()) => {
                if let Err(error) = fs::rename(stage, &path) { let _ = fs::remove_dir(&path); return Err(error.to_string()); }
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("同名导出过多，请稍后重试".into())
}

pub(crate) fn publish_file(mut file: tempfile::NamedTempFile, destination: &Path, stem: &str, extension: &str) -> Result<PathBuf, String> {
    for number in 1..=10000 {
        let path = candidate(destination, stem, extension, number);
        match file.persist_noclobber(&path) {
            Ok(_) => return Ok(path),
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => file = error.file,
            Err(error) => return Err(error.error.to_string()),
        }
    }
    Err("同名导出过多，请稍后重试".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preferences_persist_reset_and_reject_unusable_paths() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("config/export-settings.json");
        let default = root.path().join("Downloads");
        assert!(resolve(load(&path).unwrap(), || Ok(default.clone())).unwrap().is_default);
        save(&path, &Settings { directory: Some(root.path().to_owned()) }).unwrap();
        let location = resolve(load(&path).unwrap(), || panic!("custom path must not resolve Downloads")).unwrap();
        assert_eq!(location.directory, root.path());
        assert!(!location.is_default);
        assert!(save(&path, &Settings { directory: Some(root.path().join("missing")) }).is_err());
        assert_eq!(load(&path).unwrap().directory.unwrap(), root.path());
        assert!(resolve(Settings { directory: Some("relative".into()) }, || Ok(default.clone())).is_err());
        save(&path, &Settings::default()).unwrap();
        assert_eq!(resolve(load(&path).unwrap(), || Ok(default.clone())).unwrap().directory, default);
        fs::write(&path, "broken").unwrap();
        assert!(load(&path).is_err());
        save(&path, &Settings::default()).unwrap();
        assert!(load(&path).unwrap().directory.is_none());
    }

    #[test]
    fn names_are_readable_bounded_and_cannot_escape_destination() {
        let value = name("狂澜之上", "EP01-SC001 烈日暴晒", "Muse素材包");
        assert!(value.starts_with("狂澜之上_EP01-SC001 烈日暴晒_Muse素材包_"));
        let stamp = value.rsplit('_').next().unwrap();
        assert_eq!(stamp.len(), 15);
        let value = name(&"角".repeat(100), &"景".repeat(1000), "Muse素材包");
        assert!(value.len() < 220);
        assert_eq!(component(" ../../坏\\名:*?\"<>|\n ", 80, "项目"), "_.._坏_名_______");
        assert_eq!(component(" . ", 80, "项目"), "项目");
    }

    #[test]
    fn repeated_exports_never_replace_folders_files_or_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let stem = "项目_Muse素材包_20261024-160000";
        let stage = tempfile::tempdir_in(root.path()).unwrap();
        fs::write(stage.path().join("prompt.txt"), "first").unwrap();
        let first = publish_folder(stage.path(), root.path(), stem).unwrap();
        let stage = tempfile::tempdir_in(root.path()).unwrap();
        fs::write(stage.path().join("prompt.txt"), "second").unwrap();
        let second = publish_folder(stage.path(), root.path(), stem).unwrap();
        assert!(second.ends_with(format!("{stem} (2)")));
        assert_eq!(fs::read_to_string(first.join("prompt.txt")).unwrap(), "first");
        for content in ["one", "two"] {
            let mut file = tempfile::NamedTempFile::new_in(root.path()).unwrap();
            file.write_all(content.as_bytes()).unwrap();
            publish_file(file, root.path(), stem, "md").unwrap();
        }
        assert_eq!(fs::read_to_string(root.path().join(format!("{stem}.md"))).unwrap(), "one");
        assert_eq!(fs::read_to_string(root.path().join(format!("{stem} (2).md"))).unwrap(), "two");
        #[cfg(unix)] {
            std::os::unix::fs::symlink(&first, root.path().join("blocked")).unwrap();
            let stage = tempfile::tempdir_in(root.path()).unwrap();
            let path = publish_folder(stage.path(), root.path(), "blocked").unwrap();
            assert!(path.ends_with("blocked (2)"));
        }
    }
}
