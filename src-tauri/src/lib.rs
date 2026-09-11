mod runtime;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(runtime::RuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            runtime::runtime_snapshot,
            runtime::connection_test,
            runtime::generate_text,
            runtime::cancel_generation
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AI Creator Workbench");
}
