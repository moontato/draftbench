use crate::storage;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path},
};
use tauri::Manager;

pub const MAX_DOCUMENTS: usize = 20;
pub const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;
pub const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
const VERSION: u32 = 1;

/// One unsaved-draft snapshot. Recovery lives in application storage, never inside the
/// author's Markdown project.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryRecord {
    pub key: String,
    pub project_root: String,
    pub document_path: String,
    pub document_id: String,
    pub text: String,
    pub text_hash: String,
    /// Hash of the file on disk when this snapshot was captured. Restoring keeps it so a
    /// later Save conflicts instead of overwriting a file that changed somewhere else.
    pub disk_hash: String,
    pub captured_at: i64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryFile {
    pub version: u32,
    pub records: Vec<RecoveryRecord>,
}

fn empty() -> RecoveryFile {
    RecoveryFile {
        version: VERSION,
        records: Vec::new(),
    }
}

pub fn recovery_key(project_root: &str, document_path: &str) -> String {
    storage::hash(&format!("{project_root}\u{0}{document_path}"))
}

fn is_hash(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
}

fn valid(record: &RecoveryRecord) -> bool {
    is_hash(&record.key)
        && is_hash(&record.text_hash)
        && is_hash(&record.disk_hash)
        && record.captured_at > 0
        && record.text.len() <= MAX_DOCUMENT_BYTES
        && storage::hash(&record.text) == record.text_hash
        && !record.document_path.is_empty()
        && !record.project_root.is_empty()
        // The key must come from the record's own location, never be invented separately.
        && record.key == recovery_key(&record.project_root, &record.document_path)
        && Path::new(&record.document_path)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

/// Newest-first, capped by document count and by total bytes.
pub fn prune(mut records: Vec<RecoveryRecord>) -> Vec<RecoveryRecord> {
    records.sort_by_key(|record| std::cmp::Reverse(record.captured_at));
    records.truncate(MAX_DOCUMENTS);
    loop {
        let bytes = serde_json::to_string(&records).unwrap_or_default().len();
        if bytes <= MAX_FILE_BYTES || records.len() <= 1 {
            break;
        }
        records.pop();
    }
    records
}

pub fn read(dir: &Path) -> Result<RecoveryFile, String> {
    let path = dir.join("recovery.json");
    if !path.exists() {
        return Ok(empty());
    }
    let raw =
        fs::read_to_string(&path).map_err(|e| format!("Could not read recovery data: {e}"))?;
    if raw.len() > MAX_FILE_BYTES * 2 {
        return Err("Recovery data is unexpectedly large and was ignored.".into());
    }
    let parsed: RecoveryFile = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => return Ok(empty()),
    };
    if parsed.version != VERSION {
        return Ok(empty());
    }
    Ok(RecoveryFile {
        version: VERSION,
        records: prune(parsed.records.into_iter().filter(valid).collect()),
    })
}

fn write_file(dir: &Path, file: &RecoveryFile) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Could not prepare recovery storage: {e}"))?;
    // Recovery text is unsaved writing: storage::atomic_write_private creates the temporary
    // file at 0600 before any content is written and verifies the final file stays 0600.
    storage::atomic_write_private(
        &dir.join("recovery.json"),
        &serde_json::to_string_pretty(file).map_err(|e| e.to_string())?,
    )
}

pub fn write(dir: &Path, record: RecoveryRecord) -> Result<(), String> {
    if !valid(&record) {
        return Err("Recovery snapshot is too large or malformed to store.".into());
    }
    let mut records = read(dir)?.records;
    records.retain(|stored| stored.key != record.key);
    records.push(record);
    write_file(
        dir,
        &RecoveryFile {
            version: VERSION,
            records: prune(records),
        },
    )
}

pub fn clear(dir: &Path, key: Option<&str>) -> Result<(), String> {
    let mut records = read(dir)?.records;
    let before = records.len();
    match key {
        Some(key) => records.retain(|stored| stored.key != key),
        None => records.clear(),
    }
    if records.len() == before {
        return Ok(());
    }
    if records.is_empty() {
        let _ = fs::remove_file(dir.join("recovery.json"));
        return Ok(());
    }
    write_file(
        dir,
        &RecoveryFile {
            version: VERSION,
            records,
        },
    )
}

