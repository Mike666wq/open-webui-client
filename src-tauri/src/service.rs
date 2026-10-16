use std::time::Duration;

use tauri::{AppHandle, Manager, State, Url};
use tauri_plugin_opener::OpenerExt;

pub struct ServiceConfig {
    pub url: Url,
    pub timeout_ms: u64,
}

#[tauri::command]
pub async fn check_service(app: AppHandle, service: State<'_, ServiceConfig>) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(service.timeout_ms))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;

    // This preflight sends no Open WebUI credentials or stored WebView cookies.
    let response = client
        .get(service.url.as_str())
        .send()
        .await
        .map_err(|error| format!("Could not reach {}: {error}", service.url))?;

    if response.status().is_redirection() {
        if let Some(location) = response.headers().get(reqwest::header::LOCATION) {
            let location = location
                .to_str()
                .map_err(|_| "The service returned an invalid redirect.".to_string())?;
            let target = service
                .url
                .join(location)
                .map_err(|_| "The service returned an invalid redirect.".to_string())?;
            if target.origin() != service.url.origin() {
                return Err("The service redirected to a different origin.".into());
            }
        }
    }

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The main window is not available.".to_string())?;
    window
        .navigate(service.url.clone())
        .map_err(|error| format!("Could not open the service: {error}"))
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = parse_external_url(&url)?;
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| format!("Could not open link: {error}"))
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
