//! App-owned native actions. No page event or public command can enter this queue.
use crate::connection::{self, ConnectionManager};
use std::sync::mpsc::{self, Sender};
use tauri::{
    AppHandle, Manager,
    ipc::{Channel, InvokeResponseBody},
};
use tauri_plugin_connection_controls::{
    ConnectionControlsBridge, NativeClientAction, NativeClientState,
};
use uuid::Uuid;

enum Message {
    Action(NativeClientAction),
    Publish,
}
pub(crate) struct NativeClient(Sender<Message>);

pub(crate) fn publish(app: &AppHandle) {
    if let Some(client) = app.try_state::<NativeClient>() {
        let _ = client.0.send(Message::Publish);
    }
}

pub(crate) fn install(app: &AppHandle) {
    let (sender, receiver) = mpsc::channel();
    app.manage(NativeClient(sender.clone()));
    let channel = Channel::<NativeClientAction>::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            if let Ok(action) = serde_json::from_str::<NativeClientAction>(&json) {
                if Uuid::parse_str(action.request_id()).is_ok() {
                    let _ = sender.send(Message::Action(action));
                }
            }
        }
        Ok(())
    });
    let app = app.clone();
    std::thread::spawn(move || {
        let bridge = app
            .state::<ConnectionControlsBridge<tauri::Wry>>()
            .inner()
            .clone();
        if tauri::async_runtime::block_on(bridge.install_native_actions(channel)).is_err() {
            return;
        }
        let mut request_id = String::new();
        let mut revision = 0_u64;
        loop {
            let Ok(message) = receiver.recv() else {
                break;
            };
            let manager = app.state::<ConnectionManager>();
            let mut error_code = None;
            if let Message::Action(action) = message {
                request_id = action.request_id().to_owned();
                match action {
                    NativeClientAction::Snapshot { .. } => {}
                    NativeClientAction::Connect { address, .. } => {
                        let (_, phase, candidate, _, _) = manager.native_snapshot();
                        if phase == "connecting" {
                            continue;
                        }
                        match connection::validate_service_url(&address) {
                            Err(_) => error_code = Some("invalidAddress".into()),
                            Ok(url)
                                if phase == "connected"
                                    && candidate.as_deref()
                                        == Some(url.origin().ascii_serialization().as_str()) => {}
                            Ok(_) => {
                                if let Some(window) = app.get_webview_window("main") {
                                    if tauri::async_runtime::block_on(connection::start_connection(
                                        app.clone(),
                                        window.as_ref().clone(),
                                        manager.inner().clone(),
                                        address,
                                    ))
                                    .is_err()
                                    {
                                        error_code = Some("connectionFailed".into());
                                    }
                                }
                            }
                        }
                    }
                    NativeClientAction::Cancel { generation, .. } => {
                        if manager.cancel_attempt(generation) {
                            crate::save::invalidate_transfers(&app);
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.navigate(connection::settings_url());
                            }
                        }
                    }
                    NativeClientAction::Reload { generation, .. } => {
                        let (current, phase, _, _, _) = manager.native_snapshot();
                        if current == generation && phase == "connected" {
                            crate::save::invalidate_transfers(&app);
                            if let Some(webview) = app.get_webview_window("main") {
                                let _ = webview.reload();
                            }
                        }
                    }
                    NativeClientAction::ExportDiagnostics { .. } => {
                        let bridge = bridge.clone();
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let code = match bridge.export_diagnostics().await {
                                Ok(result) if result.status == "exported" => "diagnosticsExported",
                                Ok(_) => "diagnosticsCancelled",
                                Err(_) => "diagnosticsFailed",
                            };
                            bridge.show_native_notice(code).await;
                            publish(&app);
                        });
                    }
                }
            }
            let (generation, phase, candidate_url, last_success_url, failure) =
                manager.native_snapshot();
            let recent_urls = manager.native_recent_urls();
            revision = revision.wrapping_add(1);
            let _ =
                tauri::async_runtime::block_on(bridge.render_connection_state(NativeClientState {
                    request_id: request_id.clone(),
                    generation,
                    revision,
                    phase,
                    candidate_url,
                    last_success_url,
                    recent_urls,
                    error_code: error_code.or(failure),
                }));
        }
    });
}
