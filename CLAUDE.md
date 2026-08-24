# Agent Guidelines

This file provides guidance to coding agents when working with code in this repository.

## Commands

```bash
npx tauri dev      # Full dev mode: compiles Rust + starts Vite on port 1420
npm run dev        # Vite only (frontend hot-reload without the Rust binary)
npx tauri build    # Production build (.app bundle)
```

No test or lint commands are currently configured.

## Architecture

**ClipMate** is a macOS clipboard template manager built with Tauri 2 (Rust backend) + React 19 (Vite frontend).

### How the layers fit together

- **`src-tauri/src/lib.rs`** — The entire Rust backend (~75 lines). Sets up Tauri plugins (global shortcut, SQLite, clipboard, opener) and macOS NSPanel integration. The global shortcut `Alt+]` (`Code::BracketRight`) handler toggles window visibility inline (no separate `toggle_window` command). If registration fails (Accessibility permission missing, key already bound), setup does NOT abort — `window.show()` is called as a fallback so the user still has a way to reach the app.
- **`src/App.jsx`** — The entire frontend (~650 lines). One large React component containing all state, all UI sub-components (`TemplateCard`, `TemplateModal`), and all database interactions.
- **`src/App.css`** — Dark glassmorphism theme; window is 420px wide, 350px (compact) or 580px (expanded) tall. Height is changed at runtime via `LogicalSize` from JS.

### Database (SQLite via tauri-plugin-sql)

Two tables, created on first run inside `App.jsx`:

```sql
templates (id, title, content, tags TEXT DEFAULT '[]', use_count, last_used_at, created_at)
settings  (key TEXT PRIMARY KEY, value TEXT)   -- stores template_order as JSON
```

Tags are stored as a JSON array string. Template display order is stored in `settings` under key `template_order`.

The database file lives at `~/Library/Application Support/com.ivor.clipmate/clipmate.db` (delete it to fully reset state).

### Key behaviors

- **Window state**: Managed as a macOS `NSPanel` (via `tauri-nspanel`) so it stays visible when focus moves to another app and joins all Spaces/full-screen contexts. `hides_on_deactivate = false`, `floating_panel = true`, and collection behavior includes `FullScreenAuxiliary | CanJoinAllSpaces`. The app uses `ActivationPolicy::Accessory` — no Dock icon, no menu bar. Hide/show is the *only* visibility control; never call `set_focus()` after `show()` (the Accessory + NSPanel combination causes macOS to immediately `orderOut` the panel — there's an explicit comment about this in `lib.rs`).
- **Window position**: The panel is positioned near the current cursor/monitor when shown or focused, so it follows the user's active Space/display. Manual drag position is still persisted to `localStorage` under `clipmate-position` as a fallback when cursor/monitor lookup fails.
- **Drag-to-reorder**: Long-press (80 ms threshold) activates drag. Drag state uses both React state (`draggingId`) and refs (`dragActiveRef`, `templatesRef`, `draggingIdRef`) — refs exist to avoid stale closures in `pointermove` handlers without triggering re-renders. Order is written back to the `settings` table on drop.
- **Copy feedback**: Clicking a card copies content via `tauri-plugin-clipboard-manager` (write-only permission), increments `use_count`, updates `last_used_at`, and shows a 700 ms "已复制" animation.
- **Auto-paste**: After a successful copy, if enabled (localStorage `clipmate-autopaste`, default on, toggle in the ⋯ menu), JS invokes the Rust command `paste_to_previous`: it hides the panel, re-activates the app that was frontmost when the panel was summoned (pid captured in the shortcut handler into the `FrontApp` managed state), waits ~180 ms, then posts a CGEvent Cmd+V (`core-graphics` crate). Requires Accessibility permission — same grant as the global shortcut.
- **Dynamic variables**: `{date}` `{time}` `{datetime}` `{week}` `{clipboard}` in template content are expanded at copy time by `expandVariables()` in `App.jsx`. `{clipboard}` reads the current clipboard text (needs `clipboard-manager:allow-read-text`).
- **Delete undo**: Deleting a template shows a toast with an 撤销 button (~4.5 s); undo re-inserts the row (new id) and splices it back into `template_order` at its old index.
- **Keyboard**: A single `keydown` handler on `window` checks `modalOpenRef.current` to decide whether `Escape` closes the modal or hides the window. `Alt+]` (registered in Rust) toggles visibility globally.
- **Database singleton**: `db` is a module-scoped variable initialized lazily on first call to `getDb()`; tables are created there if they don't exist.
- **Tag filtering**: The "All" filter uses the magic string `'全部'` (Chinese for "all"). Tag strings in `templates.tags` are JSON arrays stored as TEXT.

### macOS-specific wiring

`tauri.conf.json` sets `decorations: false`, `transparent: true`, `alwaysOnTop: true`. The Rust `setup_macos_panel` function converts the window to an NSPanel after app setup — this is macOS-only (`#[cfg(target_os = "macos")]`). `macOSPrivateApi: true` is required in `tauri.conf.json` for NSPanel access; without it the panel conversion silently fails.

Tauri security permissions live in `src-tauri/capabilities/default.json`. Clipboard permissions currently include both `allow-write-text` and `allow-read-text`. Add new plugin permissions there when introducing new Tauri APIs.

The global shortcut requires the user to grant **Accessibility** permission to the app (or, in dev, to the terminal running `tauri dev`) under System Settings → Privacy & Security → Accessibility. Without it, `Alt+]` will silently not fire — this is a frequent cause of "shortcut isn't working" reports.
