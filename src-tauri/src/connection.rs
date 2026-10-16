use std::{
    fs::{self, File},
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, Url, Webview, ipc::CapabilityBuilder};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

const CONNECTION_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECTION_FILE: &str = "connection.json";

#[derive(Clone)]
pub struct ConnectionManager(Arc<Mutex<ConnectionRuntime>>);

#[derive(Debug)]
struct ConnectionRuntime {
    candidate: Option<Url>,
    last_success: Option<Url>,
    generation: u64,
    ready_nonce: Option<String>,
    session_token: Option<String>,
    ready: bool,
    error: Option<String>,
    startup_pending: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Attempt {
    generation: u64,
    nonce: String,
    session_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    candidate_url: Option<String>,
    last_success_url: Option<String>,
    startup_url: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct PersistedConnection {
    last_success_url: String,
}

impl ConnectionManager {
    pub fn load(app: &AppHandle) -> Self {
        let last_success = load_last_success(app);
        Self(Arc::new(Mutex::new(ConnectionRuntime::new(last_success))))
    }

    fn begin(&self, url: Url) -> Attempt {
        self.0.lock().expect("connection state poisoned").begin(url)
    }

    fn complete_ready<F>(
        &self,
        generation: u64,
        nonce: &str,
        current_origin: &str,
        persist: F,
    ) -> Result<String, String>
    where
        F: FnOnce(&Url) -> Result<(), String>,
    {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Connection state is unavailable.")?;
        let candidate = state.validate_ready(generation, nonce, current_origin)?;
        if let Err(error) = persist(&candidate) {
            state.error = Some(error.clone());
            state.ready_nonce = None;
            state.session_token = None;
            return Err(error);
        }
        state.last_success = Some(candidate);
        state.ready_nonce = None;
        state.ready = true;
        state.error = None;
        state
            .session_token
            .clone()
            .ok_or_else(|| "The connection session has expired.".to_string())
    }

    fn is_current_session(&self, generation: u64, origin: &str, token: &str) -> bool {
        self.0
            .lock()
            .map(|state| state.authorizes(generation, origin, token))
            .unwrap_or(false)
    }

    fn invalidate_for_settings(&self, manual: bool) {
        if let Ok(mut state) = self.0.lock() {
            state.observe_settings_page(manual);
        }
    }

    fn timeout(&self, generation: u64) -> bool {
        self.0
            .lock()
            .map(|mut state| state.timeout(generation))
            .unwrap_or(false)
    }

    fn should_return_after_ready_error(&self, generation: u64, origin: &str) -> bool {
        self.0
            .lock()
            .map(|state| {
                state.generation == generation
                    && !state.ready
                    && state.error.is_some()
                    && state
                        .candidate
                        .as_ref()
                        .is_some_and(|candidate| candidate.origin().ascii_serialization() == origin)
            })
            .unwrap_or(false)
    }

    fn status(&self) -> ConnectionStatus {
        let mut state = self.0.lock().expect("connection state poisoned");
        let startup_url = state.consume_startup_url();
        ConnectionStatus {
            candidate_url: state.candidate.as_ref().map(origin_string),
            last_success_url: state.last_success.as_ref().map(origin_string),
            startup_url: startup_url.as_ref().map(origin_string),
            error: state.error.clone(),
        }
    }
}

pub fn return_to_settings(app: &AppHandle, manager: &ConnectionManager) {
    manager.invalidate_for_settings(true);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.navigate(settings_url());
    }
}

impl ConnectionRuntime {
    fn new(last_success: Option<Url>) -> Self {
        Self {
            candidate: None,
            last_success,
            generation: 0,
            ready_nonce: None,
            session_token: None,
            ready: false,
            error: None,
            startup_pending: true,
        }
    }

    fn begin(&mut self, url: Url) -> Attempt {
        self.generation = self.generation.wrapping_add(1);
        let attempt = Attempt {
            generation: self.generation,
            nonce: Uuid::new_v4().to_string(),
            session_token: Uuid::new_v4().to_string(),
        };
        self.candidate = Some(url);
        self.ready_nonce = Some(attempt.nonce.clone());
        self.session_token = Some(attempt.session_token.clone());
        self.ready = false;
        self.error = None;
        self.startup_pending = false;
        attempt
    }

    fn consume_startup_url(&mut self) -> Option<Url> {
        if !self.startup_pending {
            return None;
        }
        self.startup_pending = false;
        self.last_success.clone()
    }

