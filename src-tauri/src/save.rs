use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use tauri::{AppHandle, Manager, Runtime, State, Url, Webview};
#[cfg(target_os = "android")]
use tauri_plugin_connection_controls::{
    BeginSaveArgs, ConnectionControlsBridge, TransferArgs, WriteChunkArgs,
};
#[cfg(target_os = "android")]
use tauri::Wry;
use uuid::Uuid;

use crate::connection::{self, ConnectionManager};

const CHUNK_BYTES: usize = 128 * 1024;
const MAX_SAVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_FILENAME_BYTES: usize = 255;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Owner {
    generation: u64,
    origin: String,
    session_token: String,
}

#[derive(Default)]
pub struct SaveManager(Arc<Mutex<HashMap<String, Transfer>>>);

struct Transfer {
    owner: Owner,
    expected_bytes: Option<u64>,
    written_bytes: u64,
    next_sequence: u64,
    last_chunk_short: bool,
    busy: bool,
    finishing: bool,
    sink: TransferSink,
}

enum TransferSink {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    Desktop(DesktopSink),
    #[cfg(target_os = "android")]
    Android,
}

impl SaveManager {
    fn insert(&self, id: String, transfer: Transfer) -> Result<(), String> {
        use std::collections::hash_map::Entry;
        let mut transfers = self
            .0
            .lock()
            .map_err(|_| "Save state is unavailable.")?;
        match transfers.entry(id) {
            Entry::Vacant(entry) => {
                entry.insert(transfer);
                Ok(())
            }
            Entry::Occupied(_) => Err("A save transfer with this identifier already exists.".into()),
        }
    }

    fn drain(&self) -> Vec<String> {
        let Ok(mut transfers) = self.0.lock() else {
            return Vec::new();
        };
        let ids = transfers
            .iter()
            .filter_map(|(id, transfer)| (!transfer.finishing).then(|| id.clone()))
            .collect::<Vec<_>>();
        for id in &ids {
            transfers.remove(id);
        }
        ids
    }

    fn remove_finished(&self, id: &str, owner: &Owner) -> Result<(), String> {
        let mut transfers = self
            .0
            .lock()
            .map_err(|_| "Save state is unavailable.")?;
        if transfers
            .get(id)
            .is_some_and(|transfer| transfer.owner == *owner && transfer.finishing)
        {
            transfers.remove(id);
        }
        Ok(())
    }
}

/// Drop all app-side partials when a service session is invalidated. Android's SAF
/// streams live in the plugin, so their opaque transfer ids are cancelled separately.
pub fn invalidate_transfers<R: Runtime>(app: &AppHandle<R>) {
    let Some(manager) = app.try_state::<SaveManager>() else {
        return;
    };
    let ids = manager.drain();
    #[cfg(target_os = "android")]
    if !ids.is_empty() {
        let bridge = app
            .state::<ConnectionControlsBridge<R>>()
            .inner()
            .clone();
        for transfer_id in ids {
            tauri::async_runtime::spawn(async move {
                let _ = bridge.save_cancel(TransferArgs { transfer_id }).await;
            });
        }
    }
    #[cfg(not(target_os = "android"))]
    let _ = ids;
}

fn owner_for(
    webview: &Webview,
    connections: &ConnectionManager,
    generation: u64,
    session_token: &str,
) -> Result<Owner, String> {
    let current = connection::require_current_session(
        webview,
        connections,
        generation,
        session_token,
    )?;
    Ok(Owner {
        generation,
        origin: current.origin().ascii_serialization(),
        session_token: session_token.to_string(),
    })
}

fn owner_from_url(url: &Url, generation: u64, session_token: &str) -> Owner {
    Owner {
        generation,
        origin: url.origin().ascii_serialization(),
        session_token: session_token.to_string(),
    }
}

fn with_current_owner<T>(
    webview: &Webview,
    connections: &ConnectionManager,
    generation: u64,
    session_token: &str,
    action: impl FnOnce(Owner) -> Result<T, String>,
) -> Result<T, String> {
    connection::with_current_session(
        webview,
        connections,
        generation,
        session_token,
        |current| action(owner_from_url(current, generation, session_token)),
    )
}

