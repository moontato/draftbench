mod grammar;
mod network;
mod recent_projects;
mod storage;

use serde::Serialize;
use serde_json::Value;
use std::{collections::HashMap, fs, path::PathBuf, sync::Mutex};
use tauri::{Manager, State};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct DesktopState {
    root: Mutex<Option<PathBuf>>,
    session_keys: Mutex<HashMap<String, String>>,
    requests: Mutex<HashMap<String, CancellationToken>>,
    recent_projects: Mutex<()>,
}
fn root(state: &DesktopState) -> Result<PathBuf, String> {
    state
        .root
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("Open a project folder first.".into())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    root: String,
    name: String,
    entries: Vec<storage::FileEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    recent_projects: Option<Vec<recent_projects::RecentProject>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    recent_warning: Option<String>,
}
#[tauri::command]
fn open_project(
    path: String,
    state: State<DesktopState>,
    app: tauri::AppHandle,
) -> Result<Project, String> {
    let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !path.is_dir() {
        return Err("Choose a directory.".into());
    }
    let entries = storage::tree(&path, &path, 0)?;
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    *state.root.lock().map_err(|e| e.to_string())? = Some(path.clone());
    let recent = (|| {
        let _lock = state.recent_projects.lock().map_err(|e| e.to_string())?;
        let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
        recent_projects::remember(&config, &path, &name)
    })();
    let (recent_projects, recent_warning) = match recent {
        Ok(projects) => (Some(projects), None),
        Err(_) => (
            None,
            Some("Folder opened, but the recent project list could not be saved.".into()),
        ),
    };
    Ok(Project {
        root: path.to_string_lossy().into_owned(),
        name,
        entries,
        recent_projects,
        recent_warning,
    })
}
#[tauri::command]
fn load_recent_projects(
    app: tauri::AppHandle,
    state: State<DesktopState>,
) -> Result<Vec<recent_projects::RecentProject>, String> {
    let _lock = state.recent_projects.lock().map_err(|e| e.to_string())?;
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    recent_projects::load(&config)
}
#[tauri::command]
fn remove_recent_project(
    path: String,
    app: tauri::AppHandle,
    state: State<DesktopState>,
) -> Result<Vec<recent_projects::RecentProject>, String> {
    let _lock = state.recent_projects.lock().map_err(|e| e.to_string())?;
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    recent_projects::remove(&config, &path)
}
#[tauri::command]
fn list_files(state: State<DesktopState>) -> Result<Vec<storage::FileEntry>, String> {
    let root = root(&state)?;
    storage::tree(&root, &root, 0)
}
#[derive(Serialize)]
struct LoadedFile {
    content: String,
    hash: String,
}
#[tauri::command]
fn read_document(path: String, state: State<DesktopState>) -> Result<LoadedFile, String> {
    if !path.to_lowercase().ends_with(".md") {
        return Err("Only Markdown documents can be opened.".into());
    }
    let p = storage::scoped(&root(&state)?, &path)?;
    if fs::metadata(&p).map_err(|e| e.to_string())?.len() > 5_000_000 {
        return Err("Document exceeds the 5 MB editing limit.".into());
    }
    let content = fs::read_to_string(p).map_err(|e| e.to_string())?;
    Ok(LoadedFile {
        hash: storage::hash(&content),
        content,
    })
}
#[tauri::command]
fn save_document(
    path: String,
    content: String,
    expected_hash: Option<String>,
    state: State<DesktopState>,
) -> Result<String, String> {
    storage::save_document(&root(&state)?, &path, &content, expected_hash.as_deref())
}
#[tauri::command]
fn create_folder(path: String, state: State<DesktopState>) -> Result<(), String> {
    fs::create_dir(storage::scoped(&root(&state)?, &path)?).map_err(|e| e.to_string())
}
#[tauri::command]
fn rename_entry(
    path: String,
    destination: String,
    state: State<DesktopState>,
) -> Result<(), String> {
    let root = root(&state)?;
    let src = storage::scoped(&root, &path)?;
    let dst = storage::scoped(&root, &destination)?;
    if dst.exists() {
        return Err("A file or folder with that name already exists.".into());
    }
    if src.is_file() && !destination.to_lowercase().ends_with(".md") {
        return Err("Keep the .md extension.".into());
    }
    fs::rename(src, dst).map_err(|e| e.to_string())
}
#[tauri::command]
fn delete_entry(path: String, state: State<DesktopState>) -> Result<(), String> {
    let path = storage::scoped(&root(&state)?, &path)?;
    // Only empty folders: never recursively erase a user's project.
    if path.is_dir() {
        fs::remove_dir(path)
    } else {
        fs::remove_file(path)
    }
    .map_err(|e| e.to_string())
}
#[tauri::command]
fn read_metadata(
    name: String,
    project_root: Option<String>,
    state: State<DesktopState>,
) -> Result<Option<Value>, String> {
    if !matches!(name.as_str(), "project" | "analysis") {
        return Err("Invalid metadata name".into());
    }
    let root = root(&state)?;
    storage::check_project_root(&root, project_root.as_deref())?;
    let path = storage::scoped(&root, &format!(".draftbench/{name}.json"))?;
    if !path.exists() {
        return Ok(None);
    }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 5_000_000 {
        return Err("Metadata exceeds the size limit; clear it to recover.".into());
    }
    serde_json::from_str(&fs::read_to_string(path).map_err(|e| e.to_string())?)
        .map(Some)
        .map_err(|_| "Project metadata is corrupt; a fresh analysis can safely replace it.".into())
}
#[tauri::command]
fn write_metadata(
    name: String,
    value: Value,
    project_root: Option<String>,
    state: State<DesktopState>,
) -> Result<(), String> {
    if !matches!(name.as_str(), "project" | "analysis") {
        return Err("Invalid metadata name".into());
    }
    let root = root(&state)?;
    storage::check_project_root(&root, project_root.as_deref())?;
    let dir = storage::scoped(&root, ".draftbench")?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = storage::scoped(&root, &format!(".draftbench/{name}.json"))?;
    storage::atomic_write(
        &path,
        &serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?,
    )
}
#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("settings.json");
    if !path.exists() {
        return Ok(None);
    }
    serde_json::from_str(&fs::read_to_string(path).map_err(|e| e.to_string())?)
        .map(Some)
        .map_err(|_| "Settings are corrupt; defaults were loaded.".into())
}
#[tauri::command]
fn save_settings(value: Value, app: tauri::AppHandle) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    storage::atomic_write(
        &dir.join("settings.json"),
        &serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?,
    )
}
fn credential(reference: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("org.draftbench.desktop", reference)
        .map_err(|_| "OS credential store unavailable; key is session-only.".into())
}
#[tauri::command]
fn set_api_key(
    key: String,
    credential_ref: Option<String>,
    state: State<DesktopState>,
) -> Result<(), String> {
    let reference =
        network::credential_reference(credential_ref.as_deref()).map_err(|e| e.message)?;
    if reference.is_empty() {
        return Err("Choose a backend credential slot.".into());
    }
    state
        .session_keys
        .lock()
        .map_err(|e| e.to_string())?
        .insert(reference.clone(), key.clone());
    let entry = credential(&reference)?;
    if key.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Could not remove key from OS storage. Session key was cleared.".into()),
        }
    } else {
        entry
            .set_password(&key)
            .map_err(|_| "OS credential store unavailable; key is session-only.".into())
    }
}
// Explicit ephemeral override, including an empty key for unauthenticated sessions.
// This does not read or modify any OS credential.
#[tauri::command]
fn use_session_key(
    key: String,
    credential_ref: Option<String>,
    state: State<DesktopState>,
) -> Result<(), String> {
    let reference =
        network::credential_reference(credential_ref.as_deref()).map_err(|e| e.message)?;
    state
        .session_keys
        .lock()
        .map_err(|e| e.to_string())?
        .insert(reference, key);
    Ok(())
}
#[tauri::command]
fn has_api_key(credential_ref: Option<String>, state: State<DesktopState>) -> bool {
    let Ok(reference) = network::credential_reference(credential_ref.as_deref()) else {
        return false;
    };
    if reference.is_empty() {
        return false;
    }
    if let Ok(keys) = state.session_keys.lock() {
        if let Some(key) = keys.get(&reference) {
            return !key.is_empty();
        }
    }
    credential(&reference)
        .and_then(|entry| entry.get_password().map_err(|e| e.to_string()))
        .is_ok()
}
#[tauri::command]
async fn harper_review(text: String) -> Result<Vec<grammar::Finding>, String> {
    tauri::async_runtime::spawn_blocking(move || grammar::review(&text))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn ai_http(
    request: network::HttpRequest,
    state: State<'_, DesktopState>,
) -> Result<Value, network::NetworkError> {
    let reference = network::credential_reference(request.credential_ref.as_deref())?;
    let cancel = {
        let mut requests = state.requests.lock().unwrap();
        requests.entry(request.id.clone()).or_default().clone()
    };
    // An explicit backend slot never falls back to another backend's key.
    let key = if reference.is_empty() {
        None
    } else {
        state
            .session_keys
            .lock()
            .unwrap()
            .get(&reference)
            .cloned()
            .or_else(|| credential(&reference).ok()?.get_password().ok())
    };
    let result = network::execute(&request, key, cancel).await;
    state.requests.lock().unwrap().remove(&request.id);
    result
}
#[tauri::command]
fn cancel_request(id: String, state: State<DesktopState>) {
    let mut requests = state.requests.lock().unwrap();
    if requests.len() < 128 || requests.contains_key(&id) {
        requests.entry(id).or_default().cancel();
    }
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopState::default())
        .invoke_handler(tauri::generate_handler![
            open_project,
            load_recent_projects,
            remove_recent_project,
            list_files,
            read_document,
            save_document,
            create_folder,
            rename_entry,
            delete_entry,
            read_metadata,
            write_metadata,
            load_settings,
            save_settings,
            set_api_key,
            use_session_key,
            has_api_key,
            ai_http,
            harper_review,
            cancel_request
        ])
        .run(tauri::generate_context!())
        .expect("Could not launch Draftbench");
}
