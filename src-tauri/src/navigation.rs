use tauri::{
    Manager, Runtime, Url, Webview,
    plugin::{Builder, TauriPlugin},
    webview::PageLoadEvent,
};
use tauri_plugin_opener::OpenerExt;

use crate::connection::{self, parse_external_url};

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("client-navigation")
        .js_init_script(include_str!("../../scripts/link-bridge.js"))
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
                let _ = webview
                    .app_handle()
                    .opener()
                    .open_url(external.as_str(), None::<&str>);
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