fn validate_metadata(
    filename: &str,
    mime_type: &str,
    expected_bytes: Option<u64>,
) -> Result<(String, String), String> {
    let filename = sanitize_filename(filename)?;
    let mime_type = sanitize_mime_type(mime_type)?;
    if expected_bytes.is_some_and(|size| size > MAX_SAVE_BYTES) {
        return Err("The file exceeds the 2 GiB save limit.".into());
    }
    Ok((filename, mime_type))
}

fn sanitize_filename(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_FILENAME_BYTES
        || value == "."
        || value == ".."
        || value.ends_with('.')
        || value.ends_with(' ')
        || value
            .chars()
            .any(|character| character.is_control() || "/\\:*?\"<>|".contains(character))
    {
        return Err("Choose a valid file name.".into());
    }

    let device_name = value.split('.').next().unwrap_or_default().trim_end();
    let upper = device_name.to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            upper
                .strip_prefix(prefix)
                .is_some_and(|suffix| {
                    suffix.len() == 1
                        && suffix
                            .bytes()
                            .next()
                            .is_some_and(|byte| (b'1'..=b'9').contains(&byte))
                })
        });
    if reserved {
        return Err("Choose a file name that is not reserved by the operating system.".into());
    }
    Ok(value.to_string())
}

fn sanitize_mime_type(value: &str) -> Result<String, String> {
    let value = value.trim();
    let Some((kind, subtype)) = value.split_once('/') else {
        return Err("The file type is invalid.".into());
    };
    let valid_token = |part: &str| {
        !part.is_empty()
            && part.len() <= 127
            && part.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(byte, b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-')
            })
    };
    if !valid_token(kind) || !valid_token(subtype) {
        return Err("The file type is invalid.".into());
    }
    Ok(format!("{}/{}", kind.to_ascii_lowercase(), subtype.to_ascii_lowercase()))
}

fn decode_chunk(encoded: &str) -> Result<Vec<u8>, String> {
    let max_encoded = CHUNK_BYTES.div_ceil(3) * 4;
    if encoded.len() > max_encoded {
        return Err("The save chunk exceeds the 128 KiB limit.".into());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "The save chunk is not valid base64.".to_string())?;
    if bytes.is_empty() || bytes.len() > CHUNK_BYTES {
        return Err("The save chunk must contain between 1 byte and 128 KiB.".into());
    }
    Ok(bytes)
}

fn validate_chunk(transfer: &Transfer, sequence: u64, bytes: &[u8]) -> Result<(), String> {
    if transfer.busy {
        return Err("This save transfer is busy.".into());
    }
    if transfer.last_chunk_short {
        return Err("No chunks may follow the final partial chunk.".into());
    }
    if sequence != transfer.next_sequence {
        return Err("Save chunks must arrive in order starting at sequence zero.".into());
    }
    let next_total = transfer
        .written_bytes
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| "The file exceeds the 2 GiB save limit.".to_string())?;
    if next_total > MAX_SAVE_BYTES {
        return Err("The file exceeds the 2 GiB save limit.".into());
    }
    if let Some(expected) = transfer.expected_bytes {
        let remaining = expected.saturating_sub(transfer.written_bytes);
        let required = remaining.min(CHUNK_BYTES as u64) as usize;
        if bytes.len() != required || next_total > expected {
            return Err("The received file size does not match the expected size.".into());
        }
    }
    Ok(())
}

