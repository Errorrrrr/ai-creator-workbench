use crate::{
    media,
    media_integrity::{checksum_file, sync_directory},
    runtime,
};
use futures_util::StreamExt;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Mutex},
    time::Duration,
};
use tauri::Manager;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

const MAX_QUEUED_JOBS: usize = 32;
pub(crate) const MAX_BATCH_JOBS: usize = 20;
const MAX_ACTIVE_JOBS: usize = 3;

pub(crate) struct MediaRuntime {
    running: Mutex<HashMap<String, CancellationToken>>,
    cli_processes: Mutex<HashMap<String, (Option<u32>, PathBuf)>>,
    active: Semaphore,
}

impl Default for MediaRuntime {
    fn default() -> Self {
        Self {
            running: Mutex::new(HashMap::new()),
            cli_processes: Mutex::new(HashMap::new()),
            active: Semaphore::new(MAX_ACTIVE_JOBS),
        }
    }
}

impl MediaRuntime {
    pub(crate) fn has_active_tasks(&self) -> Result<bool, String> {
        Ok(!self
            .running
            .lock()
            .map_err(|_| "媒体状态不可用")?
            .is_empty()
            || !self
                .cli_processes
                .lock()
                .map_err(|_| "媒体进程状态不可用")?
                .is_empty())
    }

