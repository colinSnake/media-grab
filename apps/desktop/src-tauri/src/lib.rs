use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    os: String,
    arch: String,
    app_data_dir: String,
}

#[tauri::command]
fn get_runtime_info(app: AppHandle) -> Result<RuntimeInfo, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;

    Ok(RuntimeInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_data_dir: app_data_dir.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn open_app_data_dir(app: AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    std::fs::create_dir_all(&path).map_err(|error| format!("无法创建应用数据目录: {error}"))?;

    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");

    command.arg(path);
    command
        .spawn()
        .map_err(|error| format!("无法打开应用数据目录: {error}"))?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_runtime_info, open_app_data_dir])
        .run(tauri::generate_context!())
        .expect("error while running mediaGrab desktop application");
}
