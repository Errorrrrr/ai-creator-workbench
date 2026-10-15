//! Signed packages stay in memory until the UI has saved and frozen editing.
use crate::{media::FileChooserRuntime, media_jobs::MediaRuntime, runtime::RuntimeState, updates};
use futures_util::StreamExt;
use serde::Serialize;
use std::{sync::Mutex, time::Duration};
use tauri::{ipc::Channel, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio_util::sync::CancellationToken;

const MAX_PACKAGE_BYTES: usize = 512 * 1024 * 1024;
#[derive(Default)]
enum Phase {
    #[default]
    Idle,
    Downloading(CancellationToken),
    Ready(Update, Vec<u8>),
    Installing,
    Installed,
}
#[derive(Default)]
pub(crate) struct UpdateRuntime(Mutex<Phase>);
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    received: usize,
    total: Option<u64>,
}

fn require_idle_tasks(app: &tauri::AppHandle) -> Result<(), String> {
    if app.state::<RuntimeState>().has_active_tasks()?
        || app.state::<MediaRuntime>().has_active_tasks()?
        || app.state::<FileChooserRuntime>().has_active_tasks()?
    {
        return Err("还有生成、媒体或文件选择任务，请等待结束后再安装更新".into());
    }
    Ok(())
}

async fn download(
    app: &tauri::AppHandle,
    expected_version: &str,
    progress: Channel<Progress>,
) -> Result<(Update, Vec<u8>), String> {
    let payload = updates::fetch_manifest(app)
        .await?
        .ok_or("暂时没有可下载的更新")?;
    updates::updater_metadata(&payload)?;
    if payload["version"].as_str() != Some(expected_version)
        || payload["draft"] != false
        || payload["prerelease"] != false
    {
        return Err("发布信息已变化，请重新检查更新".into());
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .restore_update(payload)
        .map_err(|e| e.to_string())?
        .ok_or("当前版本无需更新")?;
    let download_url = update.download_url.clone();
    #[cfg(debug_assertions)]
    let download_url = if app
        .config()
        .identifier
        .starts_with("com.aicreator.workbench.qa-")
    {
        option_env!("ACW_QA_UPDATE_URL")
            .and_then(|v| reqwest::Url::parse(&v).ok())
            .filter(|u| u.scheme() == "http" && u.host_str() == Some("127.0.0.1"))
            .and_then(|u| u.join("package.tar.gz").ok())
            .unwrap_or(download_url)
    } else {
        download_url
    };
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            if attempt.previous().len() > 5
                || url.scheme() != "https"
                || url.port().is_some()
                || !url.username().is_empty()
                || url.password().is_some()
                || !matches!(
                    url.host_str(),
                    Some("github.com" | "release-assets.githubusercontent.com")
                )
            {
                attempt.error("更新包重定向不受信任")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(download_url)
        .send()
        .await
        .map_err(|_| "无法下载更新包，请检查网络后重试")?
        .error_for_status()
        .map_err(|e| {
            format!(
                "更新包下载失败（HTTP {}），请稍后重试",
                e.status().map(|s| s.as_u16()).unwrap_or(0)
            )
        })?;
    let total = response.content_length();
    if total.is_some_and(|v| v > MAX_PACKAGE_BYTES as u64) {
        return Err("更新包超过 512 MiB 限制".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "下载中断，请重新下载更新")?;
        if bytes.len().saturating_add(chunk.len()) > MAX_PACKAGE_BYTES {
            return Err("更新包超过 512 MiB 限制".into());
        }
        bytes.extend_from_slice(&chunk);
        let _ = progress.send(Progress {
            received: bytes.len(),
            total,
        });
    }
    update
        .verify(&bytes)
        .map_err(|_| "更新包签名或版本校验失败，未安装；请重新检查更新")?;
    Ok((update, bytes))
}

#[tauri::command]
pub(crate) async fn download_update(
    app: tauri::AppHandle,
    expected_version: String,
    progress: Channel<Progress>,
) -> Result<(), String> {
    let token = CancellationToken::new();
    {
        let state = app.state::<UpdateRuntime>();
        let mut phase = state.0.lock().map_err(|_| "更新状态不可用")?;
        if !matches!(*phase, Phase::Idle) {
            return Err("已有更新操作，请先完成或取消".into());
        }
        *phase = Phase::Downloading(token.clone());
    }
    let result = tokio::select! {
        biased;
        _ = token.cancelled() => Err("下载已取消".into()),
        result = download(&app, &expected_version, progress) => result,
    };
    let state = app.state::<UpdateRuntime>();
    let mut phase = state.0.lock().map_err(|_| "更新状态不可用")?;
    match result {
        Ok((update, bytes)) if !token.is_cancelled() => {
            *phase = Phase::Ready(update, bytes);
            Ok(())
        }
        Ok(_) => {
            *phase = Phase::Idle;
            Err("下载已取消".into())
        }
        Err(error) => {
            *phase = Phase::Idle;
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) fn cancel_update(state: tauri::State<'_, UpdateRuntime>) -> Result<(), String> {
    let mut phase = state.0.lock().map_err(|_| "更新状态不可用")?;
    match &*phase {
        Phase::Downloading(token) => token.cancel(),
        Phase::Installing | Phase::Installed => return Err("正在安装或等待重启，无法取消".into()),
        _ => *phase = Phase::Idle,
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    require_idle_tasks(&app)?;
    let (update, bytes) = {
        let state = app.state::<UpdateRuntime>();
        let mut phase = state.0.lock().map_err(|_| "更新状态不可用")?;
        if !matches!(*phase, Phase::Ready(..)) {
            return Err("请先下载并验证更新包".into());
        }
        let Phase::Ready(update, bytes) = std::mem::replace(&mut *phase, Phase::Installing) else {
            unreachable!()
        };
        (update, bytes)
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        update
            .install(bytes)
            .map_err(|e| format!("安装失败：{e}；请重新下载后重试"))
    })
    .await
    .map_err(|e| format!("安装任务失败：{e}"));
    let result = result.and_then(|r| r);
    *app.state::<UpdateRuntime>()
        .0
        .lock()
        .map_err(|_| "更新状态不可用")? = if result.is_ok() {
        Phase::Installed
    } else {
        Phase::Idle
    };
    result
}

#[tauri::command]
pub(crate) fn restart_after_update(app: tauri::AppHandle) -> Result<(), String> {
    if !matches!(
        *app.state::<UpdateRuntime>()
            .0
            .lock()
            .map_err(|_| "更新状态不可用")?,
        Phase::Installed
    ) {
        return Err("尚未完成更新安装，不能重启".into());
    }
    app.restart();
}
