mod credentials;
mod media;
mod media_adapters;
mod media_codex;
mod media_integrity;
mod media_jobs;
mod media_package;
mod media_video;
mod project_deletion;
mod runtime;
mod storage;
mod updates;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol("workbench-media", |context, request| {
            media::protocol(context.app_handle(), request)
        })
        .manage(runtime::RuntimeState::default())
        .manage(media_jobs::MediaRuntime::default())
        .manage(media::FileChooserRuntime::default())
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
            media::media_list,
            media_adapters::media_adapter_catalog,
            media::media_verify_versions,
            media_jobs::media_query_jobs,
            media::media_choose_import,
            media::media_import_bytes,
            media::media_update_asset,
            media::media_export_version,
            media::media_keyframes,
            media_jobs::media_submit,
            media_jobs::media_submit_batch,
            media_jobs::media_cancel_batch,
            media_jobs::media_cancel,
            media_jobs::media_resume,
            media_package::media_export_package,
            media_package::media_import_package,
            media_package::media_pending_imports,
            media_package::media_get_pending_import,
            credentials::credential_save,
            credentials::credential_load
        ])
        .build(tauri::generate_context!())
        .expect("failed to build AI Creator Workbench")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                use tauri::Manager;
                app.state::<media_jobs::MediaRuntime>().stop_all();
                app.state::<media::FileChooserRuntime>().stop_all();
            }
        });
}
