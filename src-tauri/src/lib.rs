mod navigation;
mod service;

#[path = "service_url.generated.rs"]
mod service_url;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let service_url = tauri::Url::parse(service_url::SERVICE_URL)
        .expect("generated service URL must be a valid URL");

    tauri::Builder::default()
        .manage(service::ServiceConfig {
            url: service_url,
            timeout_ms: service_url::PREFLIGHT_TIMEOUT_MS,
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(navigation::plugin())
        .invoke_handler(tauri::generate_handler![
            service::check_service,
            service::open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Open WebUI Client");
}
