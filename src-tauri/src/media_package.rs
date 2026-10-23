//! Versioned, bounded local project container. CRC32 detects accidental corruption, not forgery.
use crate::{
    media::{self, Asset},
    media_integrity::{checksum_file, copy_checked, crc_update, sync_directory},
    media_jobs::Job,
    storage,
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::Path,
};
use tauri::Manager;

const MAGIC: &[u8; 8] = b"ACWMPK1\n";
const MAX_MANIFEST: u64 = 64 * 1024 * 1024;
const MAX_PACKAGE: u64 = 8 * 1024 * 1024 * 1024;
const MAX_FILES: usize = 2000;

fn relative_file(entry: &Entry) -> Result<String, String> {
    media::valid_id(&entry.file_id)?;
    let extension = match entry.mime_type.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        _ => return Err("项目包 MIME 类型无效".into()),
    };
    Ok(format!("{}.{}", entry.file_id, extension))
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    file_id: String,
    version_id: String,
    mime_type: String,
    bytes: u64,
    crc32: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format: String,
    version: u32,
    checksum_algorithm: String,
    workspace: Value,
    index: Value,
    assets: Vec<Asset>,
    jobs: Vec<Job>,
    files: Vec<Entry>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pending {
    import_id: String,
    project_id: String,
    workspace: Value,
    index: Value,
    assets: Vec<Asset>,
    jobs: Vec<Job>,
    files: Vec<Entry>,
    created_at: String,
    #[serde(default)]
    stage_directory: Option<String>,
    #[serde(default)]
    source_files: HashMap<String, String>,
}

fn sanitize(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.retain(|key, _| {
                ![
                    "apiKey",
                    "api_key",
                    "accessToken",
                    "refreshToken",
                    "password",
                    "secret",
                    "credential",
                    "credentials",
                    "authorization",
                    "cookie",
                    "connections",
                    "semantic",
                ]
                .iter()
                .any(|forbidden| key.eq_ignore_ascii_case(forbidden))
            });
            for (key, value) in object.iter_mut() {
                if ["path", "absolutePath", "rootPath", "directory"].contains(&key.as_str())
                    && value.as_str().is_some_and(|value| {
                        Path::new(value).is_absolute() || value.as_bytes().get(1) == Some(&b':')
                    })
                {
                    *value = json!("[本机路径未随包导出]");
                } else {
                    sanitize(value);
                }
            }
        }
        Value::Array(array) => {
            for value in array {
                sanitize(value);
            }
        }
        _ => {}
    }
}

fn portable_workflow(workspace: &mut Value) -> Result<(), String> {
    let Some(workflow) = workspace.get_mut("workflow") else {
        return Ok(());
    };
    let source = workflow.as_object().ok_or("项目流程配置无效")?;
    let mut portable = serde_json::Map::new();
    if let Some(preset) = source.get("preset") {
        if !preset
            .as_str()
            .is_some_and(|value| ["text", "script", "storyboard"].contains(&value))
        {
            return Err("项目流程预设无效".into());
        }
        portable.insert("preset".into(), preset.clone());
    }
    for key in [
        "textConnectionId",
        "storyboardConnectionId",
        "imageConnectionId",
        "videoConnectionId",
    ] {
        if let Some(value) = source.get(key) {
            let id = value.as_str().ok_or("项目执行端标识无效")?;
            if !id.is_empty() {
                media::valid_id(id)?;
            }
            portable.insert(key.into(), value.clone());
        }
    }
    *workflow = Value::Object(portable);
    Ok(())
}

fn initialize(app: &tauri::AppHandle) -> Result<rusqlite::Connection, String> {
    let db = media::database(app)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS media_imports(id TEXT PRIMARY KEY,project_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,created_at TEXT NOT NULL);").map_err(|e| e.to_string())?;
    crate::project_deletion::initialize(&db)?;
    Ok(db)
}

