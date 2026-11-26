# Tycho Desktop

轻量级 **Tauri v2** 桌面薄壳应用，复用系统自带 WebView（Windows WebView2 / macOS WKWebView / Linux WebKitGTK），与 Tycho 服务端发布包完全隔离。

> 完整的多平台客户端分发（Windows Portable / Installer、macOS Universal DMG、Linux AppImage / deb、iOS & Android PWA）以及自动发版流程见 [docs/clients.md](../docs/clients.md)。

## 特性

- **零摩擦启动**：首次配置 Tycho 服务器地址后自动持久化至 `~/.tycho/desktop.json`，后续打开直接进入控制台。
- **本机一键连接**：内置「连接本机 (`http://127.0.0.1:8799`)」快捷入口与最近连接历史。
- **系统托盘 & 关闭最小化**：点击关闭按钮自动隐藏到托盘以保持后台 SSE 连接不断开；托盘左键一键切换显隐，右键支持：
  - `打开 Tycho`
  - `切换服务器地址…`
  - `重新加载`
  - `退出 Tycho`
- **全局快捷键**：`Alt + Shift + T` 一键呼出或隐藏窗口（若热键被其他软件占用会自动降级并忽略，不会影响启动）。
- **外部链接保护**：控制台内同源路由在应用内打开；GitHub / GitLab 等外链自动调用系统默认浏览器打开，避免离开控制台。
- **单实例保护**：重复启动时自动唤起已有窗口。
- **原生通知与托盘提示**：窗口在后台时监听页面标题告警变化并推送系统通知，托盘提示同步显示当前连接的服务器地址。

## 环境要求

- Rust (`rustc` / `cargo`) 1.77+
- Windows 10/11（系统内置 Microsoft Edge WebView2 Runtime）

## 开发与构建

### 1. 运行单元测试与类型检查

```powershell
cd D:\code\tycho\desktop\src-tauri
cargo test
cargo check
```

### 2. 开发模式运行

```powershell
cd D:\code\tycho\desktop\src-tauri
cargo run
```

### 3. 构建独立 Release 可执行文件（`.exe`）

```powershell
cd D:\code\tycho\desktop\src-tauri
cargo build --release
```

产物位于：

```text
desktop/src-tauri/target/release/tycho-desktop.exe
```

可直接复制该 `.exe` 到任意位置运行（无需额外运行库）。

## 配置文件说明

桌面端配置保存在用户主目录 `~/.tycho/desktop.json`：

```json
{
  "server_url": "https://your-tycho-server",
  "recent_urls": [
    "https://your-tycho-server",
    "http://127.0.0.1:8799"
  ],
  "width": 1360,
  "height": 860
}
```

## 常用快捷键与操作

| 操作 | 行为 |
| --- | --- |
| `Alt + Shift + T` | 全局呼出 / 隐藏 Tycho 窗口 |
| 点击窗口关闭 (`×`) | 隐藏到系统托盘，保持后台连接 |
| 左键点击系统托盘图标 | 切换显示 / 隐藏窗口 |
| 右键系统托盘图标 → `切换服务器地址…` | 返回启动器切换或管理服务器地址 |
