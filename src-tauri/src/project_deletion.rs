//! Project deletion is committed with the library. Files are removed only afterwards,
//! using a durable retry queue so a crash can neither lose live files nor resurrect a project.
use rusqlite::{params, Connection};
use serde_json::Value;
use std::{fs, path::Path};

const MEDIA_TABLES: [&str; 5] = [
    "media_assets",
    "media_files",
    "media_jobs",
    "media_registrations",
    "media_imports",
];

fn table_exists(db: &Connection, table: &str) -> Result<bool, String> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

pub(crate) fn initialize(db: &Connection) -> Result<(), String> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS deleted_projects(id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS media_deletion_queue(path TEXT PRIMARY KEY, project_id TEXT NOT NULL);").map_err(|e| e.to_string())?;
    for table in MEDIA_TABLES {
        if table_exists(db, table)? {
            // Late async imports/workers must not recreate data after deletion commits.
            db.execute_batch(&format!(
                "CREATE TRIGGER IF NOT EXISTS prevent_deleted_{table} BEFORE INSERT ON {table}
                WHEN EXISTS(SELECT 1 FROM deleted_projects WHERE id=NEW.project_id)
                BEGIN SELECT RAISE(ABORT, '项目已删除，拒绝写入'); END;"
            ))
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub(crate) fn ensure_live(db: &Connection, id: &str) -> Result<(), String> {
    let deleted: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM deleted_projects WHERE id=?1)",
            [id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if deleted {
        Err("项目已删除，请重新打开项目库".into())
    } else {
        Ok(())
    }
}

pub(crate) fn validate_library(
    db: &Connection,
    library: &Value,
    archives: &Value,
) -> Result<(), String> {
    for projects in [
        library.get("projects"),
        library.get("legacyTemplateBackups"),
        Some(archives),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(projects) = projects.as_array() {
            for project in projects {
                if let Some(id) = project["id"].as_str() {
                    ensure_live(db, id)?;
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn remove_from_snapshot(value: &mut Value, id: &str) {
    if let Some(projects) = value.as_array_mut() {
        projects.retain(|project| project["id"] != id);
        return;
    }
    for key in ["projects", "legacyTemplateBackups"] {
        if let Some(projects) = value.get_mut(key).and_then(Value::as_array_mut) {
            projects.retain(|project| project["id"] != id);
        }
    }
    if value["activeId"] == id {
        value["activeId"] = value["projects"][0]["id"].clone();
    }
}

fn safe_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0'])
}

fn enqueue(db: &Connection, project: &str, folder: &str, name: &str) -> Result<(), String> {
    if !safe_name(name) {
        return Err("项目媒体路径异常，未删除项目".into());
    }
    db.execute(
        "INSERT OR IGNORE INTO media_deletion_queue(path,project_id) VALUES(?1,?2)",
        params![format!("{folder}/{name}"), project],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn strings(db: &Connection, sql: &str, id: &str) -> Result<Vec<String>, String> {
    let mut statement = db.prepare(sql).map_err(|e| e.to_string())?;
    let values = statement
        .query_map([id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(values)
}

pub(crate) fn prepare(db: &Connection, id: &str) -> Result<(), String> {
    crate::media::valid_id(id)?;
    if table_exists(db, "media_jobs")? {
        let active: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM media_jobs WHERE project_id=?1 AND status IN ('queued','submitting','running','downloading'))", [id], |row| row.get(0)).map_err(|e| e.to_string())?;
        if active {
            return Err(
                "项目仍有媒体任务，请先在任务中心停止或恢复核对，待任务结束后再删除".into(),
            );
        }
        for job in strings(db, "SELECT id FROM media_jobs WHERE project_id=?1", id)? {
            enqueue(db, id, "tasks", &job)?;
        }
    }
    if table_exists(db, "media_imports")? {
        let pending: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM media_imports WHERE project_id=?1)",
                [id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if pending {
            return Err("项目仍有待完成的媒体导入，请先恢复导入再删除".into());
        }
    }
    if table_exists(db, "media_files")? {
        for path in strings(db, "SELECT relative_path FROM media_files WHERE project_id=?1 AND relative_path NOT IN (SELECT relative_path FROM media_files WHERE project_id<>?1)", id)? { enqueue(db, id, "files", &path)?; }
    }
    if table_exists(db, "media_registrations")? {
        for payload in strings(
            db,
            "SELECT payload FROM media_registrations WHERE project_id=?1",
            id,
        )? {
            let registration: Value =
                serde_json::from_str(&payload).map_err(|_| "媒体登记损坏，未删除项目")?;
            enqueue(
                db,
                id,
                "files",
                registration["relativePath"]
                    .as_str()
                    .ok_or("媒体登记缺少路径")?,
            )?;
            if let Some(path) = registration["stagingFile"].as_str() {
                enqueue(db, id, "incoming", path)?;
            }
        }
    }
    db.execute("INSERT INTO deleted_projects(id) VALUES(?1)", [id])
        .map_err(|e| e.to_string())?;
    for table in MEDIA_TABLES {
        if table_exists(db, table)? {
            db.execute(&format!("DELETE FROM {table} WHERE project_id=?1"), [id])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub(crate) fn cleanup(db: &Connection, root: &Path) -> Result<usize, String> {
    let paths = strings(
        db,
        "SELECT path FROM media_deletion_queue WHERE project_id<>?1",
        "",
    )?;
    for relative in paths {
        let Some((folder, name)) = relative.split_once('/') else {
            continue;
        };
        if !["files", "incoming", "tasks"].contains(&folder) || !safe_name(name) {
            continue;
        }
        // A surviving owner wins over cleanup, including a recovered registration.
        let mut referenced = false;
        for (table, field) in match folder {
            "files" => vec![
                ("media_files", "relative_path"),
                (
                    "media_registrations",
                    "json_extract(payload,'$.relativePath')",
                ),
            ],
            "incoming" => vec![(
                "media_registrations",
                "json_extract(payload,'$.stagingFile')",
            )],
            _ => vec![("media_jobs", "id")],
        } {
            if table_exists(db, table)? {
                referenced |= db
                    .query_row(
                        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {field}=?1)"),
                        [name],
                        |row| row.get::<_, bool>(0),
                    )
                    .map_err(|e| e.to_string())?;
            }
        }
        if referenced {
            db.execute(
                "DELETE FROM media_deletion_queue WHERE path=?1",
                [&relative],
            )
            .map_err(|e| e.to_string())?;
            continue;
        }
        let parent = root.join(folder);
        // Never traverse a substituted directory, including after an interrupted cleanup.
        if parent.canonicalize().ok().as_ref() != Some(&parent) {
            continue;
        }
        let path = parent.join(name);
        let removed = match fs::symlink_metadata(&path) {
            Ok(info) if info.is_dir() && !info.file_type().is_symlink() && folder == "tasks" => {
                fs::remove_dir_all(&path)
            }
            Ok(_) => fs::remove_file(&path),
            Err(error) => Err(error),
        };
        if removed.is_ok()
            || removed
                .as_ref()
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            // Sync the directory before forgetting the cleanup work.
            if crate::media_integrity::sync_directory(&parent).is_ok() {
                db.execute(
                    "DELETE FROM media_deletion_queue WHERE path=?1",
                    [&relative],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    db.query_row("SELECT count(*) FROM media_deletion_queue", [], |row| {
        row.get(0)
    })
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE media_files(id TEXT PRIMARY KEY,project_id TEXT,relative_path TEXT);
            CREATE TABLE media_assets(id TEXT PRIMARY KEY,project_id TEXT);
            CREATE TABLE media_jobs(id TEXT PRIMARY KEY,project_id TEXT,status TEXT);
            CREATE TABLE media_registrations(id TEXT PRIMARY KEY,project_id TEXT,payload TEXT);",
        )
        .unwrap();
        initialize(&db).unwrap();
        db
    }

    #[test]
    fn deletion_removes_only_owned_records_and_retries_files_after_commit() {
        let mut db = database();
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        for folder in ["files", "incoming", "tasks"] {
            fs::create_dir(root.join(folder)).unwrap();
        }
        fs::write(root.join("files/a.png"), b"target").unwrap();
        fs::write(root.join("files/b.png"), b"survivor").unwrap();
        fs::write(root.join("incoming/pending"), b"pending").unwrap();
        fs::create_dir(root.join("tasks/job-a")).unwrap();
        fs::write(root.join("tasks/job-a/log"), b"log").unwrap();
        db.execute_batch(
            "INSERT INTO media_files VALUES('f-a','a','a.png'),('f-b','b','b.png');
            INSERT INTO media_assets VALUES('a-a','a'),('a-b','b');
            INSERT INTO media_jobs VALUES('job-a','a','completed');",
        )
        .unwrap();
        db.execute(
            "INSERT INTO media_registrations VALUES('reg','a',?1)",
            [json!({"relativePath":"c.png","stagingFile":"pending"}).to_string()],
        )
        .unwrap();
        {
            let tx = db.transaction().unwrap();
            prepare(&tx, "a").unwrap();
            // No file is touched before the library transaction has committed.
            assert!(root.join("files/a.png").exists());
            tx.commit().unwrap();
        }
        assert_eq!(cleanup(&db, &root).unwrap(), 0);
        assert!(!root.join("files/a.png").exists());
        assert!(!root.join("incoming/pending").exists());
        assert!(!root.join("tasks/job-a").exists());
        assert_eq!(fs::read(root.join("files/b.png")).unwrap(), b"survivor");
        assert_eq!(
            db.query_row("SELECT count(*) FROM media_assets", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(db
            .execute("INSERT INTO media_jobs VALUES('late','a','running')", [])
            .is_err());
        assert!(db
            .execute(
                "INSERT INTO media_registrations VALUES('late','a','{}')",
                []
            )
            .is_err());
        assert_eq!(cleanup(&db, &root).unwrap(), 0);
    }

    #[test]
    fn running_jobs_and_corrupt_paths_abort_without_deleting_anything() {
        let mut db = database();
        db.execute_batch("INSERT INTO media_jobs VALUES('job','a','running'); INSERT INTO media_files VALUES('file','a','../other');").unwrap();
        {
            let tx = db.transaction().unwrap();
            assert!(prepare(&tx, "a").unwrap_err().contains("媒体任务"));
        }
        db.execute("UPDATE media_jobs SET status='completed'", [])
            .unwrap();
        {
            let tx = db.transaction().unwrap();
            assert!(prepare(&tx, "a").unwrap_err().contains("路径"));
        }
        assert!(ensure_live(&db, "a").is_ok());
        assert_eq!(
            db.query_row("SELECT count(*) FROM media_deletion_queue", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM media_jobs", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn interrupted_cleanup_is_retryable_and_does_not_follow_symlink_directories() {
        let db = database();
        let base = tempfile::tempdir().unwrap();
        let root = base.path().canonicalize().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("a.png"), b"protected").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), root.join("files")).unwrap();
        enqueue(&db, "a", "files", "a.png").unwrap();
        assert_eq!(cleanup(&db, &root).unwrap(), 1);
        assert_eq!(
            fs::read(outside.path().join("a.png")).unwrap(),
            b"protected"
        );
        #[cfg(unix)]
        fs::remove_file(root.join("files")).unwrap();
        fs::create_dir(root.join("files")).unwrap();
        assert_eq!(cleanup(&db, &root).unwrap(), 0);
    }

    #[test]
    fn cleanup_preserves_files_referenced_by_a_surviving_project() {
        let db = database();
        let base = tempfile::tempdir().unwrap();
        let root = base.path().canonicalize().unwrap();
        fs::create_dir(root.join("files")).unwrap();
        fs::write(root.join("files/shared.png"), b"keep").unwrap();
        db.execute(
            "INSERT INTO media_files VALUES('other-file','other','shared.png')",
            [],
        )
        .unwrap();
        enqueue(&db, "deleted", "files", "shared.png").unwrap();
        assert_eq!(cleanup(&db, &root).unwrap(), 0);
        assert_eq!(fs::read(root.join("files/shared.png")).unwrap(), b"keep");
    }

    #[test]
    fn snapshots_and_deleted_identity_cannot_resurrect_target() {
        let db = database();
        db.execute("INSERT INTO deleted_projects VALUES('a')", [])
            .unwrap();
        let mut library = json!({"projects":[{"id":"a"},{"id":"b"}],"activeId":"a","legacyTemplateBackups":[{"id":"a"}],"inspirations":[{"id":"idea"}]});
        assert!(validate_library(&db, &library, &json!([])).is_err());
        remove_from_snapshot(&mut library, "a");
        assert_eq!(library["activeId"], "b");
        assert_eq!(library["projects"], json!([{"id":"b"}]));
        assert_eq!(library["legacyTemplateBackups"], json!([]));
        assert_eq!(library["inspirations"], json!([{"id":"idea"}]));
        assert!(validate_library(&db, &library, &json!([])).is_ok());
    }
}