    fn validate_ready(
        &self,
        generation: u64,
        nonce: &str,
        current_origin: &str,
    ) -> Result<Url, String> {
        if self.ready || generation != self.generation || self.ready_nonce.as_deref() != Some(nonce)
        {
            return Err("This connection attempt is no longer active.".into());
        }
        let candidate = self
            .candidate
            .as_ref()
            .ok_or_else(|| "There is no active connection attempt.".to_string())?;
        if candidate.origin().ascii_serialization() != current_origin {
            return Err("The readiness response came from an unexpected server.".into());
        }
        Ok(candidate.clone())
    }

    fn authorizes(&self, generation: u64, origin: &str, token: &str) -> bool {
        self.ready
            && generation == self.generation
            && self.session_token.as_deref() == Some(token)
            && self
                .candidate
                .as_ref()
                .is_some_and(|candidate| candidate.origin().ascii_serialization() == origin)
    }

    fn return_to_settings(&mut self, manual: bool) {
        if manual || self.candidate.is_some() || self.session_token.is_some() {
            self.startup_pending = false;
        }
        self.generation = self.generation.wrapping_add(1);
        self.ready_nonce = None;
        self.session_token = None;
        self.ready = false;
        if self.candidate.is_none() {
            self.candidate = self.last_success.clone();
        }
    }

    fn observe_settings_page(&mut self, manual: bool) {
        if manual || self.ready || self.ready_nonce.is_some() || self.session_token.is_some() {
            self.return_to_settings(manual);
        }
    }

    fn timeout(&mut self, generation: u64) -> bool {
        if self.generation != generation || self.ready || self.candidate.is_none() {
            return false;
        }
        self.error
            .get_or_insert_with(|| "The server did not finish loading within 30 seconds.".into());
        self.ready_nonce = None;
        self.session_token = None;
        true
    }
}

pub fn validate_service_url(value: &str) -> Result<Url, String> {
    let url =
        Url::parse(value.trim()).map_err(|_| "Enter a valid HTTP or HTTPS address.".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none_or(str::is_empty)
        || url.host_str() == Some("tauri.localhost")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Use an HTTP or HTTPS address without a path, query, credentials, or fragment.".into(),
        );
    }
    Ok(url)
}

fn origin_string(url: &Url) -> String {
    url.origin().ascii_serialization()
}

fn connection_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(CONNECTION_FILE))
        .map_err(|error| format!("Could not locate app settings: {error}"))
}

fn load_last_success(app: &AppHandle) -> Option<Url> {
    let file = connection_path(app).ok()?;
    let saved: PersistedConnection = serde_json::from_slice(&fs::read(file).ok()?).ok()?;
    validate_service_url(&saved.last_success_url).ok()
}

