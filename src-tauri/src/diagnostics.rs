use tauri::{State, Webview};
use tauri_plugin_connection_controls::{ConnectionControlsBridge, DiagnosticsExportReply};

use crate::connection::is_local_entry;

/// Opens Android's system document picker from the bundled local settings page.
/// The selected URI stays inside the native plugin and is never returned to JavaScript.
#[tauri::command(rename = "export-android-diagnostics")]
pub async fn export_android_diagnostics(
    webview: Webview,
    bridge: State<'_, ConnectionControlsBridge<tauri::Wry>>,
) -> Result<DiagnosticsExportReply, String> {
    if webview.label() != "main" {
        return Err("Diagnostics export is available only from local settings.".into());
    }
    let url = webview
        .url()
        .map_err(|_| "Could not verify the local settings page.")?;
    if !is_local_entry(&url) {
        return Err("Diagnostics export is available only from local settings.".into());
    }
    bridge.export_diagnostics().await
}
