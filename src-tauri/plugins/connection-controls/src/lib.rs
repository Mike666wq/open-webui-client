#[cfg(target_os = "android")]
use serde::Serialize;
use tauri::{
    Runtime,
    plugin::{Builder, TauriPlugin},
};

#[cfg(target_os = "android")]
const ANDROID_PLUGIN_IDENTIFIER: &str = "local.openwebui.connectioncontrols";

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigureArgs {
    settings_url: String,
}

/// Installs Android's native system-back behavior for the local connection screen.
///
/// The settings URL is supplied by the app's Rust layer so the Kotlin plugin can
/// return to the actual bundled entry point without relying on remote-page JS.
pub fn init<R: Runtime>(settings_url: impl Into<String>) -> TauriPlugin<R> {
    #[cfg(target_os = "android")]
    let settings_url = settings_url.into();
    #[cfg(not(target_os = "android"))]
    let _ = settings_url;

    Builder::new("connection-controls")
        .setup(move |_app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(
                    ANDROID_PLUGIN_IDENTIFIER,
                    "ConnectionControlsPlugin",
                )?;
                handle
                    .run_mobile_plugin::<()>("configure", ConfigureArgs { settings_url })
                    .map_err(Into::into)?;
            }
            #[cfg(not(target_os = "android"))]
            let _ = api;

            Ok(())
        })
        .build()
}
