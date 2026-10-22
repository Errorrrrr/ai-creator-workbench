use std::collections::HashMap;
use tokio_util::sync::CancellationToken;

const PROXY_VARIABLES: [&str; 6] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
];

#[derive(Clone, Default, serde::Deserialize, serde::Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ProxySettings {
    pub mode: String,
    pub url: String,
}

static SETTINGS_PATH: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

pub(crate) fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|_| "无法定位全局网络配置目录")?;
    std::fs::create_dir_all(&directory).map_err(|_| "无法创建全局网络配置目录")?;
    SETTINGS_PATH
        .set(directory.join("network-proxy.json"))
        .map_err(|_| "网络配置已初始化".into())
}

fn load_settings() -> Result<ProxySettings, String> {
    let Some(path) = SETTINGS_PATH.get() else {
        // Unit tests do not run the desktop application's setup lifecycle.
        #[cfg(test)]
        return Ok(ProxySettings {
            mode: "direct".into(),
            url: String::new(),
        });
        #[cfg(not(test))]
        return Err("全局网络配置尚未初始化".into());
    };
    match std::fs::read(path) {
        Ok(bytes) if bytes.len() <= 8192 => serde_json::from_slice(&bytes)
            .map_err(|_| "全局代理配置无效，请在连接中心重新保存".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ProxySettings {
            mode: "auto".into(),
            url: String::new(),
        }),
        _ => Err("无法读取全局代理配置，请在连接中心重新保存".into()),
    }
}

#[tauri::command]
pub(crate) fn network_proxy_get() -> Result<ProxySettings, String> {
    load_settings()
}

#[tauri::command]
pub(crate) fn network_proxy_save(mut settings: ProxySettings) -> Result<ProxySettings, String> {
    use std::io::Write;
    configured_environment(&settings)?;
    if settings.mode.is_empty() {
        settings.mode = "auto".into();
    }
    settings.url = if settings.mode == "manual" {
        settings.url.trim().to_owned()
    } else {
        String::new()
    };
    let path = SETTINGS_PATH.get().ok_or("全局网络配置尚未初始化")?;
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("配置目录无效")?)
        .map_err(|_| "无法保存全局代理设置")?;
    let bytes = serde_json::to_vec(&settings).map_err(|_| "代理配置格式无效")?;
    file.write_all(&bytes)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "无法保存全局代理设置")?;
    file.persist(path)
        .map_err(|_| "无法替换全局代理配置，原设置保留")?;
    Ok(settings)
}

fn configured_environment(
    settings: &ProxySettings,
) -> Result<Option<Vec<(String, String)>>, String> {
    match settings.mode.as_str() {
        "" | "auto" => Ok(None),
        "direct" => Ok(Some(Vec::new())),
        "manual" => {
            let address = settings.url.trim();
            let invalid =
                "请输入有效的 HTTP／HTTPS 代理地址（含端口，不含账号、密码、路径或查询参数）";
            if address.len() > 2048
                || address
                    .chars()
                    .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
            {
                return Err(invalid.into());
            }
            let url = reqwest::Url::parse(address).map_err(|_| invalid)?;
            // Require an explicit port even when it is the scheme default.
            let authority = address
                .split_once("://")
                .map(|(_, tail)| tail.trim_end_matches('/'))
                .unwrap_or("");
            let port = authority
                .rsplit_once(':')
                .and_then(|(_, port)| port.parse::<u16>().ok());
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || authority.contains('@')
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
                || port.is_none_or(|port| port == 0)
            {
                return Err(invalid.into());
            }
            Ok(Some(
                ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]
                    .into_iter()
                    .map(|name| (name.into(), address.to_owned()))
                    .collect(),
            ))
        }
        _ => Err("代理模式无效，请在连接中心重新设置".into()),
    }
}

