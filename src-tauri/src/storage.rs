use rusqlite::{params, Connection, OptionalExtension};
use std::io::Write;
use tauri::Manager;

const MAX_LIBRARY_BYTES: usize = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: usize = 448 * 1024 * 1024;
const MAX_BACKUP_BYTES: usize = 512 * 1024 * 1024;
const BACKUP_ENVELOPE_RESERVE: usize = 1024;

fn initialize_database(connection: &Connection) -> Result<(), String> {
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS library (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS archive_snapshots (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);").map_err(|e| e.to_string())?;
    crate::project_deletion::initialize(connection)
}

fn database(app: &tauri::AppHandle) -> Result<Connection, String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let connection =
        Connection::open(directory.join("workbench.sqlite3")).map_err(|e| e.to_string())?;
    initialize_database(&connection)?;
    Ok(connection)
}

fn read_library(connection: &Connection, previous: bool) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT payload FROM library WHERE id=?1",
            [if previous { 2 } else { 1 }],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
}

fn read_archives(connection: &Connection, previous: bool) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT payload FROM archive_snapshots WHERE id=?1",
            [if previous { 2 } else { 1 }],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
}

fn current_revision(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row("SELECT revision FROM library WHERE id=1", [], |row| {
            row.get(0)
        })
        .optional()
        .map(|value| value.unwrap_or(0))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn library_read(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let db = database(&app)?;
    if let Ok(root) = crate::media::media_root(&app) {
        let _ = crate::project_deletion::cleanup(&db, &root);
    }
    read_library(&db, false)
}

#[tauri::command]
pub(crate) fn library_read_previous(app: tauri::AppHandle) -> Result<Option<String>, String> {
    read_library(&database(&app)?, true)
}

#[tauri::command]
pub(crate) fn library_read_archives(app: tauri::AppHandle) -> Result<Option<String>, String> {
    read_archives(&database(&app)?, false)
}

#[tauri::command]
pub(crate) fn library_read_previous_archives(
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    read_archives(&database(&app)?, true)
}

#[tauri::command]
pub(crate) fn library_current_revision(app: tauri::AppHandle) -> Result<i64, String> {
    current_revision(&database(&app)?)
}

fn validate_sizes(active_bytes: usize, archive_bytes: usize) -> Result<(), String> {
    if active_bytes > MAX_LIBRARY_BYTES {
        return Err("活动项目库超过 64 MiB，请归档部分项目后重试".into());
    }
    if archive_bytes > MAX_ARCHIVE_BYTES {
        return Err("归档库超过 448 MiB，请先导出完整备份".into());
    }
    if active_bytes
        .saturating_add(archive_bytes)
        .saturating_add(BACKUP_ENVELOPE_RESERVE)
        > MAX_BACKUP_BYTES
    {
        return Err("总容量已达到完整备份预算，请先导出完整备份".into());
    }
    Ok(())
}

#[cfg(test)]
fn write_library(
    connection: &mut Connection,
    payload: String,
    archive_payload: Option<String>,
    expected_revision: i64,
) -> Result<(), String> {
    write_library_with_media(
        connection,
        payload,
        archive_payload,
        expected_revision,
        None,
        None,
        None,
    )
}

fn write_library_with_media(
    connection: &mut Connection,
    payload: String,
    archive_payload: Option<String>,
    expected_revision: i64,
    media_import_id: Option<&str>,
    media_root: Option<&std::path::Path>,
    deleted_project_id: Option<&str>,
) -> Result<(), String> {
    validate_sizes(
        payload.len(),
        archive_payload.as_ref().map_or(2, String::len),
    )?;
    let next_revision = expected_revision
        .checked_add(1)
        .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
        .ok_or("无效的保存版本")?;
    let value: serde_json::Value = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
    if value["revision"].as_i64() != Some(next_revision)
        || value["version"].as_i64() != Some(1)
        || !value["projects"].is_array()
    {
        return Err("无效的保存版本或项目库结构".into());
    }
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    if current_revision(&transaction)? != expected_revision {
        return Err("项目已在另一窗口更新，请备份当前内容后重新打开".into());
    }
    // Ordinary saves omit the archive payload. Keep its bytes in SQLite rather
    // than reading/parsing/rewriting hundreds of MiB for each keystroke pause.
    let archive_value = if let Some(archives) = archive_payload.as_ref() {
        validate_sizes(payload.len(), archives.len())?;
        let value: serde_json::Value = serde_json::from_str(archives).map_err(|e| e.to_string())?;
        if !value.is_array() { return Err("归档库格式无效".into()); }
        value
    } else {
        let bytes: i64 = transaction.query_row(
            "SELECT COALESCE((SELECT length(CAST(payload AS BLOB)) FROM archive_snapshots WHERE id=1),2)",
            [], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        validate_sizes(payload.len(), usize::try_from(bytes).map_err(|_| "归档库大小无效")?)?;
        // The unchanged archive was validated by the transaction that saved it.
        serde_json::json!([])
    };
    if (deleted_project_id.is_some() || media_import_id.is_some()) && archive_payload.is_none() {
        return Err("项目导入或删除必须提供完整归档快照".into());
    }
    crate::project_deletion::validate_library(&transaction, &value, &archive_value)?;
    if let Some(id) = deleted_project_id {
        if media_import_id.is_some() {
            return Err("不能同时导入和删除项目".into());
        }
        let current: serde_json::Value =
            serde_json::from_str(&read_library(&transaction, false)?.ok_or("未找到项目库")?)
                .map_err(|e| e.to_string())?;
        let old_archives: serde_json::Value = serde_json::from_str(
            &read_archives(&transaction, false)?.unwrap_or_else(|| "[]".into()),
        )
        .map_err(|e| e.to_string())?;
        let contains = |v: &serde_json::Value| {
            v.as_array()
                .is_some_and(|items| items.iter().any(|p| p["id"] == id))
        };
        if !contains(&current["projects"]) && !contains(&old_archives) {
            return Err("未找到要删除的项目".into());
        }
        if contains(&value["projects"])
            || contains(&archive_value)
            || contains(&value["legacyTemplateBackups"])
        {
            return Err("删除后的项目库仍包含目标项目".into());
        }
        crate::project_deletion::prepare(&transaction, id)?;
    }
    if let Some(import_id) = media_import_id {
        crate::media_package::apply_import(
            &transaction,
            import_id,
            &value,
            media_root.ok_or("完整项目包缺少媒体根目录")?,
        )?;
    }
    // Both snapshots are captured in the same transaction, so recovery also restores archive moves.
    transaction
        .execute(
            "INSERT OR REPLACE INTO library SELECT 2, revision, payload FROM library WHERE id=1",
            [],
        )
        .map_err(|e| e.to_string())?;
    transaction.execute("INSERT INTO archive_snapshots(id,payload) VALUES (2,COALESCE((SELECT payload FROM archive_snapshots WHERE id=1),'[]')) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE archive_snapshots.payload != excluded.payload", []).map_err(|e| e.to_string())?;
    transaction
        .execute(
            "INSERT OR REPLACE INTO library(id,revision,payload) VALUES (1,?1,?2)",
            params![next_revision, payload],
        )
        .map_err(|e| e.to_string())?;
    if let Some(archives) = archive_payload {
        transaction
            .execute(
                "INSERT INTO archive_snapshots(id,payload) VALUES (1,?1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE archive_snapshots.payload != excluded.payload",
                [archives],
            )
            .map_err(|e| e.to_string())?;
    }
    if let Some(id) = deleted_project_id {
        for (table, previous) in [
            ("library", read_library(&transaction, true)?),
            ("archive_snapshots", read_archives(&transaction, true)?),
        ] {
            if let Some(previous) = previous {
                let mut snapshot: serde_json::Value =
                    serde_json::from_str(&previous).map_err(|e| e.to_string())?;
                crate::project_deletion::remove_from_snapshot(&mut snapshot, id);
                transaction
                    .execute(
                        &format!("UPDATE {table} SET payload=?1 WHERE id=2"),
                        [snapshot.to_string()],
                    )
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    transaction.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn library_write(
    app: tauri::AppHandle,
    payload: String,
    archive_payload: Option<String>,
    expected_revision: i64,
    media_import_id: Option<String>,
    deleted_project_id: Option<String>,
) -> Result<usize, String> {
    let media_root = if media_import_id.is_some() {
        Some(crate::media::media_root(&app)?)
    } else {
        None
    };
    let mut db = database(&app)?;
    // Hold the worker registry lock until the deletion commits. A terminal job may
    // still be unwinding; deleting its task directory while it runs is unsafe.
    let runtime = app.state::<crate::media_jobs::MediaRuntime>();
    let guard = if let Some(id) = deleted_project_id.as_deref() {
        Some(runtime.guard_project_deletion(&db, id)?)
    } else {
        None
    };
    write_library_with_media(
        &mut db,
        payload,
        archive_payload,
        expected_revision,
        media_import_id.as_deref(),
        media_root.as_deref(),
        deleted_project_id.as_deref(),
    )?;
    drop(guard);
    if deleted_project_id.is_some() {
        // A committed deletion must not be reported as rolled back if file cleanup fails.
        let pending = || {
            db.query_row("SELECT count(*) FROM media_deletion_queue", [], |row| {
                row.get::<_, usize>(0)
            })
            .unwrap_or(1)
        };
        Ok(crate::media::media_root(&app)
            .and_then(|root| crate::project_deletion::cleanup(&db, &root))
            .unwrap_or_else(|_| pending()))
    } else {
        Ok(0)
    }
}

#[tauri::command]
pub(crate) fn export_document(
    app: tauri::AppHandle,
    name: String,
    content: String,
) -> Result<String, String> {
    if content.len() > MAX_BACKUP_BYTES {
        return Err("导出文件超过 512 MiB".into());
    }
    let extension = if name.ends_with(".json") {
        "json"
    } else {
        "md"
    };
    let stem = crate::export_location::name(name.trim_end_matches(&format!(".{extension}")), "", if extension == "json" { "文字备份" } else { "Markdown" });
    let directory = crate::export_location::directory(&app)?;
    let mut file = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes())
        .and_then(|_| file.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    let path = crate::export_location::publish_file(file, &directory, &stem, extension)?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn memory_database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        connection
    }

    fn payload(revision: i64, projects: serde_json::Value) -> String {
        json!({"version":1,"revision":revision,"projects":projects}).to_string()
    }

    #[test]
    fn ordinary_writes_reuse_archives_and_keep_a_coherent_previous_snapshot() {
        let mut db = memory_database();
        let archived = json!([{"id":"archived","content":"unchanged archive"}]).to_string();
        write_library(&mut db, payload(1, json!([{"id":"a"}])), Some(archived.clone()), 0).unwrap();
        // The first later save advances previousArchives to the current archive.
        write_library(&mut db, payload(2, json!([{"id":"a","content":"one"}])), None, 1).unwrap();
        db.execute_batch("CREATE TRIGGER no_archive_insert BEFORE INSERT ON archive_snapshots WHEN NOT EXISTS(SELECT 1 FROM archive_snapshots WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'archive insertion forbidden'); END; CREATE TRIGGER no_archive_update BEFORE UPDATE ON archive_snapshots BEGIN SELECT RAISE(ABORT,'archive rewrite forbidden'); END;").unwrap();
        write_library(&mut db, payload(3, json!([{"id":"a","content":"two"}])), None, 2).unwrap();
        assert_eq!(read_archives(&db, false).unwrap(), Some(archived.clone()));
        assert_eq!(read_archives(&db, true).unwrap(), Some(archived));
        assert_eq!(serde_json::from_str::<serde_json::Value>(&read_library(&db, true).unwrap().unwrap()).unwrap()["projects"][0]["content"], "one");
    }

    #[test]
    fn archive_move_and_previous_snapshot_are_atomic() {
        let mut db = memory_database();
        let first = payload(1, json!([{"id":"a"}]));
        write_library(&mut db, first.clone(), Some("[]".into()), 0).unwrap();
        write_library(
            &mut db,
            payload(2, json!([])),
            Some("[{\"id\":\"a\"}]".into()),
            1,
        )
        .unwrap();
        assert_eq!(read_library(&db, true).unwrap(), Some(first));
        assert_eq!(read_archives(&db, true).unwrap().unwrap(), "[]");
        assert_eq!(
            read_archives(&db, false).unwrap().unwrap(),
            "[{\"id\":\"a\"}]"
        );
        assert_eq!(current_revision(&db).unwrap(), 2);
    }

    #[test]
    fn stale_save_changes_neither_current_nor_previous_archive() {
        let mut db = memory_database();
        let initial = payload(1, json!([]));
        write_library(&mut db, initial.clone(), Some("[]".into()), 0).unwrap();
        assert!(write_library(&mut db, payload(1, json!([])), Some("[123]".into()), 0).is_err());
        assert_eq!(read_library(&db, false).unwrap(), Some(initial));
        assert_eq!(read_library(&db, true).unwrap(), None);
        assert_eq!(read_archives(&db, false).unwrap().unwrap(), "[]");
    }

    #[test]
    fn invalid_archive_rolls_back_the_whole_transaction() {
        let mut db = memory_database();
        write_library(&mut db, payload(1, json!([])), Some("[]".into()), 0).unwrap();
        assert!(write_library(&mut db, payload(2, json!([])), Some("{}".into()), 1).is_err());
        assert_eq!(current_revision(&db).unwrap(), 1);
        assert_eq!(read_library(&db, true).unwrap(), None);
    }

    #[test]
    fn restore_can_itself_be_undone_and_keeps_monotonic_revisions() {
        let mut db = memory_database();
        write_library(
            &mut db,
            payload(1, json!([{"id":"a"}])),
            Some("[]".into()),
            0,
        )
        .unwrap();
        let archived = payload(2, json!([]));
        write_library(
            &mut db,
            archived.clone(),
            Some("[{\"id\":\"a\"}]".into()),
            1,
        )
        .unwrap();
        let mut restored: serde_json::Value =
            serde_json::from_str(&read_library(&db, true).unwrap().unwrap()).unwrap();
        restored["revision"] = json!(3);
        let previous_archives = read_archives(&db, true).unwrap();
        write_library(&mut db, restored.to_string(), previous_archives, 2).unwrap();
        assert_eq!(read_library(&db, true).unwrap(), Some(archived));
        assert_eq!(
            read_archives(&db, true).unwrap().unwrap(),
            "[{\"id\":\"a\"}]"
        );
        assert_eq!(read_archives(&db, false).unwrap().unwrap(), "[]");
        assert_eq!(current_revision(&db).unwrap(), 3);
    }

    #[test]
    fn project_deletion_scrubs_snapshots_and_is_atomic_on_stale_revision() {
        let mut db = memory_database();
        write_library(
            &mut db,
            payload(1, json!([{"id":"a"},{"id":"b"}])),
            Some("[]".into()),
            0,
        )
        .unwrap();
        assert!(write_library_with_media(
            &mut db,
            payload(1, json!([{"id":"b"}])),
            Some("[]".into()),
            0,
            None,
            None,
            Some("a")
        )
        .is_err());
        assert!(crate::project_deletion::ensure_live(&db, "a").is_ok());
        write_library_with_media(
            &mut db,
            payload(2, json!([{"id":"b"}])),
            Some("[]".into()),
            1,
            None,
            None,
            Some("a"),
        )
        .unwrap();
        let previous: serde_json::Value =
            serde_json::from_str(&read_library(&db, true).unwrap().unwrap()).unwrap();
        assert_eq!(previous["projects"], json!([{"id":"b"}]));
        assert!(write_library(
            &mut db,
            payload(3, json!([{"id":"a"}])),
            Some("[]".into()),
            2
        )
        .is_err());
        assert_eq!(current_revision(&db).unwrap(), 2);
        write_library_with_media(
            &mut db,
            payload(3, json!([])),
            Some("[]".into()),
            2,
            None,
            None,
            Some("b"),
        )
        .unwrap();
        assert_eq!(current_revision(&db).unwrap(), 3);
    }

    #[test]
    fn failed_library_write_rolls_back_the_deletion_tombstone_and_queue() {
        let mut db = memory_database();
        write_library(
            &mut db,
            payload(1, json!([{"id":"a"}])),
            Some("[]".into()),
            0,
        )
        .unwrap();
        db.execute_batch("CREATE TABLE media_files(id TEXT PRIMARY KEY,project_id TEXT,relative_path TEXT); INSERT INTO media_files VALUES('file','a','file.png'); CREATE TRIGGER fail_delete BEFORE INSERT ON library WHEN NEW.id=1 AND NEW.revision=2 BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;").unwrap();
        crate::project_deletion::initialize(&db).unwrap();
        assert!(write_library_with_media(
            &mut db,
            payload(2, json!([])),
            Some("[]".into()),
            1,
            None,
            None,
            Some("a")
        )
        .is_err());
        assert!(crate::project_deletion::ensure_live(&db, "a").is_ok());
        assert_eq!(current_revision(&db).unwrap(), 1);
        assert_eq!(
            db.query_row("SELECT count(*) FROM media_files", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM media_deletion_queue", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn deleting_an_archived_project_keeps_other_archives() {
        let mut db = memory_database();
        write_library(
            &mut db,
            payload(1, json!([])),
            Some(json!([{"id":"a"},{"id":"b"}]).to_string()),
            0,
        )
        .unwrap();
        write_library_with_media(
            &mut db,
            payload(2, json!([])),
            Some(json!([{"id":"b"}]).to_string()),
            1,
            None,
            None,
            Some("a"),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&read_archives(&db, true).unwrap().unwrap())
                .unwrap(),
            json!([{"id":"b"}])
        );
    }

    #[test]
    fn budgets_reserve_room_for_a_recoverable_backup() {
        assert!(validate_sizes(MAX_LIBRARY_BYTES, 2).is_ok());
        assert!(validate_sizes(2, MAX_ARCHIVE_BYTES).is_ok());
        assert!(validate_sizes(MAX_LIBRARY_BYTES + 1, 2).is_err());
        assert!(validate_sizes(2, MAX_ARCHIVE_BYTES + 1).is_err());
        assert!(validate_sizes(MAX_LIBRARY_BYTES, MAX_ARCHIVE_BYTES).is_err());
        assert!(validate_sizes(
            MAX_LIBRARY_BYTES - BACKUP_ENVELOPE_RESERVE,
            MAX_ARCHIVE_BYTES
        )
        .is_ok());
    }

    #[test]
    fn unsupported_or_overflowing_revisions_are_rejected() {
        let mut db = memory_database();
        assert!(write_library(&mut db, payload(3, json!([])), None, 0).is_err());
        assert!(write_library(&mut db, payload(1, json!([])), None, i64::MAX).is_err());
        assert!(write_library(&mut db, payload(0, json!([])), None, -1).is_err());
        assert_eq!(current_revision(&db).unwrap(), 0);
    }
}
