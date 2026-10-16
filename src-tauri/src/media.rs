use crate::media_integrity::{checksum_file, sync_directory};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, FilePath};

pub(crate) const MAX_MEDIA_BYTES: u64 = 512 * 1024 * 1024;
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
pub(crate) struct FileChooserRuntime {
    state: Mutex<FileChooserState>,
}

#[derive(Default)]
struct FileChooserState {
    closing: bool,
    open: bool,
}

impl FileChooserRuntime {
    pub(crate) fn has_active_tasks(&self) -> Result<bool, String> {
        Ok(self.state.lock().map_err(|_| "文件选择器状态不可用")?.open)
    }

    pub(crate) fn stop_all(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closing = true;
        }
    }
}

struct FileChooserRegistration {
    app: tauri::AppHandle,
}

impl Drop for FileChooserRegistration {
    fn drop(&mut self) {
        if let Ok(mut state) = self.app.state::<FileChooserRuntime>().state.lock() {
            state.open = false;
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaVersion {
    pub id: String,
    pub file_id: String,
    pub name: String,
    pub mime_type: String,
    pub bytes: u64,
    pub created_at: String,
    pub metadata: Value,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Asset {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub role: String,
    pub kind: String,
    pub versions: Vec<MediaVersion>,
    pub selected_version_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registration {
    project_id: String,
    target_id: Option<String>,
    role: String,
    kind: String,
    relative_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    staging_file: Option<String>,
    version: MediaVersion,
    crc32: u32,
}

pub(crate) fn now() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

pub(crate) fn new_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "m-{nanos:032x}-{:x}",
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

pub(crate) fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 96
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("媒体或项目标识无效".into());
    }
    Ok(())
}

fn validate_role(role: &str) -> Result<(), String> {
    if !["character", "scene", "prop", "style", "shot", "other"].contains(&role) {
        return Err("素材用途无效".into());
    }
    Ok(())
}

pub(crate) fn media_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("media");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    for directory in ["files", "incoming", "tasks"] {
        let path = root.join(directory);
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        let info = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !info.is_dir()
            || info.file_type().is_symlink()
            || path.canonicalize().map_err(|e| e.to_string())? != path
        {
            return Err("媒体子目录越界或被替换为符号链接，拒绝访问".into());
        }
    }
    sync_directory(&root)?;
    if let Some(parent) = root.parent() {
        sync_directory(parent)?;
    }
    Ok(root)
}

pub(crate) fn database(app: &tauri::AppHandle) -> Result<Connection, String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let mut db =
        Connection::open(directory.join("workbench.sqlite3")).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let has_schema: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_schema')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let version: i64 = if has_schema {
        db.query_row("SELECT version FROM media_schema WHERE id=1", [], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?
    } else {
        0
    };
    if !(0..=2).contains(&version) {
        return Err("媒体库版本高于当前应用支持范围，请使用新版应用".into());
    }
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
        .map_err(|e| e.to_string())?;
    if version == 2 {
        crate::project_deletion::initialize(&db)?;
        return Ok(db);
    }
    let migration = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    migration.execute_batch("
        CREATE TABLE IF NOT EXISTS media_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS media_assets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, target_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS media_assets_project ON media_assets(project_id);
        CREATE TABLE IF NOT EXISTS media_files (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version_id TEXT NOT NULL UNIQUE, relative_path TEXT NOT NULL, mime_type TEXT NOT NULL, bytes INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS media_files_project ON media_files(project_id);
        CREATE TABLE IF NOT EXISTS media_jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS media_jobs_project ON media_jobs(project_id);
        CREATE TABLE IF NOT EXISTS media_registrations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS media_registrations_project ON media_registrations(project_id);
        INSERT INTO media_schema(id,version) VALUES(1,2) ON CONFLICT(id) DO UPDATE SET version=2;").map_err(|e| e.to_string())?;
    migration.commit().map_err(|e| e.to_string())?;
    crate::project_deletion::initialize(&db)?;
    Ok(db)
}

pub(crate) fn list_assets(db: &Connection, project_id: &str) -> Result<Vec<Asset>, String> {
    let mut statement = db
        .prepare("SELECT payload FROM media_assets WHERE project_id=?1 ORDER BY updated_at DESC,id")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([project_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|e| e.to_string())?)
            .map_err(|e| format!("素材元数据损坏，文件保留：{e}"))
    })
    .collect()
}

pub(crate) fn stored_file(
    app: &tauri::AppHandle,
    project_id: Option<&str>,
    file_id: &str,
) -> Result<(PathBuf, String, u64), String> {
    valid_id(file_id)?;
    let db = database(app)?;
    let record: Option<(String, String, String, u64)> = db
        .query_row(
            "SELECT project_id,relative_path,mime_type,bytes FROM media_files WHERE id=?1",
            [file_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (owner, relative, mime, bytes) = record.ok_or("媒体未登记或已经移除")?;
    if project_id.is_some_and(|project| project != owner) {
        return Err("媒体不属于当前项目".into());
    }
    let root = media_root(app)?
        .join("files")
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if relative.contains('/') || relative.contains('\\') || relative.starts_with('.') {
        return Err("媒体登记路径无效".into());
    }
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|_| "媒体文件缺失，请恢复完整项目包".to_string())?;
    if !path.starts_with(&root)
        || !path.is_file()
        || path.metadata().map_err(|e| e.to_string())?.len() != bytes
    {
        return Err("媒体文件越界或大小已变化，拒绝读取".into());
    }
    Ok((path, mime, bytes))
}

pub(crate) fn version_file(
    app: &tauri::AppHandle,
    project_id: &str,
    version_id: &str,
) -> Result<(MediaVersion, PathBuf), String> {
    valid_id(project_id)?;
    valid_id(version_id)?;
    let version = list_assets(&database(app)?, project_id)?
        .into_iter()
        .flat_map(|asset| asset.versions)
        .find(|version| version.id == version_id)
        .ok_or("引用版本不存在于该项目")?;
    let (path, _, _) = stored_file(app, Some(project_id), &version.file_id)?;
    Ok((version, path))
}

pub(crate) fn tool(name: &str) -> Result<PathBuf, String> {
    if !["ffprobe", "ffmpeg"].contains(&name) {
        return Err("媒体工具不在白名单中".into());
    }
    ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
        .iter()
        .map(|directory| Path::new(directory).join(name))
        .find(|path| path.is_file())
        .ok_or_else(|| format!("未找到 {name}。请安装或配置受支持的媒体工具；应用不会自动安装。"))
}

pub(crate) async fn run_tool(
    path: &Path,
    args: &[String],
    timeout: u64,
) -> Result<Vec<u8>, String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("媒体工具");
    let result = tokio::time::timeout(
        Duration::from_secs(timeout),
        tokio::process::Command::new(path)
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| {
        format!("{name} 执行超过 {timeout} 秒，请检查本机媒体工具后重试当前阶段；不会自动重新生成")
    })?
    .map_err(|e| format!("{name} 启动失败：{e}"))?;
    if !result.status.success() || result.stdout.len() > 128 * 1024 {
        return Err(format!("{name} 无法解码媒体或返回无效结果"));
    }
    Ok(result.stdout)
}

pub(crate) fn detect_format(
    path: &Path,
) -> Result<(&'static str, &'static str, &'static str), String> {
    let mut header = [0u8; 32];
    let count = File::open(path)
        .map_err(|e| e.to_string())?
        .read(&mut header)
        .map_err(|e| e.to_string())?;
    let header = &header[..count];
    if header.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok(("image", "image/png", "png"))
    } else if header.starts_with(b"\xff\xd8\xff") {
        Ok(("image", "image/jpeg", "jpg"))
    } else if header.starts_with(b"RIFF") && header.get(8..12) == Some(b"WEBP") {
        Ok(("image", "image/webp", "webp"))
    } else if header.starts_with(b"GIF87a") || header.starts_with(b"GIF89a") {
        Ok(("image", "image/gif", "gif"))
    } else if header.get(4..8) == Some(b"ftyp") {
        Ok(("video", "video/mp4", "mp4"))
    } else if header.starts_with(b"\x1a\x45\xdf\xa3") {
        Ok(("video", "video/webm", "webm"))
    } else {
        Err("仅支持可解码的 PNG、JPEG、WebP、GIF、MP4 或 WebM，不按扩展名冒充媒体".into())
    }
}