fn persist_last_success(app: &AppHandle, url: &Url) -> Result<(), String> {
    let file = connection_path(app)?;
    let parent = file
        .parent()
        .ok_or_else(|| "Could not locate app settings folder.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("Could not save connection: {error}"))?;
    let temp = parent.join(format!(".connection-{}.tmp", Uuid::new_v4()));
    let contents = serde_json::to_vec(&PersistedConnection {
        last_success_url: origin_string(url),
    })
    .map_err(|error| format!("Could not save connection: {error}"))?;
    let write_result = (|| {
        let mut output = File::create(&temp).map_err(|error| error.to_string())?;
        output
            .write_all(&contents)
            .map_err(|error| error.to_string())?;
        output.sync_all().map_err(|error| error.to_string())?;
        replace_file(&temp, &file).map_err(|error| error.to_string())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_result.map_err(|error| format!("Could not save connection: {error}"))
}

#[cfg(windows)]
fn replace_file(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    let success = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if success == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    fs::rename(from, to)
}

#[tauri::command(rename = "get-connection-state")]
pub fn get_connection_state(
    webview: Webview,
    manager: State<'_, ConnectionManager>,
) -> Result<ConnectionStatus, String> {
    ensure_local_webview(&webview)?;
    let local_origin = is_local_entry(&webview.url().map_err(|error| error.to_string())?);
    if local_origin {
        manager.invalidate_for_settings(false);
    }
    Ok(manager.status())
}

#[tauri::command(rename = "connect-service", rename_all = "camelCase")]
pub fn connect_service(
    app: AppHandle,
    webview: Webview,
    manager: State<'_, ConnectionManager>,
    address: String,
) -> Result<(), String> {
    ensure_local_webview(&webview)?;
    let url = validate_service_url(&address)?;
    let attempt = manager.begin(url.clone());
    let origin_pattern = format!("{}/*", origin_string(&url));
    let capability = CapabilityBuilder::new(format!("remote-session-{}", attempt.generation))
        .window("main")
        .local(false)
        .remote(origin_pattern)
        .permission("allow-connection-ready")
        .permission("allow-open-external");
    app.add_capability(capability)
        .map_err(|error| format!("Could not authorize this server session: {error}"))?;
    webview
        .navigate(url)
        .map_err(|error| format!("Could not open the server: {error}"))?;

    let app_for_timeout = app.clone();
    let manager_for_timeout = manager.inner().clone();
    let generation = attempt.generation;
    thread::spawn(move || {
        thread::sleep(CONNECTION_TIMEOUT);
        if manager_for_timeout.timeout(generation) {
            if let Some(window) = app_for_timeout.get_webview_window("main") {
                let _ = window.navigate(settings_url());
            }
        }
    });
    Ok(())
}

#[tauri::command(rename = "connection-ready", rename_all = "camelCase")]
pub fn connection_ready(
    app: AppHandle,
    webview: Webview,
    manager: State<'_, ConnectionManager>,
    generation: u64,
    nonce: String,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("This connection is not available in this webview.".into());
    }
    let current = webview.url().map_err(|error| error.to_string())?;
    let current_origin = current.origin().ascii_serialization();
    let token = match manager.complete_ready(generation, &nonce, &current_origin, |url| {
        persist_last_success(&app, url)
    }) {
        Ok(token) => token,
        Err(error) => {
            if manager.should_return_after_ready_error(generation, &current_origin) {
                let _ = webview.navigate(settings_url());
            }
            return Err(error);
        }
    };
    let injection = format!(
        "window.__OWC_SESSION__={{generation:{generation},token:{}}};",
        serde_json::to_string(&token).map_err(|error| error.to_string())?
    );
    webview.eval(&injection).map_err(|error| error.to_string())
}

#[tauri::command(rename = "open-external", rename_all = "camelCase")]
pub fn open_external(
    app: AppHandle,
    webview: Webview,
    manager: State<'_, ConnectionManager>,
    url: String,
    generation: u64,
    session_token: String,
) -> Result<(), String> {
    require_current_session(&webview, &manager, generation, &session_token)?;
    let parsed = parse_external_url(&url)?;
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| format!("Could not open link: {error}"))
}

/// Reusable guard for any remote-only native bridge, including future download commands.
/// Call it again after every asynchronous user interaction before committing side effects.
pub(crate) fn require_current_session(
    webview: &Webview,
    manager: &ConnectionManager,
    generation: u64,
    session_token: &str,
) -> Result<Url, String> {
    if webview.label() != "main" {
        return Err("This connection is not available in this webview.".into());
    }
    let current = webview.url().map_err(|error| error.to_string())?;
    let current_origin = current.origin().ascii_serialization();
    if !manager.is_current_session(generation, &current_origin, session_token) {
        return Err("This server session is no longer active.".into());
    }
    Ok(current)
}

pub fn on_page_load(webview: &Webview, url: &Url) {
    let Ok(current) = webview.url() else { return };
    let Some(manager) = webview.try_state::<ConnectionManager>() else {
        return;
    };
    enum LoadAction {
        Handshake(u64, String, String),
        RestoreSession(u64, String, String),
    }
    let action = {
        let state = manager.0.lock().expect("connection state poisoned");
        let Some(candidate) = state.candidate.as_ref() else {
            return;
        };
        if candidate.origin() != current.origin() || url.origin() != current.origin() {
            return;
        }
        if state.ready {
            let Some(token) = state.session_token.clone() else {
                return;
            };
            LoadAction::RestoreSession(state.generation, token, origin_string(candidate))
        } else {
            let Some(nonce) = state.ready_nonce.clone() else {
                return;
            };
            LoadAction::Handshake(state.generation, nonce, origin_string(candidate))
        }
    };
    let script = match action {
        LoadAction::Handshake(generation, nonce, expected_origin) => {
            let origin = serde_json::to_string(&expected_origin).expect("origin string serializes");
            let nonce = serde_json::to_string(&nonce).expect("nonce serializes");
            format!(
                "(async()=>{{try{{if(location.origin!=={origin})return;const r=await fetch('/api/config',{{credentials:'omit',cache:'no-store',redirect:'error'}});if(!r.ok)return;const d=await r.json();if(!d||d.status!==true)return;await window.__TAURI__.core.invoke('connection-ready',{{generation:{generation},nonce:{nonce}}});}}catch{{}}}})();"
            )
        }
        LoadAction::RestoreSession(generation, token, expected_origin) => {
            let origin = serde_json::to_string(&expected_origin).expect("origin string serializes");
            let token = serde_json::to_string(&token).expect("session token serializes");
            format!(
                "if(location.origin==={origin})window.__OWC_SESSION__={{generation:{generation},token:{token}}};"
            )
        }
    };
    let _ = webview.eval(&script);
}

pub fn on_local_navigation(webview: &Webview, url: &Url) {
    if is_local_entry(url) {
        if let Some(manager) = webview.try_state::<ConnectionManager>() {
            manager.invalidate_for_settings(false);
        }
    }
}

pub fn settings_url() -> Url {
    Url::parse(LOCAL_ENTRY_URL).expect("local settings URL is valid")
}

#[cfg(any(target_os = "windows", target_os = "android"))]
const LOCAL_ENTRY_URL: &str = "http://tauri.localhost/";
#[cfg(any(target_os = "macos", target_os = "linux"))]
const LOCAL_ENTRY_URL: &str = "tauri://localhost/";

pub fn is_local_entry(url: &Url) -> bool {
    let entry = settings_url();
    url.origin() == entry.origin() && url.username().is_empty() && url.password().is_none()
}

fn ensure_local_webview(webview: &Webview) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("This command is not available in this webview.".into());
    }
    let url = webview.url().map_err(|error| error.to_string())?;
    if is_local_entry(&url) || is_dev_entry(&url) {
        Ok(())
    } else {
        Err("This command is available only from connection settings.".into())
    }
}