async fn resolve_environment(
    settings: &ProxySettings,
    token: &CancellationToken,
) -> Result<Vec<(String, String)>, String> {
    if token.is_cancelled() {
        return Err("生成已取消".into());
    }
    let mut environment = if let Some(environment) = configured_environment(settings)? {
        environment
    } else if has_explicit_proxy(PROXY_VARIABLES.map(|name| std::env::var(name).ok())) {
        PROXY_VARIABLES
            .into_iter()
            .chain(["NO_PROXY", "no_proxy"])
            .filter_map(|name| std::env::var(name).ok().map(|value| (name.into(), value)))
            .collect()
    } else {
        let mut environment = system_proxy_env(token).await?;
        environment.extend(
            ["NO_PROXY", "no_proxy"]
                .into_iter()
                .filter_map(|name| std::env::var(name).ok().map(|value| (name.into(), value))),
        );
        environment
    };
    if settings.mode != "direct" {
        let exclusions = environment
            .iter()
            .find(|(key, _)| key == "no_proxy")
            .or_else(|| environment.iter().find(|(key, _)| key == "NO_PROXY"))
            .map(|(_, value)| value.clone())
            .unwrap_or_default();
        environment.retain(|(key, _)| !key.eq_ignore_ascii_case("no_proxy"));
        let exclusions = format!("localhost,127.0.0.1,::1,{exclusions}");
        environment.push(("NO_PROXY".into(), exclusions.clone()));
        environment.push(("no_proxy".into(), exclusions));
    }
    Ok(environment)
}

async fn configure_cli_with_settings(
    command: &mut tokio::process::Command,
    settings: &ProxySettings,
    token: &CancellationToken,
) -> Result<(), String> {
    let environment = resolve_environment(settings, token).await?;
    for name in PROXY_VARIABLES.into_iter().chain(["NO_PROXY", "no_proxy"]) {
        command.env_remove(name);
    }
    command.envs(environment);
    Ok(())
}

pub(crate) async fn configure_cli(
    command: &mut tokio::process::Command,
    token: &CancellationToken,
) -> Result<(), String> {
    configure_cli_with_settings(command, &load_settings()?, token).await
}

fn apply_http_environment(
    mut builder: reqwest::ClientBuilder,
    environment: &[(String, String)],
) -> Result<reqwest::ClientBuilder, String> {
    builder = builder.no_proxy();
    let value = |upper: &str, lower: &str| {
        environment
            .iter()
            .find(|(key, value)| key == lower && !value.is_empty())
            .or_else(|| {
                environment
                    .iter()
                    .find(|(key, value)| key == upper && !value.is_empty())
            })
            .map(|(_, value)| value.as_str())
    };
    let exclusions = value("NO_PROXY", "no_proxy").and_then(reqwest::NoProxy::from_string);
    for (upper, lower) in [
        ("HTTP_PROXY", "http_proxy"),
        ("HTTPS_PROXY", "https_proxy"),
        ("ALL_PROXY", "all_proxy"),
    ] {
        if let Some(address) = value(upper, lower) {
            let proxy = match upper {
                "HTTP_PROXY" => reqwest::Proxy::http(address),
                "HTTPS_PROXY" => reqwest::Proxy::https(address),
                _ => reqwest::Proxy::all(address),
            }
            .map_err(|_| "代理地址或协议无效，请检查全局代理设置")?;
            builder = builder.proxy(proxy.no_proxy(exclusions.clone()));
        }
    }
    Ok(builder)
}

pub(crate) async fn http_builder() -> Result<reqwest::ClientBuilder, String> {
    let environment = resolve_environment(&load_settings()?, &CancellationToken::new()).await?;
    apply_http_environment(reqwest::Client::builder(), &environment)
}

fn has_explicit_proxy(values: impl IntoIterator<Item = Option<String>>) -> bool {
    values
        .into_iter()
        .flatten()
        .any(|value| !value.trim().is_empty())
}

