use std::{fs::OpenOptions, os::fd::AsRawFd};

use tauri::{Manager, PhysicalPosition, Position};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, ShortcutState};

#[cfg(target_os = "macos")]
use tauri_nspanel::ManagerExt;

const WINDOW_W: i32 = 420;
const WINDOW_H: i32 = 580;
const WINDOW_GAP: i32 = 16;

struct SingleInstanceLock {
    _file: std::fs::File,
}

fn clamp_to_range(value: i32, min: i32, max: i32) -> i32 {
    if min > max {
        min
    } else {
        value.clamp(min, max)
    }
}

fn acquire_single_instance_lock() -> Option<SingleInstanceLock> {
    let path = std::env::temp_dir().join("com.ivor.clipmate.lock");
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(path)
        .ok()?;

    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc == 0 {
        Some(SingleInstanceLock { _file: file })
    } else {
        None
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let Some(instance_lock) = acquire_single_instance_lock() else {
        eprintln!("another ClipMate instance is already running, exiting");
        return;
    };

    let mut builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if shortcut.matches(Modifiers::ALT, Code::BracketRight)
                        && event.state() == ShortcutState::Pressed
                    {
                        if let Some(window) = app.get_webview_window("main") {
                            if is_main_window_visible(app, &window) {
                                hide_main_window(app, &window);
                            } else {
                                position_near_cursor(app, &window);
                                show_main_window(app, &window);
                            }
                        }
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    builder
        .setup(|app| {
            app.manage(instance_lock);

            // 快捷键注册失败时不中断 setup：可能是辅助功能权限未授予或被其他应用占用。
            // 此时直接显示窗口，让用户至少有可见入口，而不是应用完全打不开。
            if let Err(e) = app.global_shortcut().register("Alt+BracketRight") {
                eprintln!("global shortcut register failed: {e}");
                if let Some(window) = app.get_webview_window("main") {
                    show_main_window(app.handle(), &window);
                }
            }

            #[cfg(target_os = "macos")]
            setup_macos_panel(app);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn is_main_window_visible(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> bool {
    #[cfg(target_os = "macos")]
    {
        if let Ok(panel) = app.get_webview_panel("main") {
            return panel.is_visible();
        }
    }

    window.is_visible().unwrap_or(false)
}

fn show_main_window(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(panel) = app.get_webview_panel("main") {
            // NSPanel 原生 show() 内部会 orderFrontRegardless + makeKeyWindow，
            // 比普通 window.show() 更可靠地浮到当前全屏 Space 前面。
            panel.show();
            return;
        }
    }

    let _ = window.show();
}

fn hide_main_window(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(panel) = app.get_webview_panel("main") {
            panel.order_out(None);
            return;
        }
    }

    let _ = window.hide();
}

// macOS：转为 NSPanel，禁止系统自动隐藏。
// 隐藏逻辑完全交给 JS 的 onFocusChanged 处理，避免 Rust/JS 状态同步问题。
#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn setup_macos_panel(app: &mut tauri::App) {
    use tauri::ActivationPolicy;
    use tauri_nspanel::{cocoa::appkit::NSWindowCollectionBehavior, WebviewWindowExt};

    app.set_activation_policy(ActivationPolicy::Accessory);

    let Some(window) = app.get_webview_window("main") else {
        eprintln!("main window missing during NSPanel setup");
        return;
    };

    let Ok(panel) = window.to_panel() else {
        eprintln!("failed to convert main window to NSPanel");
        return;
    };

    // 关键：禁止系统在 app 失活时自动隐藏 panel
    // 这样 JS 的 onFocusChanged 才是唯一的隐藏控制点
    panel.set_hides_on_deactivate(false);
    panel.set_floating_panel(true);
    #[allow(non_upper_case_globals)]
    const NSWindowStyleMaskNonActivatingPanel: i32 = 1 << 7;
    #[allow(non_upper_case_globals)]
    const NSResizableWindowMask: i32 = 1 << 3;
    // 官方 fullscreen 示例要求 NonActivatingPanel；否则面板在全屏 Space 中
    // 会尝试激活自身 app，最终无法稳定浮到当前全屏应用上层。
    panel.set_style_mask(NSWindowStyleMaskNonActivatingPanel | NSResizableWindowMask);
    panel.set_collection_behaviour(
        NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces,
    );

    // 关键：collection behavior 只让面板「进入」全屏所在的 Space，
    // 但能否压在全屏内容之上取决于 window level。set_floating_panel 设的是
    // NSPanel 的同 app 浮动属性，并不改 NSWindow 的 level，所以面板进了全屏
    // 空间却还在下层。这里显式把 level 抬到 NSPopUpMenuWindowLevel(101)，
    // 高于普通全屏窗口，面板才真正浮在全屏应用之上。
    #[allow(non_upper_case_globals)]
    const NSMainMenuWindowLevel: i32 = 24;
    panel.set_level(NSMainMenuWindowLevel + 1);
}

fn position_near_cursor(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let Ok(cursor) = app.cursor_position() else {
        return;
    };

    let Ok(Some(monitor)) = app.monitor_from_point(cursor.x, cursor.y) else {
        return;
    };

    let area = monitor.work_area();
    let left = area.position.x;
    let top = area.position.y;
    let right = left + area.size.width as i32;
    let bottom = top + area.size.height as i32;

    let cursor_x = cursor.x.round() as i32;
    let cursor_y = cursor.y.round() as i32;
    let mut x = cursor_x - WINDOW_W / 2;
    let mut y = cursor_y + WINDOW_GAP;

    if y + WINDOW_H > bottom - WINDOW_GAP {
        y = cursor_y - WINDOW_H - WINDOW_GAP;
    }

    x = clamp_to_range(x, left + WINDOW_GAP, right - WINDOW_W - WINDOW_GAP);
    y = clamp_to_range(y, top + WINDOW_GAP, bottom - WINDOW_H - WINDOW_GAP);

    let _ = window.set_position(Position::Physical(PhysicalPosition::new(x, y)));
}
