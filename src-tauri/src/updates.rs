use futures_util::StreamExt;
use reqwest::{Client, Url};
use semver::Version;
use serde::Serialize;
use serde_json::Value;
use std::{cmp::Ordering, time::Duration};

const RELEASES_URL: &str = "https://github.com/Errorrrrr/ai-creator-workbench/releases";
const UPDATE_MANIFEST_URL: &str =
    "https://github.com/Errorrrrr/ai-creator-workbench/releases/latest/download/latest.json";
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);

fn trusted_manifest_location(url: &Url) -> bool {
    let github_path = url.path()
        == "/Errorrrrr/ai-creator-workbench/releases/latest/download/latest.json"
        || url
            .path()
            .strip_prefix("/Errorrrrr/ai-creator-workbench/releases/download/")
            .and_then(|path| path.split_once('/'))
            .is_some_and(|(tag, file)| !tag.is_empty() && file == "latest.json");
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && (url.host_str() == Some("release-assets.githubusercontent.com")
            || (url.host_str() == Some("github.com") && github_path))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCheck {
    status: String,
    current_version: String,
    latest_version: Option<String>,
    published_at: Option<String>,
    notes: String,
    release_url: Option<String>,
    download_url: Option<String>,
    asset_name: Option<String>,
    platform: String,
    auto_install_available: bool,
}

fn decode_segment(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let encoded = bytes.get(index + 1..index + 3).ok_or("更新链接路径无效")?;
            let encoded = std::str::from_utf8(encoded).map_err(|_| "更新链接路径无效")?;
            decoded.push(u8::from_str_radix(encoded, 16).map_err(|_| "更新链接路径无效")?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    let segment = String::from_utf8(decoded).map_err(|_| "更新链接路径无效")?;
    if matches!(segment.as_str(), "." | "..")
        || segment
            .chars()
            .any(|ch| ch == '/' || ch == '\\' || ch.is_control())
    {
        return Err("更新链接路径无效".into());
    }
    Ok(segment)
}

fn validated_update_url(value: &str) -> Result<(Url, Vec<String>), String> {
    let url = Url::parse(value).map_err(|_| "更新链接无效")?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("只允许打开本项目的 GitHub 官方发布链接".into());
    }
    let segments = url
        .path_segments()
        .ok_or("更新链接路径无效")?
        .filter(|part| !part.is_empty())
        .map(decode_segment)
        .collect::<Result<Vec<_>, _>>()?;
    let prefix = segments.get(0).is_some_and(|part| part == "Errorrrrr")
        && segments
            .get(1)
            .is_some_and(|part| part == "ai-creator-workbench")
        && segments.get(2).is_some_and(|part| part == "releases");
    let page = segments.len() == 3
        || (segments.len() == 4 && segments[3] == "latest")
        || (segments.len() == 5 && segments[3] == "tag");
    let asset = segments.len() == 6 && segments[3] == "download";
    if !prefix || (!page && !asset) {
        return Err("只允许打开本项目的 GitHub 官方发布链接".into());
    }
    Ok((url, segments))
}

fn version(value: &str) -> Result<Version, String> {
    Version::parse(
        value
            .strip_prefix('v')
            .or_else(|| value.strip_prefix('V'))
            .unwrap_or(value),
    )
    .map_err(|_| "发布版本号不是有效的语义版本，暂时无法比较".into())
}

fn normalized_platform(platform: &str, architecture: &str) -> (String, String) {
    let os = if matches!(platform, "darwin" | "macos") {
        "macos"
    } else {
        platform
    };
    let arch = match architecture {
        "arm64" | "aarch64" => "aarch64",
        "x64" | "x86_64" | "amd64" => "x86_64",
        other => other,
    };
    (os.into(), arch.into())
}

fn empty_result(
    current_version: &str,
    platform: &str,
    architecture: &str,
) -> Result<UpdateCheck, String> {
    version(current_version)?;
    let (os, arch) = normalized_platform(platform, architecture);
    Ok(UpdateCheck {
        status: "no_release".into(),
        current_version: current_version.into(),
        latest_version: None,
        published_at: None,
        notes: "未找到可访问的稳定更新清单；可能尚未发布更新清单，或仓库当前不可访问。".into(),
        release_url: Some(RELEASES_URL.into()),
        download_url: None,
        asset_name: None,
        platform: format!("{os}-{arch}"),
        auto_install_available: false,
    })
}

fn architecture_marker(name: &str, marker: &str) -> bool {
    name.match_indices(marker).any(|(start, _)| {
        let before = start == 0 || matches!(name.as_bytes()[start - 1], b'_' | b'-');
        let end = start + marker.len();
        let after = end == name.len() || matches!(name.as_bytes()[end], b'_' | b'-' | b'.');
        before && after
    })
}

fn asset_score(name: &str, architecture: &str) -> u8 {
    let name = name.to_lowercase();
    if !name.ends_with(".dmg") {
        return 0;
    }
    let arm = ["aarch64", "arm64"]
        .iter()
        .any(|marker| architecture_marker(&name, marker));
    let intel = ["x86_64", "x64", "amd64"]
        .iter()
        .any(|marker| architecture_marker(&name, marker));
    if arm && intel {
        return 0;
    }
    if (architecture == "aarch64" && arm) || (architecture == "x86_64" && intel) {
        return 2;
    }
    if !arm
        && !intel
        && ["universal", "universal2"]
            .iter()
            .any(|marker| architecture_marker(&name, marker))
    {
        return 1;
    }
    0
}

fn parse_release(
    payload: &Value,
    current_version: &str,
    platform: &str,
    architecture: &str,
) -> Result<UpdateCheck, String> {
    if payload.get("draft").and_then(Value::as_bool) != Some(false)
        || payload.get("prerelease").and_then(Value::as_bool) != Some(false)
    {
        return Err("GitHub 返回的稳定发布信息无效".into());
    }
    let tag = payload
        .get("tag_name")
        .and_then(Value::as_str)
        .ok_or("GitHub 返回的稳定发布信息无效")?;
    let latest = version(tag)?;
    if !latest.pre.is_empty() {
        return Err("最新发布不是稳定版本，暂不提供更新".into());
    }
    let (release_url, release_segments) = validated_update_url(
        payload
            .get("html_url")
            .and_then(Value::as_str)
            .ok_or("GitHub 发布页无效")?,
    )?;
    if release_segments.len() != 5 || release_segments[3] != "tag" || release_segments[4] != tag {
        return Err("GitHub 发布页与版本信息不一致".into());
    }
    let mut result = empty_result(current_version, platform, architecture)?;
    let (os, arch) = normalized_platform(platform, architecture);
    let mut best_score = 0;
    if os == "macos" {
        if let Some(assets) = payload.get("assets").and_then(Value::as_array) {
            for asset in assets {
                if asset.get("state").and_then(Value::as_str) != Some("uploaded") {
                    continue;
                }
                let Some(name) = asset.get("name").and_then(Value::as_str) else {
                    continue;
                };
                let score = asset_score(name, &arch);
                if score <= best_score {
                    continue;
                }
                let Some(link) = asset.get("browser_download_url").and_then(Value::as_str) else {
                    continue;
                };
                let Ok((url, segments)) = validated_update_url(link) else {
                    continue;
                };
                if segments.len() != 6
                    || segments[3] != "download"
                    || segments[4] != tag
                    || segments[5] != name
                {
                    continue;
                }
                result.download_url = Some(url.into());
                result.asset_name = Some(name.into());
                best_score = score;
            }
        }
    }
    result.status = match latest.cmp_precedence(&version(current_version)?) {
        Ordering::Greater => "update_available",
        Ordering::Less => "ahead",
        Ordering::Equal => "up_to_date",
    }
    .into();
    result.latest_version = Some(latest.to_string());
    result.published_at = payload
        .get("published_at")
        .and_then(Value::as_str)
        .filter(|value| {
            value.len() <= 64
                && value.contains('T')
                && (value.ends_with('Z') || value.contains('+'))
        })
        .map(str::to_owned);
    result.notes = payload
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .chars()
        .take(12000)
        .collect();
    result.release_url = Some(release_url.into());
    Ok(result)
}

fn status_error(status: u16) -> String {
    if status == 429 {
        "GitHub 下载服务暂时限制请求，请稍后重试".into()
    } else if matches!(status, 401 | 403) {
        "GitHub 暂时拒绝访问此发布信息，请稍后重试".into()
    } else {
        format!("GitHub 检查更新返回 HTTP {status}")
    }
}

#[tauri::command]
pub(crate) fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

pub(crate) async fn fetch_manifest(app: &tauri::AppHandle) -> Result<Option<Value>, String> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(CHECK_TIMEOUT)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > 5 || !trusted_manifest_location(attempt.url()) {
                attempt.error("更新清单重定向地址不受信任或次数过多")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| "无法初始化更新检查")?;
    let response = client
        .get(manifest_url(app))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(
            reqwest::header::USER_AGENT,
            format!("AI-Creator-Workbench/{}", app.package_info().version),
        )
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "检查更新超时，请稍后重试"
            } else {
                "无法连接 GitHub 检查更新，请检查网络后重试"
            }
        })?;
    if response.status().as_u16() == 404 {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(status_error(response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("GitHub 发布信息超过 1 MiB 限制".into());
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            if error.is_timeout() {
                "检查更新超时，请稍后重试"
            } else {
                "读取 GitHub 发布信息失败"
            }
        })?;
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("GitHub 发布信息超过 1 MiB 限制".into());
        }
        body.extend_from_slice(&chunk);
    }
    let payload: Value =
        serde_json::from_slice(&body).map_err(|_| "GitHub 返回了无法解析的发布信息")?;
    Ok(Some(payload))
}

