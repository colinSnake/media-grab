use serde::Serialize;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, RunEvent};

struct CoreProcess(Mutex<Option<Child>>);

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

fn resource_path(app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
    let root = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位应用资源目录: {error}"))?;
    Ok(root.join(relative))
}

fn start_core(app: &AppHandle) -> Result<Option<Child>, String> {
    if cfg!(debug_assertions) {
        return Ok(None);
    }

    let core_dir = resource_path(app, "resources/core")?;
    let node_name = if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    };
    let node = core_dir.join(node_name);
    let entry = core_dir.join("dist/index.js");
    if !node.is_file() || !entry.is_file() {
        eprintln!(
            "mediaGrab core 未随当前构建提供，跳过自动启动: {}",
            core_dir.display()
        );
        return Ok(None);
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    std::fs::create_dir_all(&data_dir).map_err(|error| format!("无法创建应用数据目录: {error}"))?;
    let tools_dir = resource_path(app, "resources/media-tools")?;
    let log_dir = data_dir.join("logs");
    std::fs::create_dir_all(&log_dir).map_err(|error| format!("无法创建核心日志目录: {error}"))?;
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("core.log"))
        .map_err(|error| format!("无法打开核心日志: {error}"))?;
    let error_file = log_file
        .try_clone()
        .map_err(|error| format!("无法复制核心日志句柄: {error}"))?;

    let mut command = Command::new(&node);
    command
        .arg(&entry)
        .current_dir(&core_dir)
        .env("HOST", "127.0.0.1")
        .env("PORT", "9070")
        .env("DATA_DIR", &data_dir)
        .env("WEB_DIST", core_dir.join("web"))
        .env("MEDIA_TOOLS_DIR", tools_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(error_file));

    command
        .spawn()
        .map(Some)
        .map_err(|error| format!("无法启动 mediaGrab 本地核心: {error}"))
}

fn stop_core(app: &AppHandle) {
    let state = app.state::<CoreProcess>();
    let Ok(mut process) = state.0.lock() else {
        return;
    };
    let Some(mut child) = process.take() else {
        return;
    };
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    #[cfg(windows)]
    let _ = child.kill();
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let core = start_core(app.handle()).map_err(std::io::Error::other)?;
            app.manage(CoreProcess(Mutex::new(core)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_runtime_info,
            open_app_data_dir
        ])
        .build(tauri::generate_context!())
        .expect("error while building mediaGrab desktop application")
        .run(|app, event| match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => stop_core(app),
            _ => {}
        });
}
