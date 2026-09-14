use rusqlite::{params, Connection, OptionalExtension};
use std::io::Write;
use tauri::Manager;

fn database(app: &tauri::AppHandle) -> Result<Connection, String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let connection =
        Connection::open(directory.join("workbench.sqlite3")).map_err(|e| e.to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS library (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL);").map_err(|e| e.to_string())?;
    Ok(connection)
}

#[tauri::command]
pub(crate) fn library_read(app: tauri::AppHandle) -> Result<Option<String>, String> {
    database(&app)?
        .query_row("SELECT payload FROM library WHERE id=1", [], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn library_write(
    app: tauri::AppHandle,
    payload: String,
    expected_revision: i64,
) -> Result<(), String> {
    if payload.len() > 64 * 1024 * 1024 {
        return Err("项目库超过 64 MiB，请导出并归档部分项目".into());
    }
    let value: serde_json::Value = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
    if value["revision"].as_i64() != Some(expected_revision + 1) {
        return Err("无效的保存版本".into());
    }
    let mut connection = database(&app)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let revision: i64 = transaction
        .query_row("SELECT revision FROM library WHERE id=1", [], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(0);
    if revision != expected_revision {
        return Err("项目已在另一窗口更新，请备份当前内容后重新打开".into());
    }
    transaction
        .execute(
            "INSERT OR REPLACE INTO library SELECT 2, revision, payload FROM library WHERE id=1",
            [],
        )
        .map_err(|e| e.to_string())?;
    transaction
        .execute(
            "INSERT OR REPLACE INTO library(id, revision, payload) VALUES (1, ?1, ?2)",
            params![expected_revision + 1, payload],
        )
        .map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn export_document(
    app: tauri::AppHandle,
    name: String,
    content: String,
) -> Result<String, String> {
    if content.len() > 64 * 1024 * 1024 {
        return Err("导出文件过大".into());
    }
    let extension = if name.ends_with(".json") {
        "json"
    } else {
        "md"
    };
    let stem: String = name
        .trim_end_matches(&format!(".{extension}"))
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .take(60)
        .collect();
    let directory = app.path().download_dir().map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let path = directory.join(format!("{stem}-{stamp}.{extension}"));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