#[tauri::command(rename = "save-begin", rename_all = "camelCase")]
pub async fn save_begin(
    app: AppHandle,
    webview: Webview,
    connections: State<'_, ConnectionManager>,
    saves: State<'_, SaveManager>,
    generation: u64,
    session_token: String,
    filename: String,
    mime_type: String,
    expected_bytes: Option<u64>,
) -> Result<tauri_plugin_connection_controls::BeginSaveReply, String> {
    let owner = owner_for(&webview, &connections, generation, &session_token)?;
    let (filename, mime_type) = validate_metadata(&filename, &mime_type, expected_bytes)?;
    let transfer_id = Uuid::new_v4().to_string();

    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        use tauri_plugin_dialog::DialogExt;
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        app.dialog()
            .file()
            .set_file_name(filename)
            .save_file(move |path| {
                let _ = sender.send(path);
            });
        let selected = tauri::async_runtime::spawn_blocking(move || receiver.recv())
            .await
            .map_err(|_| "The save dialog could not be completed.")?
            .map_err(|_| "The save dialog was interrupted.")?;
        let Some(selected) = selected else {
            return Ok(tauri_plugin_connection_controls::BeginSaveReply {
                status: "cancelled".into(),
                transfer_id: None,
            });
        };
        let target = selected
            .into_path()
            .map_err(|_| "Could not use the selected file.")?;
        owner_for(&webview, &connections, generation, &session_token)?;
        let sink = DesktopSink::create(target)?;
        owner_for(&webview, &connections, generation, &session_token)?;
        saves.insert(
            transfer_id.clone(),
            Transfer {
                owner,
                expected_bytes,
                written_bytes: 0,
                next_sequence: 0,
                last_chunk_short: false,
                busy: false,
                finishing: false,
                sink: TransferSink::Desktop(sink),
            },
        )?;
        if let Err(error) = owner_for(&webview, &connections, generation, &session_token) {
            saves
                .0
                .lock()
                .ok()
                .and_then(|mut transfers| transfers.remove(&transfer_id));
            return Err(error);
        }
        Ok(tauri_plugin_connection_controls::BeginSaveReply {
            status: "started".into(),
            transfer_id: Some(transfer_id),
        })
    }

    #[cfg(target_os = "android")]
    {
        let bridge = app.state::<ConnectionControlsBridge<Wry>>().inner().clone();
        let reply = bridge
            .save_begin(BeginSaveArgs {
                transfer_id: transfer_id.clone(),
                filename,
                mime_type,
                expected_bytes,
            })
            .await?;
        if let Err(error) = owner_for(&webview, &connections, generation, &session_token) {
            if reply.status == "started" {
                let _ = bridge
                    .save_cancel(TransferArgs {
                        transfer_id: transfer_id.clone(),
                    })
                    .await;
            }
            return Err(error);
        }
        if reply.status == "cancelled" {
            return Ok(reply);
        }
        if reply.status != "started" || reply.transfer_id.as_deref() != Some(&transfer_id) {
            let _ = bridge
                .save_cancel(TransferArgs {
                    transfer_id: transfer_id.clone(),
                })
                .await;
            return Err("The document provider returned an invalid save session.".into());
        }
        saves.insert(
            transfer_id.clone(),
            Transfer {
                owner,
                expected_bytes,
                written_bytes: 0,
                next_sequence: 0,
                last_chunk_short: false,
                busy: false,
                finishing: false,
                sink: TransferSink::Android,
            },
        )?;
        if let Err(error) = owner_for(&webview, &connections, generation, &session_token) {
            saves
                .0
                .lock()
                .ok()
                .and_then(|mut transfers| transfers.remove(&transfer_id));
            let _ = bridge
                .save_cancel(TransferArgs {
                    transfer_id: transfer_id.clone(),
                })
                .await;
            return Err(error);
        }
        Ok(reply)
    }

    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux",
        target_os = "android"
    )))]
    {
        let _ = (app, saves, owner, transfer_id, filename, mime_type, expected_bytes);
        Err("File saving is unavailable on this platform.".into())
    }
}