fn proxy_url(host: &str, port: &str) -> Result<String, String> {
    let port: u16 = port
        .parse()
        .ok()
        .filter(|port| *port > 0)
        .ok_or("系统代理端口无效，请检查 macOS 网络代理设置")?;
    if host.is_empty()
        || host
            .chars()
            .any(|c| c.is_whitespace() || "/@?#\\".contains(c))
    {
        return Err("系统代理地址无效，请检查 macOS 网络代理设置".into());
    }
    let host = if host.parse::<std::net::Ipv6Addr>().is_ok() {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    let address = format!("http://{host}:{port}");
    let url =
        reqwest::Url::parse(&address).map_err(|_| "系统代理地址无效，请检查 macOS 网络代理设置")?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
    {
        return Err("系统代理地址无效，请检查 macOS 网络代理设置".into());
    }
    Ok(address)
}

// scutil exposes effective settings without changing the user's network configuration.
// Only manual HTTP(S) proxies are translated; PAC rules cannot be represented by env vars.
fn parse_system_proxy(
    text: &str,
    preserve_no_proxy: bool,
) -> Result<Vec<(String, String)>, String> {
    let mut fields = HashMap::new();
    let mut exceptions = Vec::new();
    let mut in_exceptions = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with("ExceptionsList :") {
            in_exceptions = true;
            continue;
        }
        if line == "}" {
            in_exceptions = false;
            continue;
        }
        let Some((key, value)) = line.split_once(" : ") else {
            continue;
        };
        if in_exceptions {
            let value = value
                .strip_prefix("*.")
                .map(|suffix| format!(".{suffix}"))
                .unwrap_or_else(|| value.to_owned());
            if !value.is_empty()
                && value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || ".-_:/".contains(c))
            {
                exceptions.push(value);
            }
        } else {
            fields.insert(key, value);
        }
    }
    if fields.get("ProxyAutoConfigEnable") == Some(&"1")
        || fields.get("ProxyAutoDiscoveryEnable") == Some(&"1")
    {
        return Err(
            "工作台暂不支持系统 PAC／自动发现代理，请配置 HTTP／HTTPS 系统代理或显式代理环境变量"
                .into(),
        );
    }
    let mut environment = Vec::new();
    for (prefix, upper, lower) in [
        ("HTTP", "HTTP_PROXY", "http_proxy"),
        ("HTTPS", "HTTPS_PROXY", "https_proxy"),
    ] {
        if fields.get(format!("{prefix}Enable").as_str()) != Some(&"1") {
            continue;
        }
        let host = fields
            .get(format!("{prefix}Proxy").as_str())
            .copied()
            .unwrap_or("");
        let port = fields
            .get(format!("{prefix}Port").as_str())
            .copied()
            .unwrap_or("");
        let address = proxy_url(host, port)?;
        environment.push((upper.to_owned(), address.clone()));
        environment.push((lower.to_owned(), address));
    }
    if environment.is_empty() && fields.get("SOCKSEnable") == Some(&"1") {
        return Err("工作台暂不自动转换仅 SOCKS 的系统代理，请同时配置 HTTP／HTTPS 系统代理或显式代理环境变量".into());
    }
    if !environment.is_empty() && !preserve_no_proxy && !exceptions.is_empty() {
        let exclusions = exceptions.join(",");
        environment.push(("NO_PROXY".into(), exclusions.clone()));
        environment.push(("no_proxy".into(), exclusions));
    }
    Ok(environment)
}