fn validate_manifest(manifest: &Manifest) -> Result<(), String> {
    if manifest.format != "ai-creator-workbench-media"
        || manifest.version != 1
        || manifest.checksum_algorithm != "crc32"
    {
        return Err("项目包格式或版本不受支持".into());
    }
    if manifest.files.len() > MAX_FILES
        || manifest.assets.len() > MAX_FILES
        || manifest.jobs.len() > 10000
    {
        return Err("项目包对象数量超出安全边界".into());
    }
    let mut ids = HashSet::new();
    let mut versions = HashSet::new();
    let mut all_ids = HashSet::new();
    let mut total = 20u64;
    for entry in &manifest.files {
        media::valid_id(&entry.file_id)?;
        media::valid_id(&entry.version_id)?;
        if !ids.insert(&entry.file_id)
            || !versions.insert(&entry.version_id)
            || !all_ids.insert(entry.file_id.as_str())
            || !all_ids.insert(entry.version_id.as_str())
            || entry.bytes == 0
            || entry.bytes > media::MAX_MEDIA_BYTES
            || ![
                "image/png",
                "image/jpeg",
                "image/webp",
                "image/gif",
                "video/mp4",
                "video/webm",
            ]
            .contains(&entry.mime_type.as_str())
        {
            return Err("项目包文件清单无效或重复".into());
        }
        total = total.checked_add(entry.bytes).ok_or("项目包长度溢出")?;
    }
    if total > MAX_PACKAGE {
        return Err("项目包超过 8 GiB 边界".into());
    }
    let mut asset_ids = HashSet::new();
    let mut asset_versions = HashSet::new();
    for asset in &manifest.assets {
        media::valid_id(&asset.id)?;
        if !asset_ids.insert(&asset.id)
            || !all_ids.insert(asset.id.as_str())
            || !["character", "scene", "prop", "style", "shot", "other"]
                .contains(&asset.role.as_str())
            || !["image", "video"].contains(&asset.kind.as_str())
            || asset.versions.is_empty()
            || asset.versions.len() > MAX_FILES
            || asset.name.len() > 1000
        {
            return Err("项目包资产结构无效".into());
        }
        if !asset
            .versions
            .iter()
            .any(|version| version.id == asset.selected_version_id)
        {
            return Err("资产选用版本缺失".into());
        }
        for version in &asset.versions {
            let entry = manifest
                .files
                .iter()
                .find(|entry| entry.version_id == version.id && entry.file_id == version.file_id)
                .ok_or("资产版本缺少对应实际文件")?;
            if !asset_versions.insert(&version.id)
                || !version.metadata.is_object()
                || version.mime_type != entry.mime_type
                || version.bytes != entry.bytes
                || !version.mime_type.starts_with(&format!("{}/", asset.kind))
            {
                return Err("版本与文件清单不一致".into());
            }
            if let Some(references) = version
                .metadata
                .get("provenance")
                .and_then(|value| value.get("references"))
            {
                for reference in references.as_array().ok_or("素材来源引用结构无效")? {
                    let id = reference["versionId"]
                        .as_str()
                        .ok_or("素材来源引用版本无效")?;
                    if !versions.contains(&id.to_string()) {
                        return Err("素材来源引用缺少实际媒体文件".into());
                    }
                }
            }
        }
    }
    if asset_versions.len() != manifest.files.len() {
        return Err("包中存在未归属版本的文件".into());
    }
    if !manifest.workspace["documents"].is_object()
        || !manifest.workspace["project"]["name"]
            .as_str()
            .is_some_and(|name| !name.trim().is_empty())
    {
        return Err("项目工作区格式无效".into());
    }
    let mut all_shot_ids = HashSet::new();
    for shots in storyboard_shot_groups(&manifest.workspace)? {
        if shots.len() > 120 {
            return Err("分镜数量超限".into());
        }
        let mut shot_ids = HashSet::new();
        for shot in shots {
            let id = shot["id"].as_str().ok_or("镜头标识无效")?;
            media::valid_id(id)?;
            if !shot_ids.insert(id) {
                return Err("镜头标识重复".into());
            }
            if all_shot_ids.insert(id) && !all_ids.insert(id) {
                return Err("项目包不同对象共用了标识，拒绝模糊重映射".into());
            }
            for key in [
                "selectedImageVersionId",
                "selectedVideoVersionId",
                "reviewedVideoVersionId",
            ] {
                if let Some(id) = shot[key].as_str().filter(|id| !id.is_empty()) {
                    if !versions.contains(&id.to_string()) {
                        return Err("选用／审核媒体缺失，不能伪装成完整备份".into());
                    }
                }
            }
            if let Some(references) = shot["references"].as_array() {
                for reference in references {
                    let id = reference["versionId"].as_str().ok_or("参考版本无效")?;
                    if !versions.contains(&id.to_string()) {
                        return Err("分镜参考缺少实际媒体文件".into());
                    }
                }
            }
        }
    }
    for job in &manifest.jobs {
        media::valid_id(&job.id)?;
        if let Some(batch_id) = &job.batch_id {
            media::valid_id(batch_id)?;
        }
        if job.batch_id.is_some() != job.batch_index.is_some()
            || job
                .batch_index
                .is_some_and(|index| index >= crate::media_jobs::MAX_BATCH_JOBS)
        {
            return Err("历史批量任务的计划顺序无效".into());
        }
        if !all_ids.insert(job.id.as_str())
            || !["image", "video"].contains(&job.capability.as_str())
        {
            return Err("历史任务标识重复或能力无效".into());
        }
        if job
            .asset_id
            .as_ref()
            .is_some_and(|id| !asset_ids.contains(id))
        {
            return Err("历史任务引用了不存在的资产".into());
        }
        for reference in &job.request.references {
            if !versions.contains(&reference.version_id) {
                return Err("历史任务的输入版本缺少实际文件".into());
            }
        }
    }
    Ok(())
}

