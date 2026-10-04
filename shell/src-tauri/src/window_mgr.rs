//! 多窗口管理（阶段 2）：新开项目窗口 + 窗口→项目目录映射 + 窗口销毁清理。
//! 遵循「一窗口一项目」：label = project_hash(绝对路径)，已存在则聚焦去重。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::file_ops::project_hash;
use crate::util::unpoison;

/// label（= project_hash 或 "main"）→ 项目绝对路径
static WINDOW_PROJECTS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// 打开项目窗口：label = project_hash(path)，已存在则聚焦，不存在则新建。
/// 必须 `async fn`：同步命令里 `WebviewWindowBuilder::build()` 死锁（§2.4 探针 #2）。
#[tauri::command]
pub async fn open_workspace_window(app: AppHandle, path: String) -> Result<(), String> {
    let label = project_hash(&path);

    // 去重：同名项目窗口已存在 → 仅聚焦
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_focus();
        return Ok(());
    }

    // 复刻主窗口构建配置（lib.rs:41）：隐藏待页面加载完成后显示（防 FOUC）
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::default())
        .title("Pylume")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .decorations(false)
        .disable_drag_drop_handler()
        .visible(false);

    // 与主窗口共享同一 WebView2 数据目录（同一 profile，多 Webview 共享是常态）：
    // 应用级 UI 偏好经 localStorage 共享；窗口/项目级状态走 Rust storage 按 root 落盘。
    #[cfg(windows)]
    let builder = builder.data_directory(crate::util::webview_data_dir());

    let win = builder
        .on_page_load(|window, payload| {
            if let PageLoadEvent::Finished = payload.event() {
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .build()
        .map_err(|e| e.to_string())?;

    let label_for_close = label.clone();
    unpoison(WINDOW_PROJECTS.lock()).insert(label, path);

    // 窗口销毁时统一清理：移除映射 + 停该窗口 LSP/终端/调试/文件监听
    win.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            cleanup_window(&label_for_close);
        }
    });

    Ok(())
}

/// 返回本窗口的项目目录（label 反查；主窗口 / 无项目窗口返回 null）。
#[tauri::command]
pub fn get_window_project(window: tauri::WebviewWindow) -> Option<String> {
    unpoison(WINDOW_PROJECTS.lock()).get(window.label()).cloned()
}

/// 窗口销毁的统一清理：移除映射 + 各域按 wid 清理资源。
fn cleanup_window(wid: &str) {
    unpoison(WINDOW_PROJECTS.lock()).remove(wid);
    crate::lsp::lsp_stop_for_window(wid);
    crate::terminal::term_kill_all_for_window(wid);
    crate::dap::debug_stop_for_window(wid);
    crate::watcher::watch_stop_impl(wid);
}