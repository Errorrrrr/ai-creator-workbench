//! Portable handoff folder; all media resolves through project-owned version IDs.
use crate::{media, media_integrity::copy_checked};
use serde::Deserialize;
use std::{
    collections::HashSet,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};
use tauri::Manager;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextEntry {
    path: String,
    content: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageEntry {
    path: String,
    version_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Export {
    texts: Vec<TextEntry>,
    images: Vec<ImageEntry>,
}

#[derive(Clone, Copy)]
enum Target {
    Flow,
    Muse,
}
impl Target {
    fn folder_prefix(self) -> &'static str {
        match self {
            Self::Flow => "Google-Flow",
            Self::Muse => "Meta-Muse",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Flow => "Google Flow 素材包",
            Self::Muse => "Muse 聊天素材包",
        }
    }
}

fn valid_path(path: &str, image: bool) -> bool {
    if !image && ["使用说明.md", "manifest.json"].contains(&path) {
        return true;
    }
    let Some((folder, file)) = path.split_once('/') else {
        return false;
    };
    let Some(number) = folder.strip_prefix("shot-") else {
        return false;
    };
    if number.len() != 3
        || !number.bytes().all(|b| b.is_ascii_digit())
        || !number.parse::<u32>().is_ok_and(|n| (1..=120).contains(&n))
    {
        return false;
    }
    if !image {
        return ["prompt.txt", "说明.md", "修改消息.txt"].contains(&file);
    }
    let Some((stem, ext)) = file.rsplit_once('.') else {
        return false;
    };
    let Some(number) = stem.strip_prefix("ref-") else {
        return false;
    };
    number.len() == 2
        && number.bytes().all(|b| b.is_ascii_digit())
        && ["png", "jpg", "webp", "gif"].contains(&ext)
}

fn validate(export: &Export) -> Result<(), String> {
    if export.texts.is_empty() || export.texts.len() > 362 || export.images.len() > 2040 {
        return Err("导出内容数量无效".into());
    }
    let mut paths = HashSet::new();
    let mut bytes = 0usize;
    for entry in &export.texts {
        bytes += entry.content.len();
        if !valid_path(&entry.path, false) || !paths.insert(&entry.path) || bytes > 64 * 1024 * 1024
        {
            return Err("导出文本路径、大小或重复条目无效".into());
        }
    }
    for entry in &export.images {
        media::valid_id(&entry.version_id)?;
        if !valid_path(&entry.path, true) || !paths.insert(&entry.path) {
            return Err("导出图片路径或重复条目无效".into());
        }
    }
    Ok(())
}

fn write_folder(
    export: &Export,
    destination: &Path,
    target: Target,
    resolve: impl Fn(&str) -> Result<(PathBuf, String, u64), String>,
) -> Result<PathBuf, String> {
    validate(export)?;
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    let staging = tempfile::Builder::new()
        .prefix(".video-export-")
        .tempdir_in(destination)
        .map_err(|e| e.to_string())?;
    for entry in &export.texts {
        let path = staging.path().join(&entry.path);
        fs::create_dir_all(path.parent().ok_or("导出目录无效")?).map_err(|e| e.to_string())?;
        let mut file = File::create(path).map_err(|e| e.to_string())?;
        file.write_all(entry.content.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
    }
    let mut total = 0u64;
    for entry in &export.images {
        let (source, mime, bytes) = resolve(&entry.version_id)
            .map_err(|e| format!("{}：{e}；未生成不完整素材包", entry.path))?;
        let extension = match mime.as_str() {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
            _ => return Err("参考素材不是支持的图片".into()),
        };
        total = total.checked_add(bytes).ok_or("导出图片过大")?;
        if total > 8 * 1024 * 1024 * 1024 || !entry.path.ends_with(&format!(".{extension}")) {
            return Err("图片总量超过 8 GiB 或扩展名不匹配".into());
        }
        let path = staging.path().join(&entry.path);
        fs::create_dir_all(path.parent().ok_or("图片目录无效")?).map_err(|e| e.to_string())?;
        let mut output = File::create(path).map_err(|e| e.to_string())?;
        copy_checked(
            &mut File::open(source).map_err(|e| e.to_string())?,
            &mut output,
            bytes,
        )?;
        output.sync_all().map_err(|e| e.to_string())?;
    }
    let path = destination.join(format!("{}-{}", target.folder_prefix(), media::new_id()));
    fs::rename(staging.path(), &path).map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
pub(crate) async fn media_export_flow(
    app: tauri::AppHandle,
    project_id: String,
    bundle: Export,
) -> Result<String, String> {
    export_for(app, project_id, bundle, Target::Flow).await
}

#[tauri::command]
pub(crate) async fn media_export_muse(
    app: tauri::AppHandle,
    project_id: String,
    bundle: Export,
) -> Result<String, String> {
    export_for(app, project_id, bundle, Target::Muse).await
}

async fn export_for(
    app: tauri::AppHandle,
    project_id: String,
    bundle: Export,
    target: Target,
) -> Result<String, String> {
    media::valid_id(&project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let directory = app.path().download_dir().map_err(|e| e.to_string())?;
        let path = write_folder(&bundle, &directory, target, |id| {
            let (version, source) = media::version_file(&app, &project_id, id)?;
            Ok((source, version.mime_type, version.bytes))
        })?;
        Ok(format!("{}已导出到：{}", target.label(), path.display()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bundle() -> Export {
        Export {
            texts: vec![TextEntry {
                path: "shot-001/prompt.txt".into(),
                content: "人物走入画面".into(),
            }],
            images: vec![ImageEntry {
                path: "shot-001/ref-01.png".into(),
                version_id: "fixed-version".into(),
            }],
        }
    }
    #[test]
    fn rejects_unsafe_and_duplicate_paths() {
        for path in [
            "../prompt.txt",
            "/tmp/x",
            "shot-001/../../x",
            "shot-121/prompt.txt",
            "shot-001/a/b.png",
            "shot-001\\prompt.txt",
        ] {
            assert!(!valid_path(path, false));
            assert!(!valid_path(path, true));
        }
        let mut export = bundle();
        export.texts.push(TextEntry {
            path: "shot-001/prompt.txt".into(),
            content: "".into(),
        });
        assert!(validate(&export).is_err());
    }
    #[test]
    fn exports_exact_bytes_and_cleans_failed_exports() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("original.png");
        fs::write(&source, b"image bytes").unwrap();
        let destination = root.path().join("downloads");
        let result = write_folder(&bundle(), &destination, Target::Flow, |_| {
            Ok((source.clone(), "image/png".into(), 11))
        })
        .unwrap();
        assert_eq!(
            fs::read(result.join("shot-001/ref-01.png")).unwrap(),
            b"image bytes"
        );
        assert_eq!(
            fs::read_to_string(result.join("shot-001/prompt.txt")).unwrap(),
            "人物走入画面"
        );
        assert!(write_folder(&bundle(), &destination, Target::Flow, |_| Err(
            "missing".into()
        ))
        .is_err());
        assert!(write_folder(&bundle(), &destination, Target::Flow, |_| Ok((
            source.clone(),
            "image/png".into(),
            100
        )))
        .is_err());
        assert_eq!(fs::read_dir(destination).unwrap().count(), 1);
    }

    #[test]
    fn muse_exports_chat_files_with_its_own_prefix_and_cleans_failed_copy() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("downloads");
        let mut export = bundle();
        export.images.clear();
        export.texts.push(TextEntry {
            path: "shot-001/修改消息.txt".into(),
            content: "请修改上一版视频".into(),
        });
        let result = write_folder(&export, &destination, Target::Muse, |_| unreachable!()).unwrap();
        assert!(result
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("Meta-Muse-"));
        assert_eq!(
            fs::read_to_string(result.join("shot-001/修改消息.txt")).unwrap(),
            "请修改上一版视频"
        );
        assert!(write_folder(&bundle(), &destination, Target::Muse, |_| Err(
            "missing".into()
        ))
        .is_err());
        assert_eq!(fs::read_dir(destination).unwrap().count(), 1);
    }
}