#[tauri::command]
pub fn load_recovery(app: tauri::AppHandle) -> Result<RecoveryFile, String> {
    read(&app.path().app_config_dir().map_err(|e| e.to_string())?)
}

#[tauri::command]
pub fn write_recovery(app: tauri::AppHandle, record: RecoveryRecord) -> Result<(), String> {
    write(
        &app.path().app_config_dir().map_err(|e| e.to_string())?,
        record,
    )
}

#[tauri::command]
pub fn clear_recovery(app: tauri::AppHandle, key: Option<String>) -> Result<(), String> {
    clear(
        &app.path().app_config_dir().map_err(|e| e.to_string())?,
        key.as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn record(path: &str, text: &str, at: i64) -> RecoveryRecord {
        RecoveryRecord {
            key: recovery_key("/writing", path),
            project_root: "/writing".into(),
            document_path: path.into(),
            document_id: "doc".into(),
            text: text.into(),
            text_hash: storage::hash(text),
            disk_hash: storage::hash("disk"),
            captured_at: at,
        }
    }

    #[test]
    fn keys_are_stable_and_path_specific() {
        assert_eq!(recovery_key("/a", "b.md"), recovery_key("/a", "b.md"));
        assert_ne!(recovery_key("/a", "b.md"), recovery_key("/a", "c.md"));
        assert_ne!(recovery_key("/a", "b.md"), recovery_key("/c", "b.md"));
    }

    #[test]
    fn validation_rejects_forged_or_oversized_records() {
        let mut forged = record("a.md", "text", 1);
        forged.text_hash = storage::hash("different");
        assert!(!valid(&forged));
        let huge = record("a.md", &"x".repeat(MAX_DOCUMENT_BYTES + 1), 1);
        assert!(!valid(&huge));
        assert!(!valid(&record("../escape.md", "text", 1)));
        assert!(valid(&record("a.md", "text", 1)));
    }

    #[test]
    fn pruning_caps_documents_and_total_bytes() {
        let many: Vec<RecoveryRecord> = (0..MAX_DOCUMENTS + 8)
            .map(|i| record(&format!("{i}.md"), &format!("text {i}"), 1_000 + i as i64))
            .collect();
        let kept = prune(many);
        assert_eq!(kept.len(), MAX_DOCUMENTS);
        assert_eq!(kept[0].document_path, format!("{}.md", MAX_DOCUMENTS + 7));
        let big: Vec<RecoveryRecord> = (0..MAX_DOCUMENTS)
            .map(|i| record(&format!("{i}.md"), &"x".repeat(180_000), 1_000 + i as i64))
            .collect();
        let capped = prune(big);
        assert!(capped.len() < MAX_DOCUMENTS);
        assert!(serde_json::to_string(&capped).unwrap().len() <= MAX_FILE_BYTES);
    }

    #[test]
    fn storage_round_trips_privately_and_clears_one_document() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), record("a.md", "first draft", 10)).unwrap();
        write(dir.path(), record("b.md", "second draft", 20)).unwrap();
        write(dir.path(), record("a.md", "first draft updated", 30)).unwrap();
        let file = read(dir.path()).unwrap();
        assert_eq!(file.records.len(), 2);
        assert_eq!(
            file.records
                .iter()
                .find(|r| r.document_path == "a.md")
                .unwrap()
                .text,
            "first draft updated"
        );
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(dir.path().join("recovery.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        clear(dir.path(), Some(&recovery_key("/writing", "a.md"))).unwrap();
        assert_eq!(read(dir.path()).unwrap().records.len(), 1);
        clear(dir.path(), None).unwrap();
        assert!(read(dir.path()).unwrap().records.is_empty());
    }

    #[test]
    fn corrupt_or_unknown_version_data_is_ignored_not_applied() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("recovery.json"), "{ not json").unwrap();
        assert!(read(dir.path()).unwrap().records.is_empty());
        fs::write(
            dir.path().join("recovery.json"),
            r#"{"version":99,"records":[{"key":"x","projectRoot":"/w","documentPath":"a.md","documentId":"d","text":"secret","textHash":"y","diskHash":"z","capturedAt":1}]}"#,
        )
        .unwrap();
        assert!(read(dir.path()).unwrap().records.is_empty());
    }
}
