mod credentials;
mod runtime;
mod storage;
mod updates;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(runtime::RuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            updates::app_version,
            updates::check_for_updates,
            updates::open_update_link,
            runtime::runtime_snapshot,
            runtime::connection_test,
            runtime::generate_text,
            runtime::cancel_generation,
            runtime::embed_text,
            storage::library_read,
            storage::library_read_archives,
            storage::library_read_previous,
            storage::library_read_previous_archives,
            storage::library_current_revision,
            storage::library_write,
            storage::export_document,
            credentials::credential_save,
            credentials::credential_load
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AI Creator Workbench");
}
