//! Explicit Gemini Veo protocol adapter. No default provider or implicit billing fallback.
use crate::{
    media,
    media_integrity::sync_directory,
    media_jobs::{self, Job, Request},
    runtime,
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    io::{Read, Write},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub(crate) fn validate(app: &tauri::AppHandle, request: &Request) -> Result<(), String> {
    if !["veo-3.1-generate-preview", "veo-3.1-fast-generate-preview"]
        .contains(&request.connection.model.as_str())
    {
        return Err("此适配器当前只接 Veo 3.1 标准／Fast preview；其他视频模型需要对应协议适配，不能只替换名称".into());
    }
    if !["16:9", "9:16"].contains(&request.parameters.aspect_ratio.as_str())
        || ![4.0, 6.0, 8.0].contains(&request.parameters.duration)
    {
        return Err("Veo 当前适配范围：16:9／9:16、4／6／8 秒；不会静默修改目标时长".into());
    }
    let count = |role: &str| {
        request
            .references
            .iter()
            .filter(|reference| reference.role == role)
            .count()
    };
    let (start, end, extend, reference) = (
        count("start"),
        count("end"),
        count("extend"),
        count("reference"),
    );
    if start > 1 || end > 1 || extend > 1 || reference > 3 {
        return Err("视频输入超限：首尾帧各 1 张、续接视频 1 个、主体参考最多 3 张".into());
    }
    let expected = if extend > 0 {
        if start + end + reference > 0 || request.parameters.duration != 8.0 {
            return Err("续接只接受单个原生 Veo 视频、8 秒；不能与首尾帧或参考图混用".into());
        }
        let source = request
            .references
            .iter()
            .find(|reference| reference.role == "extend")
            .ok_or("缺少续接输入")?;
        let (version, _) = media::version_file(app, &request.project_id, &source.version_id)?;
        let provenance = &version.metadata["provenance"];
        if !provenance["model"]
            .as_str()
            .is_some_and(|model| model.starts_with("veo-3.1-"))
            || provenance["connectionId"] != request.connection.id
        {
            return Err(
                "续接必须使用同一执行端生成的原生 Veo 3.1 视频，普通导入视频不冒充原生输入".into(),
            );
        }
        "extend"
    } else if reference > 0 {
        if start + end > 0 || request.parameters.duration != 8.0 {
            return Err(
                "主体参考模式为 8 秒，当前不混用首尾帧；可先把主体参考融入选用分镜图再图生视频"
                    .into(),
            );
        }
        "reference-to-video"
    } else if end > 0 {
        if start != 1 {
            return Err("结束帧必须与一张起始帧配合".into());
        }
        "first-last"
    } else if start == 1 {
        "image-to-video"
    } else {
        return Err(
            "此工作流要求已选分镜图、主体参考或原生续接视频，不直接跳过图片审核生成视频".into(),
        );
    };
    if request.parameters.mode != expected {
        return Err("视频输入与所选模式不一致，请重新选择模式与参考".into());
    }
    let mut bytes = 0u64;
    for reference in &request.references {
        let (version, _) = media::version_file(app, &request.project_id, &reference.version_id)?;
        if version.bytes > 50 * 1024 * 1024 {
            return Err("此内联上传适配器单项参考限 50 MiB".into());
        }
        bytes += version.bytes;
    }
    if bytes > 100 * 1024 * 1024 {
        return Err("视频参考总上传大小限 100 MiB".into());
    }
    Ok(())
}

pub(crate) fn valid_operation(operation: &str) -> bool {
    operation.len() <= 512
        && (operation.starts_with("operations/") || operation.starts_with("models/"))
        && operation.contains("operations/")
        && operation.split('/').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
        })
}

async fn json_response(
    response: reqwest::Response,
    token: &CancellationToken,
) -> Result<Value, String> {
    if !response.status().is_success() {
        return Err(media_jobs::http_error(response.status()));
    }
    serde_json::from_slice(&media_jobs::response_bytes(response, token, 2 * 1024 * 1024).await?)
        .map_err(|_| "视频接口响应不是有效 JSON".into())
}