#[tauri::command(rename = "save-write-chunk", rename_all = "camelCase")]
pub async fn save_write_chunk(
    app: AppHandle,
    webview: Webview,
    connections: State<'_, ConnectionManager>,
    saves: State<'_, SaveManager>,
    generation: u64,
    session_token: String,
    transfer_id: String,
    sequence: u64,
    chunk_base64: String,
) -> Result<(), String> {
    let bytes = decode_chunk(&chunk_base64)?;
    #[cfg(target_os = "android")]
    {
        let owner = with_current_owner(
            &webview,
            &connections,
            generation,
            &session_token,
            |owner| {
                let mut transfers = saves.0.lock().map_err(|_| "Save state is unavailable.")?;
                let transfer = get_owned_transfer(&mut transfers, &transfer_id, &owner)?;
                validate_chunk(transfer, sequence, &bytes)?;
                transfer.busy = true;
                Ok(owner)
            },
        )?;
        let bridge = app.state::<ConnectionControlsBridge<Wry>>().inner().clone();
        let result = bridge
            .save_write_chunk(WriteChunkArgs {
                transfer_id: transfer_id.clone(),
                sequence,
                chunk_base64,
            })
            .await;
        let still_current = owner_for(&webview, &connections, generation, &session_token).is_ok();
        let mut transfers = saves.0.lock().map_err(|_| "Save state is unavailable.")?;
        let Some(transfer) = transfers.get_mut(&transfer_id) else {
            drop(transfers);
            if !still_current {
                let _ = bridge.save_cancel(TransferArgs { transfer_id }).await;
            }
            return Err("This save transfer is no longer active.".into());
        };
        if transfer.owner != owner || !transfer.busy || !still_current {
            transfers.remove(&transfer_id);
            drop(transfers);
            let _ = bridge.save_cancel(TransferArgs { transfer_id }).await;
            return Err("This server session is no longer active.".into());
        }
        if let Err(error) = result {
            transfers.remove(&transfer_id);
            drop(transfers);
            let _ = bridge.save_cancel(TransferArgs { transfer_id }).await;
            return Err(error);
        }
        transfer.written_bytes += bytes.len() as u64;
        transfer.next_sequence += 1;
        transfer.last_chunk_short = bytes.len() < CHUNK_BYTES;
        transfer.busy = false;
        return Ok(());
    }
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        let _ = &app;
        with_current_owner(
            &webview,
            &connections,
            generation,
            &session_token,
            |owner| {
                let mut transfers = saves.0.lock().map_err(|_| "Save state is unavailable.")?;
                let transfer = get_owned_transfer(&mut transfers, &transfer_id, &owner)?;
                validate_chunk(transfer, sequence, &bytes)?;
                let TransferSink::Desktop(sink) = &mut transfer.sink else {
                    return Err("This save transfer is unavailable.".into());
                };
                sink.write_chunk(&bytes)?;
                transfer.written_bytes += bytes.len() as u64;
                transfer.next_sequence += 1;
                transfer.last_chunk_short = bytes.len() < CHUNK_BYTES;
                Ok(())
            },
        )
    }
    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux",
        target_os = "android"
    )))]
    {
        let _ = (app, webview, connections, saves, bytes, sequence, chunk_base64);
        Err("File saving is unavailable on this platform.".into())
    }
}

#[tauri::command(rename = "save-finish", rename_all = "camelCase")]
pub async fn save_finish(
    app: AppHandle,
    webview: Webview,
    connections: State<'_, ConnectionManager>,
    saves: State<'_, SaveManager>,
    generation: u64,
    session_token: String,
    transfer_id: String,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let owner = with_current_owner(
            &webview,
            &connections,
            generation,
            &session_token,
            |owner| {
                let mut transfers = saves.0.lock().map_err(|_| "Save state is unavailable.")?;
                let transfer = get_owned_transfer(&mut transfers, &transfer_id, &owner)?;
                ensure_complete(transfer)?;
                transfer.busy = true;
                transfer.finishing = true;
                Ok(owner)
            },
        )?;
        let bridge = app.state::<ConnectionControlsBridge<Wry>>().inner().clone();
        // The locked owner/transfer transition above is the commit point. Invalidation
        // preserves this finishing record; after it, a successful native finish may
        // complete even if navigation occurs while the plugin future is being awaited.
        let result = bridge
            .save_finish(TransferArgs {
                transfer_id: transfer_id.clone(),
            })
            .await;
        saves.remove_finished(&transfer_id, &owner)?;
        if result.is_err() {
            let _ = bridge
                .save_cancel(TransferArgs {
                    transfer_id: transfer_id.clone(),
                })
                .await;
        }
        result
    }
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        let _ = &app;
        let sink = with_current_owner(
            &webview,
            &connections,
            generation,
            &session_token,
            |owner| {
                let mut transfers = saves.0.lock().map_err(|_| "Save state is unavailable.")?;
                let transfer = get_owned_transfer(&mut transfers, &transfer_id, &owner)?;
                ensure_complete(transfer)?;
                transfers
                    .remove(&transfer_id)
                    .map(|transfer| transfer.sink)
                    .ok_or_else(|| "This save transfer is no longer active.".to_string())
            },
        )?;
        let TransferSink::Desktop(sink) = sink else {
            return Err("This save transfer is unavailable.".into());
        };
        sink.finish()
    }
    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux",
        target_os = "android"
    )))]
    {
        let _ = (app, webview, connections, saves, generation, session_token, transfer_id);
        Err("File saving is unavailable on this platform.".into())
    }
}