pub(crate) async fn system_proxy_env(
    token: &CancellationToken,
) -> Result<Vec<(String, String)>, String> {
    if token.is_cancelled() {
        return Err("生成已取消".into());
    }
    if has_explicit_proxy(PROXY_VARIABLES.map(|name| std::env::var(name).ok())) {
        return Ok(Vec::new());
    }
    #[cfg(target_os = "macos")]
    {
        use std::{process::Stdio, time::Duration};
        let mut command = tokio::process::Command::new("/usr/sbin/scutil");
        command
            .arg("--proxy")
            .env_clear()
            .env("LANG", "C")
            .stdin(Stdio::null())
            .kill_on_drop(true);
        let output = tokio::select! {
            _ = token.cancelled() => return Err("生成已取消".into()),
            result = tokio::time::timeout(Duration::from_secs(3), command.output()) => result.map_err(|_| "读取 macOS 系统代理超时，未提交生成")?.map_err(|_| "无法读取 macOS 系统代理，未提交生成")?,
        };
        if !output.status.success() || output.stdout.len() > 64 * 1024 {
            return Err("无法读取 macOS 系统代理，未提交生成".into());
        }
        let text = std::str::from_utf8(&output.stdout)
            .map_err(|_| "macOS 系统代理格式无效，未提交生成")?;
        if !text.trim_start().starts_with("<dictionary>") {
            return Err("macOS 系统代理格式无效，未提交生成".into());
        }
        parse_system_proxy(
            text,
            std::env::var_os("NO_PROXY").is_some() || std::env::var_os("no_proxy").is_some(),
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const MANUAL: &str = "<dictionary> {\n  ExceptionsList : <array> {\n    0 : 127.0.0.1\n    1 : *.local\n    2 : 10.0.0.0/8\n  }\n  HTTPEnable : 1\n  HTTPProxy : 127.0.0.1\n  HTTPPort : 7897\n  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 8899\n  SOCKSEnable : 1\n}";
    #[test]
    fn manual_system_proxy_preserves_protocol_ports_and_exclusions() {
        let values: HashMap<_, _> = parse_system_proxy(MANUAL, false)
            .unwrap()
            .into_iter()
            .collect();
        assert_eq!(values["HTTP_PROXY"], "http://127.0.0.1:7897");
        assert_eq!(values["https_proxy"], "http://127.0.0.1:8899");
        assert_eq!(values["NO_PROXY"], "127.0.0.1,.local,10.0.0.0/8");
        assert!(!parse_system_proxy(MANUAL, true)
            .unwrap()
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case("no_proxy")));
        assert!(parse_system_proxy(
            "<dictionary> {\n HTTPEnable : 0\n HTTPProxy : old\n HTTPPort : 7897\n}",
            false
        )
        .unwrap()
        .is_empty());
        let changed = MANUAL.replace("8899", "9000");
        assert!(parse_system_proxy(&changed, false)
            .unwrap()
            .iter()
            .any(|(_, value)| value == "http://127.0.0.1:9000"));
    }
    #[test]
    fn explicit_proxy_wins_and_invalid_or_unsupported_system_settings_do_not_fall_back_silently() {
        assert!(has_explicit_proxy([
            None,
            Some("http://custom:8080".into())
        ]));
        assert!(!has_explicit_proxy([None, Some(" ".into())]));
        for config in [
            "ProxyAutoConfigEnable : 1",
            "ProxyAutoDiscoveryEnable : 1",
            "SOCKSEnable : 1",
            "HTTPEnable : 1\nHTTPProxy : localhost\nHTTPPort : 0",
        ] {
            assert!(parse_system_proxy(config, false).is_err());
        }
        assert_eq!(proxy_url("::1", "7897").unwrap(), "http://[::1]:7897");
        for host in ["", "user:password@host", "host/path", "host\nsecret"] {
            assert!(proxy_url(host, "7897").is_err());
        }
        for port in ["0", "65536", "not-a-port"] {
            assert!(proxy_url("localhost", port).is_err());
        }
    }
    #[tokio::test]
    async fn manual_and_direct_override_all_inherited_proxy_variables() {
        for mode in ["manual", "direct"] {
            let mut command = tokio::process::Command::new("unused");
            for name in PROXY_VARIABLES.into_iter().chain(["NO_PROXY", "no_proxy"]) {
                command.env(name, "stale");
            }
            configure_cli_with_settings(
                &mut command,
                &ProxySettings {
                    mode: mode.into(),
                    url: "http://127.0.0.1:7897".into(),
                },
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            let variables: HashMap<_, _> = command
                .as_std()
                .get_envs()
                .map(|(k, v)| (k.to_str().unwrap(), v.map(|s| s.to_str().unwrap())))
                .collect();
            for name in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
                assert_eq!(
                    variables[name],
                    if mode == "manual" {
                        Some("http://127.0.0.1:7897")
                    } else {
                        None
                    }
                );
            }
            for name in ["ALL_PROXY", "all_proxy"] {
                assert_eq!(variables[name], None);
            }
            for name in ["NO_PROXY", "no_proxy"] {
                assert_eq!(
                    variables[name],
                    if mode == "manual" {
                        Some("localhost,127.0.0.1,::1,")
                    } else {
                        None
                    }
                );
            }
        }
    }
    async fn mock_http() -> (std::net::SocketAddr, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut stream, _) =
                tokio::time::timeout(std::time::Duration::from_secs(3), listener.accept())
                    .await
                    .unwrap()
                    .unwrap();
            let mut request = Vec::new();
            loop {
                let mut bytes = [0; 1024];
                let count = stream.read(&mut bytes).await.unwrap();
                request.extend_from_slice(&bytes[..count]);
                if count == 0 || request.windows(4).any(|part| part == b"\r\n\r\n") {
                    break;
                }
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK")
                .await
                .unwrap();
            String::from_utf8(request).unwrap()
        });
        (address, task)
    }

    #[tokio::test]
    async fn http_traffic_reaches_manual_proxy_and_loopback_bypasses_it() {
        let (proxy, proxy_request) = mock_http().await;
        let environment = resolve_environment(
            &ProxySettings {
                mode: "manual".into(),
                url: format!("http://{proxy}"),
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let client = apply_http_environment(reqwest::Client::builder(), &environment)
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(
            client
                .get("http://unresolvable-proxy-test.invalid/models")
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "OK"
        );
        assert!(proxy_request
            .await
            .unwrap()
            .starts_with("GET http://unresolvable-proxy-test.invalid/models HTTP/1.1"));
        // The proxy is now closed: a local request can succeed only by bypassing it.
        let (local, local_request) = mock_http().await;
        assert_eq!(
            client
                .get(format!("http://{local}/api/tags"))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "OK"
        );
        assert!(local_request
            .await
            .unwrap()
            .starts_with("GET /api/tags HTTP/1.1"));
    }

    #[tokio::test]
    async fn direct_http_clears_an_existing_proxy() {
        let (local, request) = mock_http().await;
        let builder =
            reqwest::Client::builder().proxy(reqwest::Proxy::all("http://127.0.0.1:1").unwrap());
        let client = apply_http_environment(builder, &[])
            .unwrap()
            .build()
            .unwrap();
        assert!(client
            .get(format!("http://{local}/direct"))
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
        assert!(request.await.unwrap().starts_with("GET /direct HTTP/1.1"));
    }

    #[test]
    fn manual_proxy_validation_rejects_credentials_and_malformed_addresses() {
        assert!(configured_environment(&ProxySettings::default())
            .unwrap()
            .is_none());
        for url in [
            "http://localhost:7897",
            "https://host:443",
            "http://[::1]:8080/",
        ] {
            assert!(configured_environment(&ProxySettings {
                mode: "manual".into(),
                url: url.into()
            })
            .is_ok());
        }
        for url in [
            "",
            "localhost:7897",
            "socks5://localhost:7897",
            "http://localhost",
            "http://user:secret@host:7897",
            "http://@host:7897",
            "http://host:0",
            "http://host:65536",
            "http://host:7897/path",
            "http://host:7897?",
            "http://host:7897#",
            "http://host:7897\nsecret",
        ] {
            assert!(
                configured_environment(&ProxySettings {
                    mode: "manual".into(),
                    url: url.into()
                })
                .is_err(),
                "{url}"
            );
        }
        assert!(configured_environment(&ProxySettings {
            mode: "invalid".into(),
            url: String::new()
        })
        .is_err());
    }
    #[tokio::test]
    async fn cancellation_stops_before_reading_proxy_settings() {
        let token = CancellationToken::new();
        token.cancel();
        assert_eq!(system_proxy_env(&token).await.unwrap_err(), "生成已取消");
    }
}