pub(crate) async fn generate(
    app: &tauri::AppHandle,
    job: &mut Job,
    token: &CancellationToken,
    resume: bool,
) -> Result<(), String> {
    let base = runtime::validate_base_url("api", &job.request.connection.base_url)?;
    let client = runtime::http_client(Duration::from_secs(180))?;
    let key = job
        .request
        .api_key
        .as_deref()
        .filter(|key| !key.is_empty())
        .ok_or("恢复远端视频需要原执行端密钥；请在连接中心配置")?
        .to_owned();
    if !resume {
        validate(app, &job.request)?;
        let mut instance = json!({"prompt":job.request.prompt});
        let mut references = vec![];
        for reference in &job.request.references {
            if token.is_cancelled() {
                return Err("尚未提交，已取消".into());
            }
            let (version, path) = media::version_file(app, &job.project_id, &reference.version_id)?;
            let mut bytes = Vec::new();
            File::open(path)
                .map_err(|e| e.to_string())?
                .take(50 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() > 50 * 1024 * 1024 {
                return Err("参考上传超限".into());
            }
            let input = json!({"inlineData":{"mimeType":version.mime_type,"data":media_jobs::encode_base64(&bytes)}});
            match reference.role.as_str() {
                "start" => instance["image"] = input,
                "end" => instance["lastFrame"] = input,
                "extend" => instance["video"] = input,
                _ => references.push(json!({"image":input,"referenceType":"asset"})),
            }
        }
        if !references.is_empty() {
            instance["referenceImages"] = json!(references);
        }
        let body = json!({"instances":[instance],"parameters":{"numberOfVideos":1,"durationSeconds":job.request.parameters.duration as u32,"aspectRatio":job.request.parameters.aspect_ratio,"resolution":"720p"}});
        if token.is_cancelled() {
            return Err("尚未提交，已取消".into());
        }
        job.status = "submitting".into();
        media_jobs::save(app, job)?;
        let send = client
            .post(runtime::endpoint_url(
                &base,
                &format!("models/{}:predictLongRunning", job.request.connection.model),
            )?)
            .header("x-goog-api-key", &key)
            .json(&body)
            .send();
        let response = tokio::select! { _=token.cancelled()=>return Err("提交中止".into()),result=send=>result.map_err(|_| "视频提交连接中断".to_string())? };
        if response.status().is_client_error() {
            job.status = "failed".into();
        }
        let value = json_response(response, token).await?;
        let operation = value["name"]
            .as_str()
            .filter(|name| valid_operation(name))
            .ok_or("提交响应没有有效远端任务句柄")?;
        job.remote_id = Some(operation.into());
        media_jobs::atomic_file(
            &media_jobs::directory(app, &job.id)?,
            "remote-operation.json",
            &serde_json::to_vec(&json!({"remoteId":operation})).map_err(|e| e.to_string())?,
        )?;
        job.status = "running".into();
        media_jobs::save(app, job)?;
    }
    let operation = job
        .remote_id
        .as_deref()
        .filter(|id| valid_operation(id))
        .ok_or("无有效远端句柄，不能恢复查询")?
        .to_owned();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(900);
    loop {
        if token.is_cancelled() {
            return Err("已停止远端等待".into());
        }
        if tokio::time::Instant::now() > deadline {
            return Err("等待远端视频超时，句柄保留；可恢复查询，不会重新提交".into());
        }
        let request = client
            .get(runtime::endpoint_url(&base, &operation)?)
            .header("x-goog-api-key", &key)
            .send();
        let response = tokio::select! { _=token.cancelled()=>return Err("已停止查询".into()),result=request=>result.map_err(|_| "查询连接中断，远端句柄保留")? };
        let value = json_response(response, token).await?;
        if value.get("error").is_some_and(|error| !error.is_null()) {
            return Err("远端任务报告失败或安全拒绝，请核对供应商记录；不会自动重试".into());
        }
        if value["done"] == true {
            let uri = value["response"]["generateVideoResponse"]["generatedSamples"]
                .as_array()
                .and_then(|samples| samples.first())
                .and_then(|sample| sample["video"]["uri"].as_str())
                .ok_or("远端已结束但未交付视频，可能被安全策略拒绝")?;
            job.status = "downloading".into();
            media_jobs::save(app, job)?;
            download(app, job, token, &client, &base, uri, &key).await?;
            return Ok(());
        }
        tokio::select! { _=token.cancelled()=>return Err("已停止等待".into()),_=tokio::time::sleep(Duration::from_secs(10))=>{} }
    }
}

async fn download(
    app: &tauri::AppHandle,
    job: &Job,
    token: &CancellationToken,
    client: &reqwest::Client,
    base: &reqwest::Url,
    uri: &str,
    key: &str,
) -> Result<(), String> {
    let mut url = reqwest::Url::parse(uri).map_err(|_| "供应商视频地址无效")?;
    let directory = media_jobs::directory(app, &job.id)?;
    for _ in 0..6 {
        let same_origin = url.origin() == base.origin();
        let google_origin = base.host_str() == Some("generativelanguage.googleapis.com");
        let trusted_google = url.host_str().is_some_and(|host| {
            host == "storage.googleapis.com"
                || host.ends_with(".googleapis.com")
                || host.ends_with(".googleusercontent.com")
        });
        if !url.username().is_empty()
            || url.password().is_some()
            || (!same_origin && !(google_origin && trusted_google && url.scheme() == "https"))
        {
            return Err("视频下载或重定向指向非受信域名，拒绝泄露凭据；远端句柄保留".into());
        }
        if url.scheme() != "https" && !same_origin {
            return Err("视频下载必须使用安全地址".into());
        }
        let mut request = client.get(url.clone());
        // Never forward a provider key to a storage/redirect host.
        if same_origin {
            request = request.header("x-goog-api-key", key);
        }
        let response = tokio::select! { _=token.cancelled()=>return Err("已停止下载".into()),result=request.send()=>result.map_err(|_| "视频下载连接中断，远端句柄保留")? };
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or("视频重定向无有效目标")?;
            url = url.join(location).map_err(|_| "视频重定向地址无效")?;
            continue;
        }
        if !response.status().is_success() {
            return Err(media_jobs::http_error(response.status()));
        }
        if response
            .content_length()
            .is_some_and(|size| size > media::MAX_MEDIA_BYTES)
        {
            return Err("视频超过 512 MiB 收录边界".into());
        }
        let outputs = directory.join("outputs");
        fs::create_dir_all(&outputs).map_err(|e| e.to_string())?;
        let mut temporary = tempfile::NamedTempFile::new_in(&outputs).map_err(|e| e.to_string())?;
        let mut total = 0usize;
        let mut stream = response.bytes_stream();
        loop {
            let chunk = tokio::select! { _=token.cancelled()=>return Err("已停止下载，完整远端句柄保留".into()),chunk=stream.next()=>chunk };
            let Some(chunk) = chunk else {
                break;
            };
            let chunk = chunk.map_err(|_| "视频下载中断，可恢复同一任务")?;
            total = total.saturating_add(chunk.len());
            if total as u64 > media::MAX_MEDIA_BYTES {
                return Err("视频响应超过收录边界".into());
            }
            temporary
                .write_all(&chunk)
                .map_err(|_| "本地磁盘写入失败，远端句柄保留")?;
        }
        if total == 0 {
            return Err("远端交付了空视频".into());
        }
        temporary.as_file().sync_all().map_err(|e| e.to_string())?;
        temporary
            .persist(outputs.join("video-output.bin"))
            .map_err(|e| e.error.to_string())?;
        sync_directory(&outputs)?;
        sync_directory(&directory)?;
        return Ok(());
    }
    Err("视频重定向次数过多，远端任务仍保留".into())
}
