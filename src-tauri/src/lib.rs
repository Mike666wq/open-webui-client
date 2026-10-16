mod connection;
mod navigation;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .setup(|app| {
            let _ = app.manage(connection::ConnectionManager::load(app.handle()));
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_connection_controls::init(
            "http://tauri.localhost/",
        ))
        .plugin(navigation::plugin())
        .invoke_handler(tauri::generate_handler![
            connection::get_connection_state,
            connection::connect_service,
            connection::connection_ready,
            connection::open_external,
        ]);

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .menu(|handle| {
            use tauri::menu::{Menu, MenuItem, Submenu};
            let settings = MenuItem::with_id(
                handle,
                "connection-settings",
                "Connection Settings",
                true,
                Some("CmdOrCtrl+L"),
            )?;
            let app_menu =
                Submenu::with_items(handle, "Open WebUI Client", true, &[&settings])?;
            Menu::with_items(handle, &[&app_menu])
        })
        .on_menu_event(|app, event| {
            if event.id() == "connection-settings" {
                let manager = app.state::<connection::ConnectionManager>();
                connection::return_to_settings(app, manager.inner());
            }
        });

    builder
        .run(tauri::generate_context!())
        .expect("error while running Open WebUI Client");
}
