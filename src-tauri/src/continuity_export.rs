//! Portable setting sheets and pinned images for characters, locations and props.
use crate::{
    export_location, media,
    media_integrity::{copy_checked, sync_directory},
};
use serde::Deserialize;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_STATES: usize = 4000;
const MAX_TEXT_BYTES: usize = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024 * 1024;

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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Export {
    project_name: String,
    scope_name: String,
    texts: Vec<TextEntry>,
    images: Vec<ImageEntry>,
}

fn valid_component(component: &str) -> bool {
    if component.is_empty()
        || component.len() > 120
        || component.trim() != component
        || component.starts_with('.')
        || component.ends_with('.')
        || component
            .chars()
            .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
    {
        return false;
    }
    let stem = component
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    !["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        && !(stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

fn state_path(path: &str, image: bool) -> Option<&str> {
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 4
        || !["人物", "场景", "关键物品"].contains(&parts[0])
        || !valid_component(parts[1])
        || !valid_component(parts[2])
    {
        return None;
    }
    let allowed = if image {
        ["参考图.png", "参考图.jpg", "参考图.webp", "参考图.gif"].contains(&parts[3])
    } else {
        ["设定.md", "prompt.txt"].contains(&parts[3])
    };
    allowed.then(|| path.rsplit_once('/').unwrap().0)
}

fn validate(export: &Export) -> Result<(), String> {
    if export.project_name.trim().is_empty()
        || export.project_name.chars().count() > 100
        || export.scope_name.chars().count() > 2200
    {
        return Err("导出项目名或范围无效".into());
    }
    if export.texts.len() < 4
        || export.texts.len() > MAX_STATES * 2 + 2
        || export.images.len() > MAX_STATES
    {
        return Err("请选择包含设定的素材，单次最多导出 4000 个状态".into());
    }
    let mut paths = HashSet::new();
    let mut states = HashMap::<String, u8>::new();
    let mut text_bytes = 0usize;
    for entry in &export.texts {
        text_bytes = text_bytes
            .checked_add(entry.content.len())
            .ok_or("导出文本过大")?;
        if text_bytes > MAX_TEXT_BYTES || !paths.insert(entry.path.to_lowercase()) {
            return Err("导出文本超出 64 MiB 或包含重复路径".into());
        }
        if ["manifest.json", "使用说明.md"].contains(&entry.path.as_str()) {
            continue;
        }
        let state = state_path(&entry.path, false).ok_or("设定文本路径无效")?;
        *states.entry(state.to_lowercase()).or_default() += 1;
    }
    if !paths.contains("manifest.json")
        || !paths.contains("使用说明.md")
        || states.is_empty()
        || states.len() > MAX_STATES
        || states.values().any(|count| *count != 2)
    {
        return Err("素材包缺少清单、说明或状态的设定与提示词".into());
    }
    let mut illustrated = HashSet::new();
    for entry in &export.images {
        media::valid_id(&entry.version_id)?;
        let state = state_path(&entry.path, true)
            .ok_or("设定图片路径无效")?
            .to_lowercase();
        if !states.contains_key(&state)
            || !paths.insert(entry.path.to_lowercase())
            || !illustrated.insert(state)
        {
            return Err("设定图片缺少对应状态或包含重复条目".into());
        }
    }
    Ok(())
}

fn write_folder(
    export: &Export,
    destination: &Path,
    resolve: impl Fn(&str) -> Result<(PathBuf, String, u64), String>,
) -> Result<PathBuf, String> {
    validate(export)?;
    let mut sources = Vec::with_capacity(export.images.len());
    let mut total = 0u64;
    // Check ownership, type and total size before copying any image bytes.
    for entry in &export.images {
        let (source, mime, bytes) = resolve(&entry.version_id)
            .map_err(|e| format!("{}：{e}；未生成不完整素材包", entry.path))?;
        let extension = match mime.as_str() {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
            _ => return Err("设定参考素材不是支持的图片".into()),
        };
        let info = fs::symlink_metadata(&source).map_err(|_| "设定参考图文件缺失")?;
        if !info.is_file()
            || info.file_type().is_symlink()
            || bytes == 0
            || bytes > media::MAX_MEDIA_BYTES
            || info.len() != bytes
            || !entry.path.ends_with(&format!(".{extension}"))
        {
            return Err("设定参考图类型、大小或扩展名已变化，未导出素材包".into());
        }
        total = total.checked_add(bytes).ok_or("设定图片总量溢出")?;
        if total > MAX_IMAGE_BYTES {
            return Err("设定图片超过 8 GiB，请分批导出".into());
        }
        sources.push((source, mime, bytes));
    }
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    let staging = tempfile::Builder::new()
        .prefix(".continuity-export-")
        .tempdir_in(destination)
        .map_err(|e| e.to_string())?;
    let mut directories = HashSet::new();
    directories.insert(staging.path().to_owned());
    for entry in &export.texts {
        let path = staging.path().join(&entry.path);
        let parent = path.parent().ok_or("设定目录无效")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        for ancestor in parent
            .ancestors()
            .take_while(|p| p.starts_with(staging.path()))
        {
            directories.insert(ancestor.to_owned());
        }
        let mut file = File::create_new(path).map_err(|e| e.to_string())?;
        file.write_all(entry.content.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
    }
    for (entry, (source, mime, bytes)) in export.images.iter().zip(sources) {
        let path = staging.path().join(&entry.path);
        let mut input = File::open(source).map_err(|e| e.to_string())?;
        let mut output = File::create_new(&path).map_err(|e| e.to_string())?;
        copy_checked(&mut input, &mut output, bytes)?;
        if input.read(&mut [0u8; 1]).map_err(|e| e.to_string())? != 0 {
            return Err("设定参考图大小在导出时变化，未导出素材包".into());
        }
        output.sync_all().map_err(|e| e.to_string())?;
        let (kind, actual_mime, _) = media::detect_format(&path)?;
        if kind != "image" || actual_mime != mime {
            return Err("设定参考图实际格式与登记不符，未导出素材包".into());
        }
        tauri::async_runtime::block_on(media::inspect(&path, "image"))
            .map_err(|e| format!("{}：{e}；未生成不完整素材包", entry.path))?;
    }
    let mut directories: Vec<_> = directories.into_iter().collect();
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for directory in directories {
        sync_directory(&directory)?;
    }
    let path = export_location::publish_folder(
        staging.path(),
        destination,
        &export_location::name(&export.project_name, &export.scope_name, "设定素材包"),
    )?;
    if let Err(error) = sync_directory(destination) {
        let _ = fs::remove_dir_all(&path);
        return Err(format!("设定素材包目录同步失败，未交付导出结果：{error}"));
    }
    Ok(path)
}

#[tauri::command]
pub(crate) async fn media_export_continuity(
    app: tauri::AppHandle,
    project_id: String,
    bundle: Export,
) -> Result<String, String> {
    media::valid_id(&project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let destination = export_location::directory(&app)?;
        let path = write_folder(&bundle, &destination, |id| {
            let (version, source) = media::version_file(&app, &project_id, id)?;
            Ok((source, version.mime_type, version.bytes))
        })?;
        Ok(path.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATE: &str = "关键物品/001_木筏/001_基础状态";

    fn bundle() -> Export {
        Export {
            project_name: "狂澜之上".into(),
            scope_name: "全部设定".into(),
            texts: vec![
                TextEntry {
                    path: "manifest.json".into(),
                    content: "{\"version\":1}".into(),
                },
                TextEntry {
                    path: "使用说明.md".into(),
                    content: "状态固定引用版本，不改变木筏的平板结构。".into(),
                },
                TextEntry {
                    path: format!("{STATE}/设定.md"),
                    content: "平板木筏，基础状态".into(),
                },
                TextEntry {
                    path: format!("{STATE}/prompt.txt"),
                    content: "白底平板木筏设定图".into(),
                },
            ],
            images: vec![ImageEntry {
                path: format!("{STATE}/参考图.png"),
                version_id: "pinned-image".into(),
            }],
        }
    }

    fn image(root: &Path) -> (PathBuf, Vec<u8>) {
        let source = root.join("source.png");
        image::DynamicImage::new_rgb8(3, 5).save(&source).unwrap();
        let bytes = fs::read(&source).unwrap();
        (source, bytes)
    }

    #[test]
    fn writes_portable_settings_with_pinned_image_bytes_without_replacing_previous_exports() {
        let root = tempfile::tempdir().unwrap();
        let (source, original) = image(root.path());
        let destination = root.path().join("chosen-export-directory");
        let export = bundle();
        for _ in 0..2 {
            let path = write_folder(&export, &destination, |id| {
                assert_eq!(id, "pinned-image");
                Ok((source.clone(), "image/png".into(), original.len() as u64))
            })
            .unwrap();
            assert!(path
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("狂澜之上_全部设定_设定素材包_"));
            for entry in &export.texts {
                assert_eq!(
                    fs::read_to_string(path.join(&entry.path)).unwrap(),
                    entry.content
                );
            }
            assert_eq!(
                fs::read(path.join(&export.images[0].path)).unwrap(),
                original
            );
        }
        assert_eq!(fs::read_dir(destination).unwrap().count(), 2);
    }

    #[test]
    fn rejects_unsafe_case_colliding_duplicate_and_incomplete_paths_before_creating_export() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("exports");
        for path in [
            "../prompt.txt",
            "/tmp/prompt.txt",
            "人物/../基础/设定.md",
            "人物/角色/../设定.md",
            "人物/角色/状态/extra/设定.md",
            "人物/角色\\外部/状态/设定.md",
            "人物/角色/状态/other.md",
            "人物/.hidden/状态/设定.md",
            "人物/角色./状态/设定.md",
            "人物/角色/ 状态/设定.md",
            "人物/CON/状态/设定.md",
            "人物/角色/LPT1.txt/设定.md",
            "其他/角色/状态/设定.md",
        ] {
            let mut export = bundle();
            export.texts[2].path = path.into();
            assert!(
                write_folder(&export, &destination, |_| panic!(
                    "invalid paths must not resolve files"
                ))
                .is_err(),
                "{path}"
            );
        }
        let mut export = bundle();
        export.texts.push(TextEntry {
            path: export.texts[2].path.clone(),
            content: "duplicate".into(),
        });
        assert!(validate(&export).is_err());
        let mut export = bundle();
        export.images.push(ImageEntry {
            path: format!("{STATE}/参考图.jpg"),
            version_id: "other".into(),
        });
        assert!(validate(&export).is_err());
        let mut export = bundle();
        export.texts[2].path = "人物/A/状态/设定.md".into();
        export.texts[3].path = "人物/A/状态/prompt.txt".into();
        export.texts.push(TextEntry {
            path: "人物/a/状态/设定.md".into(),
            content: "collision".into(),
        });
        assert!(validate(&export).is_err());
        assert!(!destination.exists());
        assert!(!valid_component(&"角".repeat(41)));
    }

    #[test]
    fn missing_foreign_truncated_and_corrupt_images_leave_no_partial_packages() {
        let root = tempfile::tempdir().unwrap();
        let (source, original) = image(root.path());
        let destination = root.path().join("exports");
        fs::create_dir(&destination).unwrap();
        let export = bundle();
        for failure in 0..6 {
            let result = write_folder(&export, &destination, |_| match failure {
                0 => Err("引用版本不存在于该项目".into()),
                1 => Ok((
                    root.path().join("missing.png"),
                    "image/png".into(),
                    original.len() as u64,
                )),
                2 => Ok((
                    source.clone(),
                    "image/png".into(),
                    original.len() as u64 + 1,
                )),
                3 => {
                    let path = root.path().join("corrupt.png");
                    fs::write(&path, &original[..original.len() / 2]).unwrap();
                    Ok((path, "image/png".into(), (original.len() / 2) as u64))
                }
                4 => {
                    let path = root.path().join("fake.png");
                    fs::write(&path, b"not an image").unwrap();
                    Ok((path, "image/png".into(), 12))
                }
                _ => Ok((source.clone(), "image/jpeg".into(), original.len() as u64)),
            });
            assert!(result.is_err(), "failure {failure}");
            assert_eq!(
                fs::read_dir(&destination).unwrap().count(),
                0,
                "failure {failure} left staging residue"
            );
            assert_eq!(fs::read(&source).unwrap(), original);
        }
        #[cfg(unix)]
        {
            let link = root.path().join("link.png");
            std::os::unix::fs::symlink(&source, &link).unwrap();
            assert!(write_folder(&export, &destination, |_| Ok((
                link.clone(),
                "image/png".into(),
                original.len() as u64
            )))
            .is_err());
            assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
        }
    }

    #[test]
    fn unillustrated_states_export_settings_and_protocol_rejects_caller_file_paths() {
        let root = tempfile::tempdir().unwrap();
        let mut export = bundle();
        export.images.clear();
        let path = write_folder(&export, root.path(), |_| panic!("no image to resolve")).unwrap();
        assert!(path.join(format!("{STATE}/prompt.txt")).is_file());
        assert!(!path.join(format!("{STATE}/参考图.png")).exists());
        assert!(serde_json::from_value::<Export>(serde_json::json!({
            "projectName":"项目", "scopeName":"全部", "texts":[],
            "images":[{"path":"关键物品/木筏/默认/参考图.png", "versionId":"image", "filePath":"/private/file"}]
        })).is_err());
    }

    #[test]
    fn supports_all_setting_categories_and_image_formats_but_rejects_disguised_files() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("exports");
        for (format, extension, mime) in [
            (image::ImageFormat::Png, "png", "image/png"),
            (image::ImageFormat::Jpeg, "jpg", "image/jpeg"),
            (image::ImageFormat::WebP, "webp", "image/webp"),
            (image::ImageFormat::Gif, "gif", "image/gif"),
        ] {
            let source = root.path().join(format!("source.{extension}"));
            image::DynamicImage::new_rgb8(3, 5)
                .save_with_format(&source, format)
                .unwrap();
            let original = fs::read(&source).unwrap();
            let mut export = bundle();
            export.images[0].path = format!("{STATE}/参考图.{extension}");
            for category in ["人物", "场景"] {
                for file in ["设定.md", "prompt.txt"] {
                    export.texts.push(TextEntry {
                        path: format!("{category}/001_设定/001_默认/{file}"),
                        content: category.into(),
                    });
                }
            }
            let path = write_folder(&export, &destination, |_| {
                Ok((source.clone(), mime.into(), original.len() as u64))
            })
            .unwrap();
            assert_eq!(
                fs::read(path.join(&export.images[0].path)).unwrap(),
                original
            );
        }
        let (source, original) = image(root.path());
        let mut export = bundle();
        export.images[0].path = format!("{STATE}/参考图.jpg");
        assert!(write_folder(&export, &destination, |_| {
            Ok((source.clone(), "image/jpeg".into(), original.len() as u64))
        })
        .is_err());
        assert_eq!(fs::read_dir(destination).unwrap().count(), 4);
    }
}