// Local fixtures exist only in debug builds and only for a separate QA application ID.
fn manifest_url(app: &tauri::AppHandle) -> String {
    #[cfg(debug_assertions)]
    if app
        .config()
        .identifier
        .starts_with("com.aicreator.workbench.qa-")
    {
        if let Some(value) = option_env!("ACW_QA_UPDATE_URL") {
            if Url::parse(&value)
                .is_ok_and(|url| url.scheme() == "http" && url.host_str() == Some("127.0.0.1"))
            {
                return value.into();
            }
        }
    }
    let _ = app;
    UPDATE_MANIFEST_URL.into()
}

pub(crate) fn updater_metadata(payload: &Value) -> Result<(), String> {
    let version = payload["version"].as_str().ok_or("缺少签名更新版本")?;
    if payload["tag_name"].as_str() != Some(&format!("v{version}")) {
        return Err("更新包版本与发布版本不一致".into());
    }
    if !Version::parse(version)
        .map_err(|_| "更新版本无效")?
        .pre
        .is_empty()
    {
        return Err("不允许安装预发布版本".into());
    }
    let platform = &payload["platforms"]["darwin-aarch64"];
    let (url, segments) =
        validated_update_url(platform["url"].as_str().ok_or("缺少当前平台更新包")?)?;
    if segments.len() != 6
        || segments[3] != "download"
        || segments[4] != format!("v{version}")
        || segments[5] != format!("ai-creator-workbench_{version}_aarch64.app.tar.gz")
        || platform["signature"]
            .as_str()
            .is_none_or(|s| s.is_empty() || s.len() > 8192)
    {
        return Err("签名更新包信息无效".into());
    }
    let _ = url;
    Ok(())
}

