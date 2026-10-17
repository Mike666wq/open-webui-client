use tauri::{
    Manager, Runtime, Url, Webview,
    plugin::{Builder, TauriPlugin},
    webview::PageLoadEvent,
};
use tauri_plugin_opener::OpenerExt;

use crate::connection::{self, parse_external_url};

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    #[cfg(target_os = "android")]
    let download_bridge = include_str!("../android-scripts/download-bridge.js");
    #[cfg(not(target_os = "android"))]
    let download_bridge = include_str!("../../scripts/download-bridge.js");
    #[cfg(target_os = "android")]
    let link_bridge = include_str!("../android-scripts/link-bridge.js");
    #[cfg(not(target_os = "android"))]
    let link_bridge = include_str!("../../scripts/link-bridge.js");
    let init_script =
        format!("if (window.top === window.self) {{\n{download_bridge}\n{link_bridge}\n}}");
    Builder::new("client-navigation")
        .js_init_script(init_script)
        .on_navigation(move |webview: &Webview<R>, url: &Url| {
            if connection::is_local_entry(url) || connection::is_dev_entry(url) {
                connection::on_local_navigation(webview, url);
                return true;
            }

            if connection::is_current_service_origin(webview, url) {
                return true;
            }

            if connection::has_active_service_session(webview)
                && let Ok(external) = parse_external_url(url.as_str())
            {
                #[cfg(any(target_os = "android", target_os = "ios"))]
                {
                    let app = webview.app_handle().clone();
                    let url = external.to_string();
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        let _ = app.opener().open_url(url, None::<&str>);
                    });
                }
                #[cfg(not(any(target_os = "android", target_os = "ios")))]
                {
                    let _ = webview
                        .app_handle()
                        .opener()
                        .open_url(external.as_str(), None::<&str>);
                }
            }
            false
        })
        .on_page_load(|webview: &Webview<R>, payload| {
            if payload.event() == PageLoadEvent::Finished {
                connection::on_page_load(webview, payload.url());
            }
        })
        .build()
}
