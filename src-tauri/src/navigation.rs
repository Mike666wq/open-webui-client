use tauri::{
    Manager, Runtime, Url, Webview,
    plugin::{Builder, TauriPlugin},
};
use tauri_plugin_opener::OpenerExt;

use crate::{service::parse_external_url, service_url::SERVICE_URL};

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    let service_origin = Url::parse(SERVICE_URL)
        .expect("generated service URL must be valid")
        .origin();

    Builder::new("client-navigation")
        .js_init_script(include_str!("../../scripts/link-bridge.js"))
        .on_navigation(move |webview: &Webview<R>, url: &Url| {
            if url.origin() == service_origin || is_local_entry(url) || is_dev_entry(url) {
                return true;
            }

            if matches!(url.scheme(), "http" | "https" | "mailto" | "tel") {
                if let Ok(external) = parse_external_url(url.as_str()) {
                    let _ = webview
                        .app_handle()
                        .opener()
                        .open_url(external.as_str(), None::<&str>);
                }
            }
            false
        })
        .build()
}

fn is_local_entry(url: &Url) -> bool {
    let no_credentials = url.username().is_empty() && url.password().is_none();
    #[cfg(any(target_os = "windows", target_os = "android"))]
    let matches_entry =
        url.scheme() == "http" && url.host_str() == Some("tauri.localhost") && url.port().is_none();
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let matches_entry =
        url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none();

    no_credentials && matches_entry
}

fn is_dev_entry(url: &Url) -> bool {
    cfg!(dev)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1420)
        && url.username().is_empty()
        && url.password().is_none()
}