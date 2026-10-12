//! Fixed, audited media adapters. Adding a provider never widens CLI permissions or
//! silently changes a saved resource. The job layer owns persistence and collection;
//! adapters own protocol validation, submission and non-submitting recovery.
use crate::{
    media_jobs::{self, Job, Request},
    runtime,
};
use serde::Serialize;
use std::{
    fs::{self, File},
    future::Future,
    pin::Pin,
};
use tokio_util::sync::CancellationToken;

type Operation<'a> = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Descriptor {
    id: &'static str,
    name: &'static str,
    transport: &'static str,
    capability: &'static str,
    driver_id: Option<&'static str>,
    modes: &'static [&'static str],
    reference_roles: &'static [&'static str],
    max_references: usize,
    remote_query: bool,
    remote_cancel: bool,
    recovery: &'static str,
    parameter_notes: &'static str,
}

trait MediaAdapter: Sync {
    fn descriptor(&self) -> Descriptor;
    fn validate(&self, app: &tauri::AppHandle, request: &Request) -> Result<(), String>;
    fn submit<'a>(
        &'a self,
        app: &'a tauri::AppHandle,
        job: &'a mut Job,
        token: &'a CancellationToken,
    ) -> Operation<'a>;
    /// May query an existing handle or collect known files, but MUST NOT submit.
    fn recover<'a>(
        &'a self,
        app: &'a tauri::AppHandle,
        job: &'a mut Job,
        token: &'a CancellationToken,
    ) -> Operation<'a>;
}

struct CodexImage;
struct OpenAiImages;
struct GeminiVeo;
static ADAPTERS: [&dyn MediaAdapter; 3] = [&CodexImage, &OpenAiImages, &GeminiVeo];

fn resolve(request: &Request) -> Result<&'static dyn MediaAdapter, String> {
    let adapter = ADAPTERS
        .iter()
        .copied()
        .find(|adapter| adapter.descriptor().id == request.connection.adapter)
        .ok_or("媒体协议适配器尚未实现；不会自动换用其他 API 或 CLI")?;
    let descriptor = adapter.descriptor();
    if descriptor.transport != request.connection.kind
        || descriptor.capability != request.capability
        || descriptor.driver_id != request.connection.driver_id.as_deref()
    {
        return Err("媒体协议、执行方式、驱动与能力不匹配；未自动回退".into());
    }
    Ok(adapter)
}

/// A catalogue of implemented protocols, not a login, quota or quality health check.
#[tauri::command]
pub(crate) fn media_adapter_catalog() -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "adapters": ADAPTERS.iter().map(|adapter| adapter.descriptor()).collect::<Vec<_>>(),
        "cancelScope": "local-only",
        "verification": "implementation-only"
    })
}

pub(crate) fn validate(app: &tauri::AppHandle, request: &Request) -> Result<(), String> {
    let adapter = resolve(request)?;
    let descriptor = adapter.descriptor();
    if !descriptor.modes.contains(&request.parameters.mode.as_str()) {
        return Err("所选适配器不支持此生成模式".into());
    }
    if request.references.len() > descriptor.max_references
        || request.references.iter().any(|reference| {
            !descriptor
                .reference_roles
                .contains(&reference.role.as_str())
        })
    {
        return Err("参考素材数量或用途超出所选适配器能力".into());
    }
    if request.capability == "image"
        && ((request.parameters.mode == "generate") != request.references.is_empty())
    {
        return Err("无参考图片应选择生成模式，有参考图片应选择编辑模式".into());
    }
    if request.connection.kind == "api" {
        runtime::validate_base_url("api", &request.connection.base_url)?;
        if request.api_key.as_deref().is_none_or(|key| {
            key.trim().is_empty() || key.len() > 8192 || key.contains(['\r', '\n'])
        }) {
            return Err("API 密钥未配置或格式无效".into());
        }
        if request.connection.model.trim().is_empty() {
            return Err("请明确填写资源实际支持的模型名称".into());
        }
    }
    adapter.validate(app, request)
}

pub(crate) async fn run(
    app: &tauri::AppHandle,
    job: &mut Job,
    token: &CancellationToken,
    recovery: bool,
) -> Result<(), String> {
    if token.is_cancelled() {
        return Err("已取消，尚未调用执行端".into());
    }
    if job.capability != job.request.capability {
        return Err("任务与输入能力不一致".into());
    }
    let adapter = resolve(&job.request)?;
    if recovery {
        adapter.recover(app, job, token).await
    } else {
        validate(app, &job.request)?;
        adapter.submit(app, job, token).await
    }
}

pub(crate) fn check_recovery_route(request: &Request) -> Result<(), String> {
    resolve(request).map(|_| ())
}

fn delivered(app: &tauri::AppHandle, job: &Job, name: &str) -> Result<bool, String> {
    Ok(media_jobs::directory(app, &job.id)?
        .join("outputs")
        .join(name)
        .is_file())
}

fn no_recovery() -> String {
    "没有可恢复的本地文件或远端句柄；不会偷偷重新生成。请先核对供应商记录后明确发起新任务".into()
}