    pub(crate) fn guard_project_deletion<'a>(
        &'a self,
        db: &rusqlite::Connection,
        project_id: &str,
    ) -> Result<std::sync::MutexGuard<'a, HashMap<String, CancellationToken>>, String> {
        let running = self.running.lock().map_err(|_| "媒体运行状态不可用")?;
        let has_jobs: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_jobs')", [], |row| row.get(0)).map_err(|e| e.to_string())?;
        if has_jobs {
            let mut statement = db
                .prepare("SELECT id FROM media_jobs WHERE project_id=?1")
                .map_err(|e| e.to_string())?;
            let ids = statement
                .query_map([project_id], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            for id in ids {
                if running.contains_key(&id.map_err(|e| e.to_string())?) {
                    return Err("项目仍有媒体任务，请先停止任务并等待结束后再删除".into());
                }
            }
        }
        Ok(running)
    }

    pub(crate) fn register_cli(
        &self,
        id: &str,
        pid: Option<u32>,
        task: &Path,
    ) -> Result<(), String> {
        self.cli_processes
            .lock()
            .map_err(|_| "CLI 进程状态不可用")?
            .insert(id.into(), (pid, task.into()));
        Ok(())
    }

    pub(crate) fn unregister_cli(&self, id: &str) {
        if let Ok(mut processes) = self.cli_processes.lock() {
            processes.remove(id);
        }
    }

    pub(crate) fn stop_all(&self) {
        if let Ok(running) = self.running.lock() {
            for token in running.values() {
                token.cancel();
            }
        }
        if let Ok(mut processes) = self.cli_processes.lock() {
            for (_, (pid, task)) in processes.drain() {
                #[cfg(unix)]
                if let Some(pid) = pid {
                    unsafe {
                        libc::kill(-(pid as i32), libc::SIGKILL);
                    }
                }
                #[cfg(not(unix))]
                let _ = pid;
                crate::media_codex::cleanup_profile(&task);
            }
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Reference {
    pub version_id: String,
    pub role: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Connection {
    pub id: String,
    pub kind: String,
    pub driver_id: Option<String>,
    pub base_url: String,
    pub model: String,
    pub adapter: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Parameters {
    pub mode: String,
    pub aspect_ratio: String,
    pub duration: f64,
    pub size: String,
    pub quality: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub project_id: String,
    pub target_id: String,
    pub capability: String,
    pub prompt: String,
    pub references: Vec<Reference>,
    pub connection: Connection,
    pub parameters: Parameters,
    #[serde(default, skip_serializing)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub allow_user_profile: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Job {
    pub id: String,
    pub project_id: String,
    pub target_id: String,
    pub capability: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub remote_id: Option<String>,
    pub asset_id: Option<String>,
    pub error: Option<String>,
    pub request: Request,
    #[serde(default)]
    pub restored: bool,
    /// 批量计划标识；旧的单项任务不包含此字段。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
    /// 本任务在已确认计划中的顺序，从 0 开始。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_index: Option<usize>,
}

/// 查询已引用镜头的本地任务摘要；不触发迁移、恢复或供应商请求。
#[tauri::command]
pub(crate) fn media_query_jobs(
    app: tauri::AppHandle,
    project_id: String,
    target_ids: Vec<String>,
) -> Result<Value, String> {
    media::valid_id(&project_id)?;
    if target_ids.is_empty() || target_ids.len() > MAX_BATCH_JOBS {
        return Err("请查询 1–20 个明确引用的镜头".into());
    }
    let mut seen = HashSet::new();
    for id in &target_ids {
        media::valid_id(id)?;
        if !seen.insert(id.clone()) {
            return Err("查询镜头重复".into());
        }
    }
    let empty = || json!({"projectId":project_id,"targetIds":target_ids,"jobs":[],"hasMore":false,"queriedAt":media::now()});
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("workbench.sqlite3");
    if !path.try_exists().map_err(|e| e.to_string())? {
        return Ok(empty());
    }
    let db =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| "无法读取本地任务库，未修改项目".to_string())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_jobs')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Ok(empty());
    }
    let version: i64 = db
        .query_row("SELECT version FROM media_schema WHERE id=1", [], |row| {
            row.get(0)
        })
        .map_err(|_| "本地任务库版本信息损坏，未修改项目".to_string())?;
    if !(1..=2).contains(&version) {
        return Err("任务库版本不受支持，请使用匹配的应用版本".into());
    }
    let placeholders = (0..target_ids.len())
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!("SELECT id,payload FROM media_jobs WHERE project_id=? AND json_extract(payload,'$.targetId') IN ({placeholders}) ORDER BY updated_at DESC,id LIMIT 21");
    let mut statement = db
        .prepare(&sql)
        .map_err(|_| "本地任务摘要不可读取，未修改项目")?;
    let rows = statement
        .query_map(
            rusqlite::params_from_iter(std::iter::once(&project_id).chain(target_ids.iter())),
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|_| "本地任务查询失败，未修改项目")?;
    let mut jobs = Vec::new();
    for row in rows {
        let (id, payload) = row.map_err(|_| "本地任务查询失败，未修改项目")?;
        let job: Job =
            serde_json::from_str(&payload).map_err(|_| "任务快照损坏，原数据保留".to_string())?;
        if job.id != id || job.project_id != project_id || !seen.contains(&job.target_id) {
            return Err("任务记录归属不一致，拒绝返回摘要".into());
        }
        jobs.push(json!({"id":job.id,"targetId":job.target_id,"capability":job.capability,"status":job.status,"createdAt":job.created_at,"updatedAt":job.updated_at,"restored":job.restored}));
    }
    let has_more = jobs.len() > MAX_BATCH_JOBS;
    jobs.truncate(MAX_BATCH_JOBS);
    Ok(
        json!({"projectId":project_id,"targetIds":target_ids,"jobs":jobs,"hasMore":has_more,"queriedAt":media::now()}),
    )
}

pub(crate) fn save(app: &tauri::AppHandle, job: &mut Job) -> Result<(), String> {
    job.updated_at = media::now();
    persist(&media::database(app)?, job)
}

fn persist(db: &rusqlite::Connection, job: &Job) -> Result<(), String> {
    db.execute("INSERT INTO media_jobs(id,project_id,status,payload,updated_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload,updated_at=excluded.updated_at", params![job.id,job.project_id,job.status,serde_json::to_string(job).map_err(|e| e.to_string())?,job.updated_at]).map_err(|e| e.to_string())?;
    Ok(())
}

fn load(app: &tauri::AppHandle, project_id: &str, job_id: &str) -> Result<Job, String> {
    media::valid_id(project_id)?;
    media::valid_id(job_id)?;
    let payload: String = media::database(app)?
        .query_row(
            "SELECT payload FROM media_jobs WHERE id=?1 AND project_id=?2",
            params![job_id, project_id],
            |row| row.get(0),
        )
        .map_err(|_| "任务不存在或不属于当前项目".to_string())?;
    serde_json::from_str(&payload).map_err(|_| "任务快照损坏，原文件保留".into())
}

pub(crate) fn directory(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    media::valid_id(id)?;
    let root = media::media_root(app)?.join("tasks");
    let path = root.join(id);
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(root.canonicalize().map_err(|e| e.to_string())?) {
        return Err("任务目录越界".into());
    }
    // Persist the task directory before a committed job can refer to its checkpoints.
    sync_directory(&root)?;
    Ok(path)
}

pub(crate) fn atomic_file(directory: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    if name.contains(['/', '\\']) || name.starts_with('.') {
        return Err("任务文件名无效".into());
    }
    let mut temporary = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    temporary.write_all(bytes).map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    let path = directory.join(name);
    temporary.persist(&path).map_err(|e| e.error.to_string())?;
    // A synced temporary file alone does not make its published name durable.
    sync_directory(directory)?;
    if let Some(parent) = directory.parent() {
        // Callers can create outputs immediately before publishing the first artifact.
        sync_directory(parent)?;
    }
    Ok(path)
}

fn validate(app: &tauri::AppHandle, request: &Request) -> Result<(), String> {
    media::valid_id(&request.project_id)?;
    media::valid_id(&request.target_id)?;
    media::valid_id(&request.connection.id)?;
    if request.prompt.trim().is_empty()
        || request.prompt.len() > 100_000
        || request.references.len() > 16
    {
        return Err("提示词为空、过长或参考过多".into());
    }
    if !request.parameters.duration.is_finite()
        || !(1.0..=60.0).contains(&request.parameters.duration)
    {
        return Err("目标时长无效".into());
    }
    if !["16:9", "9:16", "1:1"].contains(&request.parameters.aspect_ratio.as_str()) {
        return Err("画幅无效".into());
    }
    if request.connection.model.len() > 160
        || request.connection.model.chars().any(char::is_control)
    {
        return Err("模型名称无效".into());
    }
    for reference in &request.references {
        if !["reference", "start", "end", "extend"].contains(&reference.role.as_str()) {
            return Err("参考用途无效".into());
        }
        let (version, _) = media::version_file(app, &request.project_id, &reference.version_id)?;
        if reference.role == "extend" && !version.mime_type.starts_with("video/") {
            return Err("续接输入必须是视频".into());
        }
        if reference.role != "extend"
            && !["image/png", "image/jpeg", "image/webp"].contains(&version.mime_type.as_str())
        {
            return Err("图片参考仅接受 PNG、JPEG 或 WebP".into());
        }
    }
    crate::media_adapters::validate(app, request)?;
    media::tool("ffprobe")?;
    media::tool("ffmpeg")?;
    Ok(())
}

// Never resurrect a submission after a crash. A handle or verified local output is required.
pub(crate) fn reconcile(app: &tauri::AppHandle, project_id: &str) -> Result<(), String> {
    let runtime = app.state::<MediaRuntime>();
    let running = runtime.running.lock().map_err(|_| "媒体运行状态不可用")?;
    let db = media::database(app)?;
    let mut statement = db.prepare("SELECT payload FROM media_jobs WHERE project_id=?1 AND status IN ('queued','submitting','running','downloading')").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([project_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for payload in rows {
        let mut job: Job = serde_json::from_str(&payload.map_err(|e| e.to_string())?)
            .map_err(|_| "任务元数据损坏".to_string())?;
        if running.contains_key(&job.id) {
            continue;
        }
        if job.request.connection.kind == "cli" {
            crate::media_codex::cleanup_profile(&directory(app, &job.id)?);
        }
        job.error = Some(
            if job.remote_id.is_some() {
                "应用曾中断等待；可恢复查询／下载同一远端任务，不会重新提交"
            } else if job.status == "queued" {
                "应用在提交前退出；未自动重新提交，请明确发起新任务"
            } else {
                "应用在生成过程中退出；可能已经消耗额度，可先尝试收录本地结果，不会重新生成"
            }
            .into(),
        );
        job.status = if job.status == "submitting" && job.request.connection.kind == "api" {
            "submission_unknown"
        } else {
            "failed"
        }
        .into();
        save(app, &mut job)?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn media_submit(app: tauri::AppHandle, request: Request) -> Result<Job, String> {
    submit_requests(app, None, vec![request])?
        .into_iter()
        .next()
        .ok_or_else(|| "未创建生成任务".into())
}

#[tauri::command]
pub(crate) fn media_submit_batch(
    app: tauri::AppHandle,
    batch_id: String,
    requests: Vec<Request>,
) -> Result<Vec<Job>, String> {
    media::valid_id(&batch_id)?;
    submit_requests(app, Some(batch_id), requests)
}

fn submit_requests(
    app: tauri::AppHandle,
    batch_id: Option<String>,
    requests: Vec<Request>,
) -> Result<Vec<Job>, String> {
    let first = requests.first().ok_or("请先选择要生成的镜头")?;
    if requests.len() > MAX_BATCH_JOBS {
        return Err("一次批量计划最多 20 个任务，请缩小范围".into());
    }
    let project_id = first.project_id.clone();
    let capability = first.capability.clone();
    let connection = serde_json::to_value(&first.connection).map_err(|e| e.to_string())?;
    let mut targets = HashSet::new();
    for request in &requests {
        if request.project_id != project_id
            || request.capability != capability
            || serde_json::to_value(&request.connection).map_err(|e| e.to_string())? != connection
            || !targets.insert(request.target_id.clone())
        {
            return Err("批量计划必须使用同一项目、能力和执行端，镜头不能重复".into());
        }
        validate(&app, request)?;
    }
    let state = app.state::<MediaRuntime>();
    let mut running = state.running.lock().map_err(|_| "媒体运行状态不可用")?;
    if running.len() + requests.len() > MAX_QUEUED_JOBS {
        return Err("本机运行及排队任务最多 32 项，请等待或取消已有任务".into());
    }
    let mut db = media::database(&app)?;
    let transaction = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    {
        let mut statement = transaction
            .prepare("SELECT payload FROM media_jobs WHERE project_id=?1")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([&project_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let prior: Job = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                .map_err(|_| "任务记录损坏".to_string())?;
            if batch_id.is_some() && prior.batch_id == batch_id {
                return Err("此批次已登记，请先在任务中心核对；不会重复提交生成".into());
            }
            if targets.contains(&prior.target_id)
                && prior.capability == capability
                && ["queued", "submitting", "running", "downloading"]
                    .contains(&prior.status.as_str())
            {
                return Err("所选镜头已有同类任务，请等待、取消或恢复核对后重新预览".into());
            }
        }
    }
    crate::project_deletion::ensure_live(&transaction, &project_id)?;
    let time = media::now();
    let mut prepared = Vec::with_capacity(requests.len());
    for (index, request) in requests.into_iter().enumerate() {
        let job = Job {
            id: media::new_id(),
            project_id: request.project_id.clone(),
            target_id: request.target_id.clone(),
            capability: request.capability.clone(),
            status: "queued".into(),
            created_at: time.clone(),
            updated_at: time.clone(),
            remote_id: None,
            asset_id: None,
            error: None,
            request,
            restored: false,
            batch_id: batch_id.clone(),
            batch_index: batch_id.as_ref().map(|_| index),
        };
        directory(&app, &job.id)?;
        persist(&transaction, &job)?;
        prepared.push((job, CancellationToken::new()));
    }
    // No worker starts until every approved input has committed successfully.
    transaction.commit().map_err(|e| e.to_string())?;
    for (job, token) in &prepared {
        running.insert(job.id.clone(), token.clone());
    }
    drop(running);
    let jobs = prepared.iter().map(|(job, _)| job.clone()).collect();
    for (job, token) in prepared {
        spawn(app.clone(), job, token, false);
    }
    Ok(jobs)
}

fn cancel_inactive_job(app: &tauri::AppHandle, job: &mut Job) -> Result<(), String> {
    if !["queued", "submitting", "running", "downloading"].contains(&job.status.as_str()) {
        return Ok(());
    }
    let unknown = job.status == "submitting"
        && job.request.connection.kind == "api"
        && job.remote_id.is_none();
    job.status = if unknown {
        "submission_unknown"
    } else {
        "cancelled"
    }
    .into();
    job.error = Some(if unknown {
        "已停止本地等待；原提交结果仍未知，远端可能已接受并计费；请核对供应商记录，不会自动重新提交"
            .into()
    } else {
        "已停止本地等待，远端任务和已有文件保留；远端可能继续生成并计费".into()
    });
    save(app, job)
}

#[tauri::command]
pub(crate) fn media_cancel_batch(
    app: tauri::AppHandle,
    project_id: String,
    batch_id: String,
) -> Result<Vec<Job>, String> {
    media::valid_id(&project_id)?;
    media::valid_id(&batch_id)?;
    let state = app.state::<MediaRuntime>();
    let running = state.running.lock().map_err(|_| "媒体运行状态不可用")?;
    // Read after locking: a worker removes its token only after final persistence.
    let db = media::database(&app)?;
    let mut statement = db
        .prepare("SELECT payload FROM media_jobs WHERE project_id=?1")
        .map_err(|e| e.to_string())?;
    let mut jobs = statement
        .query_map([&project_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|row| {
            serde_json::from_str::<Job>(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    jobs.retain(|job| job.batch_id.as_deref() == Some(batch_id.as_str()));
    if jobs.is_empty() {
        return Err("批次不存在或不属于当前项目".into());
    }
    for job in &mut jobs {
        if let Some(token) = running.get(&job.id) {
            token.cancel();
            job.error = Some("正在停止本批次等待与后续步骤；已有产物保留，远端可能继续计费".into());
        } else {
            cancel_inactive_job(&app, job)?;
        }
    }
    jobs.sort_by_key(|job| job.batch_index);
    Ok(jobs)
}

#[tauri::command]
pub(crate) fn media_cancel(
    app: tauri::AppHandle,
    project_id: String,
    job_id: String,
) -> Result<Job, String> {
    let state = app.state::<MediaRuntime>();
    let running = state.running.lock().map_err(|_| "媒体运行状态不可用")?;
    let mut job = load(&app, &project_id, &job_id)?;
    if let Some(token) = running.get(&job_id) {
        token.cancel();
        job.error = Some("正在停止等待与后续步骤；不会承诺远端任务停止计费".into());
    } else {
        cancel_inactive_job(&app, &mut job)?;
    }
    Ok(job)
}

#[tauri::command]
pub(crate) fn media_resume(
    app: tauri::AppHandle,
    project_id: String,
    job_id: String,
    api_key: Option<String>,
) -> Result<Job, String> {
    let state = app.state::<MediaRuntime>();
    let mut running = state.running.lock().map_err(|_| "媒体运行状态不可用")?;
    // Re-read under the token lock so a completed worker cannot leave a stale snapshot.
    let mut job = load(&app, &project_id, &job_id)?;
    if job.status == "completed" {
        return Ok(job);
    }
    if job.restored {
        return Err(
            "恢复的历史任务仅供追溯，不复用原执行端或远端授权；请明确发起新的创作任务".into(),
        );
    }
    crate::media_adapters::check_recovery_route(&job.request)?;
    if running.contains_key(&job_id) {
        return Err("任务仍在运行，不重复恢复".into());
    }
    if running.len() >= MAX_QUEUED_JOBS {
        return Err("请等待其他媒体任务结束".into());
    }
    if let Some(key) = &api_key {
        if key.len() > 8192 || key.contains(['\r', '\n']) {
            return Err("密钥格式无效".into());
        }
    }
    job.request.api_key = api_key;
    // A local recovery attempt cannot resolve whether the original POST was accepted.
    if job.status != "submission_unknown" || job.remote_id.is_some() {
        job.status = if job.remote_id.is_some() {
            "running"
        } else {
            "downloading"
        }
        .into();
    }
    job.error = None;
    save(&app, &mut job)?;
    let token = CancellationToken::new();
    running.insert(job.id.clone(), token.clone());
    drop(running);
    spawn(app.clone(), job.clone(), token, true);
    Ok(job)
}

fn spawn(app: tauri::AppHandle, mut job: Job, token: CancellationToken, resume: bool) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<MediaRuntime>();
        let permit = tokio::select! {
            biased;
            _ = token.cancelled() => None,
            result = state.active.acquire() => result.ok(),
        };
        let result = match permit {
            Some(_permit) if !token.is_cancelled() => {
                if resume {
                    restore(&app, &mut job, &token).await
                } else {
                    execute(&app, &mut job, &token).await
                }
            }
            _ => Err("尚未开始，已停止本地任务".into()),
        };
        if let Err(error) = result {
            let unknown = job.request.connection.kind == "api"
                && ["submitting", "submission_unknown"].contains(&job.status.as_str())
                && job.remote_id.is_none();
            job.status = if unknown {
                "submission_unknown"
            } else if token.is_cancelled() {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            job.error = Some(if unknown && resume {
                "未恢复到可验证结果；原提交结果仍未知，远端可能已接受并计费；请核对供应商记录，不会自动重新提交".into()
            } else if unknown {
                "提交结果未知，远端可能已接受并计费；请核对供应商记录，不会自动重新提交".into()
            } else if token.is_cancelled() {
                "已停止本地等待和后续步骤。远端可能继续生成并计费；已有句柄和文件保留".into()
            } else {
                error
            });
            let _ = save(&app, &mut job);
        }
        // Keep the token registered through final persistence so readers never reconcile a live job.
        if let Ok(mut running) = app.state::<MediaRuntime>().running.lock() {
            running.remove(&job.id);
        }
    });
}

async fn execute(
    app: &tauri::AppHandle,
    job: &mut Job,
    token: &CancellationToken,
) -> Result<(), String> {
    crate::media_adapters::run(app, job, token, false).await?;
    collect(app, job, token).await
}

async fn restore(
    app: &tauri::AppHandle,
    job: &mut Job,
    token: &CancellationToken,
) -> Result<(), String> {
    crate::media_adapters::run(app, job, token, true).await?;
    collect(app, job, token).await
}

async fn collect(
    app: &tauri::AppHandle,
    job: &mut Job,
    token: &CancellationToken,
) -> Result<(), String> {
    job.status = "downloading".into();
    save(app, job)?;
    let task = directory(app, &job.id)?;
    let native_receipt = if job.request.connection.kind == "cli" {
        Some(crate::media_codex::recover(&task, &job.id)?)
    } else {
        None
    };
    let output_root = task
        .join("outputs")
        .canonicalize()
        .map_err(|_| "CLI 未交付输出文件；文字回复不算生成成功".to_string())?;
    if !output_root.starts_with(&task) {
        return Err("生成输出目录越界".into());
    }
    let mut paths: Vec<PathBuf> = fs::read_dir(&output_root)
        .map_err(|e| e.to_string())?
        .map(|entry| entry.map(|entry| entry.path()).map_err(|e| e.to_string()))
        .filter(|entry| match entry {
            Ok(path) => path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name == if job.capability == "image" {
                        "image-output.bin"
                    } else {
                        "video-output.bin"
                    }
                }),
            Err(_) => true,
        })
        .take(9)
        .collect::<Result<_, _>>()?;
    paths.sort();
    if paths.is_empty() || paths.len() > 8 {
        return Err("没有生成文件或文件数量超出约定（最多 8 项）".into());
    }
    for path in paths {
        if token.is_cancelled() {
            return Err("已取消，结果文件保留".into());
        }
        let info = path.symlink_metadata().map_err(|e| e.to_string())?;
        if !info.is_file()
            || info.file_type().is_symlink()
            || !path
                .canonicalize()
                .map_err(|e| e.to_string())?
                .starts_with(&output_root)
        {
            return Err("输出包含非普通文件或越界链接，拒绝收录".into());
        }
        let artifact = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("输出文件名无效")?;
        if media::detect_format(&path)?.0 != job.capability {
            return Err("输出真实媒体类型不符合本任务，文件保留但不登记为候选".into());
        }
        let known = match media::recover_job_registration(app, job, artifact)? {
            Some(asset) => Some(asset),
            None => media::list_assets(&media::database(app)?, &job.project_id)?
                .into_iter()
                .find(|asset| {
                    asset.kind == job.capability
                        && asset.versions.iter().any(|version| {
                            version.metadata["provenance"]["jobId"] == job.id
                                && version.metadata["provenance"]["artifact"] == artifact
                        })
                }),
        };
        if let Some(asset) = known {
            let version = asset
                .versions
                .iter()
                .find(|version| {
                    version.metadata["provenance"]["jobId"] == job.id
                        && version.metadata["provenance"]["artifact"] == artifact
                })
                .ok_or("已登记产物缺少对应版本，原文件保留")?;
            let (registered_path, mime, bytes) =
                media::stored_file(app, Some(&job.project_id), &version.file_id)?;
            let (kind, actual_mime, _) = media::detect_format(&registered_path)?;
            // Metadata alone cannot prove that the previously collected file is still usable.
            if kind != job.capability
                || actual_mime != version.mime_type
                || mime != version.mime_type
                || bytes != version.bytes
                || checksum_file(&registered_path, version.bytes)?
                    != checksum_file(&path, version.bytes)?
            {
                return Err("已登记产物与任务文件不一致，原版本和任务文件保留；请恢复已有媒体，不会重新生成或新建版本".into());
            }
            job.asset_id = Some(asset.id);
            continue;
        }
        let mut provenance = json!({"source":job.request.connection.kind,"connectionId":job.request.connection.id,"model":job.request.connection.model,"jobId":job.id,"artifact":artifact,"remoteId":job.remote_id,"parameters":job.request.parameters,"references":job.request.references});
        if let Some(receipt) = &native_receipt {
            provenance["toolVerified"] = json!(true);
            provenance["toolCallId"] = json!(receipt.tool_call_id);
            provenance["planningModel"] = json!(receipt.planning_model);
            // The planning model is not the image model; native events do not identify the latter.
            provenance["model"] = Value::Null;
            provenance["imageModel"] = Value::Null;
        }
        let asset = media::import_path(
            app,
            &job.project_id,
            artifact,
            "shot",
            &path,
            Some(&job.target_id),
            provenance,
        )
        .await?;
        if asset.kind != job.capability {
            return Err("输出媒体类型不符合本任务能力，保留文件但不标记生成成功".into());
        }
        job.asset_id = Some(asset.id);
        save(app, job)?;
    }
    job.status = "completed".into();
    job.error = None;
    save(app, job)
}

pub(crate) async fn response_bytes(
    response: reqwest::Response,
    token: &CancellationToken,
    limit: usize,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("媒体响应超过大小限制".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    loop {
        let chunk = tokio::select! { _ = token.cancelled() => return Err("已停止下载".into()), chunk = stream.next() => chunk };
        let Some(chunk) = chunk else {
            break;
        };
        let chunk = chunk.map_err(|_| "媒体响应中断，保留任务供恢复".to_string())?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err("媒体响应超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub(crate) fn http_error(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        401 | 403 => "资源未授权或密钥不可用".into(),
        429 => "供应商额度不足或请求受限；未自动重试".into(),
        400 | 404 | 422 => "供应商拒绝了模型、输入或参数，请核对所选资源能力".into(),
        _ => format!("供应商返回 HTTP {}，请核对远端任务记录", status.as_u16()),
    }
}

pub(crate) async fn generate_image(
    app: &tauri::AppHandle,
    job: &mut Job,
    token: &CancellationToken,
) -> Result<(), String> {
    let request = &job.request;
    let prompt = format!(
        "{}\n期望画幅：{}。",
        request.prompt, request.parameters.aspect_ratio
    );
    let client = runtime::http_client(Duration::from_secs(600))?;
    let base = runtime::validate_base_url("api", &request.connection.base_url)?;
    let key = request.api_key.as_deref().ok_or("未提供图片 API 密钥")?;
    let builder = if request.references.is_empty() {
        client.post(runtime::endpoint_url(&base, "images/generations")?).bearer_auth(key).json(&json!({"model":request.connection.model,"prompt":prompt,"n":1,"size":request.parameters.size,"quality":request.parameters.quality}))
    } else {
        let boundary = format!("acw-{}", media::new_id());
        let mut body = Vec::new();
        for (name, value) in [
            ("model", request.connection.model.as_str()),
            ("prompt", prompt.as_str()),
            ("n", "1"),
            ("size", request.parameters.size.as_str()),
            ("quality", request.parameters.quality.as_str()),
        ] {
            write!(&mut body, "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").map_err(|e| e.to_string())?;
        }
        for (index, reference) in request.references.iter().enumerate() {
            let (version, path) = media::version_file(app, &job.project_id, &reference.version_id)?;
            if version.bytes > 50 * 1024 * 1024
                || body.len() as u64 + version.bytes > 100 * 1024 * 1024
            {
                return Err("图片参考超过单图 50 MiB／总计 100 MiB 的上传边界".into());
            }
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .ok_or("参考图片扩展名无效")?;
            write!(&mut body, "--{boundary}\r\nContent-Disposition: form-data; name=\"image[]\"; filename=\"input-{index}.{extension}\"\r\nContent-Type: {}\r\n\r\n", version.mime_type).map_err(|e| e.to_string())?;
            File::open(path)
                .map_err(|e| e.to_string())?
                .read_to_end(&mut body)
                .map_err(|e| e.to_string())?;
            body.extend_from_slice(b"\r\n");
        }
        write!(&mut body, "--{boundary}--\r\n").map_err(|e| e.to_string())?;
        client
            .post(runtime::endpoint_url(&base, "images/edits")?)
            .bearer_auth(key)
            .header(
                reqwest::header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body)
    };
    if token.is_cancelled() {
        return Err("已取消，尚未提交".into());
    }
    job.status = "submitting".into();
    save(app, job)?;
    let response = tokio::select! { _ = token.cancelled() => return Err("提交中止".into()), result = builder.send() => result.map_err(|_| "提交连接中断".to_string())? };
    if !response.status().is_success() {
        // Explicit 4xx is a rejection. A server error can occur after acceptance.
        if response.status().is_client_error() {
            job.status = "failed".into();
        }
        return Err(http_error(response.status()));
    }
    let bytes = response_bytes(response, token, 100 * 1024 * 1024).await?;
    atomic_file(&directory(app, &job.id)?, "image-response.json", &bytes)?;
    job.status = "downloading".into();
    save(app, job)?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "图片响应不是有效 JSON，缓存保留供检查".to_string())?;
    save_image_response(app, job, &value)
}

pub(crate) fn save_image_response(
    app: &tauri::AppHandle,
    job: &Job,
    value: &Value,
) -> Result<(), String> {
    let encoded = value["data"]
        .as_array()
        .and_then(|items| items.first())
        .and_then(|item| item["b64_json"].as_str())
        .ok_or("该资源没有返回 b64_json 图片字节；当前适配器不把 URL 或文字当作图片成功")?;
    let bytes = decode_base64(encoded, 64 * 1024 * 1024)?;
    let outputs = directory(app, &job.id)?.join("outputs");
    fs::create_dir_all(&outputs).map_err(|e| e.to_string())?;
    atomic_file(&outputs, "image-output.bin", &bytes)?;
    Ok(())
}

pub(crate) fn decode_base64(value: &str, limit: usize) -> Result<Vec<u8>, String> {
    let input = value.as_bytes();
    if input.is_empty() || input.len() % 4 != 0 || input.len() > limit.div_ceil(3) * 4 {
        return Err("图片字节编码无效或超限".into());
    }
    let decode = |byte: u8| -> Result<u8, String> {
        match byte {
            b'A'..=b'Z' => Ok(byte - b'A'),
            b'a'..=b'z' => Ok(byte - b'a' + 26),
            b'0'..=b'9' => Ok(byte - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err("图片字节编码无效".into()),
        }
    };
    let mut output = Vec::with_capacity(input.len() / 4 * 3);
    for (index, chunk) in input.chunks_exact(4).enumerate() {
        let a = decode(chunk[0])?;
        let b = decode(chunk[1])?;
        let last = index == input.len() / 4 - 1;
        output.push((a << 2) | (b >> 4));
        if chunk[2] == b'=' {
            if !last || chunk[3] != b'=' || b & 15 != 0 {
                return Err("图片编码填充无效".into());
            }
        } else {
            let c = decode(chunk[2])?;
            output.push((b << 4) | (c >> 2));
            if chunk[3] == b'=' {
                if !last || c & 3 != 0 {
                    return Err("图片编码填充无效".into());
                }
            } else {
                output.push((c << 6) | decode(chunk[3])?);
            }
        }
    }
    if output.len() > limit {
        return Err("解码图片超过大小限制".into());
    }
    Ok(output)
}

pub(crate) fn encode_base64(bytes: &[u8]) -> String {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied().unwrap_or(0);
        let c = chunk.get(2).copied().unwrap_or(0);
        output.push(alphabet[(a >> 2) as usize] as char);
        output.push(alphabet[(((a & 3) << 4) | (b >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            alphabet[(((b & 15) << 2) | (c >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            alphabet[(c & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}

pub(crate) async fn generate_cli(
    app: &tauri::AppHandle,
    job: &mut Job,
    token: &CancellationToken,
) -> Result<(), String> {
    let runtime_state = app.state::<runtime::RuntimeState>();
    let wait = async {
        loop {
            if token.is_cancelled() {
                return Err("等待 CLI 期间已取消".to_string());
            }
            if runtime_state
                .cli_running
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                return Ok(());
            }
            tokio::select! {
                _ = token.cancelled() => return Err("等待 CLI 期间已取消".into()),
                _ = tokio::time::sleep(Duration::from_millis(250)) => {},
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(900), wait)
        .await
        .map_err(|_| "等待 CLI 超时，尚未开始生成".to_string())??;
    // RAII releases the shared text/image CLI lock on cancellation and every error path.
    struct Guard<'a>(&'a std::sync::atomic::AtomicBool);
    impl Drop for Guard<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _guard = Guard(&runtime_state.cli_running);
    let task = directory(app, &job.id)?;
    let inputs = task.join("inputs");
    let outputs = task.join("outputs");
    fs::create_dir_all(&inputs).map_err(|e| e.to_string())?;
    fs::create_dir_all(&outputs).map_err(|e| e.to_string())?;
    let mut paths = vec![];
    let mut reference_bytes = 0u64;
    for (index, reference) in job.request.references.iter().enumerate() {
        let (version, source) = media::version_file(app, &job.project_id, &reference.version_id)?;
        if version.bytes > 50 * 1024 * 1024 {
            return Err("CLI 单张参考图片限 50 MiB".into());
        }
        reference_bytes = reference_bytes
            .checked_add(version.bytes)
            .ok_or("参考图片长度溢出")?;
        if reference_bytes > 100 * 1024 * 1024 {
            return Err("CLI 参考图片总量限 100 MiB".into());
        }
        let path = inputs.join(format!(
            "input-{index}.{}",
            source
                .extension()
                .and_then(|ext| ext.to_str())
                .ok_or("参考类型无效")?
        ));
        fs::copy(source, &path).map_err(|e| e.to_string())?;
        paths.push(path);
    }
    crate::media_codex::generate(app, job, token, &paths).await
}
