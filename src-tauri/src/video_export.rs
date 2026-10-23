//! Portable handoff folder; all media resolves through project-owned version IDs.
use crate::{media, media_integrity::{copy_checked, sync_directory}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SelectedShot {
    id: String,
    title: String,
    source_document_id: String,
    source_title: String,
    video_version_id: String,
    dialogue: String,
    duration: f64,
}

fn validate_selected(project_name: &str, shots: &[SelectedShot]) -> Result<(), String> {
    if project_name.trim().is_empty() || project_name.chars().count() > 100 || shots.is_empty() || shots.len() > 120 {
        return Err("请选择项目及 1–120 个已有选用视频的镜头".into());
    }
    let mut ids = HashSet::new();
    for shot in shots {
        media::valid_id(&shot.id)?;
        media::valid_id(&shot.video_version_id)?;
        if !ids.insert(&shot.id) || shot.title.chars().count() > 200 || shot.source_title.chars().count() > 1000
            || shot.source_document_id.len() > 200 || shot.dialogue.chars().count() > 12000
            || !shot.duration.is_finite() || !(1.0..=60.0).contains(&shot.duration) {
            return Err("导出镜头重复或字段超出范围".into());
        }
    }
    Ok(())
}

fn validate_selected_snapshot(library: &Value, project_id: &str, project_name: &str, shots: &[SelectedShot]) -> Result<(), String> {
    validate_selected(project_name, shots)?;
    let project = library["projects"].as_array().and_then(|projects| projects.iter().find(|project| project["id"] == project_id)).ok_or("导出项目不存在或已归档")?;
    let workspace = &project["workspace"];
    if workspace["project"]["name"] != project_name { return Err("项目名称已有修改，请保存后重试导出".into()); }
    let saved = workspace["storyboard"]["shots"].as_array().ok_or("项目没有分镜")?;
    for requested in shots {
        let shot = saved.iter().find(|shot| shot["id"] == requested.id).ok_or("导出镜头已不存在，请重新选择")?;
        if shot["selectedVideoVersionId"] != requested.video_version_id || shot["title"] != requested.title
            || shot["sourceDocumentId"] != requested.source_document_id || shot["dialogue"] != requested.dialogue
            || shot["duration"].as_f64() != Some(requested.duration)
            || workspace["documents"][&requested.source_document_id]["title"].as_str().unwrap_or("") != requested.source_title {
            return Err("镜头或选用视频已有修改，请保存后重新导出".into());
        }
    }
    Ok(())
}

fn write_selected_folder(
    project_id: &str,
    project_name: &str,
    shots: &[SelectedShot],
    destination: &Path,
    resolve: impl Fn(&str) -> Result<(PathBuf, String, u64), String>,
    inspect: impl Fn(&Path) -> Result<f64, String>,
) -> Result<PathBuf, String> {
    validate_selected(project_name, shots)?;
    let mut sources = vec![];
    let mut total = 0u64;
    // Resolve ownership and total size before copying any bytes.
    for shot in shots {
        let (path, mime, bytes) = resolve(&shot.video_version_id)?;
        let extension = match mime.as_str() { "video/mp4" => "mp4", "video/webm" => "webm", _ => return Err("选用版本不是支持的视频".into()) };
        if bytes == 0 || bytes > media::MAX_MEDIA_BYTES { return Err("选用视频大小无效".into()); }
        total = total.checked_add(bytes).ok_or("视频包容量溢出")?;
        if total > 8 * 1024 * 1024 * 1024 { return Err("视频包超过 8 GiB，请按分场分批导出；尚未复制视频".into()); }
        sources.push((path, mime, bytes, extension));
    }
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    let staging = tempfile::Builder::new().prefix(".selected-videos-").tempdir_in(destination).map_err(|e| e.to_string())?;
    let mut entries = vec![];
    let mut list = format!("项目：{project_name}\n按下列顺序导入剪辑工具。文件保持原始字节，未拼接、转码或生成。\n\n");
    for (index, (shot, (source, mime, bytes, extension))) in shots.iter().zip(sources).enumerate() {
        let filename = format!("shot-{:03}.{extension}", index + 1);
        let path = staging.path().join(&filename);
        let mut output = File::create(&path).map_err(|e| e.to_string())?;
        let crc32 = copy_checked(&mut File::open(source).map_err(|e| e.to_string())?, &mut output, bytes)?;
        output.sync_all().map_err(|e| e.to_string())?;
        let (kind, actual_mime, _) = media::detect_format(&path)?;
        if kind != "video" || actual_mime != mime { return Err("选用文件的实际格式与登记不符，未导出视频包".into()); }
        let actual_duration = inspect(&path)?;
        if !actual_duration.is_finite() || actual_duration <= 0.0 { return Err("选用视频无法核验实际时长".into()); }
        entries.push(json!({"number":index+1,"id":shot.id,"title":shot.title,"sourceDocumentId":shot.source_document_id,"sourceTitle":shot.source_title,"videoVersionId":shot.video_version_id,"file":filename,"dialogue":shot.dialogue,"duration":shot.duration,"actualDuration":actual_duration,"mimeType":mime,"bytes":bytes,"crc32":crc32}));
        list.push_str(&format!("{:03} · {}\n分场：{}\n文件：{}\n剧情时长：{} 秒；视频实际时长：{:.3} 秒\n对白：\n{}\n\n", index+1, shot.title, if shot.source_title.is_empty() { "未归属" } else { &shot.source_title }, filename, shot.duration, actual_duration, shot.dialogue));
    }
    let manifest = json!({"format":"ai-creator-workbench-selected-videos","version":1,"projectId":project_id,"projectName":project_name,"shots":entries});
    for (name, content) in [("manifest.json", serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?), ("镜头清单.txt", list.into_bytes())] {
        let mut file = File::create(staging.path().join(name)).map_err(|e| e.to_string())?;
        file.write_all(&content).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
    }
    sync_directory(staging.path())?;
    // Atomically reserve a unique directory; never rename over a prior export.
    let path = destination.join(format!("选用视频-{}", media::new_id()));
    fs::create_dir(&path).map_err(|e| e.to_string())?;
    if let Err(error) = fs::rename(staging.path(), &path) { let _ = fs::remove_dir(&path); return Err(error.to_string()); }
    if let Err(error) = sync_directory(destination) {
        let _ = fs::remove_dir_all(&path);
        return Err(format!("视频包目录同步失败，未交付导出结果：{error}"));
    }
    Ok(path)
}

#[tauri::command]
pub(crate) async fn media_export_selected_videos(app: tauri::AppHandle, project_id: String, project_name: String, shots: Vec<SelectedShot>) -> Result<String, String> {
    media::valid_id(&project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let library: Value = serde_json::from_str(&crate::storage::library_read(app.clone())?.ok_or("项目库不存在")?).map_err(|_| "项目库格式无效")?;
        validate_selected_snapshot(&library, &project_id, &project_name, &shots)?;
        let directory = app.path().download_dir().map_err(|e| e.to_string())?;
        let path = write_selected_folder(&project_id, &project_name, &shots, &directory, |id| {
            let (version, path) = media::version_file(&app, &project_id, id)?;
            Ok((path, version.mime_type, version.bytes))
        }, |path| {
            let metadata = tauri::async_runtime::block_on(media::inspect(path, "video"))?;
            metadata["duration"].as_f64().ok_or_else(|| "视频实际时长无效".into())
        })?;
        Ok(format!("选用视频包已导出到：{}", path.display()))
    }).await.map_err(|e| e.to_string())?
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
    fn selected(id: &str) -> SelectedShot {
        SelectedShot { id: id.into(), title: "镜头/../标题".into(), source_document_id: "scene".into(), source_title: "第一场".into(), video_version_id: format!("video-{id}"), dialogue: "第一句\n第二句".into(), duration: 5.0 }
    }
    #[test]
    fn selected_videos_keep_requested_order_bytes_and_cleanup_failed_package() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("video.mp4");
        let original = b"\0\0\0\x10ftypisom-test";
        fs::write(&source, original).unwrap();
        let destination = root.path().join("downloads");
        let shots = [selected("second"), selected("first")];
        let result = write_selected_folder("project", "剧本", &shots, &destination, |_| Ok((source.clone(), "video/mp4".into(), original.len() as u64)), |_| Ok(6.25)).unwrap();
        assert_eq!(fs::read(result.join("shot-001.mp4")).unwrap(), original);
        let manifest: Value = serde_json::from_slice(&fs::read(result.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["shots"][0]["id"], "second");
        assert_eq!(manifest["shots"][1]["id"], "first");
        assert_eq!(manifest["shots"][0]["duration"], 5.0);
        assert_eq!(manifest["shots"][0]["actualDuration"], 6.25);
        assert_eq!(manifest["shots"][0]["dialogue"], "第一句\n第二句");
        assert!(fs::read_to_string(result.join("镜头清单.txt")).unwrap().contains("视频实际时长：6.250 秒"));
        for fail_probe in [false, true] {
            assert!(write_selected_folder("project", "剧本", &shots, &destination, |_| if fail_probe { Ok((source.clone(), "video/mp4".into(), original.len() as u64)) } else { Err("视频不属于项目".into()) }, |_| Err("无法解码".into())).is_err());
            assert_eq!(fs::read_dir(&destination).unwrap().count(), 1, "failed export removes staging and never touches previous package");
        }
        assert!(write_selected_folder("project", "剧本", &[selected("same"), selected("same")], &destination, |_| unreachable!(), |_| unreachable!()).is_err());
    }

    #[test]
    fn selected_videos_require_current_project_selection_and_real_file_format() {
        let shot = selected("one");
        let library = json!({"projects":[{"id":"p","workspace":{"project":{"name":"剧本"},"documents":{"scene":{"title":"第一场"}},"storyboard":{"shots":[{"id":"one","title":shot.title,"sourceDocumentId":"scene","selectedVideoVersionId":"video-one","dialogue":shot.dialogue,"duration":5}]}}}]});
        assert!(validate_selected_snapshot(&library, "p", "剧本", &[shot.clone()]).is_ok());
        assert!(validate_selected_snapshot(&library, "other", "剧本", &[shot.clone()]).is_err());
        let mut unassigned = shot.clone(); unassigned.source_document_id.clear(); unassigned.source_title.clear();
        let mut unassigned_library = library.clone(); unassigned_library["projects"][0]["workspace"]["storyboard"]["shots"][0]["sourceDocumentId"] = json!("");
        assert!(validate_selected_snapshot(&unassigned_library, "p", "剧本", &[unassigned]).is_ok());
        let mut stale = shot.clone(); stale.video_version_id = "other-video".into();
        assert!(validate_selected_snapshot(&library, "p", "剧本", &[stale]).is_err());
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("pretend.mp4"); fs::write(&source, b"not a video").unwrap();
        let destination = root.path().join("downloads");
        assert!(write_selected_folder("p", "剧本", &[shot], &destination, |_| Ok((source.clone(), "video/mp4".into(), 11)), |_| unreachable!()).is_err());
        assert_eq!(fs::read_dir(destination).unwrap().count(), 0);
    }

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