fn storyboard_shot_groups(workspace: &Value) -> Result<Vec<&Vec<Value>>, String> {
    let mut groups = vec![];
    if let Some(shots) = workspace["storyboard"]["shots"].as_array() { groups.push(shots); }
    if let Some(history) = workspace["storyboard"].get("sourceVersions") {
        let history = history.as_array().ok_or("分镜历史格式无效")?;
        if history.len() > 10 { return Err("分镜历史数量超限".into()); }
        for entry in history { groups.push(entry["shots"].as_array().ok_or("分镜历史缺少镜头")?); }
    }
    Ok(groups)
}

fn remap_storyboard(workspace: &mut Value, mapping: &mut HashMap<String, String>) -> Result<(), String> {
    for shots in storyboard_shot_groups(workspace)? {
        for shot in shots {
            mapping.entry(shot["id"].as_str().ok_or("镜头标识缺失")?.into()).or_insert_with(media::new_id);
        }
    }
    let remap = |shots: &mut Vec<Value>| -> Result<(), String> {
        for shot in shots {
            for key in ["id", "selectedImageVersionId", "selectedVideoVersionId", "reviewedVideoVersionId"] {
                if let Some(id) = shot[key].as_str().filter(|id| !id.is_empty()) {
                    shot[key] = json!(mapping.get(id).ok_or("镜头引用无法重映射")?);
                }
            }
            if let Some(references) = shot["references"].as_array_mut() {
                for reference in references {
                    let id = reference["versionId"].as_str().ok_or("参考标识缺失")?;
                    reference["versionId"] = json!(mapping.get(id).ok_or("参考媒体缺失")?);
                }
            }
            if let Some(shot) = shot.as_object_mut() { shot.remove("reviewedInputFingerprint"); }
        }
        Ok(())
    };
    if let Some(shots) = workspace.get_mut("storyboard").and_then(|value| value.get_mut("shots")).and_then(Value::as_array_mut) { remap(shots)?; }
    if let Some(history) = workspace.get_mut("storyboard").and_then(|value| value.get_mut("sourceVersions")).and_then(Value::as_array_mut) {
        for entry in history {
            entry["id"] = json!(media::new_id());
            remap(entry["shots"].as_array_mut().ok_or("分镜历史格式无效")?)?;
        }
    }
    // Document keys are kept verbatim by project import; sourceDocumentId points
    // to those project-local keys and must remain the same in current/history shots.
    Ok(())
}

#[tauri::command]
pub(crate) async fn media_export_package(
    app: tauri::AppHandle,
    project_id: String,
    workspace: Value,
    index: Value,
) -> Result<String, String> {
    media::valid_id(&project_id)?;
    tauri::async_runtime::spawn_blocking(move || export(&app, &project_id, workspace, index))
        .await
        .map_err(|_| "完整包导出任务中断".to_string())?
}