pub(crate) async fn inspect(path: &Path, kind: &str) -> Result<Value, String> {
    if kind == "image" {
        let path = path.to_owned();
        return tokio::task::spawn_blocking(move || inspect_image(&path))
            .await
            .map_err(|_| "图片解码任务中断".to_string())?;
    }
    let args = vec![
        "-v".into(),
        "error".into(),
        "-protocol_whitelist".into(),
        "file,pipe".into(),
        "-show_entries".into(),
        "stream=codec_type,width,height:format=duration".into(),
        "-of".into(),
        "json".into(),
        path.to_string_lossy().into_owned(),
    ];
    let result: Value = serde_json::from_slice(&run_tool(&tool("ffprobe")?, &args, 12).await?)
        .map_err(|_| "媒体探测结果无效".to_string())?;
    let stream = result["streams"]
        .as_array()
        .and_then(|streams| {
            streams
                .iter()
                .find(|stream| stream["codec_type"] == "video")
        })
        .ok_or("媒体没有可解码的图像／视频轨道")?;
    let width = stream["width"].as_u64().ok_or("媒体尺寸无效")?;
    let height = stream["height"].as_u64().ok_or("媒体尺寸无效")?;
    if width == 0
        || height == 0
        || width > 16384
        || height > 16384
        || width.saturating_mul(height) > 120_000_000
    {
        return Err("媒体尺寸超出安全处理范围".into());
    }
    let duration = result["format"]["duration"]
        .as_str()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0);
    if kind == "video" && duration.is_none() {
        return Err("视频时长无效，拒绝收录不完整文件".into());
    }
    // Decode an actual frame; a valid container header alone is not a media artifact.
    let args = vec![
        "-v".into(),
        "error".into(),
        "-nostdin".into(),
        "-protocol_whitelist".into(),
        "file,pipe".into(),
        "-i".into(),
        path.to_string_lossy().into_owned(),
        "-map".into(),
        "0:v:0".into(),
        "-frames:v".into(),
        "1".into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ];
    run_tool(&tool("ffmpeg")?, &args, 15).await?;
    Ok(json!({"width":width,"height":height,"duration":duration}))
}