impl MediaAdapter for CodexImage {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            id: "codex-native-image",
            name: "Codex 原生图片",
            transport: "cli",
            capability: "image",
            driver_id: Some("codex"),
            modes: &["generate", "edit"],
            reference_roles: &["reference", "start", "end"],
            max_references: 16,
            remote_query: false,
            remote_cancel: false,
            recovery: "verified-native-receipt",
            parameter_notes:
                "画幅、质量为创作要求；只接收原生图片事件和实际文件，不接受文字或 URL 充当产物",
        }
    }
    fn validate(&self, _: &tauri::AppHandle, request: &Request) -> Result<(), String> {
        if !request.allow_user_profile {
            return Err("需要明确允许使用 Codex 登录态和图片生成额度".into());
        }
        runtime::find_executable("codex").ok_or("未找到受信目录中的 Codex CLI")?;
        Ok(())
    }
    fn submit<'a>(
        &'a self,
        app: &'a tauri::AppHandle,
        job: &'a mut Job,
        token: &'a CancellationToken,
    ) -> Operation<'a> {
        Box::pin(media_jobs::generate_cli(app, job, token))
    }
    fn recover<'a>(
        &'a self,
        app: &'a tauri::AppHandle,
        job: &'a mut Job,
        _: &'a CancellationToken,
    ) -> Operation<'a> {
        Box::pin(async move {
            crate::media_codex::recover(&media_jobs::directory(app, &job.id)?, &job.id).map(|_| ())
        })
    }
}

impl MediaAdapter for OpenAiImages {
    fn descriptor(&self) -> Descriptor {
        Descriptor { id: "openai-images", name: "OpenAI Images 兼容协议", transport: "api", capability: "image", driver_id: None, modes: &["generate", "edit"], reference_roles: &["reference", "start", "end"], max_references: 16, remote_query: false, remote_cancel: false, recovery: "local-response-or-file", parameter_notes: "size: auto/1024x1024/1536x1024/1024x1536；quality: auto/low/medium/high；仅接收 b64_json" }
    }
    fn validate(&self, _: &tauri::AppHandle, request: &Request) -> Result<(), String> {
        if !["auto", "1024x1024", "1536x1024", "1024x1536"]
            .contains(&request.parameters.size.as_str())
            || !["auto", "low", "medium", "high"].contains(&request.parameters.quality.as_str())
        {
            return Err("图片尺寸或质量不在当前适配范围内".into());
        }
        Ok(())
    }
    fn submit<'a>(
        &'a self,
        app: &'a tauri::AppHandle,
        job: &'a mut Job,
        token: &'a CancellationToken,
    ) -> Operation<'a> {
        Box::pin(media_jobs::generate_image(app, job, token))
    }
    fn recover<'a>(
        &'a self,
        app: &'a tauri::AppHandle,
        job: &'a mut Job,
        _: &'a CancellationToken,
    ) -> Operation<'a> {
        Box::pin(async move {
            if delivered(app, job, "image-output.bin")? {
                return Ok(());
            }
            let response = media_jobs::directory(app, &job.id)?.join("image-response.json");
            if !response.is_file() {
                return Err(no_recovery());
            }
            if response.metadata().map_err(|e| e.to_string())?.len() > 100 * 1024 * 1024 {
                return Err("缓存响应超限".into());
            }
            let value = serde_json::from_reader(File::open(response).map_err(|e| e.to_string())?)
                .map_err(|_| "缓存响应损坏".to_string())?;
            media_jobs::save_image_response(app, job, &value)
        })
    }
}

impl MediaAdapter for GeminiVeo {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            id: "veo",
            name: "Gemini Veo 协议",
            transport: "api",
            capability: "video",
            driver_id: None,
            modes: &[
                "image-to-video",
                "reference-to-video",
                "first-last",
                "extend",
            ],
            reference_roles: &["reference", "start", "end", "extend"],
            max_references: 3,
            remote_query: true,
            remote_cancel: false,
            recovery: "existing-operation-or-file",
            parameter_notes: "当前 Veo 3.1：720p、4/6/8 秒；参考组合与续接来源按模型协议严格校验",
        }
    }
    fn validate(&self, app: &tauri::AppHandle, request: &Request) -> Result<(), String> {
        crate::media_video::validate(app, request)
    }
    fn submit<'a>(
        &'a self,
        app: &'a tauri::AppHandle,
        job: &'a mut Job,
        token: &'a CancellationToken,
    ) -> Operation<'a> {
        Box::pin(crate::media_video::generate(app, job, token, false))
    }
    fn recover<'a>(
        &'a self,
        app: &'a tauri::AppHandle,
        job: &'a mut Job,
        token: &'a CancellationToken,
    ) -> Operation<'a> {
        Box::pin(async move {
            if delivered(app, job, "video-output.bin")? {
                return Ok(());
            }
            if job.remote_id.is_none() {
                let journal = media_jobs::directory(app, &job.id)?.join("remote-operation.json");
                if journal.is_file()
                    && fs::metadata(&journal).map_err(|e| e.to_string())?.len() < 2048
                {
                    let value: serde_json::Value =
                        serde_json::from_reader(File::open(journal).map_err(|e| e.to_string())?)
                            .map_err(|_| "远端句柄恢复记录损坏")?;
                    if let Some(id) = value["remoteId"]
                        .as_str()
                        .filter(|id| crate::media_video::valid_operation(id))
                    {
                        job.remote_id = Some(id.into());
                        media_jobs::save(app, job)?;
                    }
                }
            }
            if !job
                .remote_id
                .as_deref()
                .is_some_and(crate::media_video::valid_operation)
            {
                return Err(no_recovery());
            }
            crate::media_video::generate(app, job, token, true).await
        })
    }
}