#[tauri::command]
pub(crate) async fn check_for_updates(app: tauri::AppHandle) -> Result<UpdateCheck, String> {
    let current = app.package_info().version.to_string();
    let Some(payload) = fetch_manifest(&app).await? else {
        return empty_result(&current, std::env::consts::OS, std::env::consts::ARCH);
    };
    let mut result = parse_release(
        &payload,
        &current,
        std::env::consts::OS,
        std::env::consts::ARCH,
    )?;
    result.auto_install_available = cfg!(all(target_os = "macos", target_arch = "aarch64"))
        && result.status == "update_available"
        && updater_metadata(&payload).is_ok();
    Ok(result)
}

#[tauri::command]
pub(crate) async fn open_update_link(url: String) -> Result<(), String> {
    let (url, _) = validated_update_url(&url)?;
    #[cfg(target_os = "macos")]
    {
        let mut command = tokio::process::Command::new("/usr/bin/open");
        command.arg("--").arg(url.as_str()).kill_on_drop(true);
        let status = tokio::time::timeout(Duration::from_secs(5), command.status())
            .await
            .map_err(|_| "打开官方下载页超时")?
            .map_err(|_| "无法打开官方下载页")?;
        if !status.success() {
            return Err("无法打开官方下载页".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        Err("当前平台请复制官方发布链接到浏览器打开".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn release(tag: &str) -> Value {
        json!({"draft": false, "prerelease": false, "tag_name": tag, "html_url": format!("{RELEASES_URL}/tag/{tag}"), "body": "发布说明", "published_at": "2026-10-05T10:00:00Z", "assets": []})
    }

    #[test]
    fn signed_metadata_must_match_stable_tag_platform_and_exact_package() {
        let mut value = release("v0.6.0");
        value["version"] = json!("0.6.0");
        value["platforms"] = json!({"darwin-aarch64":{"url":format!("{RELEASES_URL}/download/v0.6.0/ai-creator-workbench_0.6.0_aarch64.app.tar.gz"),"signature":"signed-data"}});
        assert!(updater_metadata(&value).is_ok());
        for bad in ["https://evil.example/app.tar.gz", "https://github.com/Errorrrrr/ai-creator-workbench/releases/download/v0.5.0/ai-creator-workbench_0.5.0_aarch64.app.tar.gz"] {
            let mut changed = value.clone(); changed["platforms"]["darwin-aarch64"]["url"] = json!(bad);
            assert!(updater_metadata(&changed).is_err());
        }
        value["version"] = json!("0.7.0");
        assert!(updater_metadata(&value).is_err());
    }

    #[test]
    fn links_are_limited_to_exact_official_release_paths() {
        for url in [
            RELEASES_URL.to_owned(),
            format!("{RELEASES_URL}/latest"),
            format!("{RELEASES_URL}/tag/v1.0.0"),
            format!("{RELEASES_URL}/download/v1.0.0/app_aarch64.dmg"),
        ] {
            assert!(validated_update_url(&url).is_ok(), "{url}");
        }
        for url in ["https://evil.example/Errorrrrr/ai-creator-workbench/releases", "https://github.com/other/repo/releases", "http://github.com/Errorrrrr/ai-creator-workbench/releases", "https://user@github.com/Errorrrrr/ai-creator-workbench/releases", "https://github.com:444/Errorrrrr/ai-creator-workbench/releases", "https://github.com/Errorrrrr/ai-creator-workbench/releases?", "https://github.com/Errorrrrr/ai-creator-workbench/releases#", "https://github.com/Errorrrrr/ai-creator-workbench/releases/download/v1/app%2Fsecret.dmg", "https://github.com/Errorrrrr/ai-creator-workbench/issues"] {
            assert!(validated_update_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn versions_compare_numerically_and_ignore_build_metadata() {
        assert_eq!(
            parse_release(&release("v0.10.0"), "0.9.9", "macos", "aarch64")
                .unwrap()
                .status,
            "update_available"
        );
        assert_eq!(
            parse_release(&release("v1.0.0"), "1.0.0-beta.1", "macos", "aarch64")
                .unwrap()
                .status,
            "update_available"
        );
        assert_eq!(
            parse_release(&release("v1.0.0"), "1.0.0+local", "macos", "aarch64")
                .unwrap()
                .status,
            "up_to_date"
        );
        assert_eq!(
            parse_release(&release("v0.2.3"), "0.3.0", "macos", "aarch64")
                .unwrap()
                .status,
            "ahead"
        );
        assert!(parse_release(&release("v1.0.0-beta"), "0.3.0", "macos", "aarch64").is_err());
        assert!(parse_release(&release("not-a-version"), "0.3.0", "macos", "aarch64").is_err());
    }

    #[test]
    fn selects_native_architecture_dmg_before_universal_and_rejects_foreign_urls() {
        let mut payload = release("v0.3.0");
        payload["assets"] = json!(["App_0.3.0_universal.dmg", "App_0.3.0_x64.dmg", "App_0.3.0_aarch64.dmg"].map(|name| json!({"name": name, "state": "uploaded", "browser_download_url": format!("{RELEASES_URL}/download/v0.3.0/{name}")})));
        assert_eq!(
            parse_release(&payload, "0.2.3", "macos", "aarch64")
                .unwrap()
                .asset_name
                .as_deref(),
            Some("App_0.3.0_aarch64.dmg")
        );
        assert_eq!(
            parse_release(&payload, "0.2.3", "macos", "x86_64")
                .unwrap()
                .asset_name
                .as_deref(),
            Some("App_0.3.0_x64.dmg")
        );
        assert!(parse_release(&payload, "0.2.3", "linux", "x86_64")
            .unwrap()
            .asset_name
            .is_none());
        payload["assets"][2]["browser_download_url"] =
            json!("https://evil.example/App_0.3.0_aarch64.dmg");
        assert_eq!(
            parse_release(&payload, "0.2.3", "macos", "aarch64")
                .unwrap()
                .asset_name
                .as_deref(),
            Some("App_0.3.0_universal.dmg")
        );
    }

    #[test]
    fn no_asset_keeps_release_page_and_missing_release_is_not_up_to_date() {
        let result = parse_release(&release("v0.3.0"), "0.2.3", "macos", "aarch64").unwrap();
        assert!(result.download_url.is_none());
        assert!(result.release_url.is_some());
        let missing = empty_result("0.3.0", "macos", "aarch64").unwrap();
        assert_eq!(missing.status, "no_release");
        assert!(missing.notes.contains("仓库当前不可访问"));
        assert!(status_error(429).contains("暂时限制请求"));
        assert!(status_error(403).contains("拒绝访问"));
    }
}