#[tauri::command(rename = "save-cancel", rename_all = "camelCase")]
pub async fn save_cancel(
    app: AppHandle,
    webview: Webview,
    connections: State<'_, ConnectionManager>,
    saves: State<'_, SaveManager>,
    generation: u64,
    session_token: String,
    transfer_id: String,
) -> Result<(), String> {
    let transfer = with_current_owner(
        &webview,
        &connections,
        generation,
        &session_token,
        |owner| {
            let mut transfers = saves.0.lock().map_err(|_| "Save state is unavailable.")?;
            if let Some(transfer) = transfers.get(&transfer_id) {
                if transfer.owner != owner {
                    return Err("This server session is no longer active.".into());
                }
                if transfer.finishing {
                    return Err("This save transfer is already finishing.".into());
                }
            }
            Ok(transfers.remove(&transfer_id))
        },
    )?;
    #[cfg(target_os = "android")]
    {
        let Some(transfer) = transfer else {
            return Ok(());
        };
        drop(transfer);
        let bridge = app.state::<ConnectionControlsBridge<Wry>>().inner().clone();
        bridge.save_cancel(TransferArgs { transfer_id }).await
    }
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        let _ = &app;
        drop(transfer);
        Ok(())
    }
    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux",
        target_os = "android"
    )))]
    {
        let _ = (app, webview, connections, saves, generation, session_token, transfer_id);
        Err("File saving is unavailable on this platform.".into())
    }
}

fn get_owned_transfer<'a>(
    transfers: &'a mut HashMap<String, Transfer>,
    transfer_id: &str,
    owner: &Owner,
) -> Result<&'a mut Transfer, String> {
    let transfer = transfers
        .get_mut(transfer_id)
        .ok_or_else(|| "This save transfer is no longer active.".to_string())?;
    if transfer.owner != *owner {
        return Err("This server session is no longer active.".into());
    }
    Ok(transfer)
}

