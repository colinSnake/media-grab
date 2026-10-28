use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::Sha256;
use std::fmt::Write as FmtWrite;
use std::io::{Read, Write as IoWrite};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{menu::{Menu, MenuItem}, tray::TrayIconBuilder, AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

struct CoreProcess(Mutex<Option<Child>>);
struct CoreSecret(String);

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

#[tauri::command]
fn choose_download_dir(app: AppHandle) -> Result<Option<String>, String> {
    app.dialog()
        .file()
        .set_title("选择下载目录")
        .blocking_pick_folder()
        .map(|file| {
            file.into_path()
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|error| format!("无法读取所选目录: {error}"))
        })
        .transpose()
}

#[tauri::command]
fn open_download_file(directory: String, file_name: String) -> Result<(), String> {
    let name = Path::new(&file_name)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| *value == file_name && *value != "." && *value != "..")
        .ok_or_else(|| "下载文件名不合法".to_owned())?;
    let file = PathBuf::from(directory).join(name);
    if !file.is_file() {
        return Err("下载文件不存在，请重新下载".to_owned());
    }

    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "start", ""]);
        command
    };

    command.arg(&file);
    command
        .spawn()
        .map_err(|error| format!("无法打开已保存文件: {error}"))?;
    Ok(())
}

#[tauri::command]
fn notify_download(app: AppHandle, title: String) -> Result<(), String> {
    let short_title: String = title.chars().take(80).collect();
    app.notification()
        .builder()
        .title("MediaGrab 下载完成")
        .body(if short_title.is_empty() { "媒体已保存".to_owned() } else { short_title })
        .show()
        .map_err(|error| format!("无法发送通知: {error}"))
}

fn fresh_hex(bytes: usize) -> Result<String, String> {
    let mut raw = vec![0u8; bytes];
    getrandom::fill(&mut raw).map_err(|error| format!("无法生成桌面会话随机数: {error}"))?;
    let mut encoded = String::with_capacity(bytes * 2);
    for byte in raw {
        write!(&mut encoded, "{byte:02x}").expect("format into String");
    }
    Ok(encoded)
}

fn verify_core_challenge(address: SocketAddr, token: &str, nonce: &str) -> Result<bool, String> {
    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_millis(600)) {
        Ok(stream) => stream,
        Err(_) => return Ok(false), // Core may still be starting.
    };
    stream.set_read_timeout(Some(Duration::from_secs(2))).map_err(|error| error.to_string())?;
    stream.write_all(format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:9070\r\nX-Mediagrab-Nonce: {nonce}\r\nConnection: close\r\n\r\n").as_bytes())
        .map_err(|error| format!("本地核心握手失败: {error}"))?;
    let mut response = Vec::new();
    let mut block = [0u8; 2048];
    while response.len() < 16_384 && !response.windows(4).any(|part| part == b"\r\n\r\n") {
        let n = stream.read(&mut block).map_err(|error| format!("读取核心握手响应失败: {error}"))?;
        if n == 0 { break; }
        response.extend_from_slice(&block[..n]);
    }
    let header_end = response.windows(4).position(|part| part == b"\r\n\r\n").ok_or_else(|| "核心握手响应缺少 HTTP 头".to_owned())?;
    let headers = std::str::from_utf8(&response[..header_end]).map_err(|_| "核心握手响应不合法".to_owned())?;
    if !headers.starts_with("HTTP/1.1 200 ") { return Err("本地端口已被其他服务占用或核心未能启动".to_owned()); }
    let proof = headers.split("\r\n").find_map(|line| line.split_once(':').filter(|(name, _)| name.eq_ignore_ascii_case("x-mediagrab-proof")).map(|(_, value)| value.trim()));
    let proof = proof.ok_or_else(|| "本地端口上的服务没有通过桌面握手".to_owned())?;
    if proof.len() != 64 { return Err("核心握手响应不合法".to_owned()); }
    let mut actual = Vec::with_capacity(32);
    for chunk in proof.as_bytes().chunks_exact(2) {
        let hex = std::str::from_utf8(chunk).map_err(|_| "核心握手响应不合法".to_owned())?;
        actual.push(u8::from_str_radix(hex, 16).map_err(|_| "核心握手响应不合法".to_owned())?);
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).map_err(|error| error.to_string())?;
    mac.update(nonce.as_bytes());
    mac.verify_slice(&actual).map_err(|_| "本地端口上的服务未通过桌面身份验证".to_owned())?;
    Ok(true)
}

