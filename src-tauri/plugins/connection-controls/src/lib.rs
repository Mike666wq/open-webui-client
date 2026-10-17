use serde::{Deserialize, Serialize};
use tauri::{
    Runtime,
    plugin::{Builder, TauriPlugin},
};
#[cfg(target_os = "android")]
use tauri::plugin::PluginHandle;
#[cfg(not(target_os = "android"))]
use std::marker::PhantomData;

#[cfg(target_os = "android")]
const ANDROID_PLUGIN_IDENTIFIER: &str = "local.openwebui.connectioncontrols";

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigureArgs {
    settings_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginSaveArgs {
    pub transfer_id: String,
    pub filename: String,
    pub mime_type: String,
    pub expected_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteChunkArgs {
    pub transfer_id: String,
    pub sequence: u64,
    pub chunk_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferArgs {
    pub transfer_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginSaveReply {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer_id: Option<String>,
}

/// Android SAF bridge retained by the plugin and consumed by app-owned Rust commands.
///
/// The native picker and document URI are never exposed to frontend JavaScript. On
/// non-Android targets the methods return an explicit unsupported error so shared app
/// commands can still compile on desktop.
pub struct ConnectionControlsBridge<R: Runtime> {
    #[cfg(target_os = "android")]
    handle: PluginHandle<R>,
    #[cfg(not(target_os = "android"))]
    _runtime: PhantomData<fn() -> R>,
}

impl<R: Runtime> Clone for ConnectionControlsBridge<R> {
    fn clone(&self) -> Self {
        #[cfg(target_os = "android")]
        {
            Self {
                handle: self.handle.clone(),
            }
        }
        #[cfg(not(target_os = "android"))]
        {
            Self {
                _runtime: PhantomData,
            }
        }
    }
}

impl<R: Runtime> ConnectionControlsBridge<R> {
    pub async fn save_begin(&self, args: BeginSaveArgs) -> Result<BeginSaveReply, String> {
        #[cfg(target_os = "android")]
        {
            self.handle
                .run_mobile_plugin_async("saveBegin", args)
                .await
                .map_err(|error| error.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = args;
            Err("Android document saving is unavailable on this platform".into())
        }
    }

    pub async fn save_write_chunk(&self, args: WriteChunkArgs) -> Result<(), String> {
        #[cfg(target_os = "android")]
        {
            self.handle
                .run_mobile_plugin_async("saveWriteChunk", args)
                .await
                .map_err(|error| error.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = args;
            Err("Android document saving is unavailable on this platform".into())
        }
    }

    pub async fn save_finish(&self, args: TransferArgs) -> Result<(), String> {
        #[cfg(target_os = "android")]
        {
            self.handle
                .run_mobile_plugin_async("saveFinish", args)
                .await
                .map_err(|error| error.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = args;
            Err("Android document saving is unavailable on this platform".into())
        }
    }

    pub async fn save_cancel(&self, args: TransferArgs) -> Result<(), String> {
        #[cfg(target_os = "android")]
        {
            self.handle
                .run_mobile_plugin_async("saveCancel", args)
                .await
                .map_err(|error| error.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = args;
            Err("Android document saving is unavailable on this platform".into())
        }
    }
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
        .setup(move |app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(
                    ANDROID_PLUGIN_IDENTIFIER,
                    "ConnectionControlsPlugin",
                )?;
                handle.run_mobile_plugin::<()>("configure", ConfigureArgs { settings_url })?;
                use tauri::Manager;
                app.manage(ConnectionControlsBridge { handle });
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = api;
                use tauri::Manager;
                app.manage(ConnectionControlsBridge {
                    _runtime: PhantomData,
                });
            }

            Ok(())
        })
        .build()
}
