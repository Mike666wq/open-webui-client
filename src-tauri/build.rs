fn main() {
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "get-connection-state",
            "connect-service",
            "connection-ready",
            "open-external",
            "save-begin",
            "save-write-chunk",
            "save-finish",
            "save-cancel",
            "export-android-diagnostics",
        ]));
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