#[tauri::command]
async fn get_core_access(app: AppHandle) -> Result<String, String> {
    if cfg!(debug_assertions) { return Ok(String::new()); }
    {
        let state = app.state::<CoreProcess>();
        let mut process = state.0.lock().map_err(|_| "核心进程锁不可用".to_owned())?;
        let child = process.as_mut().ok_or_else(|| "桌面核心未安装".to_owned())?;
        if child.try_wait().map_err(|error| error.to_string())?.is_some() {
            return Err("桌面核心已退出，请检查数据目录中的 core.log".to_owned());
        }
    }
    let token = app.state::<CoreSecret>().0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let nonce = fresh_hex(16)?;
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline {
            if verify_core_challenge(SocketAddr::from(([127, 0, 0, 1], 9070)), &token, &nonce)? { return Ok(token); }
            std::thread::sleep(Duration::from_millis(150));
        }
        Err("本地核心未就绪，请稍后重试".to_owned())
    }).await.map_err(|error| error.to_string())?
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "打开 MediaGrab", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 MediaGrab", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("MediaGrab")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn resource_path(app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
    let root = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位应用资源目录: {error}"))?;
    Ok(root.join(relative))
}

fn start_core(app: &AppHandle, token: &str) -> Result<Option<Child>, String> {
    if cfg!(debug_assertions) {
        return Ok(None);
    }

    if TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], 9070)), Duration::from_millis(250)).is_ok() {
        return Err("本地端口 9070 已被占用，请先关闭占用该端口的程序".to_owned());
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
        // The Windows release job also compiles FFmpeg through MSYS2. Do not
        // leak its shell markers into the packaged Node process: they can
        // change path handling for child tools even though the desktop app
        // itself is a native Windows process.
        .env_remove("MSYSTEM")
        .env_remove("MSYS2_ARG_CONV_EXCL")
        .env_remove("MSYS_NO_PATHCONV")
        .env_remove("CHERE_INVOKING")
        .env_remove("CYGWIN")
        .env("HOST", "127.0.0.1")
        .env("MEDIAGRAB_DESKTOP_CORE", "1")
        .env("MEDIAGRAB_CORE_TOKEN", token)
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide(); // Keep downloads alive; the tray menu provides Quit.
            }
        })
        .setup(|app| {
            setup_tray(app.handle())?;
            let token = fresh_hex(32).map_err(std::io::Error::other)?;
            let core = start_core(app.handle(), &token).map_err(std::io::Error::other)?;
            app.manage(CoreSecret(token));
            app.manage(CoreProcess(Mutex::new(core)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_runtime_info,
            open_app_data_dir,
            choose_download_dir,
            open_download_file,
            notify_download,
            get_core_access
        ])
        .build(tauri::generate_context!())
        .expect("error while building mediaGrab desktop application")
        .run(|app, event| match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => stop_core(app),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn handshake_accepts_only_the_correct_session_secret() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral loopback");
        let address = listener.local_addr().expect("listener address");
        let token = "a".repeat(64);
        let nonce = "b".repeat(32);
        let response_token = token.clone();
        let response_nonce = nonce.clone();
        let responder = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept challenge");
            let mut input = [0u8; 512];
            let size = socket.read(&mut input).expect("read challenge");
            assert!(String::from_utf8_lossy(&input[..size]).contains(&response_nonce));
            let mut mac = Hmac::<Sha256>::new_from_slice(response_token.as_bytes()).expect("HMAC");
            mac.update(response_nonce.as_bytes());
            let proof = mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect::<String>();
            write!(socket, "HTTP/1.1 200 OK\r\nX-Mediagrab-Proof: {proof}\r\nConnection: close\r\n\r\n").expect("write proof");
        });
        assert!(verify_core_challenge(address, &token, &nonce).expect("verify challenge"));
        responder.join().expect("server done");
    }

    #[test]
    fn handshake_rejects_an_untrusted_port_owner() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral loopback");
        let address = listener.local_addr().expect("listener address");
        let responder = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept challenge");
            let mut input = [0u8; 512];
            let _ = socket.read(&mut input).expect("read challenge");
            write!(socket, "HTTP/1.1 200 OK\r\nX-Mediagrab-Proof: {}\r\n\r\n", "c".repeat(64)).expect("write forged proof");
        });
        assert!(verify_core_challenge(address, &"a".repeat(64), &"b".repeat(32)).is_err());
        responder.join().expect("server done");
    }
}