pub fn is_dev_entry(url: &Url) -> bool {
    cfg!(dev)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1420)
        && url.username().is_empty()
        && url.password().is_none()
}

pub fn is_current_service_origin(webview: &Webview, target: &Url) -> bool {
    let Ok(current) = webview.url() else {
        return false;
    };
    let Some(manager) = webview.try_state::<ConnectionManager>() else {
        return false;
    };
    let state = manager.0.lock().expect("connection state poisoned");
    state.candidate.as_ref().is_some_and(|candidate| {
        (state.ready || state.ready_nonce.is_some())
            && candidate.origin() == target.origin()
            && (is_local_entry(&current) || current.origin() == candidate.origin())
    })
}

pub fn has_active_service_session(webview: &Webview) -> bool {
    let Ok(current) = webview.url() else {
        return false;
    };
    let Some(manager) = webview.try_state::<ConnectionManager>() else {
        return false;
    };
    let state = manager.0.lock().expect("connection state poisoned");
    state.ready
        && state
            .candidate
            .as_ref()
            .is_some_and(|candidate| candidate.origin() == current.origin())
}

pub fn parse_external_url(value: &str) -> Result<Url, String> {
    if value.len() > 4096 {
        return Err("The link is too long.".into());
    }
    let url = Url::parse(value).map_err(|_| "The link is not a valid URL.".to_string())?;
    match url.scheme() {
        "http" | "https" if !url.host_str().unwrap_or_default().is_empty() => {
            if !url.username().is_empty() || url.password().is_some() {
                return Err("Links containing credentials cannot be opened.".into());
            }
        }
        "mailto" | "tel" => {}
        _ => return Err("Only web, email, and telephone links can be opened.".into()),
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        validate_service_url(value).unwrap()
    }

    #[test]
    fn accepts_http_https_hosts_and_ports_but_only_root_origins() {
        assert_eq!(
            origin_string(&url("http://192.168.31.60:3000")),
            "http://192.168.31.60:3000"
        );
        assert_eq!(
            origin_string(&url("https://chat.example.org:8443/")),
            "https://chat.example.org:8443"
        );
        for invalid in [
            "file:///tmp",
            "javascript:alert(1)",
            "ftp://example.org",
            "http:///path",
            "http://user:pass@example.org",
            "http://tauri.localhost",
            "http://example.org/path",
            "http://example.org/?q=1",
            "http://example.org/#fragment",
        ] {
            assert!(validate_service_url(invalid).is_err(), "accepted {invalid}");
        }
        assert_eq!(
            origin_string(&url("http://localhost:3000")),
            "http://localhost:3000"
        );
    }

    #[test]
    fn only_current_generation_and_one_time_nonce_can_become_ready_and_persist() {
        let manager = ConnectionManager(Arc::new(Mutex::new(ConnectionRuntime::new(None))));
        let first = manager.begin(url("http://example.org:3000"));
        let second = manager.begin(url("https://chat.example.org"));
        let mut writes = 0;
        assert!(
            manager
                .complete_ready(
                    first.generation,
                    &first.nonce,
                    "http://example.org:3000",
                    |_| {
                        writes += 1;
                        Ok(())
                    }
                )
                .is_err()
        );
        assert!(
            !manager.should_return_after_ready_error(first.generation, "http://example.org:3000")
        );
        assert!(
            manager
                .complete_ready(
                    second.generation,
                    &first.nonce,
                    "https://chat.example.org",
                    |_| {
                        writes += 1;
                        Ok(())
                    }
                )
                .is_err()
        );
        assert_eq!(writes, 0);
        assert!(
            manager
                .complete_ready(
                    second.generation,
                    &second.nonce,
                    "https://chat.example.org",
                    |saved| {
                        assert_eq!(origin_string(saved), "https://chat.example.org");
                        writes += 1;
                        Ok(())
                    }
                )
                .is_ok()
        );
        assert_eq!(writes, 1);
        assert!(
            manager
                .complete_ready(
                    second.generation,
                    &second.nonce,
                    "https://chat.example.org",
                    |_| Ok(())
                )
                .is_err()
        );
        assert!(!manager.is_current_session(
            second.generation,
            "https://chat.example.org",
            &first.session_token
        ));
        assert!(manager.is_current_session(
            second.generation,
            "https://chat.example.org",
            &second.session_token
        ));
    }

    #[test]
    fn failed_persistence_does_not_replace_last_success_or_mark_ready() {
        let original = url("https://saved.example.org");
        let manager = ConnectionManager(Arc::new(Mutex::new(ConnectionRuntime::new(Some(
            original.clone(),
        )))));
        let attempt = manager.begin(url("http://new.example.org:8080"));
        let persistence = manager.complete_ready(
            attempt.generation,
            &attempt.nonce,
            "http://new.example.org:8080",
            |_| Err("disk full".into()),
        );
        assert!(persistence.is_err());
        assert!(
            manager
                .should_return_after_ready_error(attempt.generation, "http://new.example.org:8080")
        );
        let state = manager.0.lock().unwrap();
        assert_eq!(state.last_success, Some(original));
        assert!(!state.ready);
        assert!(state.ready_nonce.is_none());
        assert!(state.session_token.is_none());
        assert!(
            state
                .validate_ready(
                    attempt.generation,
                    &attempt.nonce,
                    "http://new.example.org:8080"
                )
                .is_err()
        );
    }

    #[test]
    fn return_to_settings_and_timeout_invalidate_old_handshakes_and_startup_autoconnect() {
        let saved = url("https://saved.example.org");
        let mut state = ConnectionRuntime::new(Some(saved));
        let attempt = state.begin(url("http://192.168.31.60:3000"));
        state.return_to_settings(true);
        assert!(!state.startup_pending);
        assert!(state.ready_nonce.is_none());
        assert!(
            state
                .validate_ready(
                    attempt.generation,
                    &attempt.nonce,
                    "http://192.168.31.60:3000"
                )
                .is_err()
        );
        assert!(!state.authorizes(
            attempt.generation,
            "http://192.168.31.60:3000",
            &attempt.session_token
        ));
        assert!(!state.timeout(attempt.generation));

        let next = state.begin(url("https://next.example.org"));
        assert!(state.timeout(next.generation));
        assert!(state.error.is_some());
        assert!(state.ready_nonce.is_none());
        assert!(!state.authorizes(
            next.generation,
            "https://next.example.org",
            &next.session_token
        ));
    }

    #[test]
    fn initial_local_navigation_preserves_one_time_startup_autoconnect() {
        let saved = url("https://saved.example.org");
        let mut state = ConnectionRuntime::new(Some(saved.clone()));
        state.observe_settings_page(false); // First local page navigation / settings query.
        assert!(state.startup_pending);
        assert_eq!(state.last_success, Some(saved));
        assert_eq!(state.consume_startup_url(), Some(saved));
        state.observe_settings_page(false); // A later local query cannot re-arm it.
        assert!(!state.startup_pending);
        assert_eq!(state.consume_startup_url(), None);
    }
}

