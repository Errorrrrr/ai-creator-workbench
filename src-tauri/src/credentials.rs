const SERVICE: &str = "com.aicreator.workbench.connections";

fn account(id: &str, endpoint: &str) -> Result<String, String> {
    if id.is_empty() || id.len() > 128 || endpoint.len() > 2048 {
        return Err("连接标识无效".into());
    }
    Ok(format!("{id}|{endpoint}"))
}

#[tauri::command]
pub(crate) fn credential_save(id: String, endpoint: String, secret: String) -> Result<(), String> {
    let account = account(&id, &endpoint)?;
    if secret.len() > 8192 {
        return Err("密钥长度超出限制".into());
    }
    #[cfg(target_os = "macos")]
    {
        if secret.is_empty() {
            match security_framework::passwords::delete_generic_password(SERVICE, &account) {
                Ok(()) => Ok(()),
                Err(error) if error.code() == -25300 => Ok(()),
                Err(_) => Err("无法移除钥匙串中的连接密钥".into()),
            }
        } else {
            security_framework::passwords::set_generic_password(
                SERVICE,
                &account,
                secret.as_bytes(),
            )
            .map_err(|_| "无法保存到 macOS 钥匙串".into())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (account, secret, SERVICE);
        Err("当前平台请使用会话密钥".into())
    }
}

#[tauri::command]
pub(crate) fn credential_load(id: String, endpoint: String) -> Result<Option<String>, String> {
    let account = account(&id, &endpoint)?;
    #[cfg(target_os = "macos")]
    {
        match security_framework::passwords::get_generic_password(SERVICE, &account) {
            Ok(value) => String::from_utf8(value)
                .map(Some)
                .map_err(|_| "密钥格式无效".into()),
            Err(error) if error.code() == -25300 => Ok(None),
            Err(_) => Err("无法读取 macOS 钥匙串，请检查访问授权".into()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (account, SERVICE);
        Ok(None)
    }
}
