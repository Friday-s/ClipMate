# ClipMate

macOS 剪贴板模板管理器，基于 Tauri 2 (Rust) + React 19 构建。通过全局快捷键 `Alt+]` 随时唤出，快速复制常用文本片段。

---

## 环境要求

| 工具 | 版本要求 |
|------|----------|
| Node.js | ≥ 18 |
| Rust | stable（通过 [rustup](https://rustup.rs) 安装） |
| macOS | 12 Monterey 及以上（NSPanel 依赖） |

> Windows / Linux 不受支持，Rust 后端中 NSPanel 部分使用了 `#[cfg(target_os = "macos")]` 条件编译。

---

## 快速开始

### 1. 安装依赖

```bash
npm install
```

Rust 依赖会在首次运行 `tauri dev` 时由 Cargo 自动拉取，无需手动操作。

### 2. 启动开发环境

```bash
npx tauri dev
```

此命令会：
1. 执行 `npm run dev` 启动 Vite 开发服务器（固定端口 **1420**）
2. 编译 Rust 后端（首次编译约需 1–3 分钟）
3. 打开 ClipMate 应用窗口

> `npm run dev` 只会启动 Vite 开发服务器，不会启动 Tauri 容器、数据库插件或窗口 API。日常开发和排查启动问题时，请始终使用 `npx tauri dev`。

### 3. 生产构建

```bash
npx tauri build
```

输出产物位于 `src-tauri/target/release/bundle/macos/ClipMate.app`。

---

## 使用说明

### 唤出 / 隐藏窗口

- **全局快捷键**：`Alt+]`（在任意应用中均可触发）
- 窗口为 macOS NSPanel，切换到其他应用后仍保持可见
- 唤出时会跟随当前鼠标所在屏幕，适配不同桌面、全屏页面和多显示器切换

### 管理模板

| 操作 | 方式 |
|------|------|
| 新建模板 | 点击标题栏 `+` 按钮 |
| 编辑模板 | 悬停卡片 → 点击编辑图标 |
| 删除模板 | 悬停卡片 → 点击删除图标 |
| 复制内容 | 点击卡片任意区域 |
| 调整顺序 | 长按卡片左侧拖拽手柄（80 ms）后拖动 |

### 标签筛选

- 在模板中添加标签后，左侧边栏自动出现对应筛选按钮
- 点击"全部"显示所有模板

### 视图切换

- 点击标题栏展开按钮，在**紧凑视图**（350px）和**展开视图**（580px）之间切换
- 展开视图显示最近使用区块和多行卡片预览

### 键盘快捷键

| 按键 | 效果 |
|------|------|
| `Alt+]` | 全局唤出 / 隐藏 |
| `Escape` | 关闭编辑弹窗，或隐藏主窗口 |

---

## 数据存储

数据库文件为 SQLite，路径：

```
~/Library/Application Support/com.ivor.clipmate/clipmate.db
```

包含两张表：

```sql
-- 模板内容
templates (id, title, content, tags TEXT DEFAULT '[]', use_count, last_used_at, created_at)

-- 应用设置（当前仅存储模板排序）
settings  (key TEXT PRIMARY KEY, value TEXT)
```

窗口位置存储在浏览器 `localStorage`，key 为 `clipmate-position`。

---

## 项目结构

```
clipboard/
├── src/
│   ├── App.jsx          # 全部前端逻辑（组件、状态、数据库交互）
│   └── App.css          # 深色玻璃态主题样式
├── src-tauri/
│   ├── src/
│   │   └── lib.rs       # Rust 后端（插件注册、NSPanel、全局快捷键）
│   ├── tauri.conf.json  # 窗口配置（尺寸、透明、置顶）
│   ├── capabilities/
│   │   └── default.json # Tauri 权限声明
│   └── Cargo.toml       # Rust 依赖
├── package.json
└── vite.config.js
```

---

## 部署

### 本机安装

执行构建后，产物位于：

```
src-tauri/target/release/bundle/
├── macos/ClipMate.app          # 直接拖入 /Applications 即可使用
└── dmg/ClipMate_0.1.0_aarch64.dmg  # 分发用安装包
```

**方式一：直接复制 .app**

```bash
cp -r src-tauri/target/release/bundle/macos/ClipMate.app /Applications/
```

**方式二：双击 .dmg 安装**

打开 `dmg/ClipMate_0.1.0_aarch64.dmg`，将 ClipMate 拖入 Applications 文件夹。

### 首次运行授权

macOS 默认会阻止未经公证的应用。有两种方式处理：

**方式 A（推荐，临时绕过）：**
```bash
xattr -cr /Applications/ClipMate.app
```

**方式 B（图形界面）：**
双击 .app 提示被阻止后，前往「系统设置 → 隐私与安全性」，点击「仍要打开」。

### 开机自动启动

1. 打开「系统设置 → 通用 → 登录项」
2. 点击 `+`，选择 `/Applications/ClipMate.app`

或使用命令行：

```bash
osascript -e 'tell application "System Events" to make login item at end with properties {path:"/Applications/ClipMate.app", hidden:true}'
```

### 辅助功能授权（全局快捷键必须）

首次启动后，前往「系统设置 → 隐私与安全性 → 辅助功能」，将 ClipMate 添加到允许列表，否则 `Alt+]` 全局快捷键无法响应。

---

## 常见问题

**Q: 首次 `npx tauri dev` 很慢？**
Rust 依赖首次编译需要时间，后续增量编译会快很多。

**Q: 快捷键 `Alt+]` 没有响应？**
检查系统"隐私与安全性 → 辅助功能"中是否已授权 ClipMate（或终端）。全局快捷键需要辅助功能权限。

**Q: 窗口透明效果异常？**
确认 macOS 系统偏好 → 辅助功能 → 显示 → 关闭"减少透明度"。

**Q: 如何重置所有数据？**
删除数据库文件后重启应用即可：
```bash
rm ~/Library/Application\ Support/com.ivor.clipmate/clipmate.db
```
