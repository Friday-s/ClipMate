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

// 唤起面板前记录的前台应用 pid，供「自动粘贴」把焦点还回去。
// NonActivating 面板通常不会改变前台应用，但显式记录 + 激活最稳。
struct FrontApp(std::sync::Mutex<Option<i32>>);

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
                                // 显示面板前记下当前前台应用，自动粘贴时要把焦点还给它
                                #[cfg(target_os = "macos")]
                                if let Some(state) = app.try_state::<FrontApp>() {
                                    *state.0.lock().unwrap() = frontmost_app_pid();
                                }
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
            app.manage(FrontApp(std::sync::Mutex::new(None)));

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
        .invoke_handler(tauri::generate_handler![paste_to_previous])
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

// 自动粘贴：隐藏面板 → 激活唤起前记录的应用 → 模拟 Cmd+V。
// 剪贴板内容由前端先写好；这里只负责焦点交还和键击。
// 需要辅助功能权限（CGEventPost），与全局快捷键是同一个授权。
#[tauri::command]
fn paste_to_previous(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        hide_main_window(&app, &window);
    }

    #[cfg(target_os = "macos")]
    {
        let pid = app
            .try_state::<FrontApp>()
            .and_then(|s| *s.0.lock().unwrap());

        // 激活必须在主线程；键击延迟等待目标应用真正拿回焦点
        let _ = app.run_on_main_thread(move || {
            if let Some(pid) = pid {
                activate_app_by_pid(pid);
            }
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(180));
                post_cmd_v();
            });
        });
    }
}

#[cfg(target_os = "macos")]
fn frontmost_app_pid() -> Option<i32> {
    use tauri_nspanel::objc::{class, msg_send, runtime::Object, sel, sel_impl};
    unsafe {
        let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        if workspace.is_null() {
            return None;
        }
        let front: *mut Object = msg_send![workspace, frontmostApplication];
        if front.is_null() {
            return None;
        }
        let pid: i32 = msg_send![front, processIdentifier];
        Some(pid)
    }
}

#[cfg(target_os = "macos")]
fn activate_app_by_pid(pid: i32) {
    use tauri_nspanel::objc::{class, msg_send, runtime::Object, sel, sel_impl};
    unsafe {
        let running: *mut Object = msg_send![
            class!(NSRunningApplication),
            runningApplicationWithProcessIdentifier: pid
        ];
        if !running.is_null() {
            // NSApplicationActivateIgnoringOtherApps = 1 << 1
            let _: bool = msg_send![running, activateWithOptions: 2u64];
        }
    }
}

#[cfg(target_os = "macos")]
fn post_cmd_v() {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let Ok(source) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) else {
        eprintln!("CGEventSource create failed (accessibility permission?)");
        return;
    };

    // 9 = ANSI 键盘布局中的 'v'
    const KEY_V: u16 = 9;
    for key_down in [true, false] {
        if let Ok(event) = CGEvent::new_keyboard_event(source.clone(), KEY_V, key_down) {
            event.set_flags(CGEventFlags::CGEventFlagCommand);
            event.post(CGEventTapLocation::HID);
        }
    }
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