fn inspect_image(path: &Path) -> Result<Value, String> {
    let reader = || {
        image::ImageReader::open(path)
            .map_err(|_| "图片无法读取".to_string())?
            .with_guessed_format()
            .map_err(|_| "图片格式无法识别".to_string())
    };
    let (width, height) = reader()?
        .into_dimensions()
        .map_err(|_| "图片尺寸无法解码".to_string())?;
    if width == 0
        || height == 0
        || width > 16384
        || height > 16384
        || u64::from(width) * u64::from(height) > 120_000_000
    {
        return Err("图片尺寸超出安全处理范围".into());
    }
    let mut decoder = reader()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(256 * 1024 * 1024);
    decoder.limits(limits);
    // Decode pixels, not just headers. Corrupt provider output never becomes a saved asset.
    let decoded = decoder
        .decode()
        .map_err(|_| "图片损坏、不完整或超出解码内存限制".to_string())?;
    if decoded.width() != width || decoded.height() != height {
        return Err("图片尺寸与实际像素不一致".into());
    }
    Ok(json!({"width":width,"height":height,"duration":Value::Null}))
}

#[cfg(test)]
mod image_tests {
    use super::*;
    use std::io::Cursor;

    #[tokio::test]
    async fn still_images_decode_without_external_media_tools() {
        for format in [
            image::ImageFormat::Png,
            image::ImageFormat::Jpeg,
            image::ImageFormat::WebP,
            image::ImageFormat::Gif,
        ] {
            let mut bytes = Cursor::new(Vec::new());
            image::DynamicImage::new_rgb8(4, 6)
                .write_to(&mut bytes, format)
                .unwrap();
            let mut file = tempfile::NamedTempFile::new().unwrap();
            file.write_all(bytes.get_ref()).unwrap();
            assert_eq!(detect_format(file.path()).unwrap().0, "image");
            let metadata = inspect(file.path(), "image").await.unwrap();
            assert_eq!(metadata["width"], 4);
            assert_eq!(metadata["height"], 6);
            assert!(metadata["duration"].is_null());
        }
    }

    #[tokio::test]
    async fn valid_header_without_pixels_is_rejected() {
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(4, 6)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(&bytes.get_ref()[..33]).unwrap();
        assert_eq!(detect_format(file.path()).unwrap().0, "image");
        assert!(inspect(file.path(), "image").await.is_err());
    }
}

