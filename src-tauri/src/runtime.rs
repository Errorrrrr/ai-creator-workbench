use futures_util::StreamExt;
use reqwest::{Client, Response, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, State, WebviewWindow};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    time::{sleep_until, timeout, timeout_at, Instant as TokioInstant},
};
use tokio_util::sync::CancellationToken;

const TEST_TIMEOUT: Duration = Duration::from_secs(8);
const GENERATION_TIMEOUT: Duration = Duration::from_secs(120);
const PROVIDER_TOTAL_TIMEOUT: Duration = Duration::from_secs(600);
const PROVIDER_FIRST_RESPONSE_TIMEOUT: Duration = Duration::from_secs(120);
const PROVIDER_IDLE_TIMEOUT: Duration = Duration::from_secs(45);
const CLI_DETECTION_TIMEOUT: Duration = Duration::from_secs(3);
const PROCESS_CLEANUP_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_VERSION_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES: usize = 96 * 1024;
const MAX_STDOUT_BYTES: usize = 1024 * 1024;
const MAX_STDERR_BYTES: usize = 64 * 1024;
const MAX_CANCEL_TOMBSTONES: usize = 128;

#[derive(Default)]
struct TaskRegistry {
    running: HashMap<String, Arc<CancellationToken>>,
    cancelled_before_register: HashSet<String>,
}

#[derive(Default)]
pub(crate) struct RuntimeState {
    tasks: Mutex<TaskRegistry>,
    pub(crate) cli_running: AtomicBool,
}

impl RuntimeState {
    fn register(&self, task_id: &str) -> Result<Arc<CancellationToken>, String> {
        if task_id.is_empty() || task_id.len() > 96 {
            return Err("生成任务 ID 无效".into());
        }
        let token = Arc::new(CancellationToken::new());
        let mut registry = self.tasks.lock().map_err(|_| "运行时状态不可用")?;
        if registry.cancelled_before_register.remove(task_id) {
            token.cancel();
        }
        if let Some(previous) = registry.running.insert(task_id.to_owned(), token.clone()) {
            previous.cancel();
        }
        Ok(token)
    }

    fn finish(&self, task_id: &str, token: &Arc<CancellationToken>) {
        if let Ok(mut registry) = self.tasks.lock() {
            let owns_registration = registry
                .running
                .get(task_id)
                .is_some_and(|current| Arc::ptr_eq(current, token));
            if owns_registration {
                registry.running.remove(task_id);
            }
        }
    }

    fn cancel(&self, task_id: &str) -> bool {
        if task_id.is_empty() || task_id.len() > 96 {
            return false;
        }
        let Ok(mut registry) = self.tasks.lock() else {
            return false;
        };
        if let Some(token) = registry.running.get(task_id) {
            token.cancel();
            true
        } else {
            if registry.cancelled_before_register.len() >= MAX_CANCEL_TOMBSTONES {
                registry.cancelled_before_register.clear();
            }
            registry
                .cancelled_before_register
                .insert(task_id.to_owned());
            true
        }
    }
}

struct CliDriverDefinition {
    id: &'static str,
    name: &'static str,
    command: &'static str,
    version_args: &'static [&'static str],
    generate_args: &'static [&'static str],
    credential_name: Option<&'static str>,
}

const CLAUDE_GENERATE_ARGS: &[&str] = &[
    "--print",
    "--bare",
    "--output-format",
    "text",
    "--permission-mode",
    "dontAsk",
    "--tools",
    "",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--no-chrome",
];