fn ensure_complete(transfer: &Transfer) -> Result<(), String> {
    if transfer.busy {
        return Err("This save transfer is busy.".into());
    }
    if let Some(expected) = transfer.expected_bytes {
        if transfer.written_bytes != expected {
            return Err("The received file size does not match the expected size.".into());
        }
    }
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
struct DesktopSink {
    target: std::path::PathBuf,
    temporary: std::path::PathBuf,
    file: Option<std::fs::File>,
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
impl DesktopSink {
    fn create(target: std::path::PathBuf) -> Result<Self, String> {
        use std::{fs::OpenOptions, path::Path};

        let parent = target
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        for _ in 0..5 {
            let temporary = parent.join(format!(".owc-save-{}.part", Uuid::new_v4()));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
            {
                Ok(file) => {
                    return Ok(Self {
                        target,
                        temporary,
                        file: Some(file),
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err("Could not create a temporary save file.".into()),
            }
        }
        Err("Could not create a temporary save file.".into())
    }

    fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), String> {
        use std::io::Write;
        self.file
            .as_mut()
            .ok_or_else(|| "The temporary save file is unavailable.".to_string())?
            .write_all(bytes)
            .map_err(|_| "Could not write the file.".to_string())
    }

    fn finish(mut self) -> Result<(), String> {
        let mut file = self
            .file
            .take()
            .ok_or_else(|| "The temporary save file is unavailable.".to_string())?;
        use std::io::Write;
        file.flush()
            .and_then(|()| file.sync_all())
            .map_err(|_| "Could not finish the file.".to_string())?;
        drop(file);
        connection::replace_file(&self.temporary, &self.target)
            .map_err(|_| "Could not finish the file.".to_string())?;
        self.temporary = std::path::PathBuf::new();
        Ok(())
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
impl Drop for DesktopSink {
    fn drop(&mut self) {
        self.file.take();
        if !self.temporary.as_os_str().is_empty() {
            let _ = std::fs::remove_file(&self.temporary);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use tauri_plugin_connection_controls::{BeginSaveArgs, TransferArgs, WriteChunkArgs};

    fn transfer(expected_bytes: Option<u64>, sink: DesktopSink) -> Transfer {
        Transfer {
            owner: Owner {
                generation: 4,
                origin: "https://chat.example.org".into(),
                session_token: "session-secret".into(),
            },
            expected_bytes,
            written_bytes: 0,
            next_sequence: 0,
            last_chunk_short: false,
            busy: false,
            finishing: false,
            sink: TransferSink::Desktop(sink),
        }
    }

    fn scratch_dir() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("owc-save-test-{}", Uuid::new_v4()));
        std::fs::create_dir(&path).expect("create test directory");
        path
    }

    #[test]
    fn ipc_reply_and_android_payload_use_only_the_approved_camel_case_fields() {
        let started = tauri_plugin_connection_controls::BeginSaveReply {
            status: "started".into(),
            transfer_id: Some("opaque-id".into()),
        };
        assert_eq!(
            serde_json::to_value(started).unwrap(),
            serde_json::json!({ "status": "started", "transferId": "opaque-id" })
        );
        let cancelled = tauri_plugin_connection_controls::BeginSaveReply {
            status: "cancelled".into(),
            transfer_id: None,
        };
        assert_eq!(
            serde_json::to_value(cancelled).unwrap(),
            serde_json::json!({ "status": "cancelled" })
        );

        let args = BeginSaveArgs {
            transfer_id: "opaque-id".into(),
            filename: "report.txt".into(),
            mime_type: "text/plain".into(),
            expected_bytes: Some(12),
        };
        let value = serde_json::to_value(args).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "transferId": "opaque-id",
                "filename": "report.txt",
                "mimeType": "text/plain",
                "expectedBytes": 12
            })
        );
        let object = value.as_object().unwrap();
        assert!(!object.keys().any(|key| {
            key.contains("path") || key.contains("uri") || key.contains('_')
        }));

        assert_eq!(
            serde_json::to_value(WriteChunkArgs {
                transfer_id: "opaque-id".into(),
                sequence: 0,
                chunk_base64: "Ynl0ZXM=".into(),
            })
            .unwrap(),
            serde_json::json!({
                "transferId": "opaque-id",
                "sequence": 0,
                "chunkBase64": "Ynl0ZXM="
            })
        );
        assert_eq!(
            serde_json::to_value(TransferArgs {
                transfer_id: "opaque-id".into(),
            })
            .unwrap(),
            serde_json::json!({ "transferId": "opaque-id" })
        );
    }

    #[test]
    fn filename_and_mime_validation_reject_paths_controls_and_reserved_names() {
        assert_eq!(sanitize_filename(" report.txt ").unwrap(), "report.txt");
        for invalid in ["", "../report.txt", "C:\\report.txt", "NUL.txt", "COM4.log", "bad\nname"] {
            assert!(sanitize_filename(invalid).is_err(), "accepted {invalid:?}");
        }
        assert_eq!(sanitize_mime_type("Text/Plain").unwrap(), "text/plain");
        for invalid in ["text/plain; charset=utf-8", "*/*", "text/", "text/plain\n"] {
            assert!(sanitize_mime_type(invalid).is_err(), "accepted {invalid:?}");
        }
    }

    #[test]
    fn desktop_finish_replaces_atomically_and_cancel_preserves_existing_file() {
        let directory = scratch_dir();
        let target = directory.join("report.bin");
        std::fs::write(&target, b"old file").unwrap();

        let cancelled = DesktopSink::create(target.clone()).unwrap();
        drop(cancelled);
        assert_eq!(std::fs::read(&target).unwrap(), b"old file");
        assert_eq!(
            std::fs::read_dir(&directory).unwrap().count(),
            1,
            "cancel removes its same-directory partial"
        );

        let mut sink = DesktopSink::create(target.clone()).unwrap();
        sink.write_chunk(b"new ").unwrap();
        sink.write_chunk(b"bytes").unwrap();
        sink.finish().unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new bytes");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn invalidating_a_session_drops_its_partial_files() {
        let directory = scratch_dir();
        let manager = SaveManager::default();
        let sink = DesktopSink::create(directory.join("data.bin")).unwrap();
        manager
            .insert("transfer".into(), transfer(None, sink))
            .unwrap();
        let mut finishing = transfer(
            None,
            DesktopSink::create(directory.join("finishing.bin")).unwrap(),
        );
        finishing.busy = true;
        finishing.finishing = true;
        manager.insert("finishing".into(), finishing).unwrap();
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 2);
        assert_eq!(manager.drain(), vec!["transfer".to_string()]);
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        assert!(manager.0.lock().unwrap().contains_key("finishing"));
        drop(manager.0.lock().unwrap().remove("finishing"));
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn async_finish_cleanup_only_removes_the_matching_old_owner() {
        let directory = scratch_dir();
        let manager = SaveManager::default();
        let mut old = transfer(
            None,
            DesktopSink::create(directory.join("old.bin")).unwrap(),
        );
        old.busy = true;
        old.finishing = true;
        let old_owner = old.owner.clone();
        manager.insert("same-id".into(), old).unwrap();
        manager.drain();
        drop(manager.0.lock().unwrap().remove("same-id"));

        let new = transfer(
            None,
            DesktopSink::create(directory.join("new.bin")).unwrap(),
        );
        manager.insert("same-id".into(), new).unwrap();
        manager.remove_finished("same-id", &old_owner).unwrap();
        assert!(manager.0.lock().unwrap().contains_key("same-id"));

        let current_owner = {
            let mut transfers = manager.0.lock().unwrap();
            let current_transfer = transfers.get_mut("same-id").unwrap();
            current_transfer.finishing = true;
            current_transfer.owner.clone()
        };
        manager.remove_finished("same-id", &current_owner).unwrap();
        assert!(!manager.0.lock().unwrap().contains_key("same-id"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn sequence_size_chunk_and_owner_checks_reject_invalid_transfers() {
        let directory = scratch_dir();
        let sink = DesktopSink::create(directory.join("data.bin")).unwrap();
        let mut transfer = transfer(Some(3), sink);
        assert!(validate_chunk(&transfer, 1, b"abc").is_err());
        assert!(validate_chunk(&transfer, 0, b"ab").is_err());
        assert!(validate_chunk(&transfer, 0, b"abcd").is_err());
        assert!(validate_chunk(&transfer, 0, b"abc").is_ok());
        transfer.written_bytes = 3;
        transfer.next_sequence = 1;
        transfer.last_chunk_short = true;
        assert!(validate_chunk(&transfer, 1, b"x").is_err());
        assert!(ensure_complete(&transfer).is_ok());

        let mut transfers = HashMap::from([("id".into(), transfer)]);
        let wrong_owner = Owner {
            generation: 5,
            origin: "https://chat.example.org".into(),
            session_token: "old-session".into(),
        };
        assert!(get_owned_transfer(&mut transfers, "id", &wrong_owner).is_err());
        drop(transfers);
        std::fs::remove_dir_all(directory).unwrap();

        let at_limit = Transfer {
            owner: wrong_owner,
            expected_bytes: None,
            written_bytes: MAX_SAVE_BYTES,
            next_sequence: 0,
            last_chunk_short: false,
            busy: false,
            finishing: false,
            sink: TransferSink::Desktop(DesktopSink::create(
                std::env::temp_dir().join(format!("owc-limit-{}.tmp", Uuid::new_v4())),
            ).unwrap()),
        };
        assert!(validate_chunk(&at_limit, 0, b"x").is_err());
    }

    #[test]
    fn encoded_chunks_are_strictly_bounded_and_nonempty() {
        assert!(decode_chunk("").is_err());
        assert!(decode_chunk("%%%not-base64%%%").is_err());
        let encoded = STANDARD.encode(vec![0_u8; CHUNK_BYTES + 1]);
        assert!(decode_chunk(&encoded).is_err());
        assert_eq!(decode_chunk(&STANDARD.encode(b"bytes")).unwrap(), b"bytes");
    }
}
