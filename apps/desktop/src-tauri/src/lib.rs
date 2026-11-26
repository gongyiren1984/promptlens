use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Serialize, Deserialize)]
pub struct CoreEndpoint {
    pub endpoint: String,
    pub token: String,
}

#[derive(Default)]
pub struct CoreState {
    endpoint: Mutex<Option<CoreEndpoint>>,
    child: Mutex<Option<Child>>,
}

/// 前端只在内存中持有令牌；桌面壳不把它写入 WebView 存储。
#[tauri::command]
fn core_endpoint(state: State<'_, CoreState>) -> Result<CoreEndpoint, String> {
    if let Ok(guard) = state.endpoint.lock() {
        if let Some(core) = guard.as_ref() {
            return Ok(core.clone());
        }
    }
    Err("本地核心服务尚未就绪，请稍后重试或重启应用。".into())
}

/// 首次启动引导：调用系统目录选择器。
/// 必须为 async：同步命令在主线程内联执行，而 blocking_pick_folder 禁止在主线程调用。
#[tauri::command]
async fn pick_directory(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("选择默认项目目录")
        .blocking_pick_folder()
        .and_then(|path| path.into_path().ok())
        .map(|path| path.to_string_lossy().to_string())
}

#[derive(Deserialize)]
struct DevFile {
    endpoint: String,
    token: String,
}

/// 开发模式下读取 scripts/dev.js 写出的环回地址与临时令牌。
fn read_dev_endpoint() -> Option<CoreEndpoint> {
    let path = std::env::var("PROMPTLENS_DEV_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.promptlens-dev.json"));
    let text = std::fs::read_to_string(path).ok()?;
    let parsed: DevFile = serde_json::from_str(&text).ok()?;
    Some(CoreEndpoint {
        endpoint: parsed.endpoint,
        token: parsed.token,
    })
}

/// 发布模式：启动随包分发的 Node SEA sidecar，读取握手行后从 0600 令牌文件取值。
fn spawn_sidecar(app: &tauri::AppHandle) -> Result<(CoreEndpoint, Child), String> {
    let resource_dir = app.path().resource_dir().map_err(|error| error.to_string())?;
    let sidecar = resource_dir.join("promptlens-sidecar");
    if !sidecar.exists() {
        return Err(
            "未找到内置核心 sidecar。请先执行 npm run sidecar:build 生成 Node SEA，并放入应用资源目录。"
                .into(),
        );
    }
    let data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    let token_file = data_dir.join("core-token");
    let workspace = data_dir.join("workspace");
    std::fs::create_dir_all(&workspace).map_err(|error| error.to_string())?;

    let mut child = Command::new(&sidecar)
        .args(["serve", "--host", "127.0.0.1", "--port", "0", "--json"])
        .arg("--token-file")
        .arg(&token_file)
        .arg("--workspace")
        .arg(&workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("启动核心 sidecar 失败: {error}"))?;

    let stdout = child.stdout.take().ok_or("无法读取核心 sidecar 输出")?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|error| format!("读取核心握手失败: {error}"))?;
    let ready: serde_json::Value =
        serde_json::from_str(line.trim()).map_err(|error| format!("核心握手格式无效: {error}"))?;
    let endpoint = ready
        .get("endpoint")
        .and_then(|value| value.as_str())
        .ok_or("核心握手缺少 endpoint")?
        .to_string();
    let token = std::fs::read_to_string(&token_file)
        .map_err(|error| format!("读取核心令牌失败: {error}"))?
        .trim()
        .to_string();

    Ok((CoreEndpoint { endpoint, token }, child))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(CoreState::default())
        .setup(|app| {
            let state = app.state::<CoreState>();
            if cfg!(debug_assertions) {
                if let Some(endpoint) = read_dev_endpoint() {
                    *state.endpoint.lock().unwrap() = Some(endpoint);
                }
                return Ok(());
            }
            match spawn_sidecar(app.handle()) {
                Ok((endpoint, child)) => {
                    *state.endpoint.lock().unwrap() = Some(endpoint);
                    *state.child.lock().unwrap() = Some(child);
                }
                Err(message) => {
                    eprintln!("[promptlens] {message}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![core_endpoint, pick_directory])
        .build(tauri::generate_context!())
        .expect("启动 PromptLens 失败")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<CoreState>() {
                    if let Ok(mut guard) = state.child.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