fn export(
    app: &tauri::AppHandle,
    project_id: &str,
    mut workspace: Value,
    mut index: Value,
) -> Result<String, String> {
    sanitize(&mut workspace);
    sanitize(&mut index);
    portable_workflow(&mut workspace)?;
    let db = initialize(app)?;
    let mut assets = media::list_assets(&db, project_id)?;
    let mut statement = db
        .prepare("SELECT payload FROM media_jobs WHERE project_id=?1 ORDER BY id")
        .map_err(|e| e.to_string())?;
    let mut jobs = statement
        .query_map([project_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|row| {
            serde_json::from_str::<Job>(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    for job in &mut jobs {
        job.request.api_key = None;
        job.request.connection.base_url.clear();
        job.request.allow_user_profile = false;
        job.remote_id = None;
        job.error = job
            .error
            .as_ref()
            .map(|_| "历史任务未完成或曾中断；错误详情保留在原项目，不随包导出本机路径".into());
    }
    let mut entries = vec![];
    for asset in &mut assets {
        for version in &mut asset.versions {
            if entries.len() >= MAX_FILES {
                return Err("完整包最多 2000 个媒体版本".into());
            }
            sanitize(&mut version.metadata);
            if let Some(provenance) = version
                .metadata
                .get_mut("provenance")
                .and_then(Value::as_object_mut)
            {
                provenance.remove("remoteId");
            }
            entries.push(Entry {
                file_id: version.file_id.clone(),
                version_id: version.id.clone(),
                mime_type: version.mime_type.clone(),
                bytes: version.bytes,
                // Reserve the longest JSON checksum before doing any file I/O.
                crc32: u32::MAX,
            });
        }
    }
    let mut manifest = Manifest {
        format: "ai-creator-workbench-media".into(),
        version: 1,
        checksum_algorithm: "crc32".into(),
        workspace,
        index,
        assets,
        jobs,
        files: entries,
    };
    preflight_export(&manifest)?;
    let stage = tempfile::tempdir_in(media::media_root(app)?.join("incoming"))
        .map_err(|e| e.to_string())?;
    for entry in &mut manifest.files {
        let (path, mime, bytes) = media::stored_file(app, Some(project_id), &entry.file_id)?;
        if mime != entry.mime_type || bytes != entry.bytes {
            return Err("媒体登记在导出准备后发生变化，请重新导出".into());
        }
        let mut output = File::create(stage.path().join(&entry.file_id)).map_err(|e| e.to_string())?;
        entry.crc32 = copy_checked(&mut File::open(path).map_err(|e| e.to_string())?, &mut output, bytes)?;
        output.sync_all().map_err(|e| e.to_string())?;
    }
    let metadata = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
    let downloads = app.path().download_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(&downloads).map_err(|e| e.to_string())?;
    file.write_all(MAGIC)
        .and_then(|_| file.write_all(&(metadata.len() as u64).to_le_bytes()))
        .and_then(|_| file.write_all(&(!crc_update(u32::MAX, &metadata)).to_le_bytes()))
        .and_then(|_| file.write_all(&metadata))
        .map_err(|e| e.to_string())?;
    for entry in &manifest.files {
        let crc = copy_checked(
            &mut File::open(stage.path().join(&entry.file_id)).map_err(|e| e.to_string())?,
            &mut file,
            entry.bytes,
        )?;
        if crc != entry.crc32 {
            return Err("导出期间文件发生变化，未交付不完整项目包".into());
        }
    }
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    let path = downloads.join(format!("创作项目-{}.acwpack", media::new_id()));
    file.persist_noclobber(&path)
        .map_err(|e| e.error.to_string())?;
    sync_directory(&downloads)
        .map_err(|_| "项目包已写入但导出目录同步失败，请核验文件后重试".to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

// This runs before a staging directory or any media copy is created.
fn preflight_export(manifest: &Manifest) -> Result<(), String> {
    validate_manifest(manifest)?;
    let metadata = serde_json::to_vec(manifest).map_err(|e| e.to_string())?;
    let total = manifest.files.iter().try_fold(20u64 + metadata.len() as u64, |sum, entry| {
        sum.checked_add(entry.bytes).ok_or("完整包长度溢出")
    })?;
    if metadata.len() as u64 > MAX_MANIFEST || total > MAX_PACKAGE {
        return Err("完整项目包超过 64 MiB 元数据或 8 GiB 总容量限制；尚未复制媒体文件".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn media_import_package(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<Option<Value>, String> {
    media::valid_id(&project_id)?;
    let Some(path) = media::choose_files(
        &app,
        "选择完整创作项目包（.acwpack）；将恢复为独立项目",
        false,
    )
    .await?
    .into_iter()
    .next() else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || stage_import(&app, &project_id, &path).map(Some))
        .await
        .map_err(|_| "项目包读取中断，原项目未修改".to_string())?
}

fn stage_import(app: &tauri::AppHandle, project_id: &str, path: &Path) -> Result<Value, String> {
    let db = initialize(app)?;
    crate::project_deletion::ensure_live(&db, project_id)?;
    for payload in [
        storage::library_read(app.clone())?,
        storage::library_read_archives(app.clone())?,
    ]
    .into_iter()
    .flatten()
    {
        let library: Value =
            serde_json::from_str(&payload).map_err(|_| "原项目库格式异常，请先恢复原数据")?;
        let projects = library
            .as_array()
            .or_else(|| library["projects"].as_array());
        if projects
            .is_some_and(|projects| projects.iter().any(|project| project["id"] == project_id))
        {
            return Err("目标项目标识已存在，不覆盖原项目".into());
        }
    }
    let occupied:i64=db.query_row("SELECT (SELECT count(*) FROM media_assets WHERE project_id=?1)+(SELECT count(*) FROM media_imports WHERE project_id=?1)",[project_id],|row| row.get(0)).map_err(|e| e.to_string())?;
    if occupied > 0 {
        return Err("目标媒体项目标识已存在".into());
    }
    let mut input = File::open(path).map_err(|e| e.to_string())?;
    let size = input.metadata().map_err(|e| e.to_string())?.len();
    if !(20..=MAX_PACKAGE).contains(&size) {
        return Err("项目包长度超限或不完整".into());
    }
    let mut magic = [0u8; 8];
    let mut length = [0u8; 8];
    let mut checksum = [0u8; 4];
    input
        .read_exact(&mut magic)
        .and_then(|_| input.read_exact(&mut length))
        .and_then(|_| input.read_exact(&mut checksum))
        .map_err(|_| "项目包头不完整")?;
    let length = u64::from_le_bytes(length);
    if &magic != MAGIC || length > MAX_MANIFEST || length > size - 20 {
        return Err("项目包头无效或版本不受支持".into());
    }
    let mut bytes = vec![0u8; length as usize];
    input
        .read_exact(&mut bytes)
        .map_err(|_| "项目包元数据不完整")?;
    if !crc_update(u32::MAX, &bytes) != u32::from_le_bytes(checksum) {
        return Err("项目包元数据校验失败，未修改原项目".into());
    }
    let mut manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|_| "项目包元数据无效或含未知结构")?;
    validate_manifest(&manifest)?;
    let expected = manifest
        .files
        .iter()
        .try_fold(20u64 + length, |sum, entry| {
            sum.checked_add(entry.bytes).ok_or("项目包长度溢出")
        })?;
    if size != expected {
        return Err("项目包长度与清单不符，可能缺失或被追加内容".into());
    }
    let root = media::media_root(app)?;
    let stage = tempfile::tempdir_in(root.join("incoming")).map_err(|e| e.to_string())?;
    // Verify every byte before registering any asset. Entry names are IDs, never archive paths.
    for entry in &manifest.files {
        let mut file =
            File::create(stage.path().join(&entry.file_id)).map_err(|e| e.to_string())?;
        if copy_checked(&mut input, &mut file, entry.bytes)? != entry.crc32 {
            return Err("媒体文件校验失败，原项目与源项目包保持不变".into());
        }
        file.sync_all().map_err(|e| e.to_string())?;
        let (kind, mime, _) = media::detect_format(&stage.path().join(&entry.file_id))?;
        if mime != entry.mime_type {
            return Err("文件真实类型与项目包声明不符".into());
        }
        let verified = tauri::async_runtime::block_on(media::inspect(
            &stage.path().join(&entry.file_id),
            kind,
        ))?;
        for asset in &mut manifest.assets {
            if let Some(version) = asset
                .versions
                .iter_mut()
                .find(|version| version.id == entry.version_id)
            {
                version.metadata["width"] = verified["width"].clone();
                version.metadata["height"] = verified["height"].clone();
                version.metadata["duration"] = verified["duration"].clone();
            }
        }
    }
    // Persist directory entries before a durable journal can refer to the verified sources.
    sync_directory(stage.path())
        .map_err(|_| "项目包暂存目录同步失败，原项目保持不变".to_string())?;
    sync_directory(&root.join("incoming"))
        .map_err(|_| "项目包暂存父目录同步失败，原项目保持不变".to_string())?;
    sanitize(&mut manifest.workspace);
    sanitize(&mut manifest.index);
    portable_workflow(&mut manifest.workspace)?;
    let mut mapping = HashMap::<String, String>::new();
    for entry in &manifest.files {
        mapping.insert(entry.file_id.clone(), media::new_id());
        mapping.insert(entry.version_id.clone(), media::new_id());
    }
    for asset in &manifest.assets {
        mapping.insert(asset.id.clone(), media::new_id());
    }
    for job in &manifest.jobs {
        media::valid_id(&job.id)?;
        mapping.insert(job.id.clone(), media::new_id());
    }
    remap_storyboard(&mut manifest.workspace, &mut mapping)?;
    for asset in &mut manifest.assets {
        asset.id = mapping[&asset.id].clone();
        asset.project_id = project_id.into();
        asset.selected_version_id = mapping[&asset.selected_version_id].clone();
        for version in &mut asset.versions {
            version.id = mapping[&version.id].clone();
            version.file_id = mapping[&version.file_id].clone();
            sanitize(&mut version.metadata);
            if let Some(provenance) = version
                .metadata
                .get_mut("provenance")
                .and_then(Value::as_object_mut)
            {
                provenance.remove("remoteId");
                if let Some(id) = provenance.get("jobId").and_then(Value::as_str) {
                    let id = mapping.get(id).cloned().unwrap_or_default();
                    provenance.insert("jobId".into(), json!(id));
                }
                if let Some(references) = provenance
                    .get_mut("references")
                    .and_then(Value::as_array_mut)
                {
                    for reference in references {
                        let id = reference["versionId"]
                            .as_str()
                            .ok_or("素材来源引用版本缺失")?;
                        reference["versionId"] =
                            json!(mapping.get(id).ok_or("素材来源引用无法重映射")?);
                    }
                }
            }
        }
    }
    let mut batch_mapping = HashMap::new();
    for job in &mut manifest.jobs {
        if let Some(batch_id) = &mut job.batch_id {
            *batch_id = batch_mapping
                .entry(batch_id.clone())
                .or_insert_with(media::new_id)
                .clone();
        }
        job.id = mapping[&job.id].clone();
        job.project_id = project_id.into();
        // Character jobs may share a target outside the storyboard. Keep all
        // versions attached to that same target when restoring a project pack.
        job.target_id = mapping
            .entry(job.target_id.clone())
            .or_insert_with(media::new_id)
            .clone();
        job.asset_id = job
            .asset_id
            .as_ref()
            .and_then(|id| mapping.get(id))
            .cloned();
        job.remote_id = None;
        job.request.api_key = None;
        job.request.project_id = project_id.into();
        job.request.target_id = job.target_id.clone();
        job.request.connection.base_url.clear();
        job.request.connection.id = media::new_id();
        job.request.allow_user_profile = false;
        for reference in &mut job.request.references {
            reference.version_id = mapping
                .get(&reference.version_id)
                .cloned()
                .ok_or("历史任务引用媒体缺失")?;
        }
        job.restored = true;
        job.status = if job.status == "completed" && job.asset_id.is_some() {
            "completed"
        } else {
            "failed"
        }
        .into();
        job.error = Some(
            "恢复的历史记录；不复用原远端句柄或登录许可。如需再次创作，请选择资源后明确生成".into(),
        );
    }
    let mut files = vec![];
    let mut source_files = HashMap::new();
    for entry in manifest.files {
        let new_file = mapping[&entry.file_id].clone();
        let new_version = mapping[&entry.version_id].clone();
        let mapped = Entry {
            file_id: new_file,
            version_id: new_version,
            ..entry.clone()
        };
        source_files.insert(mapped.file_id.clone(), entry.file_id);
        files.push(mapped);
    }
    let pending = Pending {
        import_id: media::new_id(),
        project_id: project_id.into(),
        workspace: manifest.workspace,
        index: manifest.index,
        assets: manifest.assets,
        jobs: manifest.jobs,
        files,
        created_at: media::now(),
        stage_directory: Some(
            stage
                .path()
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("暂存目录标识无效")?
                .into(),
        ),
        source_files,
    };
    let payload = serde_json::to_string(&pending).map_err(|e| e.to_string())?;
    // Retain verified sources on a journal or publication error; never discard recoverable bytes.
    let _stage = stage.keep();
    db.execute(
        "INSERT INTO media_imports(id,project_id,payload,created_at) VALUES(?1,?2,?3,?4)",
        params![pending.import_id, project_id, payload, pending.created_at],
    )
    .map_err(|e| e.to_string())?;
    // The durable journal and source directory precede final publication.
    finish_pending_files(&root, &pending)?;
    Ok(json!(pending))
}

fn verify_pending_files(root: &Path, pending: &Pending) -> Result<(), String> {
    if pending.files.len() > MAX_FILES {
        return Err("待恢复文件数量超限".into());
    }
    for entry in &pending.files {
        let path = root.join("files").join(relative_file(entry)?);
        if checksum_file(&path, entry.bytes)? != entry.crc32 {
            return Err("待恢复媒体已变化，项目与媒体均未登记，恢复记录保留".into());
        }
        let (_, mime, _) = media::detect_format(&path)?;
        if mime != entry.mime_type {
            return Err("待恢复媒体类型与清单不符".into());
        }
    }
    Ok(())
}

fn finish_pending_files(root: &Path, pending: &Pending) -> Result<(), String> {
    if pending.files.len() > MAX_FILES {
        return Err("待恢复文件数量超限".into());
    }
    for entry in &pending.files {
        let destination = root.join("files").join(relative_file(entry)?);
        if destination.exists() {
            continue;
        } // Existing bytes are verified below, never overwritten.
        let directory = pending
            .stage_directory
            .as_deref()
            .ok_or("待恢复文件缺失，请重新选择原完整项目包；原项目未修改")?;
        if directory.is_empty()
            || directory.contains(['/', '\\'])
            || [".", ".."].contains(&directory)
        {
            return Err("暂存目录标识无效".into());
        }
        let stage = root.join("incoming").join(directory);
        let info =
            fs::symlink_metadata(&stage).map_err(|_| "验证后的暂存目录缺失，请重新选择原项目包")?;
        if !info.is_dir() || info.file_type().is_symlink() {
            return Err("暂存目录越界，拒绝恢复".into());
        }
        let source_id = pending
            .source_files
            .get(&entry.file_id)
            .ok_or("待恢复来源清单缺失")?;
        media::valid_id(source_id)?;
        let source = stage.join(source_id);
        if checksum_file(&source, entry.bytes)? != entry.crc32 {
            return Err("暂存媒体校验失败，未登记到项目".into());
        }
        // Both paths are on the same managed filesystem. A hard link is atomic and cannot overwrite.
        match fs::hard_link(&source, &destination) {
            Ok(()) => (),
            Err(problem) if problem.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(_) => return Err("恢复文件发布失败，验证后的暂存文件与恢复记录保留".into()),
        }
    }
    sync_directory(&root.join("files"))?;
    verify_pending_files(root, pending)
}

fn cleanup_pending_stage(root: &Path, pending: &Pending) {
    let Some(directory) = pending.stage_directory.as_deref() else {
        return;
    };
    if directory.is_empty() || directory.contains(['/', '\\']) || [".", ".."].contains(&directory) {
        return;
    }
    let stage = root.join("incoming").join(directory);
    if !fs::symlink_metadata(&stage)
        .is_ok_and(|info| info.is_dir() && !info.file_type().is_symlink())
    {
        return;
    }
    // Only discard our duplicate staging links after every final file passed the commit-time check.
    // If the DB commit subsequently fails, the pending record still points at those final files.
    for source_id in pending.source_files.values() {
        if media::valid_id(source_id).is_ok() {
            let _ = fs::remove_file(stage.join(source_id));
        }
    }
    let _ = fs::remove_dir(stage); // Non-recursive: never remove unexpected contents.
}

/// Called inside the library-write transaction, after frontend workspace validation.
pub(crate) fn apply_import(
    transaction: &Transaction<'_>,
    import_id: &str,
    library: &Value,
    media_root: &Path,
) -> Result<(), String> {
    media::valid_id(import_id)?;
    let payload: String = transaction
        .query_row(
            "SELECT payload FROM media_imports WHERE id=?1",
            [import_id],
            |row| row.get(0),
        )
        .map_err(|_| "待完成导入不存在，请重新选择项目包")?;
    let pending: Pending =
        serde_json::from_str(&payload).map_err(|_| "待导入数据损坏，文件保留")?;
    // Re-check bytes at the actual commit boundary, including imports resumed days later.
    verify_pending_files(media_root, &pending)?;
    let project = library["projects"]
        .as_array()
        .and_then(|projects| {
            projects
                .iter()
                .find(|project| project["id"] == pending.project_id)
        })
        .ok_or("新项目不在保存快照中")?;
    if project["workspace"]["documents"] != pending.workspace["documents"]
        || project["workspace"]["storyboard"] != pending.workspace["storyboard"]
    {
        return Err("导入项目与验证后的媒体清单不一致".into());
    }
    let old: Option<String> = transaction
        .query_row("SELECT payload FROM library WHERE id=1", [], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(old) = old {
        let old: Value = serde_json::from_str(&old).map_err(|_| "原项目库损坏")?;
        if old["projects"].as_array().is_some_and(|projects| {
            projects
                .iter()
                .any(|project| project["id"] == pending.project_id)
        }) {
            return Err("导入不能覆盖已有项目".into());
        }
    }
    for entry in &pending.files {
        transaction.execute("INSERT INTO media_files(id,project_id,version_id,relative_path,mime_type,bytes) VALUES(?1,?2,?3,?4,?5,?6)",params![entry.file_id,pending.project_id,entry.version_id,relative_file(entry)?,entry.mime_type,entry.bytes]).map_err(|e| e.to_string())?;
    }
    for asset in &pending.assets {
        let target = pending
            .jobs
            .iter()
            .find(|job| job.asset_id.as_deref() == Some(&asset.id))
            .map_or("", |job| job.target_id.as_str());
        transaction.execute("INSERT INTO media_assets(id,project_id,target_id,kind,payload,updated_at) VALUES(?1,?2,?3,?4,?5,?6)",params![asset.id,pending.project_id,target,asset.kind,serde_json::to_string(asset).map_err(|e| e.to_string())?,asset.updated_at]).map_err(|e| e.to_string())?;
    }
    for job in &pending.jobs {
        transaction.execute("INSERT INTO media_jobs(id,project_id,status,payload,updated_at) VALUES(?1,?2,?3,?4,?5)",params![job.id,pending.project_id,job.status,serde_json::to_string(job).map_err(|e| e.to_string())?,job.updated_at]).map_err(|e| e.to_string())?;
    }
    cleanup_pending_stage(media_root, &pending);
    transaction
        .execute("DELETE FROM media_imports WHERE id=?1", [import_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn media_pending_imports(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let db = initialize(&app)?;
    let mut statement = db
        .prepare("SELECT payload FROM media_imports ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let result=statement.query_map([],|row| row.get::<_,String>(0)).map_err(|e| e.to_string())?.map(|row| { let pending:Pending=serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?; Ok(json!({"importId":pending.import_id,"projectId":pending.project_id,"name":pending.workspace["project"]["name"],"createdAt":pending.created_at})) }).collect();
    result
}

#[tauri::command]
pub(crate) fn media_get_pending_import(
    app: tauri::AppHandle,
    import_id: String,
) -> Result<Value, String> {
    media::valid_id(&import_id)?;
    let payload: String = initialize(&app)?
        .query_row(
            "SELECT payload FROM media_imports WHERE id=?1",
            [import_id],
            |row| row.get(0),
        )
        .map_err(|_| "待完成导入不存在")?;
    let pending: Pending =
        serde_json::from_str(&payload).map_err(|_| "待导入数据损坏，原文件保留")?;
    finish_pending_files(&media::media_root(&app)?, &pending)?;
    Ok(json!(pending))
}

#[cfg(test)]
mod export_preflight_tests {
    use super::*;
    fn manifest(count: usize, bytes: u64) -> Manifest {
        let files: Vec<Entry> = (0..count).map(|i| Entry { file_id: format!("f-{i}"), version_id: format!("v-{i}"), mime_type: "video/mp4".into(), bytes, crc32: u32::MAX }).collect();
        let assets = files.iter().enumerate().map(|(i, file)| Asset {
            id: format!("a-{i}"), project_id: "p".into(), name: "视频".into(), role: "shot".into(), kind: "video".into(), selected_version_id: file.version_id.clone(), created_at: "1".into(), updated_at: "1".into(),
            versions: vec![media::MediaVersion { id: file.version_id.clone(), file_id: file.file_id.clone(), name: "video.mp4".into(), mime_type: file.mime_type.clone(), bytes, created_at: "1".into(), metadata: json!({}) }],
        }).collect();
        Manifest { format:"ai-creator-workbench-media".into(), version:1, checksum_algorithm:"crc32".into(), workspace:json!({"project":{"name":"test"},"documents":{}}), index:Value::Null, assets, jobs:vec![], files }
    }
    #[test]
    fn budgets_reject_before_any_media_files_are_opened() {
        // No source files or staging directories exist for these metadata-only inputs.
        assert!(preflight_export(&manifest(1, 1024)).is_ok());
        assert!(preflight_export(&manifest(MAX_FILES + 1, 1)).is_err());
        assert!(preflight_export(&manifest(17, media::MAX_MEDIA_BYTES)).is_err());
        assert!(preflight_export(&manifest(16, media::MAX_MEDIA_BYTES)).is_err(), "metadata also counts against the 8 GiB budget");
    }
    #[test]
    fn history_media_are_validated_and_remapped_with_current_shots() {
        let mut value = manifest(1, 1024);
        let shot = json!({"id":"shot","sourceDocumentId":"scene","selectedImageVersionId":"","selectedVideoVersionId":"v-0","reviewedVideoVersionId":"v-0","reviewedInputFingerprint":"old","references":[{"versionId":"v-0","role":"extend"}]});
        value.workspace["storyboard"] = json!({"shots":[shot.clone()],"sourceVersions":[{"id":"history","sourceDocumentId":"scene","shots":[shot.clone()]}]});
        assert!(validate_manifest(&value).is_ok(), "same shot identity may appear in history and current storyboard");
        value.workspace["storyboard"]["sourceVersions"][0]["shots"][0]["selectedVideoVersionId"] = json!("missing");
        assert!(validate_manifest(&value).is_err());
        value.workspace["storyboard"]["sourceVersions"][0]["shots"][0] = shot;
        let mut mapping = HashMap::from([("v-0".into(), "new-video".into())]);
        remap_storyboard(&mut value.workspace, &mut mapping).unwrap();
        let current = &value.workspace["storyboard"]["shots"][0];
        let history = &value.workspace["storyboard"]["sourceVersions"][0]["shots"][0];
        assert_eq!(current["id"], history["id"]);
        assert_ne!(current["id"], "shot");
        assert_eq!(history["selectedVideoVersionId"], "new-video");
        assert_eq!(history["references"][0]["versionId"], "new-video");
        assert_eq!(history["sourceDocumentId"], "scene");
        assert!(history.get("reviewedInputFingerprint").is_none());
        let mut legacy = json!({"project":{"name":"legacy"},"documents":{}});
        remap_storyboard(&mut legacy, &mut mapping).unwrap();
        assert!(legacy.get("storyboard").is_none());
    }
}
