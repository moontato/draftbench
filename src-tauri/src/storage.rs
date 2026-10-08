use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
};

pub fn check_project_root(active: &Path, expected: Option<&str>) -> Result<(), String> {
    if expected.is_some_and(|expected| Path::new(expected) != active) {
        return Err("Project changed; metadata was not read or written.".into());
    }
    Ok(())
}

pub fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

// Reject symlinks rather than following paths outside the open project.
pub fn scoped(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if rel.as_os_str().is_empty() || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("Use a relative path inside the project.".into());
    }
    let mut path = root.to_path_buf();
    for part in rel.components() {
        path.push(part);
        if let Ok(meta) = fs::symlink_metadata(&path) {
            if meta.file_type().is_symlink() {
                return Err("Symlinks are not editable in v0.1.".into());
            }
        }
    }
    Ok(path)
}

pub fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    if fs::metadata(path).is_ok_and(|meta| meta.permissions().readonly()) {
        return Err("This file is read-only. Save a copy instead.".into());
    }
    let parent = path.parent().ok_or("Missing parent directory")?;
    let tmp = parent.join(format!(".draftbench-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        // Preserve existing permissions (especially files containing sensitive writing).
        if let Ok(meta) = fs::metadata(path) {
            fs::set_permissions(&tmp, meta.permissions())?;
        }
        fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result.map_err(|e| format!("Could not safely save file: {e}"))
}

pub fn save_document(
    root: &Path,
    relative: &str,
    contents: &str,
    expected_hash: Option<&str>,
) -> Result<String, String> {
    if !relative.to_lowercase().ends_with(".md") {
        return Err("Documents must use the .md extension.".into());
    }
    let path = scoped(root, relative)?;
    if path.exists() {
        let current = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if expected_hash != Some(hash(&current).as_str()) {
            return Err("CONFLICT: File changed on disk. Reload it or save a copy.".into());
        }
    } else if expected_hash.is_some() {
        return Err("CONFLICT: File was removed on disk. Save a copy.".into());
    }
    atomic_write(&path, contents)?;
    Ok(hash(contents))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub folder: bool,
    pub children: Vec<FileEntry>,
}

pub fn tree(root: &Path, dir: &Path, depth: usize) -> Result<Vec<FileEntry>, String> {
    if depth > 20 {
        return Ok(vec![]);
    }
    let mut entries = vec![];
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || matches!(name.as_str(), "node_modules" | "target") {
            continue;
        }
        let meta = entry.file_type().map_err(|e| e.to_string())?;
        if meta.is_symlink() {
            continue;
        }
        let folder = meta.is_dir();
        if !folder && !name.to_lowercase().ends_with(".md") {
            continue;
        }
        let path = entry.path();
        entries.push(FileEntry {
            path: path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/"),
            name,
            folder,
            children: if folder {
                tree(root, &path, depth + 1)?
            } else {
                vec![]
            },
        });
    }
    entries.sort_by(|a, b| {
        b.folder
            .cmp(&a.folder)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_requires_the_expected_project_root() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        assert!(check_project_root(first.path(), Some(first.path().to_str().unwrap())).is_ok());
        assert!(check_project_root(second.path(), Some(first.path().to_str().unwrap())).is_err());
        assert!(check_project_root(first.path(), None).is_ok());
    }
    #[test]
    fn markdown_round_trip_and_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let md = "# Essay\n\nAn **important** point.\n";
        let h = save_document(dir.path(), "essay.md", md, None).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("essay.md")).unwrap(), md);
        assert!(save_document(dir.path(), "essay.md", "changed", None).is_err());
        save_document(dir.path(), "essay.md", "changed", Some(&h)).unwrap();
        assert!(save_document(dir.path(), "essay.md", "stale", Some(&h)).is_err());
        assert_eq!(
            fs::read_to_string(dir.path().join("essay.md")).unwrap(),
            "changed"
        );
    }
    #[cfg(unix)]
    #[test]
    fn refuses_read_only_files_and_preserves_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("essay.md");
        let h = save_document(dir.path(), "essay.md", "original", None).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let next = save_document(dir.path(), "essay.md", "revision", Some(&h)).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
        assert!(
            save_document(dir.path(), "essay.md", "unexpected", Some(&next))
                .unwrap_err()
                .contains("read-only")
        );
        assert_eq!(fs::read_to_string(path).unwrap(), "revision");
    }
    #[test]
    fn paths_and_failed_writes() {
        let dir = tempfile::tempdir().unwrap();
        assert!(scoped(dir.path(), "../secret").is_err());
        assert!(scoped(dir.path(), "/etc/passwd").is_err());
        assert!(atomic_write(&dir.path().join("missing/essay.md"), "text").is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlink() {
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/etc", dir.path().join("link")).unwrap();
        assert!(scoped(dir.path(), "link/passwd").is_err());
    }
}
