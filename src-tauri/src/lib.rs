mod credentials;
mod runtime;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(runtime::RuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            runtime::runtime_snapshot,
            runtime::connection_test,
            runtime::generate_text,
            runtime::cancel_generation,
            runtime::embed_text,
            storage::library_read,
            storage::library_write,
            storage::export_document,
            credentials::credential_save,
            credentials::credential_load
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AI Creator Workbench");
}