pub(crate) async fn import_path(
    app: &tauri::AppHandle,
    project_id: &str,
    name: &str,
    role: &str,
    source: &Path,
    target: Option<&str>,
    provenance: Value,
) -> Result<Asset, String> {
    valid_id(project_id)?;
    if let Some(target) = target {
        valid_id(target)?;
    }
    validate_role(role)?;
    let name: String = name
        .chars()
        .filter(|character| !character.is_control())
        .take(200)
        .collect();
    if name.trim().is_empty() {
        return Err("素材名称不能为空".into());
    }
    let source_info = source.metadata().map_err(|e| e.to_string())?;
    if !source_info.is_file() || source_info.len() == 0 || source_info.len() > MAX_MEDIA_BYTES {
        return Err("素材必须是 1 字节至 512 MiB 的普通文件".into());
    }
    let root = media_root(app)?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(root.join("incoming")).map_err(|e| e.to_string())?;
    let copied = std::io::copy(
        &mut File::open(source)
            .map_err(|e| e.to_string())?
            .take(MAX_MEDIA_BYTES + 1),
        &mut temporary,
    )
    .map_err(|e| format!("复制媒体失败，原文件保留：{e}"))?;
    if copied == 0 || copied > MAX_MEDIA_BYTES {
        return Err("素材超过导入大小限制".into());
    }
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    let (kind, mime, extension) = detect_format(temporary.path())?;
    let mut metadata = inspect(temporary.path(), kind).await?;
    metadata["provenance"] = provenance;
    let file_id = new_id();
    let version_id = new_id();
    let time = now();
    let relative = format!("{file_id}.{extension}");
    let staging_file = format!("{file_id}-pending");
    let version = MediaVersion {
        id: version_id,
        file_id,
        name: name.clone(),
        mime_type: mime.into(),
        bytes: copied,
        created_at: time.clone(),
        metadata,
    };
    // Keep a durable source before journaling: a crash before final publication is recoverable too.
    let registration = Registration {
        project_id: project_id.into(),
        target_id: target.map(str::to_owned),
        role: role.into(),
        kind: kind.into(),
        relative_path: relative,
        staging_file: Some(staging_file.clone()),
        crc32: checksum_file(temporary.path(), copied)?,
        version,
    };
    let mut db = database(app)?;
    let transaction = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    crate::project_deletion::ensure_live(&transaction, project_id)?;
    fs::hard_link(temporary.path(), root.join("incoming").join(staging_file))
        .map_err(|e| format!("暂存媒体失败，原文件保留：{e}"))?;
    sync_directory(&root.join("incoming"))
        .map_err(|_| "媒体暂存目录同步失败，未登记到项目，原文件保留".to_string())?;
    transaction
        .execute(
            "INSERT INTO media_registrations(id,project_id,payload) VALUES(?1,?2,?3)",
            params![
                registration.version.id,
                project_id,
                serde_json::to_string(&registration).map_err(|e| e.to_string())?
            ],
        )
        .map_err(|e| format!("媒体已暂存但恢复记录保存失败，原文件保留：{e}"))?;
    transaction.commit().map_err(|e| e.to_string())?;
    register_pending(app, &registration)
}

fn cleanup_registration_source(root: &Path, registration: &Registration) {
    let Some(staging_file) = registration.staging_file.as_deref() else {
        return;
    };
    if staging_file == format!("{}-pending", registration.version.file_id)
        && valid_id(staging_file).is_ok()
        && fs::remove_file(root.join("incoming").join(staging_file)).is_ok()
    {
        let _ = sync_directory(&root.join("incoming"));
    }
}

fn register_pending(app: &tauri::AppHandle, registration: &Registration) -> Result<Asset, String> {
    let Registration {
        project_id,
        target_id,
        role,
        kind,
        relative_path,
        staging_file,
        version,
        crc32,
    } = registration;
    valid_id(project_id)?;
    valid_id(&version.id)?;
    valid_id(&version.file_id)?;
    validate_role(role)?;
    if let Some(target) = target_id {
        valid_id(target)?;
    }
    if relative_path.contains(['/', '\\'])
        || !relative_path.starts_with(&format!("{}.", version.file_id))
    {
        return Err("待恢复文件登记路径无效".into());
    }
    let mut db = database(app)?;
    let transaction = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    crate::project_deletion::ensure_live(&transaction, project_id)?;
    let root = media_root(app)?;
    let path = root.join("files").join(relative_path);
    if let Some(staging_file) = staging_file {
        valid_id(staging_file)?;
        if staging_file != &format!("{}-pending", version.file_id) {
            return Err("待恢复暂存文件不属于该媒体版本，拒绝发布".into());
        }
        if !path.exists() {
            let source = root.join("incoming").join(staging_file);
            if checksum_file(&source, version.bytes)? != *crc32 {
                return Err("待恢复暂存媒体校验失败，文件与登记记录保留".into());
            }
            // Publication cannot replace an existing file. Concurrent recovery verifies it below.
            match fs::hard_link(&source, &path) {
                Ok(()) => (),
                Err(problem) if problem.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(_) => return Err("媒体发布失败，暂存文件与登记记录保留，可稍后恢复收录".into()),
            }
        }
    }
    if checksum_file(&path, version.bytes)? != *crc32 {
        return Err("待恢复媒体校验失败，文件与登记记录保留".into());
    }
    let (actual_kind, mime, _) = detect_format(&path)?;
    if actual_kind != kind || mime != version.mime_type {
        return Err("待恢复媒体真实类型与登记不符".into());
    }
    sync_directory(&root.join("files"))?;
    let pending: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM media_registrations WHERE id=?1 AND project_id=?2)",
            params![version.id, project_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !pending {
        let asset = list_assets(&transaction, project_id)?
            .into_iter()
            .find(|asset| asset.versions.iter().any(|item| item.id == version.id))
            .ok_or("待恢复登记不存在，文件保留")?;
        drop(transaction);
        cleanup_registration_source(&root, registration);
        return Ok(asset);
    }
    let prior: Option<String> = if let Some(target) = target_id {
        transaction.query_row("SELECT payload FROM media_assets WHERE project_id=?1 AND target_id=?2 AND kind=?3 LIMIT 1", params![project_id, target, kind], |row| row.get(0)).optional().map_err(|e| e.to_string())?
    } else {
        None
    };
    let mut asset = if let Some(prior) = prior {
        serde_json::from_str::<Asset>(&prior).map_err(|e| e.to_string())?
    } else {
        Asset {
            id: new_id(),
            project_id: project_id.into(),
            name: version.name.clone(),
            role: role.into(),
            kind: kind.clone(),
            versions: vec![],
            selected_version_id: version.id.clone(),
            created_at: version.created_at.clone(),
            updated_at: version.created_at.clone(),
        }
    };
    if role == "character" {
        asset.role = "character".into();
    }
    asset.versions.push(version.clone());
    asset.updated_at = now();
    transaction.execute("INSERT INTO media_files(id,project_id,version_id,relative_path,mime_type,bytes) VALUES(?1,?2,?3,?4,?5,?6)", params![version.file_id, project_id, version.id, relative_path, mime, version.bytes]).map_err(|e| format!("文件已保存但登记失败，可恢复收录：{e}"))?;
    transaction.execute("INSERT INTO media_assets(id,project_id,target_id,kind,payload,updated_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at", params![asset.id, project_id, target_id.as_deref().unwrap_or(""), kind, serde_json::to_string(&asset).map_err(|e| e.to_string())?, asset.updated_at]).map_err(|e| e.to_string())?;
    transaction
        .execute("DELETE FROM media_registrations WHERE id=?1", [&version.id])
        .map_err(|e| e.to_string())?;
    transaction
        .commit()
        .map_err(|e| format!("文件已保存但登记失败，可恢复收录：{e}"))?;
    cleanup_registration_source(&root, registration);
    Ok(asset)
}

