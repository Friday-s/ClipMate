use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, ShortcutState};

fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            // 不调用 set_focus()：Accessory policy + NSPanel 组合下，
            // makeKeyAndOrderFront 会导致 macOS 立即将 panel orderOut。
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    let is_toggle_shortcut =
                        shortcut.matches(Modifiers::SUPER, Code::BracketLeft)
                            || shortcut.matches(Modifiers::ALT, Code::BracketRight);

                    if is_toggle_shortcut && event.state() == ShortcutState::Pressed {
                        toggle_main_window(app);
                    };
                })
                .build(),
        )
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    builder
        .setup(|app| {
            // 快捷键注册失败时不中断 setup：可能是辅助功能权限未授予或被其他应用占用。
            // 此时直接显示窗口，让用户至少有可见入口，而不是应用完全打不开。
            let shortcuts = ["Command+BracketLeft", "Alt+BracketRight"];
            let mut registered_any = false;
            for shortcut in shortcuts {
                if let Err(e) = app.global_shortcut().register(shortcut) {
                    eprintln!("global shortcut register failed ({shortcut}): {e}");
                } else {
                    registered_any = true;
                }
            }

            if !registered_any {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
            }

            #[cfg(target_os = "macos")]
            setup_macos_panel(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// macOS：转为 NSPanel，禁止系统自动隐藏。
// 隐藏逻辑完全交给 JS 的 onFocusChanged 处理，避免 Rust/JS 状态同步问题。
#[cfg(target_os = "macos")]
fn setup_macos_panel(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::ActivationPolicy;
    use tauri_nspanel::WebviewWindowExt;

    app.set_activation_policy(ActivationPolicy::Accessory);

    let panel = app.get_webview_window("main").unwrap().to_panel().unwrap();

    // 关键：禁止系统在 app 失活时自动隐藏 panel
    // 这样 JS 的 onFocusChanged 才是唯一的隐藏控制点
    panel.set_hides_on_deactivate(false);
    panel.set_floating_panel(true);

    Ok(())
}