const CODEX_GENERATE_ARGS: &[&str] = &[
    "exec",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "--json",
    "-c",
    "approval_policy=\"never\"",
];
const CLAUDE_LOGIN_ARGS: &[&str] = &[
    "--print",
    "--output-format",
    "text",
    "--permission-mode",
    "dontAsk",
    "--tools",
    "",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--no-chrome",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    "{\"mcpServers\":{}}",
    "--settings",
    "{\"disableAllHooks\":true}",
];

const ANTIGRAVITY_GENERATE_ARGS: &[&str] = &[
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--mode",
    "plan",
    "--sandbox",
    "--disable-slash-commands",
    "--print-timeout",
    "110s",
];

fn cli_drivers() -> [CliDriverDefinition; 4] {
    [
        CliDriverDefinition {
            id: "antigravity",
            name: "Antigravity CLI",
            command: "agy",
            version_args: &["--help"],
            generate_args: ANTIGRAVITY_GENERATE_ARGS,
            credential_name: None,
        },
        CliDriverDefinition {
            id: "codex",
            name: "Codex CLI",
            command: "codex",
            version_args: &["exec", "--help"],
            generate_args: CODEX_GENERATE_ARGS,
            credential_name: None,
        },
        CliDriverDefinition {
            id: "claude",
            name: "Claude Code",
            command: "claude",
            version_args: &["--help"],
            generate_args: CLAUDE_GENERATE_ARGS,
            credential_name: Some("ANTHROPIC_API_KEY"),
        },
        CliDriverDefinition {
            id: "gemini",
            name: "Gemini CLI",
            command: "gemini",
            version_args: &["--version"],
            generate_args: &[],
            credential_name: None,
        },
    ]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeSnapshot {
    platform: String,
    architecture: String,
    drivers: Vec<CliDriverStatus>,
    checked_at: String,
    ollama: OllamaStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliDriverStatus {
    id: String,
    name: String,
    status: String,
    executable_path: Option<String>,
    version: Option<String>,
    can_generate: bool,
    execution_status: String,
    binary_architecture: Option<String>,
    compatibility: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OllamaStatus {
    status: String,
    models: Vec<OllamaModel>,
}

#[derive(Serialize)]
struct OllamaModel {
    name: String,
    size: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionInput {
    kind: String,
    base_url: String,
    model: String,
    api_key: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionTestResult {
    status: String,
    models: Vec<String>,
    latency_ms: u128,
}

#[derive(Clone, Deserialize, Serialize)]
struct MessageInput {
    role: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GenerationRequest {
    task_id: String,
    kind: String,
    base_url: String,
    model: String,
    api_key: Option<String>,
    driver_id: Option<String>,
    #[serde(default)]
    allow_user_profile: bool,
    messages: Vec<MessageInput>,
}

#[derive(Serialize)]
pub(crate) struct GenerationResult {
    output: String,
}

#[tauri::command]
pub(crate) async fn embed_text(
    base_url: String,
    model: String,
    texts: Vec<String>,
) -> Result<Vec<Vec<f64>>, String> {
    if model.trim().is_empty()
        || model.len() > 200
        || texts.is_empty()
        || texts.len() > 8
        || texts.iter().any(|text| text.len() > 16000)
    {
        return Err("Embedding 请求参数超出限制".into());
    }
    let url = validate_base_url("ollama", &base_url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法建立请求")?;
    let response = client
        .post(endpoint_url(&url, "api/embed")?)
        .json(&json!({"model": model, "input": texts}))
        .send()
        .await
        .map_err(|_| "无法连接本机 Embedding 模型，请检查 Ollama 服务")?;
    if !response.status().is_success() {
        return Err(provider_status_error(response.status()));
    }
    let payload = response_json(response, &CancellationToken::new()).await?;
    let vectors: Vec<Vec<f64>> =
        serde_json::from_value(payload["embeddings"].clone()).map_err(|_| "Embedding 响应无效")?;
    if vectors.len() != texts.len()
        || vectors
            .iter()
            .any(|v| v.is_empty() || v.len() > 8192 || v.iter().any(|x| !x.is_finite()))
    {
        return Err("Embedding 向量无效".into());
    }
    Ok(vectors)
}

pub(crate) fn trusted_executable_directories() -> Vec<PathBuf> {
    let mut directories = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        directories.push(home.join(".local/bin"));
        directories.push(home.join(".cargo/bin"));
    }
    directories
}

pub(crate) fn find_executable(command: &str) -> Option<PathBuf> {
    trusted_executable_directories()
        .into_iter()
        .map(|directory| directory.join(command))
        .find(|path| path.is_file())
}

fn display_executable_path(path: &Path) -> String {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .and_then(|home| path.strip_prefix(home).ok().map(Path::to_path_buf))
        .map(|relative| PathBuf::from("~").join(relative))
        .unwrap_or_else(|| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn inspect_executable_compatibility(path: &Path) -> (Option<String>, String) {
    if std::env::consts::OS != "macos" {
        return (None, "unknown".into());
    }
    let output = StdCommand::new("/usr/bin/file")
        .env_clear()
        .args(["-Lb"])
        .arg(path)
        .output();
    let Ok(output) = output else {
        return (None, "unknown".into());
    };
    let description = String::from_utf8_lossy(&output.stdout).to_lowercase();
    let has_arm64 = description.contains("arm64") || description.contains("aarch64");
    let has_x64 = description.contains("x86_64");
    if std::env::consts::ARCH == "aarch64" && has_x64 && !has_arm64 {
        return (Some("x86_64".into()), "translated".into());
    }
    if has_arm64 {
        return (Some("arm64".into()), "native".into());
    }
    if has_x64 {
        return (
            Some("x86_64".into()),
            if std::env::consts::ARCH == "x86_64" {
                "native".into()
            } else {
                "unknown".into()
            },
        );
    }
    (None, "script".into())
}

fn execution_status(driver: &CliDriverDefinition) -> &'static str {
    if driver.generate_args.is_empty() {
        return "disabled";
    }
    if driver.id != "claude"
        && driver
            .credential_name
            .is_some_and(|name| std::env::var_os(name).is_none())
    {
        return "credential_required";
    }
    "available"
}

async fn inspect_cli(driver: &CliDriverDefinition) -> CliDriverStatus {
    let execution_status = execution_status(driver);
    let Some(path) = find_executable(driver.command) else {
        return CliDriverStatus {
            id: driver.id.into(),
            name: driver.name.into(),
            status: "not_found".into(),
            executable_path: None,
            version: None,
            can_generate: false,
            execution_status: execution_status.into(),
            binary_architecture: None,
            compatibility: "unknown".into(),
        };
    };
    let (binary_architecture, compatibility) = inspect_executable_compatibility(&path);
    let error_status = || CliDriverStatus {
        id: driver.id.into(),
        name: driver.name.into(),
        status: "error".into(),
        executable_path: Some(display_executable_path(&path)),
        version: None,
        can_generate: false,
        execution_status: execution_status.into(),
        binary_architecture: binary_architecture.clone(),
        compatibility: compatibility.clone(),
    };
    let Ok(run_directory) = tempfile::Builder::new()
        .prefix("ai-creator-cli-detect-")
        .tempdir()
    else {
        return error_status();
    };
    let Ok(trusted_path) = std::env::join_paths(trusted_executable_directories()) else {
        return error_status();
    };
    let mut command = Command::new(&path);
    command
        .args(driver.version_args)
        .current_dir(run_directory.path())
        .env_clear()
        .env("HOME", run_directory.path())
        .env("TMPDIR", run_directory.path())
        .env("XDG_CONFIG_HOME", run_directory.path().join(".config"))
        .env("XDG_DATA_HOME", run_directory.path().join(".local/share"))
        .env("XDG_CACHE_HOME", run_directory.path().join(".cache"))
        .env("PATH", trusted_path)
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .env("LANG", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    let Ok(mut child) = command.spawn() else {
        return error_status();
    };
    let process_group_id = child.id();
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        terminate_and_reap(&mut child, process_group_id).await;
        return error_status();
    };
    let mut stdout_task = tokio::spawn(read_limited(stdout, MAX_VERSION_OUTPUT_BYTES));
    let mut stderr_task = tokio::spawn(read_limited(stderr, MAX_VERSION_OUTPUT_BYTES));
    let deadline = TokioInstant::now() + CLI_DETECTION_TIMEOUT;
    let status = match timeout_at(deadline, child.wait()).await {
        Ok(Ok(status)) => status,
        _ => {
            terminate_and_reap(&mut child, process_group_id).await;
            stdout_task.abort();
            stderr_task.abort();
            return error_status();
        }
    };
    terminate_process_group(&mut child, process_group_id);
    let drain_result = timeout_at(deadline, async {
        tokio::join!(&mut stdout_task, &mut stderr_task)
    })
    .await;
    let (stdout, stdout_exceeded, stderr, stderr_exceeded) = match drain_result {
        Ok((Ok((stdout, stdout_exceeded)), Ok((stderr, stderr_exceeded)))) => {
            (stdout, stdout_exceeded, stderr, stderr_exceeded)
        }
        _ => {
            terminate_process_group(&mut child, process_group_id);
            stdout_task.abort();
            stderr_task.abort();
            return error_status();
        }
    };
    if !status.success() || stdout_exceeded || stderr_exceeded {
        return error_status();
    }
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&stdout),
        String::from_utf8_lossy(&stderr)
    );
    let required_flags: &[&str] = match driver.id {
        "codex" => &[
            "--sandbox",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--output-last-message",
        ],
        "claude" => &[
            "--bare",
            "--tools",
            "--setting-sources",
            "--strict-mcp-config",
            "--no-session-persistence",
            "--disable-slash-commands",
        ],
        _ => &[],
    };
    if !required_flags.iter().all(|flag| combined.contains(flag)) {
        return error_status();
    }
    if driver.id == "antigravity"
        && ![
            "--input-format",
            "--output-format",
            "--sandbox",
            "--mode",
            "--disable-slash-commands",
            "--print-timeout",
        ]
        .iter()
        .all(|flag| combined.contains(flag))
    {
        return error_status();
    }
    CliDriverStatus {
        id: driver.id.into(),
        name: driver.name.into(),
        status: "ready".into(),
        executable_path: Some(display_executable_path(&path)),
        version: if matches!(driver.id, "antigravity" | "codex" | "claude") {
            Some("非交互调用参数已检测".into())
        } else {
            combined
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(|line| line.chars().take(160).collect())
        },
        can_generate: execution_status == "available",
        execution_status: execution_status.into(),
        binary_architecture,
        compatibility,
    }
}

pub(crate) fn http_client(timeout_duration: Duration) -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(timeout_duration)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化桌面网络客户端".into())
}

fn is_loopback_host(url: &Url) -> bool {
    url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    })
}

pub(crate) fn validate_base_url(kind: &str, value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(|_| "执行端地址格式无效")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("执行端地址不能包含凭据、查询参数或片段".into());
    }
    if kind == "ollama" {
        if url.scheme() != "http" || !is_loopback_host(&url) {
            return Err("Ollama 桌面连接只允许本机 HTTP 地址".into());
        }
    } else if url.scheme() != "https" && !(url.scheme() == "http" && is_loopback_host(&url)) {
        return Err("模型 API 必须使用 HTTPS；本机回环地址可使用 HTTP".into());
    }
    Ok(url)
}

pub(crate) fn endpoint_url(base: &Url, suffix: &str) -> Result<Url, String> {
    Url::parse(&format!(
        "{}/{}",
        base.as_str().trim_end_matches('/'),
        suffix.trim_start_matches('/')
    ))
    .map_err(|_| "执行端接口地址无效".into())
}

async fn response_json(response: Response, token: &CancellationToken) -> Result<Value, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROVIDER_RESPONSE_BYTES as u64)
    {
        return Err("执行端响应超过 2 MiB 限制".into());
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    loop {
        let next = tokio::select! {
            _ = token.cancelled() => return Err("生成已取消".into()),
            chunk = stream.next() => chunk,
        };
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk.map_err(|_| "读取执行端响应失败")?;
        if body.len().saturating_add(chunk.len()) > MAX_PROVIDER_RESPONSE_BYTES {
            return Err("执行端响应超过 2 MiB 限制".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "执行端返回了无法解析的数据".into())
}

fn provider_status_error(status: StatusCode) -> String {
    match status.as_u16() {
        401 | 403 => "鉴权失败，请检查 API Key".into(),
        404 => "接口或模型不存在".into(),
        429 => "请求受限，请稍后重试".into(),
        code => format!("执行端返回 HTTP {code}"),
    }
}

async fn detect_ollama(base_url: &str) -> OllamaStatus {
    let Ok(client) = http_client(Duration::from_millis(2500)) else {
        return OllamaStatus {
            status: "not_running".into(),
            models: Vec::new(),
        };
    };
    let url = match validate_base_url("ollama", base_url)
        .and_then(|url| endpoint_url(&url, "api/tags"))
    {
        Ok(url) => url,
        Err(_) => {
            return OllamaStatus {
                status: "invalid_url".into(),
                models: Vec::new(),
            }
        }
    };
    let response = client.get(url).send().await;
    let Ok(response) = response else {
        return OllamaStatus {
            status: "not_running".into(),
            models: Vec::new(),
        };
    };
    if !response.status().is_success() {
        return OllamaStatus {
            status: "not_running".into(),
            models: Vec::new(),
        };
    }
    let payload = response_json(response, &CancellationToken::new())
        .await
        .unwrap_or(Value::Null);
    if model_names(&payload, "ollama").is_err() {
        return OllamaStatus {
            status: "invalid_response".into(),
            models: Vec::new(),
        };
    }
    let models: Vec<OllamaModel> = payload
        .get("models")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let name = item.get("name")?.as_str()?.to_owned();
                    Some(OllamaModel {
                        name,
                        size: item.get("size").and_then(Value::as_u64).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    OllamaStatus {
        status: if models.is_empty() {
            "no_models"
        } else {
            "ready"
        }
        .into(),
        models,
    }
}

#[tauri::command]
pub(crate) async fn runtime_snapshot(
    ollama_base_url: Option<String>,
) -> Result<RuntimeSnapshot, String> {
    let definitions = cli_drivers();
    let drivers = futures_util::future::join_all(definitions.iter().map(inspect_cli)).await;
    let checked_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string();
    Ok(RuntimeSnapshot {
        platform: std::env::consts::OS.into(),
        architecture: if std::env::consts::ARCH == "aarch64" {
            "arm64".into()
        } else {
            std::env::consts::ARCH.into()
        },
        drivers,
        checked_at,
        ollama: detect_ollama(
            ollama_base_url
                .as_deref()
                .unwrap_or("http://127.0.0.1:11434"),
        )
        .await,
    })
}

#[tauri::command]
pub(crate) async fn connection_test(
    input: ConnectionInput,
) -> Result<ConnectionTestResult, String> {
    let started_at = Instant::now();
    let base_url = validate_base_url(&input.kind, &input.base_url)?;
    let client = http_client(TEST_TIMEOUT)?;
    let token = CancellationToken::new();
    let request = if input.kind == "openai-compatible" {
        let api_key = input
            .api_key
            .filter(|key| !key.is_empty())
            .ok_or("请输入 API Key")?;
        client
            .get(endpoint_url(&base_url, "models")?)
            .bearer_auth(api_key)
    } else if input.kind == "ollama" {
        client.get(endpoint_url(&base_url, "api/tags")?)
    } else {
        return Err("不支持的连接类型".into());
    };
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            "连接超时".to_owned()
        } else {
            "无法连接执行端".to_owned()
        }
    })?;
    if !response.status().is_success() {
        return Err(provider_status_error(response.status()));
    }
    let payload = response_json(response, &token).await?;
    let models = model_names(&payload, &input.kind)?;
    if models.is_empty() {
        return Err(if input.kind == "ollama" {
            "Ollama 已运行，但还没有安装模型"
        } else {
            "模型目录为空，无法验证可用模型"
        }
        .into());
    }
    if !input.model.is_empty() && !models.iter().any(|model| model == &input.model) {
        return Err(format!("模型 {} 不在可用列表中", input.model));
    }
    Ok(ConnectionTestResult {
        status: "ready".into(),
        models,
        latency_ms: started_at.elapsed().as_millis().max(1),
    })
}

fn model_names(payload: &Value, kind: &str) -> Result<Vec<String>, String> {
    let (list_key, name_key) = if kind == "ollama" {
        ("models", "name")
    } else {
        ("data", "id")
    };
    let items = payload
        .get(list_key)
        .and_then(Value::as_array)
        .ok_or("模型目录响应格式无效")?;
    items
        .iter()
        .map(|item| {
            item.get(name_key)
                .and_then(Value::as_str)
                .filter(|name| !name.trim().is_empty())
                .map(str::to_owned)
                .ok_or_else(|| "模型目录含有无效模型".to_owned())
        })
        .collect()
}

fn validate_messages(messages: &[MessageInput]) -> Result<(), String> {
    if messages.is_empty() || messages.len() > 12 {
        return Err("生成上下文数量无效".into());
    }
    let total_bytes = messages.iter().try_fold(0usize, |total, message| {
        if !matches!(message.role.as_str(), "system" | "user" | "assistant") {
            return Err("生成上下文角色无效".to_owned());
        }
        total
            .checked_add(message.content.len())
            .ok_or_else(|| "生成上下文过长".to_owned())
    })?;
    if total_bytes > MAX_PROMPT_BYTES {
        return Err("发送给执行端的上下文过长".into());
    }
    Ok(())
}

async fn send_generation_request(
    request: reqwest::RequestBuilder,
    token: &CancellationToken,
) -> Result<Response, String> {
    tokio::select! {
        biased;
        _ = token.cancelled() => Err("生成已取消".into()),
        response = timeout(PROVIDER_FIRST_RESPONSE_TIMEOUT, request.send()) => match response {
            Err(_) => Err("等待模型响应超过 120 秒，请检查服务或换用较小模型".into()),
            Ok(response) => response.map_err(|error| {
                if error.is_timeout() { "连接模型超时".into() } else { "无法连接执行端".into() }
            }),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerationDelta {
    task_id: String,
    delta: String,
}

#[derive(Clone, Copy)]
enum StreamFormat {
    Sse,
    JsonLines,
}

/// Keep undecoded bytes until a complete line arrives: network chunks may split UTF-8.
struct ProviderStream {
    format: StreamFormat,
    buffer: Vec<u8>,
    event_data: Vec<String>,
    received_bytes: usize,
    output: String,
    done: bool,
}

impl ProviderStream {
    fn new(format: StreamFormat) -> Self {
        Self {
            format,
            buffer: Vec::new(),
            event_data: Vec::new(),
            received_bytes: 0,
            output: String::new(),
            done: false,
        }
    }

    fn feed(&mut self, bytes: &[u8]) -> Result<Vec<String>, String> {
        self.received_bytes = self.received_bytes.saturating_add(bytes.len());
        if self.received_bytes > MAX_PROVIDER_RESPONSE_BYTES {
            return Err("执行端响应超过 2 MiB 限制".into());
        }
        self.buffer.extend_from_slice(bytes);
        let mut deltas = Vec::new();
        while let Some(index) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line = self.buffer.drain(..=index).collect::<Vec<_>>();
            let line = std::str::from_utf8(&line).map_err(|_| "执行端流包含无效文字编码")?;
            self.line(line.trim_end_matches(['\r', '\n']), &mut deltas)?;
        }
        Ok(deltas)
    }

    fn line(&mut self, line: &str, deltas: &mut Vec<String>) -> Result<(), String> {
        if self.done {
            return Ok(());
        }
        match self.format {
            StreamFormat::Sse => {
                if line.is_empty() {
                    if !self.event_data.is_empty() {
                        let data = self.event_data.join("\n");
                        self.event_data.clear();
                        self.event(&data, deltas)?;
                    }
                } else if let Some(data) = line.strip_prefix("data:") {
                    self.event_data
                        .push(data.strip_prefix(' ').unwrap_or(data).to_owned());
                }
            }
            StreamFormat::JsonLines => {
                if !line.trim().is_empty() {
                    self.event(line, deltas)?;
                }
            }
        }
        Ok(())
    }

    fn event(&mut self, data: &str, deltas: &mut Vec<String>) -> Result<(), String> {
        if data.trim() == "[DONE]" {
            self.done = true;
            return Ok(());
        }
        let payload: Value =
            serde_json::from_str(data).map_err(|_| "执行端返回了无法解析的流数据")?;
        if payload.get("error").is_some_and(|error| !error.is_null()) {
            return Err("模型在生成过程中返回错误，请检查服务日志后重试".into());
        }
        let delta = match self.format {
            StreamFormat::Sse => {
                if payload
                    .pointer("/choices/0/finish_reason")
                    .is_some_and(|value| !value.is_null())
                {
                    self.done = true;
                }
                payload
                    .pointer("/choices/0/delta/content")
                    .and_then(Value::as_str)
            }
            StreamFormat::JsonLines => {
                if payload.get("done").and_then(Value::as_bool) == Some(true) {
                    self.done = true;
                }
                payload
                    .pointer("/message/content")
                    .and_then(Value::as_str)
                    .or_else(|| payload.get("response").and_then(Value::as_str))
            }
        };
        if let Some(delta) = delta.filter(|delta| !delta.is_empty()) {
            self.output.push_str(delta);
            deltas.push(delta.to_owned());
        }
        Ok(())
    }

    fn finish(&mut self) -> Result<Vec<String>, String> {
        let mut deltas = Vec::new();
        if self.done {
            // finish_reason may precede a split [DONE] or usage-only trailer.
            self.buffer.clear();
            self.event_data.clear();
        }
        if !self.buffer.is_empty() {
            let remaining = std::mem::take(&mut self.buffer);
            let line = std::str::from_utf8(&remaining).map_err(|_| "执行端流包含无效文字编码")?;
            self.line(line.trim_end_matches('\r'), &mut deltas)?;
        }
        if !self.event_data.is_empty() {
            self.line("", &mut deltas)?;
        }
        if !self.done {
            return Err("模型输出流提前结束，当前片段尚未完成，请重试".into());
        }
        if self.output.trim().is_empty() {
            return Err("执行端返回了空内容".into());
        }
        Ok(deltas)
    }
}

fn provider_output(payload: &Value, kind: &str) -> Result<String, String> {
    if payload.get("error").is_some_and(|value| !value.is_null()) {
        return Err("模型返回错误，请检查服务日志后重试".into());
    }
    if kind == "ollama" && payload.get("done").and_then(Value::as_bool) == Some(false) {
        return Err("模型输出流提前结束，当前片段尚未完成，请重试".into());
    }
    let output = if kind == "openai-compatible" {
        payload
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
    } else {
        payload
            .pointer("/message/content")
            .and_then(Value::as_str)
            .or_else(|| payload.get("response").and_then(Value::as_str))
    }
    .unwrap_or_default();
    if output.trim().is_empty() {
        return Err("执行端返回了空内容".into());
    }
    Ok(output.to_owned())
}

async fn read_generation_response(
    response: Response,
    kind: &str,
    token: &CancellationToken,
    on_delta: &mut impl FnMut(&str) -> Result<(), String>,
) -> Result<String, String> {
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let format = if content_type.contains("text/event-stream") {
        Some(StreamFormat::Sse)
    } else if content_type.contains("ndjson") || content_type.contains("jsonl") {
        Some(StreamFormat::JsonLines)
    } else {
        None
    };
    let Some(format) = format else {
        // Some compatible providers ignore stream=true and return a normal JSON response.
        let payload = timeout(
            PROVIDER_FIRST_RESPONSE_TIMEOUT,
            response_json(response, token),
        )
        .await
        .map_err(|_| "等待模型内容超过 120 秒")??;
        let output = provider_output(&payload, kind)?;
        if token.is_cancelled() {
            return Err("生成已取消".into());
        }
        on_delta(&output)?;
        return Ok(output);
    };
    let mut parser = ProviderStream::new(format);
    let mut stream = response.bytes_stream();
    let mut received_any = false;
    loop {
        let idle_timeout = if received_any {
            PROVIDER_IDLE_TIMEOUT
        } else {
            PROVIDER_FIRST_RESPONSE_TIMEOUT
        };
        let chunk = tokio::select! {
            biased;
            _ = token.cancelled() => return Err("生成已取消".into()),
            chunk = timeout(idle_timeout, stream.next()) => chunk.map_err(|_| {
                if received_any { "模型连续 45 秒没有返回数据，已停止本次请求" } else { "等待模型内容超过 120 秒，请检查服务或换用较小模型" }
            })?,
        };
        let Some(chunk) = chunk else {
            break;
        };
        let chunk = chunk.map_err(|error| {
            if error.is_timeout() {
                "模型生成超时"
            } else {
                "读取执行端响应失败"
            }
        })?;
        received_any = true;
        for delta in parser.feed(&chunk)? {
            on_delta(&delta)?;
        }
        if parser.done {
            break;
        }
    }
    for delta in parser.finish()? {
        on_delta(&delta)?;
    }
    if token.is_cancelled() {
        return Err("生成已取消".into());
    }
    Ok(parser.output)
}

async fn generate_provider(
    request: &GenerationRequest,
    token: &CancellationToken,
    on_delta: &mut impl FnMut(&str) -> Result<(), String>,
) -> Result<String, String> {
    let base_url = validate_base_url(&request.kind, &request.base_url)?;
    if request.model.trim().is_empty() {
        return Err("请先选择模型".into());
    }
    let client = http_client(PROVIDER_TOTAL_TIMEOUT)?;
    let response = if request.kind == "openai-compatible" {
        let api_key = request
            .api_key
            .as_ref()
            .filter(|key| !key.is_empty())
            .ok_or("API Key 只保留在当前会话，请重新输入")?;
        send_generation_request(client.post(endpoint_url(&base_url, "chat/completions")?)
            .bearer_auth(api_key).json(&json!({
                "model": request.model, "messages": request.messages, "stream": true, "temperature": 0.7
            })), token).await?
    } else if request.kind == "ollama" {
        send_generation_request(
            client.post(endpoint_url(&base_url, "api/chat")?).json(
                &json!({ "model": request.model, "messages": request.messages, "stream": true }),
            ),
            token,
        )
        .await?
    } else {
        return Err("不支持的连接类型".into());
    };
    if !response.status().is_success() {
        return Err(provider_status_error(response.status()));
    }
    read_generation_response(response, &request.kind, token, on_delta).await
}

fn create_cli_prompt(messages: &[MessageInput]) -> Result<String, String> {
    validate_messages(messages)?;
    let content = messages
        .iter()
        .filter(|message| !message.content.trim().is_empty())
        .map(|message| {
            let role = if message.role == "system" {
                "系统约束"
            } else {
                "用户内容"
            };
            format!("## {role}\n{}", message.content)
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    if content.is_empty() {
        return Err("缺少可执行的创作请求".into());
    }
    Ok(format!(
        "你正在执行一次纯文本创作任务。不要调用工具、不要读取本机文件、不要修改环境；只输出可供用户审阅的中文候选内容。\n\n{content}"
    ))
}

pub(crate) async fn read_limited<R: AsyncRead + Unpin>(
    mut reader: R,
    limit: usize,
) -> (Vec<u8>, bool) {
    let mut output = Vec::with_capacity(limit.min(16 * 1024));
    let mut buffer = [0u8; 16 * 1024];
    let mut exceeded = false;
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let remaining = limit.saturating_sub(output.len());
                output.extend_from_slice(&buffer[..count.min(remaining)]);
                if count > remaining {
                    exceeded = true;
                }
            }
        }
    }
    (output, exceeded)
}

pub(crate) fn terminate_process_group(_child: &mut Child, process_group_id: Option<u32>) {
    #[cfg(unix)]
    if let Some(process_id) = process_group_id {
        unsafe {
            libc::kill(-(process_id as i32), libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = _child.start_kill();
    }
}

pub(crate) async fn terminate_and_reap(child: &mut Child, process_group_id: Option<u32>) {
    terminate_process_group(child, process_group_id);
    let _ = timeout(PROCESS_CLEANUP_TIMEOUT, child.wait()).await;
}

pub(crate) fn sanitize_cli_error(diagnostics: &str) -> &'static str {
    let value = diagnostics.to_lowercase();
    if ["login", "auth", "api key", "credential", "unauthorized"]
        .iter()
        .any(|pattern| value.contains(pattern))
    {
        "CLI 尚未登录或授权已失效"
    } else if ["avx", "architecture", "bad cpu", "exec format"]
        .iter()
        .any(|pattern| value.contains(pattern))
    {
        "CLI 与当前芯片架构不兼容"
    } else if ["rate limit", "quota", "too many requests"]
        .iter()
        .any(|pattern| value.contains(pattern))
    {
        "CLI 上游服务暂时受限"
    } else if ["network", "resolve", "dns", "connect", "socket", "timeout"]
        .iter()
        .any(|pattern| value.contains(pattern))
    {
        "CLI 无法连接上游服务"
    } else {
        "CLI 执行失败，未返回可用结果；请检查版本与运行环境"
    }
}

async fn generate_cli(
    state: &RuntimeState,
    request: &GenerationRequest,
    token: &CancellationToken,
) -> Result<String, String> {
    if state
        .cli_running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("已有一个 CLI 创作任务在运行".into());
    }
    let result = run_cli(request, token).await;
    state.cli_running.store(false, Ordering::SeqCst);
    result
}

pub(crate) fn validate_codex_model(model: &str) -> Result<(), String> {
    if !model.is_empty()
        && (model.len() > 128
            || !model.as_bytes()[0].is_ascii_alphanumeric()
            || !model
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:/-".contains(&byte)))
    {
        return Err("Codex 规划模型 ID 无效；未提交生成".into());
    }
    Ok(())
}

async fn run_cli(request: &GenerationRequest, token: &CancellationToken) -> Result<String, String> {
    let driver_id = request.driver_id.as_deref().ok_or("缺少 CLI 驱动")?;
    let model = request.model.trim();
    if driver_id == "codex" {
        validate_codex_model(model)?;
    }
    if matches!(driver_id, "antigravity" | "codex" | "claude") && !request.allow_user_profile {
        return Err("请先确认本次 CLI 调用的登录态与上下文使用".into());
    }
    let drivers = cli_drivers();
    let driver = drivers
        .iter()
        .find(|driver| driver.id == driver_id && !driver.generate_args.is_empty())
        .ok_or("该 CLI 未在受控驱动列表中")?;
    if execution_status(driver) != "available"
        && request
            .api_key
            .as_ref()
            .is_none_or(|key| key.trim().is_empty())
    {
        return Err("CLI 安全模式需要通过环境变量显式提供模型凭据".into());
    }
    let executable_path = find_executable(driver.command)
        .ok_or_else(|| format!("{} 未安装或不在受信目录中", driver.name))?;
    let prompt = create_cli_prompt(&request.messages)?;
    let prompt = if driver_id == "antigravity" {
        format!(
            "{}\n",
            json!({"event":"user", "message":{"content":prompt}})
        )
    } else {
        prompt
    };
    let run_directory = tempfile::Builder::new()
        .prefix("ai-creator-workbench-")
        .tempdir()
        .map_err(|_| "无法创建 CLI 隔离目录")?;
    let configured_model = if driver_id == "codex" && model.is_empty() {
        crate::media_codex::configured_model(&executable_path, run_directory.path(), token).await?
    } else {
        None
    };
    let model = configured_model.as_deref().unwrap_or(model);
    let mut command = Command::new(executable_path);
    let claude_login = driver_id == "claude"
        && request
            .api_key
            .as_ref()
            .is_none_or(|key| key.trim().is_empty())
        && std::env::var_os("ANTHROPIC_API_KEY").is_none();
    command
        .args(if claude_login {
            CLAUDE_LOGIN_ARGS
        } else {
            driver.generate_args
        })
        .current_dir(run_directory.path())
        .env_clear()
        .env("HOME", run_directory.path())
        .env("TMPDIR", run_directory.path())
        .env("XDG_CONFIG_HOME", run_directory.path().join(".config"))
        .env("XDG_DATA_HOME", run_directory.path().join(".local/share"))
        .env("XDG_CACHE_HOME", run_directory.path().join(".cache"))
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let trusted_path = std::env::join_paths(trusted_executable_directories())
        .map_err(|_| "无法建立 CLI 受信 PATH")?;
    command.env("PATH", trusted_path);
    if driver_id == "codex" {
        if !model.is_empty() {
            command.arg("--model").arg(model);
        }
        command
            .arg("--output-last-message")
            .arg(run_directory.path().join("answer.txt"));
        if let Some(value) = std::env::var_os("CODEX_HOME") {
            command.env("CODEX_HOME", value);
        }
    }
    if claude_login {
        command.env("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1");
        if let Some(value) = std::env::var_os("CLAUDE_CONFIG_DIR") {
            command.env("CLAUDE_CONFIG_DIR", value);
        }
    }
    if driver_id == "antigravity" || driver_id == "codex" || claude_login {
        let user_home = std::env::var_os("HOME").ok_or("无法定位 CLI 用户目录")?;
        command.env("HOME", &user_home);
        command
            .env_remove("XDG_CONFIG_HOME")
            .env_remove("XDG_DATA_HOME")
            .env_remove("XDG_CACHE_HOME");
        for name in [
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_CACHE_HOME",
            "USER",
            "LOGNAME",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "no_proxy",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
    }
    for name in ["LANG", "LC_ALL", "LC_CTYPE"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    if let Some(name) = driver.credential_name {
        if let Some(value) = request
            .api_key
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            if value.len() > 8192 {
                return Err("CLI 密钥长度超出限制".into());
            }
            command.env(name, value);
        } else if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    if token.is_cancelled() {
        return Err("生成已取消".into());
    }
    let mut child = command.spawn().map_err(|_| "无法启动 CLI")?;
    let process_group_id = child.id();
    let Some(mut stdin) = child.stdin.take() else {
        terminate_and_reap(&mut child, process_group_id).await;
        return Err("无法向 CLI 写入请求".into());
    };
    let deadline = TokioInstant::now() + GENERATION_TIMEOUT;
    let write_result: Result<(), String> = tokio::select! {
        _ = token.cancelled() => Err("生成已取消".into()),
        _ = sleep_until(deadline) => Err("CLI 生成超时".into()),
        result = stdin.write_all(prompt.as_bytes()) => {
            result.map_err(|_| "无法向 CLI 写入请求".into())
        },
    };
    if let Err(error) = write_result {
        terminate_and_reap(&mut child, process_group_id).await;
        return Err(error);
    }
    drop(stdin);
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        terminate_and_reap(&mut child, process_group_id).await;
        return Err("无法读取 CLI 输出".into());
    };
    let mut stdout_task = tokio::spawn(read_limited(stdout, MAX_STDOUT_BYTES));
    let mut stderr_task = tokio::spawn(read_limited(stderr, MAX_STDERR_BYTES));
    let status_result: Result<_, String> = tokio::select! {
        _ = token.cancelled() => Err("生成已取消".into()),
        _ = sleep_until(deadline) => Err("CLI 生成超时".into()),
        result = child.wait() => result.map_err(|_| "CLI 运行失败".into()),
    };
    let status = match status_result {
        Ok(status) => status,
        Err(error) => {
            terminate_and_reap(&mut child, process_group_id).await;
            stdout_task.abort();
            stderr_task.abort();
            return Err(error);
        }
    };
    terminate_process_group(&mut child, process_group_id);
    let drain_result: Result<_, String> = tokio::select! {
        _ = token.cancelled() => Err("生成已取消".into()),
        _ = sleep_until(deadline) => Err("CLI 生成超时".into()),
        result = async { tokio::join!(&mut stdout_task, &mut stderr_task) } => {
            match result {
                (Ok(stdout), Ok(stderr)) => Ok((stdout, stderr)),
                (Err(_), _) => Err("CLI 输出读取失败".into()),
                (_, Err(_)) => Err("CLI 状态读取失败".into()),
            }
        },
    };
    let ((stdout, stdout_exceeded), (stderr, stderr_exceeded)) = match drain_result {
        Ok(outputs) => outputs,
        Err(error) => {
            terminate_process_group(&mut child, process_group_id);
            stdout_task.abort();
            stderr_task.abort();
            return Err(error);
        }
    };
    if stdout_exceeded || stderr_exceeded {
        return Err("CLI 输出超过限制".into());
    }
    if !status.success() {
        if driver_id == "codex" {
            return Err(crate::media_codex::execution_error(
                &String::from_utf8_lossy(&stderr),
                &String::from_utf8_lossy(&stdout),
                status.code(),
                model,
            ));
        }
        return Err(sanitize_cli_error(&String::from_utf8_lossy(&stderr)).into());
    }
    let output = String::from_utf8_lossy(&stdout).trim().to_owned();
    if driver_id == "codex" {
        let answer_path = run_directory.path().join("answer.txt");
        let metadata = std::fs::metadata(&answer_path).map_err(|_| "Codex 未返回最终答复")?;
        if metadata.len() > MAX_STDOUT_BYTES as u64 {
            return Err("Codex 答复超过限制".into());
        }
        let answer = std::fs::read_to_string(answer_path).map_err(|_| "无法读取 Codex 答复")?;
        if answer.trim().is_empty() {
            return Err("Codex 未返回内容".into());
        }
        return Ok(answer.trim().to_owned());
    }
    if driver_id == "antigravity" {
        return parse_antigravity_output(&output);
    }
    if output.is_empty() {
        return Err("CLI 未返回内容".into());
    }
    Ok(output)
}

fn parse_antigravity_output(output: &str) -> Result<String, String> {
    let mut result = None;
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        let event: Value =
            serde_json::from_str(line).map_err(|_| "Antigravity 返回了无效的流数据")?;
        if event["event"] == "result" {
            if result.is_some() {
                return Err("Antigravity 返回了多个结果，已停止采纳".into());
            }
            result = Some(event["result"].clone());
        }
    }
    let result = result.ok_or("Antigravity 未返回完整结果")?;
    if result["status"] != "SUCCESS" {
        return Err(sanitize_cli_error(result["error"].as_str().unwrap_or("")).into());
    }
    let text = result["response"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or("Antigravity 未返回内容")?;
    Ok(text.trim().to_owned())
}

#[tauri::command]
pub(crate) async fn generate_text(
    window: WebviewWindow,
    state: State<'_, RuntimeState>,
    request: GenerationRequest,
) -> Result<GenerationResult, String> {
    validate_messages(&request.messages)?;
    let token = state.register(&request.task_id)?;
    let result = if token.is_cancelled() {
        Err("生成已取消".into())
    } else if request.kind == "cli" {
        generate_cli(&state, &request, &token).await
    } else {
        let mut on_delta = |delta: &str| {
            window
                .emit(
                    "generation-delta",
                    GenerationDelta {
                        task_id: request.task_id.clone(),
                        delta: delta.to_owned(),
                    },
                )
                .map_err(|_| "创作窗口已关闭，已停止生成".to_owned())
        };
        match timeout(
            PROVIDER_TOTAL_TIMEOUT,
            generate_provider(&request, &token, &mut on_delta),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err("模型生成超过 10 分钟，已停止本次请求；请减少上下文后重试".into()),
        }
    };
    state.finish(&request.task_id, &token);
    if token.is_cancelled() {
        return Err("生成已取消".into());
    }
    result.map(|output| GenerationResult { output })
}

#[tauri::command]
pub(crate) fn cancel_generation(state: State<'_, RuntimeState>, task_id: String) -> bool {
    state.cancel(&task_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_urls_include_ipv6_and_custom_ports_but_exclude_remote_http() {
        for value in [
            "http://127.0.0.1:11435",
            "http://localhost:54321",
            "http://[::1]:11434",
        ] {
            assert!(validate_base_url("ollama", value).is_ok(), "{value}");
            assert!(
                validate_base_url("openai-compatible", value).is_ok(),
                "{value}"
            );
        }
        for value in [
            "http://example.com",
            "http://192.168.1.1",
            "http://user@localhost",
            "http://localhost?key=x",
            "http://localhost#x",
            "https://example.com",
        ] {
            assert!(validate_base_url("ollama", value).is_err(), "{value}");
        }
        assert!(validate_base_url("openai-compatible", "https://example.com/v1").is_ok());
        assert!(validate_base_url("openai-compatible", "http://example.com/v1").is_err());
        let base = validate_base_url("ollama", "http://[::1]:11435/prefix/").unwrap();
        assert_eq!(
            endpoint_url(&base, "api/tags").unwrap().as_str(),
            "http://[::1]:11435/prefix/api/tags"
        );
    }

    #[test]
    fn model_catalog_validation_rejects_false_positive_success() {
        for payload in [
            json!({}),
            json!({"data": {}}),
            json!({"data": [{}]}),
            json!({"data": [{"id": " "}]}),
        ] {
            assert!(model_names(&payload, "openai-compatible").is_err());
        }
        assert_eq!(
            model_names(
                &json!({"data": [{"id": "test-model"}]}),
                "openai-compatible"
            )
            .unwrap(),
            vec!["test-model"]
        );
        assert_eq!(
            model_names(&json!({"models": []}), "ollama").unwrap(),
            Vec::<String>::new()
        );
        assert!(model_names(&json!({"models": [null]}), "ollama").is_err());
    }

    #[test]
    fn prompt_keeps_tail_and_enforces_byte_limit() {
        let messages = vec![MessageInput {
            role: "user".into(),
            content: format!("{}保留这个创作要求", "文".repeat(24000)),
        }];
        assert!(create_cli_prompt(&messages)
            .unwrap()
            .ends_with("保留这个创作要求"));
        let messages = vec![MessageInput {
            role: "user".into(),
            content: "文".repeat(33000),
        }];
        assert!(create_cli_prompt(&messages).is_err());
    }

    #[test]
    fn cancellation_before_registration_and_registration_replacement_are_safe() {
        let state = RuntimeState::default();
        assert!(state.cancel("before"));
        let token = state.register("before").unwrap();
        assert!(token.is_cancelled());
        state.finish("before", &token);
        let old = state.register("same").unwrap();
        let new = state.register("same").unwrap();
        assert!(old.is_cancelled());
        assert!(!new.is_cancelled());
        state.finish("same", &old);
        state.cancel("same");
        assert!(new.is_cancelled());
        state.finish("same", &new);
        assert!(state.tasks.lock().unwrap().running.is_empty());
        assert!(!state.cancel(""));
    }

    #[test]
    fn sse_survives_every_possible_utf8_chunk_boundary() {
        let stream = ": heartbeat\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"你好🌿\"}}]}\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"世界\"},\"finish_reason\":\"stop\"}]}\r\n\r\ndata: [DONE]\r\n\r\n".as_bytes();
        for boundary in 0..stream.len() {
            let mut parser = ProviderStream::new(StreamFormat::Sse);
            let mut deltas = parser.feed(&stream[..boundary]).unwrap();
            deltas.extend(parser.feed(&stream[boundary..]).unwrap());
            deltas.extend(parser.finish().unwrap());
            assert_eq!(deltas.concat(), "你好🌿世界");
            assert_eq!(parser.output, "你好🌿世界");
        }
    }

    #[test]
    fn sse_handles_multiline_event_data_and_final_event_without_newline() {
        let mut parser = ProviderStream::new(StreamFormat::Sse);
        let mut deltas = parser
            .feed(
                b"data: {\"choices\":\ndata: [{\"delta\":{\"content\":\"text\"}}]}\n\ndata: [DONE]",
            )
            .unwrap();
        deltas.extend(parser.finish().unwrap());
        assert_eq!(deltas.concat(), "text");
    }

    #[test]
    fn sse_finished_choice_does_not_require_a_complete_trailing_done_marker() {
        let mut parser = ProviderStream::new(StreamFormat::Sse);
        parser.feed(b"data: {\"choices\":[{\"delta\":{\"content\":\"finished\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DO").unwrap();
        parser.finish().unwrap();
        assert_eq!(parser.output, "finished");
    }

    #[test]
    fn ollama_ndjson_handles_partial_lines_and_final_content() {
        let bytes = "{\"message\":{\"content\":\"第一段\"},\"done\":false}\n{\"message\":{\"content\":\"结尾\"},\"done\":true}".as_bytes();
        let mut parser = ProviderStream::new(StreamFormat::JsonLines);
        let mut deltas = Vec::new();
        for byte in bytes {
            deltas.extend(parser.feed(&[*byte]).unwrap());
        }
        deltas.extend(parser.finish().unwrap());
        assert_eq!(deltas.concat(), "第一段结尾");
    }

    #[test]
    fn incomplete_empty_malformed_or_provider_error_streams_are_not_successes() {
        let mut incomplete = ProviderStream::new(StreamFormat::Sse);
        incomplete
            .feed(b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
            .unwrap();
        assert!(incomplete.finish().unwrap_err().contains("提前结束"));
        let mut empty = ProviderStream::new(StreamFormat::Sse);
        empty.feed(b"data: [DONE]\n\n").unwrap();
        assert!(empty.finish().unwrap_err().contains("空内容"));
        for stream in [
            "data: {\"error\":\"secret must not appear in error\"}\n\n",
            "data: invalid-json\n\n",
        ] {
            let mut parser = ProviderStream::new(StreamFormat::Sse);
            let error = parser.feed(stream.as_bytes()).unwrap_err();
            assert!(!error.contains("secret"));
        }
        let mut too_large = ProviderStream::new(StreamFormat::JsonLines);
        assert!(too_large
            .feed(&vec![b' '; MAX_PROVIDER_RESPONSE_BYTES + 1])
            .is_err());
    }

    #[test]
    fn normal_json_fallback_preserves_content_and_checks_errors() {
        assert_eq!(
            provider_output(
                &json!({"choices": [{"message": {"content": "正文\n"}}]}),
                "openai-compatible"
            )
            .unwrap(),
            "正文\n"
        );
        assert_eq!(
            provider_output(&json!({"message": {"content": "本机正文"}}), "ollama").unwrap(),
            "本机正文"
        );
        assert!(provider_output(&json!({}), "ollama").is_err());
        assert!(provider_output(
            &json!({"message": {"content": "半段"}, "done": false}),
            "ollama"
        )
        .is_err());
        assert!(provider_output(&json!({"error": "upstream secret"}), "ollama").is_err());
    }

    #[test]
    fn antigravity_rejects_ambiguous_or_failed_result() {
        let success =
            "{\"event\":\"result\",\"result\":{\"status\":\"SUCCESS\",\"response\":\"正文\"}}";
        assert_eq!(parse_antigravity_output(success).unwrap(), "正文");
        assert!(parse_antigravity_output(&format!("{success}\n{success}")).is_err());
        assert!(parse_antigravity_output(
            "{\"event\":\"result\",\"result\":{\"status\":\"ERROR\"}}"
        )
        .is_err());
        assert!(parse_antigravity_output("invalid-json").is_err());
    }

    /// A loopback mock verifies the HTTP parser/callback together, without any real model.
    #[tokio::test]
    async fn http_stream_emits_delta_before_response_completes() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (delta_sender, delta_receiver) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = [0u8; 4096];
            socket.read(&mut request).unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n").unwrap();
            socket.flush().unwrap();
            // The second event is not sent until the client has shown the first delta.
            delta_receiver.recv_timeout(Duration::from_secs(3)).unwrap();
            socket.write_all(b"data: {\"choices\":[{\"delta\":{\"content\":\" second\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n").unwrap();
        });
        let response = http_client(Duration::from_secs(5))
            .unwrap()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap();
        let token = CancellationToken::new();
        let mut received = String::new();
        let mut on_delta = |delta: &str| {
            received.push_str(delta);
            if delta == "first" {
                delta_sender.send(()).unwrap();
            }
            Ok(())
        };
        let output = read_generation_response(response, "openai-compatible", &token, &mut on_delta)
            .await
            .unwrap();
        assert_eq!(output, "first second");
        assert_eq!(received, output);
        server.join().unwrap();
    }

    #[tokio::test]
    async fn pre_cancelled_request_never_opens_a_connection() {
        let token = CancellationToken::new();
        token.cancel();
        let request = http_client(Duration::from_secs(1))
            .unwrap()
            .get("http://127.0.0.1:1");
        assert_eq!(
            send_generation_request(request, &token).await.unwrap_err(),
            "生成已取消"
        );
    }

    #[tokio::test]
    async fn cancellation_after_first_http_delta_does_not_return_success() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (delta_sender, delta_receiver) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            socket.read(&mut [0u8; 4096]).unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nConnection: close\r\n\r\n{\"message\":{\"content\":\"partial\"},\"done\":false}\n").unwrap();
            socket.flush().unwrap();
            delta_receiver.recv_timeout(Duration::from_secs(3)).unwrap();
        });
        let response = http_client(Duration::from_secs(5))
            .unwrap()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap();
        let token = CancellationToken::new();
        let mut deltas = Vec::new();
        let mut on_delta = |delta: &str| {
            deltas.push(delta.to_owned());
            token.cancel();
            delta_sender.send(()).unwrap();
            Ok(())
        };
        assert_eq!(
            read_generation_response(response, "ollama", &token, &mut on_delta)
                .await
                .unwrap_err(),
            "生成已取消"
        );
        assert_eq!(deltas, vec!["partial"]);
        server.join().unwrap();
    }

    fn json_mock_server(body: Value) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            socket.read(&mut [0u8; 4096]).unwrap();
            let body = body.to_string();
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            socket.write_all(response.as_bytes()).unwrap();
        });
        (format!("http://{address}"), server)
    }

    #[tokio::test]
    async fn connection_test_requires_valid_nonempty_catalog_and_requested_model() {
        for (body, model, valid) in [
            (json!({}), "test", false),
            (json!({"data": []}), "test", false),
            (json!({"data": [{"id": "other"}]}), "test", false),
            (json!({"data": [{"id": "test"}]}), "test", true),
        ] {
            let (url, server) = json_mock_server(body);
            let result = connection_test(ConnectionInput {
                kind: "openai-compatible".into(),
                base_url: url,
                model: model.into(),
                api_key: Some("mock-only".into()),
            })
            .await;
            assert_eq!(result.is_ok(), valid);
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn generation_accepts_provider_that_ignores_stream_flag_and_returns_json() {
        let (url, server) =
            json_mock_server(json!({"choices": [{"message": {"content": "完整正文"}}]}));
        let request = GenerationRequest {
            task_id: "mock".into(),
            kind: "openai-compatible".into(),
            base_url: url,
            model: "mock-model".into(),
            api_key: Some("mock-only".into()),
            driver_id: None,
            allow_user_profile: false,
            messages: vec![MessageInput {
                role: "user".into(),
                content: "mock request".into(),
            }],
        };
        let mut deltas = Vec::new();
        let mut on_delta = |delta: &str| {
            deltas.push(delta.to_owned());
            Ok(())
        };
        let output = generate_provider(&request, &CancellationToken::new(), &mut on_delta)
            .await
            .unwrap();
        assert_eq!(output, "完整正文");
        assert_eq!(deltas, vec!["完整正文"]);
        server.join().unwrap();
    }
}