pub(crate) fn recover_job_registration(
    app: &tauri::AppHandle,
    job: &crate::media_jobs::Job,
    artifact: &str,
) -> Result<Option<Asset>, String> {
    let db = database(app)?;
    let mut statement = db.prepare("SELECT id,payload FROM media_registrations WHERE project_id=?1 AND json_extract(payload,'$.version.metadata.provenance.jobId')=?2 AND json_extract(payload,'$.version.metadata.provenance.artifact')=?3").map_err(|e| e.to_string())?;
    let pending = statement
        .query_map(params![job.project_id, job.id, artifact], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if pending.len() > 1 {
        return Err("同一任务产物存在多条待收录记录，已保留原记录，未重复登记".into());
    }
    let Some((id, payload)) = pending.into_iter().next() else {
        return Ok(None);
    };
    let registration: Registration =
        serde_json::from_str(&payload).map_err(|_| "任务产物恢复记录损坏，原文件保留")?;
    if registration.project_id != job.project_id
        || registration.version.id != id
        || registration.target_id.as_deref() != Some(job.target_id.as_str())
        || registration.kind != job.capability
        || registration.role != job.request.output_role()
    {
        return Err("任务产物恢复记录归属不一致，拒绝重复收录".into());
    }
    // Reuse the journaled version after a registration failure, not a new copy of the output.
    register_pending(app, &registration).map(Some)
}

fn recover_registrations(app: &tauri::AppHandle, project_id: &str) -> Result<Vec<String>, String> {
    let db = database(app)?;
    let mut statement = db
        .prepare("SELECT id,payload FROM media_registrations WHERE project_id=?1 ORDER BY id")
        .map_err(|e| e.to_string())?;
    let pending = statement
        .query_map([project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut issues = vec![];
    for (id, payload) in pending {
        let result = serde_json::from_str::<Registration>(&payload)
            .map_err(|_| "恢复记录格式损坏".to_string())
            .and_then(|registration| {
                if registration.project_id != project_id || registration.version.id != id {
                    return Err("恢复记录归属不一致".into());
                }
                register_pending(app, &registration)
            });
        if let Err(problem) = result {
            issues.push(format!(
                "待收录 {}：{problem}",
                id.get(id.len().saturating_sub(8)..).unwrap_or(&id)
            ));
        }
    }
    Ok(issues)
}

#[tauri::command]
pub(crate) fn media_list(app: tauri::AppHandle, project_id: String) -> Result<Value, String> {
    valid_id(&project_id)?;
    let recovery_issues = recover_registrations(&app, &project_id)?;
    crate::media_jobs::reconcile(&app, &project_id)?;
    let db = database(&app)?;
    let assets = list_assets(&db, &project_id)?;
    let mut statement = db
        .prepare("SELECT payload FROM media_jobs WHERE project_id=?1 ORDER BY updated_at DESC,id")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([&project_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let jobs: Result<Vec<Value>, String> = rows
        .map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect();
    Ok(json!({"assets":assets,"jobs":jobs?,"recoveryIssues":recovery_issues}))
}

#[tauri::command]
pub(crate) fn media_verify_versions(
    app: tauri::AppHandle,
    project_id: String,
    version_ids: Vec<String>,
) -> Result<Vec<MediaVersion>, String> {
    valid_id(&project_id)?;
    if version_ids.is_empty() || version_ids.len() > 20 {
        return Err("请核验 1–20 个媒体版本".into());
    }
    let mut verified = Vec::with_capacity(version_ids.len());
    let mut seen = std::collections::HashSet::new();
    for version_id in version_ids {
        if !seen.insert(version_id.clone()) {
            return Err("待核验媒体版本重复".into());
        }
        let (version, path) = version_file(&app, &project_id, &version_id)?;
        let (_, mime_type, _) = detect_format(&path)?;
        if mime_type != version.mime_type {
            return Err("媒体文件格式已变化，请重新导入或恢复完整项目包".into());
        }
        verified.push(version);
    }
    Ok(verified)
}

pub(crate) async fn choose_files(
    app: &tauri::AppHandle,
    prompt: &str,
    multiple: bool,
) -> Result<Vec<PathBuf>, String> {
    let window = app.get_webview_window("main").ok_or("主窗口已关闭")?;
    let runtime = app.state::<FileChooserRuntime>();
    {
        let mut state = runtime.state.lock().map_err(|_| "文件选择器状态不可用")?;
        if state.closing {
            return Err("应用正在退出，未打开文件选择器".into());
        }
        if state.open {
            return Err("已有文件选择器打开，请先完成或取消当前选择".into());
        }
        state.open = true;
    }
    let registration = FileChooserRegistration { app: app.clone() };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    // The callback owns the guard, so abandoning an IPC request cannot unlock
    // another picker while the original native sheet is still visible.
    let complete = move |files: Option<Vec<FilePath>>| {
        let _registration = registration;
        let _ = sender.send(files);
    };
    let picker = app.dialog().file().set_parent(&window).set_title(prompt);
    if multiple {
        picker
            .add_filter(
                "图片或视频",
                &["png", "jpg", "jpeg", "webp", "gif", "mp4", "webm"],
            )
            .pick_files(complete);
    } else {
        picker
            .add_filter("创作项目包", &["acwpack"])
            .pick_file(move |file| complete(file.map(|file| vec![file])));
    }
    let files = receiver.await.map_err(|_| "文件选择器已结束，未导入")?;
    if runtime
        .state
        .lock()
        .map_err(|_| "文件选择器状态不可用")?
        .closing
    {
        return Err("应用正在退出，未导入文件".into());
    }
    let files = files.unwrap_or_default();
    if files.len() > 30 {
        return Err("每次最多导入 30 个文件".into());
    }
    files
        .into_iter()
        .map(|file| {
            file.into_path()
                .map_err(|_| "请选择本机文件，不能导入非文件地址".into())
        })
        .collect()
}

#[tauri::command]
pub(crate) async fn media_choose_import(
    app: tauri::AppHandle,
    project_id: String,
    role: String,
) -> Result<Vec<Asset>, String> {
    valid_id(&project_id)?;
    validate_role(&role)?;
    let paths = choose_files(&app, "选择图片或视频，导入当前创作项目", true).await?;
    let mut assets = vec![];
    for path in paths {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("导入素材");
        assets.push(
            import_path(
                &app,
                &project_id,
                name,
                &role,
                &path,
                None,
                json!({"source":"import"}),
            )
            .await?,
        );
    }
    Ok(assets)
}

#[tauri::command]
pub(crate) async fn media_import_bytes(
    app: tauri::AppHandle,
    project_id: String,
    name: String,
    role: String,
    bytes: Vec<u8>,
) -> Result<Asset, String> {
    valid_id(&project_id)?;
    validate_role(&role)?;
    if bytes.is_empty() || bytes.len() > 64 * 1024 * 1024 {
        return Err("直接字节导入限 64 MiB；大文件请使用原生文件选择器".into());
    }
    let mut input = tempfile::NamedTempFile::new_in(media_root(&app)?.join("incoming"))
        .map_err(|e| e.to_string())?;
    input.write_all(&bytes).map_err(|e| e.to_string())?;
    import_path(
        &app,
        &project_id,
        &name,
        &role,
        input.path(),
        None,
        json!({"source":"import"}),
    )
    .await
}

#[tauri::command]
pub(crate) fn media_update_asset(
    app: tauri::AppHandle,
    project_id: String,
    asset_id: String,
    name: String,
    role: String,
    selected_version_id: String,
) -> Result<Asset, String> {
    valid_id(&project_id)?;
    valid_id(&asset_id)?;
    validate_role(&role)?;
    if name.trim().is_empty() || name.chars().count() > 200 {
        return Err("素材名称须为 1–200 个字符".into());
    }
    let mut db = database(&app)?;
    let transaction = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let payload: String = transaction
        .query_row(
            "SELECT payload FROM media_assets WHERE id=?1 AND project_id=?2",
            params![asset_id, project_id],
            |row| row.get(0),
        )
        .map_err(|_| "素材不存在或不属于该项目".to_string())?;
    let mut asset: Asset = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
    if !asset
        .versions
        .iter()
        .any(|version| version.id == selected_version_id)
    {
        return Err("选用版本不属于该资产".into());
    }
    asset.name = name.trim().into();
    asset.role = role;
    asset.selected_version_id = selected_version_id;
    asset.updated_at = now();
    transaction
        .execute(
            "UPDATE media_assets SET payload=?1,updated_at=?2 WHERE id=?3 AND project_id=?4",
            params![
                serde_json::to_string(&asset).map_err(|e| e.to_string())?,
                asset.updated_at,
                asset.id,
                project_id
            ],
        )
        .map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(asset)
}

#[tauri::command]
pub(crate) fn media_export_version(
    app: tauri::AppHandle,
    project_id: String,
    version_id: String,
) -> Result<String, String> {
    let (version, source) = version_file(&app, &project_id, &version_id)?;
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("bin");
    let directory = app.path().download_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let stem: String = version
        .name
        .chars()
        .filter(|character| character.is_alphanumeric() || ['-', '_', ' '].contains(character))
        .take(60)
        .collect();
    let path = directory.join(format!(
        "{}-{}.{}",
        if stem.is_empty() { "素材" } else { &stem },
        new_id(),
        extension
    ));
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    std::io::copy(
        &mut File::open(&source).map_err(|e| e.to_string())?,
        &mut output,
    )
    .map_err(|e| format!("导出失败，原文件保留：{e}"))?;
    output.sync_all().map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) async fn media_keyframes(
    app: tauri::AppHandle,
    project_id: String,
    version_id: String,
) -> Result<Value, String> {
    let (version, path) = version_file(&app, &project_id, &version_id)?;
    if !version.mime_type.starts_with("video/") {
        return Err("关键帧检查需要视频版本".into());
    }
    let duration = version.metadata["duration"]
        .as_f64()
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .ok_or("视频时长不可用")?;
    let probe = tool("ffprobe")?;
    let probe_args = vec![
        "-v".into(),
        "error".into(),
        "-protocol_whitelist".into(),
        "file,pipe".into(),
        "-select_streams".into(),
        "v:0".into(),
        "-show_entries".into(),
        "stream=start_time,duration:format=start_time".into(),
        "-of".into(),
        "json".into(),
        path.to_string_lossy().into_owned(),
    ];
    let timing: Value = serde_json::from_slice(&run_tool(&probe, &probe_args, 12).await?)
        .map_err(|_| "视频轨道时间信息无效".to_string())?;
    let time = |value: &Value| {
        value
            .as_str()
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite())
    };
    let format_start = time(&timing["format"]["start_time"]).unwrap_or(0.0);
    let video_start = time(&timing["streams"][0]["start_time"]).unwrap_or(format_start);
    let video_duration = time(&timing["streams"][0]["duration"])
        .filter(|value| *value > 0.0)
        .unwrap_or(duration);
    let tail_args = vec![
        "-v".into(),
        "error".into(),
        "-protocol_whitelist".into(),
        "file,pipe".into(),
        "-select_streams".into(),
        "v:0".into(),
        "-read_intervals".into(),
        format!("{:.6}%", video_start + (video_duration - 1.0).max(0.0)),
        "-show_entries".into(),
        "frame=best_effort_timestamp_time".into(),
        "-of".into(),
        "json".into(),
        path.to_string_lossy().into_owned(),
    ];
    let tail: Value = serde_json::from_slice(&run_tool(&probe, &tail_args, 12).await?)
        .map_err(|_| "视频尾帧时间信息无效".to_string())?;
    let last_timestamp = tail["frames"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|frame| time(&frame["best_effort_timestamp_time"]))
        .filter(|timestamp| *timestamp >= video_start && *timestamp >= format_start)
        .reduce(f64::max)
        .ok_or("无法定位视频尾帧，请检查本机媒体工具或文件")?;
    let first_seconds = (video_start - format_start).max(0.0);
    let last_seconds = last_timestamp - format_start;
    let root = media_root(&app)?;
    let mut pending = vec![];
    for seconds in [
        first_seconds,
        (first_seconds + last_seconds) / 2.0,
        last_seconds,
    ] {
        let id = new_id();
        let relative = format!("{id}.png");
        let temporary = tempfile::Builder::new()
            .suffix(".png")
            .tempfile_in(root.join("incoming"))
            .map_err(|e| e.to_string())?;
        let output = temporary.path();
        let args = vec![
            "-v".into(),
            "error".into(),
            "-nostdin".into(),
            "-y".into(),
            "-protocol_whitelist".into(),
            "file,pipe".into(),
            "-ss".into(),
            // Stay just before the probed PTS: rounding past the last frame yields no image.
            format!("{:.6}", (seconds - 0.000001).max(0.0)),
            "-i".into(),
            path.to_string_lossy().into_owned(),
            "-map".into(),
            "0:v:0".into(),
            "-frames:v".into(),
            "1".into(),
            "-vf".into(),
            "scale=1280:1280:force_original_aspect_ratio=decrease".into(),
            output.to_string_lossy().into_owned(),
        ];
        run_tool(&tool("ffmpeg")?, &args, 20).await?;
        let bytes = output.metadata().map_err(|e| e.to_string())?.len();
        if bytes == 0 || bytes > 20 * 1024 * 1024 {
            return Err("关键帧提取失败".into());
        }
        temporary.as_file().sync_all().map_err(|e| e.to_string())?;
        pending.push((id, relative, temporary, bytes, seconds));
    }
    let mut connection = database(&app)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let mut frames = vec![];
    for (id, relative, temporary, bytes, seconds) in pending {
        temporary
            .persist_noclobber(root.join("files").join(&relative))
            .map_err(|e| e.error.to_string())?;
        transaction.execute("INSERT INTO media_files(id,project_id,version_id,relative_path,mime_type,bytes) VALUES(?1,?2,?3,?4,'image/png',?5)", params![id, project_id, id, relative, bytes]).map_err(|e| e.to_string())?;
        frames.push(json!({"fileId":id,"seconds":seconds}));
    }
    sync_directory(&root.join("files"))?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(json!({"frames":frames,"duration":duration}))
}

pub(crate) fn protocol(
    app: &tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};
    let result = (|| -> Result<_, String> {
        if request.method() != "GET" && request.method() != "HEAD" {
            return Err("只允许读取媒体".into());
        }
        let id = request.uri().path().trim_start_matches('/');
        let (path, mime, bytes) = stored_file(app, None, id)?;
        let mut start = 0;
        let mut end = bytes - 1;
        let mut partial = false;
        if let Some(range) = request
            .headers()
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok())
        {
            let range = range.strip_prefix("bytes=").ok_or("无效媒体读取范围")?;
            let (left, right) = range.split_once('-').ok_or("无效媒体读取范围")?;
            if left.is_empty() {
                let suffix = right.parse::<u64>().map_err(|_| "无效范围")?;
                start = bytes.saturating_sub(suffix);
            } else {
                start = left.parse::<u64>().map_err(|_| "无效范围")?;
                if !right.is_empty() {
                    end = right.parse::<u64>().map_err(|_| "无效范围")?.min(end);
                }
            }
            if start > end || start >= bytes {
                return Err("媒体读取范围越界".into());
            }
            end = end.min(start.saturating_add(8 * 1024 * 1024 - 1));
            partial = true;
        }
        let length = end - start + 1;
        let mut body = vec![];
        if request.method() != "HEAD" {
            let mut file = File::open(path).map_err(|e| e.to_string())?;
            file.seek(SeekFrom::Start(start))
                .map_err(|e| e.to_string())?;
            file.take(length)
                .read_to_end(&mut body)
                .map_err(|e| e.to_string())?;
        }
        let mut response = Response::builder()
            .status(if partial {
                StatusCode::PARTIAL_CONTENT
            } else {
                StatusCode::OK
            })
            .header(header::CONTENT_TYPE, mime)
            .header(header::CONTENT_LENGTH, length)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CACHE_CONTROL, "private, max-age=3600")
            .header("X-Content-Type-Options", "nosniff");
        if partial {
            response = response.header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{bytes}"),
            );
        }
        response.body(body).map_err(|e| e.to_string())
    })();
    result.unwrap_or_else(|_| {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::CONTENT_TYPE, "text/plain")
            .body(b"Media unavailable".to_vec())
            .unwrap()
    })
}
