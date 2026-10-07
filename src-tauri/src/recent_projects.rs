use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub const LIMIT: usize = 5;
const MAX_BYTES: u64 = 128_000;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub last_opened: u64,
}
#[derive(Deserialize, Serialize)]
struct RecentFile {
    version: u8,
    projects: Vec<RecentProject>,
}
fn normalize(projects: Vec<RecentProject>) -> Vec<RecentProject> {
    let mut result = Vec::<RecentProject>::new();
    for project in projects {
        if !Path::new(&project.path).is_absolute()
            || project.path.len() > 8192
            || project.path.contains('\0')
            || project.name.trim().is_empty()
            || project.name.len() > 512
            || project.last_opened > 8_640_000_000_000_000
            || result.iter().any(|p| p.path == project.path)
        {
            continue;
        }
        result.push(project);
        if result.len() == LIMIT {
            break;
        }
    }
    result
}
pub fn load(config: &Path) -> Result<Vec<RecentProject>, String> {
    let path = config.join("recent-projects.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("Recent project list exceeds the size limit.".into());
    }
    let file: RecentFile =
        serde_json::from_str(&fs::read_to_string(path).map_err(|e| e.to_string())?)
            .map_err(|_| "Recent project list is corrupt; folders and documents are unaffected.")?;
    if file.version != 1 {
        return Err("Recent project list has an unsupported version.".into());
    }
    // No filesystem probes here: missing folders and offline drives must not block startup.
    Ok(normalize(file.projects))
}
fn save(config: &Path, projects: &[RecentProject]) -> Result<(), String> {
    let value = serde_json::to_string_pretty(&RecentFile {
        version: 1,
        projects: projects.to_vec(),
    })
    .map_err(|e| e.to_string())?;
    if value.len() as u64 > MAX_BYTES {
        return Err("Recent project list exceeds the size limit.".into());
    }
    fs::create_dir_all(config).map_err(|e| e.to_string())?;
    crate::storage::atomic_write(&config.join("recent-projects.json"), &value)
}
pub fn remember(config: &Path, root: &Path, name: &str) -> Result<Vec<RecentProject>, String> {
    // The caller has already canonicalized and successfully listed this folder.
    let path = root.to_string_lossy().into_owned();
    let mut projects = load(config)?;
    projects.retain(|p| p.path != path);
    projects.insert(
        0,
        RecentProject {
            path,
            name: name.to_owned(),
            last_opened: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        },
    );
    let projects = normalize(projects);
    save(config, &projects)?;
    Ok(projects)
}
pub fn remove(config: &Path, path: &str) -> Result<Vec<RecentProject>, String> {
    let mut projects = load(config)?;
    projects.retain(|p| p.path != path);
    save(config, &projects)?;
    Ok(projects)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip_mru_deduplication_and_limit() {
        let config = tempfile::tempdir().unwrap();
        let folders = tempfile::tempdir().unwrap();
        assert!(load(config.path()).unwrap().is_empty());
        for i in 0..7 {
            let root = folders.path().join(format!("project-{i}"));
            fs::create_dir(&root).unwrap();
            remember(config.path(), &root, &format!("Project {i}")).unwrap();
        }
        let list = load(config.path()).unwrap();
        assert_eq!(list.len(), LIMIT);
        assert_eq!(list[0].name, "Project 6");
        let root = folders.path().join("project-3");
        remember(config.path(), &root, "Renamed display label").unwrap();
        let list = load(config.path()).unwrap();
        assert_eq!(list.len(), LIMIT);
        assert_eq!(list[0].name, "Renamed display label");
        assert_eq!(
            list.iter()
                .filter(|p| p.path == root.to_string_lossy())
                .count(),
            1
        );
    }
    #[test]
    fn missing_paths_load_and_removal_never_deletes_the_folder() {
        let config = tempfile::tempdir().unwrap();
        let folders = tempfile::tempdir().unwrap();
        let root = folders.path().join("notes");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("essay.md"), "Author's writing").unwrap();
        remember(config.path(), &root, "notes").unwrap();
        assert!(remove(config.path(), &root.to_string_lossy())
            .unwrap()
            .is_empty());
        assert_eq!(
            fs::read_to_string(root.join("essay.md")).unwrap(),
            "Author's writing"
        );
        remember(config.path(), &root, "notes").unwrap();
        fs::remove_file(root.join("essay.md")).unwrap();
        fs::remove_dir(&root).unwrap();
        assert_eq!(load(config.path()).unwrap().len(), 1);
    }
    #[test]
    fn corrupt_oversized_and_incompatible_files_fail_without_overwriting() {
        let config = tempfile::tempdir().unwrap();
        let file = config.path().join("recent-projects.json");
        for contents in [
            "not JSON".to_owned(),
            "{\"version\":2,\"projects\":[]}".to_owned(),
            " ".repeat(MAX_BYTES as usize + 1),
        ] {
            fs::write(&file, &contents).unwrap();
            assert!(load(config.path()).is_err());
            assert!(remember(config.path(), config.path(), "Project").is_err());
            assert_eq!(fs::read_to_string(&file).unwrap(), contents);
        }
    }
    #[test]
    fn invalid_entries_are_discarded_and_list_stays_in_app_config() {
        let config = tempfile::tempdir().unwrap();
        let folders = tempfile::tempdir().unwrap();
        let root = folders.path().join("writing");
        fs::create_dir(&root).unwrap();
        remember(config.path(), &root, "writing").unwrap();
        assert!(config.path().join("recent-projects.json").exists());
        assert!(!root.join("recent-projects.json").exists());
        assert!(!root.join(".draftbench").exists());
        let invalid = RecentProject {
            path: "relative".into(),
            name: "invalid".into(),
            last_opened: 0,
        };
        assert!(normalize(vec![invalid]).is_empty());
    }
}
