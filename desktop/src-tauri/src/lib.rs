mod updater;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, State, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use updater::{
    apply_update_and_prepare_exit, check_for_update, prepare_startup_after_update,
    DesktopUpdateInfo, CURRENT_VERSION,
};
use url::Url;

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_ID: &str = "tycho-tray";
const MAX_RECENT_URLS: usize = 8;
const MIN_WINDOW_WIDTH: u32 = 900;
const MIN_WINDOW_HEIGHT: u32 = 600;
const MAX_WINDOW_WIDTH: u32 = 3840;
const MAX_WINDOW_HEIGHT: u32 = 2160;

// WebView2 on Windows can silently swallow `<a target="_blank" rel="noopener noreferrer">` and
// programmatic `window.open(...)` popups in `NewWindowRequested`. Routing external links and
// external `window.open` calls through top-level navigation guarantees `on_navigation` intercepts
// them, launches the system browser off the UI callback thread, and cancels navigation so the SPA
// dialog stays intact. Also exposes desktop version + lightweight native update notification bar.
const DESKTOP_EXTERNAL_LINK_SCRIPT_TEMPLATE: &str = r#"(() => {
  if (window.__TYCHO_DESKTOP__) return;
  window.__TYCHO_DESKTOP__ = true;
  window.__TYCHO_DESKTOP_VERSION__ = "__CURRENT_VERSION__";
  const externalHref = (raw) => {
    try {
      const value = raw instanceof URL ? raw.href : typeof raw === 'string' ? raw : '';
      if (!value) return null;
      const parsed = new URL(value, window.location.href);
      if (parsed.protocol === 'tycho-desktop:') return null;
      if (parsed.protocol === 'mailto:') return parsed.href;
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      return parsed.origin !== window.location.origin ? parsed.href : null;
    } catch {
      return null;
    }
  };
  const openExternal = (href) => {
    window.location.assign(href);
  };
  const origOpen = typeof window.open === 'function' ? window.open.bind(window) : null;
  window.open = function(url, target, features) {
    const ext = externalHref(url);
    if (ext) {
      openExternal(ext);
      return null;
    }
    return origOpen ? origOpen(url, target, features) : null;
  };
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    const anchor = target && typeof target.closest === 'function' ? target.closest('a[href]') : null;
    if (!anchor) return;
    const ext = externalHref(anchor.getAttribute('href'));
    if (!ext) return;
    event.preventDefault();
    openExternal(ext);
  }, true);

  let dismissedVersion = null;
  window.__TYCHO_DESKTOP_SET_UPDATE__ = (state) => {
    const mount = () => {
      const existing = document.getElementById('tycho-desktop-update-bar');
      if (!state || !state.version || (state.status === 'available' && dismissedVersion === state.version)) {
        if (existing) existing.remove();
        return;
      }
      const bar = existing || document.createElement('div');
      bar.id = 'tycho-desktop-update-bar';
      bar.setAttribute('role', 'status');
      bar.style.cssText = 'position:fixed;top:10px;right:14px;z-index:2147483647;display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:10px;border:1px solid rgba(59,130,246,0.35);background:rgba(15,23,42,0.95);color:#f8fafc;font:12.5px/1.4 system-ui,-apple-system,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.28);backdrop-filter:blur(8px);max-width:440px;';
      bar.textContent = '';

      const text = document.createElement('span');
      text.style.cssText = 'flex:1;min-width:0;';
      if (state.status === 'installing') {
        text.textContent = `正在下载并校验桌面端 v${state.version}，完成后自动重启…`;
      } else if (state.status === 'error') {
        text.textContent = `桌面端更新失败：${state.message || '请稍后重试'}`;
      } else {
        text.textContent = `发现 Tycho 桌面端新版本 v${state.version}（当前 v${window.__TYCHO_DESKTOP_VERSION__}）`;
      }
      bar.appendChild(text);

      if (state.status !== 'installing') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = state.status === 'error' ? '重试更新' : '一键更新';
        btn.style.cssText = 'cursor:pointer;border:none;border-radius:7px;padding:4px 10px;background:#2563eb;color:#fff;font-weight:600;font-size:12px;white-space:nowrap;';
        btn.onclick = () => { window.location.assign('tycho-desktop://install-update'); };
        bar.appendChild(btn);

        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = '稍后';
        close.style.cssText = 'cursor:pointer;border:1px solid rgba(148,163,184,0.35);border-radius:7px;padding:4px 8px;background:transparent;color:#cbd5e1;font-size:12px;white-space:nowrap;';
        close.onclick = () => {
          dismissedVersion = state.version;
          bar.remove();
        };
        bar.appendChild(close);
      }

      if (!existing && document.body) {
        document.body.appendChild(bar);
      }
    };
    if (document.body) mount();
    else window.addEventListener('DOMContentLoaded', mount, { once: true });
  };
})();"#;

fn desktop_init_script() -> String {
    DESKTOP_EXTERNAL_LINK_SCRIPT_TEMPLATE.replace("__CURRENT_VERSION__", CURRENT_VERSION)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct DesktopConfig {
    pub server_url: Option<String>,
    #[serde(default)]
    pub recent_urls: Vec<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

impl DesktopConfig {
    pub fn record_connection(&mut self, normalized_url: &str) {
        let persisted = Url::parse(normalized_url)
            .ok()
            .filter(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some())
            .map(|u| server_origin_url(&u))
            .unwrap_or_else(|| normalized_url.to_string());
        self.server_url = Some(persisted.clone());
        self.recent_urls.retain(|u| u != &persisted);
        self.recent_urls.insert(0, persisted);
        self.recent_urls.truncate(MAX_RECENT_URLS);
    }

    pub fn remove_recent(&mut self, url: &str) {
        self.recent_urls.retain(|u| u != url);
    }

    pub fn sanitized_dimensions(&self) -> Option<(u32, u32)> {
        match (self.width, self.height) {
            (Some(w), Some(h)) => Some((
                w.clamp(MIN_WINDOW_WIDTH, MAX_WINDOW_WIDTH),
                h.clamp(MIN_WINDOW_HEIGHT, MAX_WINDOW_HEIGHT),
            )),
            _ => None,
        }
    }
}

pub struct AppState {
    config: Mutex<DesktopConfig>,
    config_path: PathBuf,
    last_title: Mutex<String>,
    launcher_base_url: Mutex<String>,
    available_update: Mutex<Option<DesktopUpdateInfo>>,
    updating: AtomicBool,
    update_menu_item: Mutex<Option<MenuItem<tauri::Wry>>>,
}

impl AppState {
    fn new(config_path: PathBuf) -> Self {
        let config = load_config_from(&config_path);
        Self {
            config: Mutex::new(config),
            config_path,
            last_title: Mutex::new(String::new()),
            launcher_base_url: Mutex::new(default_launcher_base_url().to_string()),
            available_update: Mutex::new(None),
            updating: AtomicBool::new(false),
            update_menu_item: Mutex::new(None),
        }
    }

    fn current_config(&self) -> DesktopConfig {
        self.config
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    fn save_current_config(&self) -> Result<(), String> {
        let snapshot = self.current_config();
        save_config_to(&self.config_path, &snapshot)
    }

    fn update_window_dimensions(&self, width: u32, height: u32) {
        if width < MIN_WINDOW_WIDTH || height < MIN_WINDOW_HEIGHT {
            return;
        }
        if let Ok(mut guard) = self.config.lock() {
            guard.width = Some(width.clamp(MIN_WINDOW_WIDTH, MAX_WINDOW_WIDTH));
            guard.height = Some(height.clamp(MIN_WINDOW_HEIGHT, MAX_WINDOW_HEIGHT));
        }
    }
}

pub fn default_config_path() -> PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".tycho").join("desktop.json")
}

pub fn load_config_from(path: &Path) -> DesktopConfig {
    let Ok(contents) = fs::read_to_string(path) else {
        return DesktopConfig::default();
    };
    serde_json::from_str::<DesktopConfig>(&contents).unwrap_or_default()
}

pub fn save_config_to(path: &Path, config: &DesktopConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("无法创建配置目录 {}: {err}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(config)
        .map_err(|err| format!("序列化配置失败: {err}"))?;
    fs::write(path, json).map_err(|err| format!("写入配置文件失败: {err}"))
}

pub fn server_origin_url(url: &Url) -> String {
    url.origin().ascii_serialization()
}

pub fn normalize_server_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("请输入服务器地址".to_string());
    }

    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else if trimmed.starts_with("localhost")
        || trimmed.starts_with("127.0.0.1")
        || trimmed.starts_with("[::1]")
    {
        format!("http://{trimmed}")
    } else {
        format!("https://{trimmed}")
    };

    let parsed = Url::parse(&candidate).map_err(|_| "服务器地址格式无效，请检查后重试".to_string())?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("仅支持 http:// 或 https:// 协议地址".to_string()),
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("服务器地址不允许包含用户名或密码".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("服务器地址缺少主机名".to_string());
    }

    let mut normalized = parsed.to_string();
    if parsed.path() == "/" && parsed.query().is_none() && parsed.fragment().is_none() {
        while normalized.ends_with('/') {
            normalized.pop();
        }
    }
    Ok(normalized)
}

pub fn resolve_server_target(raw: &str) -> Result<(Url, String), String> {
    let normalized = normalize_server_url(raw)?;
    let parsed = Url::parse(&normalized).map_err(|err| format!("无法解析服务器地址: {err}"))?;
    let origin = server_origin_url(&parsed);
    Ok((parsed, origin))
}

pub fn is_launcher_url(url: &Url) -> bool {
    if url.scheme() == "tauri" || url.scheme() == "about" {
        return true;
    }
    matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost")
}

pub fn is_same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

pub fn is_allowed_in_app_url(target: &Url, configured_server_url: Option<&str>) -> bool {
    if is_launcher_url(target) {
        return true;
    }
    if !matches!(target.scheme(), "http" | "https") {
        return false;
    }
    let Some(server_str) = configured_server_url else {
        return false;
    };
    let Ok(server_url) = Url::parse(server_str) else {
        return false;
    };
    is_same_origin(target, &server_url)
}

pub fn format_tray_tooltip(server_url: Option<&str>, page_title: Option<&str>) -> String {
    let host_label = server_url
        .and_then(|s| Url::parse(s).ok())
        .and_then(|u| match (u.host_str(), u.port()) {
            (Some(host), Some(port)) => Some(format!("{host}:{port}")),
            (Some(host), None) => Some(host.to_string()),
            _ => None,
        });

    let clean_title = page_title
        .map(str::trim)
        .filter(|t| !t.is_empty() && *t != "Tycho" && *t != "Tycho Desktop");

    match (host_label, clean_title) {
        (Some(host), Some(title)) => format!("Tycho ({host}) — {title}"),
        (Some(host), None) => format!("Tycho — {host}"),
        (None, Some(title)) => format!("Tycho — {title}"),
        (None, None) => "Tycho".to_string(),
    }
}

pub fn should_notify_for_title_change(prev_title: &str, next_title: &str) -> bool {
    let next = next_title.trim();
    if next.is_empty() || next == prev_title.trim() {
        return false;
    }
    if matches!(next, "Tycho" | "Tycho Desktop" | "about:blank") {
        return false;
    }
    if next.starts_with('(')
        || next.starts_with('[')
        || next.starts_with('●')
        || next.starts_with('🔔')
    {
        return true;
    }
    let lower = next.to_lowercase();
    let keywords = [
        "等待审批",
        "待审批",
        "需要确认",
        "任务失败",
        "执行失败",
        "已完成",
        "approval",
        "attention",
        "failed",
    ];
    keywords.iter().any(|kw| lower.contains(kw))
}

fn default_launcher_base_url() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "http://tauri.localhost/"
    }
    #[cfg(not(target_os = "windows"))]
    {
        "tauri://localhost/"
    }
}

fn build_switcher_url(base: &str) -> Result<Url, String> {
    let mut url = Url::parse(base)
        .or_else(|_| Url::parse(default_launcher_base_url()))
        .map_err(|err| format!("构造切换页地址失败: {err}"))?;
    url.set_path("/index.html");
    url.set_query(Some("switch=1"));
    url.set_fragment(None);
    Ok(url)
}

fn show_and_focus_window(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn toggle_window_from_hotkey(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let visible = window.is_visible().unwrap_or(false);
        let minimized = window.is_minimized().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        if visible && !minimized && focused {
            let _ = window.hide();
        } else {
            show_and_focus_window(&window);
        }
    }
}

fn toggle_window_from_tray(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let visible = window.is_visible().unwrap_or(false);
        let minimized = window.is_minimized().unwrap_or(false);
        if visible && !minimized {
            let _ = window.hide();
        } else {
            show_and_focus_window(&window);
        }
    }
}

fn refresh_tray_tooltip(app: &AppHandle) {
    let state = app.state::<AppState>();
    let server_url = state.current_config().server_url;
    let title = state
        .last_title
        .lock()
        .map(|t| t.clone())
        .unwrap_or_default();
    let tooltip = format_tray_tooltip(server_url.as_deref(), Some(&title));
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(&tooltip));
    }
}

fn is_external_openable_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

fn open_external_url(app: &AppHandle, url: &Url) {
    if !is_external_openable_url(url) {
        return;
    }
    // Spawn off the WebView navigation/new-window COM callback thread so ShellExecuteW on Windows
    // never blocks or fails inside WebView2's synchronous event handler.
    let handle = app.clone();
    let target = url.as_str().to_string();
    std::thread::spawn(move || {
        if let Err(err) = handle.opener().open_url(&target, None::<&str>) {
            eprintln!("[tycho-desktop] Warning: failed to open external URL {target}: {err}");
        }
    });
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> DesktopConfig {
    state.current_config()
}

#[tauri::command]
fn connect_server(
    url: String,
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<DesktopConfig, String> {
    let (parsed, origin) = resolve_server_target(&url)?;

    let updated = {
        let mut guard = state
            .config
            .lock()
            .map_err(|_| "内部配置状态锁定失败".to_string())?;
        guard.record_connection(&origin);
        guard.clone()
    };

    save_config_to(&state.config_path, &updated)?;
    refresh_tray_tooltip(&app);

    window
        .navigate(parsed)
        .map_err(|err| format!("页面跳转失败: {err}"))?;

    Ok(updated)
}

#[tauri::command]
fn remove_recent_url(url: String, state: State<'_, AppState>) -> Result<DesktopConfig, String> {
    let updated = {
        let mut guard = state
            .config
            .lock()
            .map_err(|_| "内部配置状态锁定失败".to_string())?;
        guard.remove_recent(&url);
        guard.clone()
    };
    save_config_to(&state.config_path, &updated)?;
    Ok(updated)
}

fn set_update_menu_label(app: &AppHandle, label: &str) {
    if let Ok(guard) = app.state::<AppState>().update_menu_item.lock() {
        if let Some(item) = guard.as_ref() {
            let _ = item.set_text(label);
        }
    }
}

fn push_update_ui(app: &AppHandle, payload: serde_json::Value) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Ok(json) = serde_json::to_string(&payload) {
            let script = format!(
                "window.__TYCHO_DESKTOP_SET_UPDATE__ && window.__TYCHO_DESKTOP_SET_UPDATE__({json});"
            );
            let _ = window.eval(&script);
        }
    }
}

fn notify_user(app: &AppHandle, body: &str) {
    let _ = app
        .notification()
        .builder()
        .title("Tycho")
        .body(body)
        .show();
}

fn trigger_check_update(app: &AppHandle, manual: bool) {
    let handle = app.clone();
    let server_url = app.state::<AppState>().current_config().server_url;
    std::thread::spawn(move || match check_for_update(server_url.as_deref()) {
        Ok(Some(info)) => {
            if let Ok(mut guard) = handle.state::<AppState>().available_update.lock() {
                *guard = Some(info.clone());
            }
            set_update_menu_label(&handle, &format!("立即更新桌面端到 v{}", info.version));
            push_update_ui(
                &handle,
                serde_json::json!({
                    "status": "available",
                    "version": info.version,
                    "source": info.source,
                }),
            );
            notify_user(
                &handle,
                &format!(
                    "发现 Tycho 桌面端新版本 v{}，可在托盘菜单或右上角提示栏一键更新",
                    info.version
                ),
            );
        }
        Ok(None) => {
            if manual {
                notify_user(
                    &handle,
                    &format!("Tycho 桌面端 v{CURRENT_VERSION} 已是最新版本"),
                );
            }
        }
        Err(err) => {
            if manual {
                notify_user(&handle, &format!("检查桌面端更新失败：{err}"));
            }
        }
    });
}

fn trigger_install_update(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.updating.swap(true, Ordering::SeqCst) {
        return;
    }
    let maybe_info = state
        .available_update
        .lock()
        .ok()
        .and_then(|guard| guard.clone());
    let Some(info) = maybe_info else {
        state.updating.store(false, Ordering::SeqCst);
        trigger_check_update(app, true);
        return;
    };

    set_update_menu_label(app, &format!("正在更新到 v{}…", info.version));
    push_update_ui(
        app,
        serde_json::json!({
            "status": "installing",
            "version": info.version,
        }),
    );

    let handle = app.clone();
    std::thread::spawn(move || match apply_update_and_prepare_exit(&info) {
        Ok(should_exit) => {
            if should_exit {
                let _ = handle.state::<AppState>().save_current_config();
                if let Some(win) = handle.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ = win.destroy();
                }
                handle.exit(0);
                // Safety net: ensure the old process always terminates promptly so the newly
                // spawned binary wakes from WaitForSingleObject and acquires the single-instance lock.
                std::thread::sleep(Duration::from_secs(2));
                std::process::exit(0);
            } else {
                handle.state::<AppState>().updating.store(false, Ordering::SeqCst);
                set_update_menu_label(&handle, &format!("立即更新桌面端到 v{}", info.version));
                notify_user(&handle, &format!("已下载桌面端 v{}，请完成安装", info.version));
            }
        }
        Err(err) => {
            handle.state::<AppState>().updating.store(false, Ordering::SeqCst);
            set_update_menu_label(&handle, &format!("立即更新桌面端到 v{}", info.version));
            push_update_ui(
                &handle,
                serde_json::json!({
                    "status": "error",
                    "version": info.version,
                    "message": err,
                }),
            );
            notify_user(&handle, &format!("桌面端更新失败：{err}"));
        }
    });
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "打开 Tycho", true, None::<&str>)?;
    let switch_item = MenuItem::with_id(app, "switch", "切换服务器地址…", true, None::<&str>)?;
    let reload_item = MenuItem::with_id(app, "reload", "重新加载", true, None::<&str>)?;
    let update_item = MenuItem::with_id(
        app,
        "check_update",
        format!("检查桌面端更新 (v{CURRENT_VERSION})…"),
        true,
        None::<&str>,
    )?;
    if let Ok(mut guard) = app.state::<AppState>().update_menu_item.lock() {
        *guard = Some(update_item.clone());
    }
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出 Tycho", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &switch_item,
            &reload_item,
            &update_item,
            &separator,
            &quit_item,
        ],
    )?;

    let tray_icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .or_else(|_| {
            app.default_window_icon()
                .cloned()
                .ok_or_else(|| tauri::Error::AssetNotFound("default tray icon".into()))
        })?;

    let state = app.state::<AppState>();
    let initial_tooltip = format_tray_tooltip(state.current_config().server_url.as_deref(), None);

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_icon)
        .tooltip(&initial_tooltip)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    show_and_focus_window(&window);
                }
            }
            "switch" => {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let base = app
                        .state::<AppState>()
                        .launcher_base_url
                        .lock()
                        .map(|s| s.clone())
                        .unwrap_or_else(|_| default_launcher_base_url().to_string());
                    if let Ok(switcher_url) = build_switcher_url(&base) {
                        let _ = window.navigate(switcher_url);
                    }
                    show_and_focus_window(&window);
                }
            }
            "reload" => {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ = window.reload();
                }
            }
            "check_update" => {
                let has_update = app
                    .state::<AppState>()
                    .available_update
                    .lock()
                    .ok()
                    .and_then(|g| g.clone())
                    .is_some();
                if has_update {
                    trigger_install_update(app);
                } else {
                    trigger_check_update(app, true);
                }
            }
            "quit" => {
                let _ = app.state::<AppState>().save_current_config();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window_from_tray(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn setup_global_shortcut(app: &AppHandle) {
    let shortcut = Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyT);
    if let Err(err) = app
        .global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                toggle_window_from_hotkey(app);
            }
        })
    {
        eprintln!("[tycho-desktop] Warning: failed to register Alt+Shift+T shortcut: {err}");
    }
}

fn setup_main_window(app: &AppHandle) -> tauri::Result<()> {
    let win_cfg = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| tauri::Error::InvalidWebviewUrl("missing main window config"))?;

    let saved_dims = app.state::<AppState>().current_config().sanitized_dimensions();

    let nav_app = app.clone();
    let new_win_app = app.clone();
    let title_app = app.clone();
    let load_app = app.clone();

    let mut builder = WebviewWindowBuilder::from_config(app, &win_cfg)?
        .initialization_script(&desktop_init_script())
        .on_navigation(move |target_url| {
            let server_url = nav_app.state::<AppState>().current_config().server_url;
            if target_url.scheme() == "tycho-desktop" {
                let trusted_caller = nav_app
                    .get_webview_window(MAIN_WINDOW_LABEL)
                    .and_then(|win| win.url().ok())
                    .is_some_and(|current| is_allowed_in_app_url(&current, server_url.as_deref()));
                if trusted_caller {
                    match target_url.host_str() {
                        Some("install-update") => trigger_install_update(&nav_app),
                        Some("check-update") => trigger_check_update(&nav_app, true),
                        _ => {}
                    }
                }
                return false;
            }
            if is_allowed_in_app_url(target_url, server_url.as_deref()) {
                return true;
            }
            open_external_url(&nav_app, target_url);
            false
        })
        .on_page_load(move |_window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let maybe_info = load_app
                    .state::<AppState>()
                    .available_update
                    .lock()
                    .ok()
                    .and_then(|g| g.clone());
                if let Some(info) = maybe_info {
                    let status = if load_app.state::<AppState>().updating.load(Ordering::SeqCst) {
                        "installing"
                    } else {
                        "available"
                    };
                    push_update_ui(
                        &load_app,
                        serde_json::json!({
                            "status": status,
                            "version": info.version,
                            "source": info.source,
                        }),
                    );
                }
            }
        })
        .on_new_window(move |target_url, _features| {
            let server_url = new_win_app.state::<AppState>().current_config().server_url;
            if is_allowed_in_app_url(&target_url, server_url.as_deref()) {
                if let Some(window) = new_win_app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ = window.navigate(target_url);
                }
            } else {
                open_external_url(&new_win_app, &target_url);
            }
            NewWindowResponse::Deny
        })
        .on_document_title_changed(move |window, next_title| {
            let trimmed = next_title.trim();
            let display_title = if trimmed.is_empty() { "Tycho" } else { trimmed };
            let _ = window.set_title(display_title);

            let prev_title = {
                let state = title_app.state::<AppState>();
                let mut guard = match state.last_title.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                let prev = guard.clone();
                *guard = trimmed.to_string();
                prev
            };

            refresh_tray_tooltip(&title_app);

            let is_visible = window.is_visible().unwrap_or(false);
            let is_focused = window.is_focused().unwrap_or(false);
            if (!is_visible || !is_focused)
                && should_notify_for_title_change(&prev_title, trimmed)
            {
                let _ = title_app
                    .notification()
                    .builder()
                    .title("Tycho")
                    .body(trimmed)
                    .show();
            }
        });

    if let Some((width, height)) = saved_dims {
        builder = builder.inner_size(width as f64, height as f64);
    }

    let window = builder.build()?;

    if let Ok(initial_url) = window.url() {
        if is_launcher_url(&initial_url) {
            if let Ok(mut guard) = app.state::<AppState>().launcher_base_url.lock() {
                *guard = initial_url.to_string();
            }
        }
    }

    let event_window = window.clone();
    let event_app = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(physical_size) => {
            if event_window.is_minimized().unwrap_or(false) {
                return;
            }
            let scale = event_window.scale_factor().unwrap_or(1.0);
            let logical = physical_size.to_logical::<u32>(scale);
            event_app
                .state::<AppState>()
                .update_window_dimensions(logical.width, logical.height);
        }
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = event_app.state::<AppState>().save_current_config();
            let _ = event_window.hide();
        }
        _ => {}
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let updated_from = prepare_startup_after_update();
    let app_state = AppState::new(default_config_path());

    tauri::Builder::default()
        .manage(app_state)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                show_and_focus_window(&window);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_config,
            connect_server,
            remove_recent_url
        ])
        .setup(move |app| {
            let handle = app.handle();
            setup_tray(handle)?;
            setup_main_window(handle)?;
            setup_global_shortcut(handle);
            if let Some(prev_version) = updated_from.clone() {
                notify_user(
                    handle,
                    &format!("Tycho 桌面端已从 v{prev_version} 自动更新到 v{CURRENT_VERSION}"),
                );
            }
            let startup_handle = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(4));
                trigger_check_update(&startup_handle, false);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Tycho desktop application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_server_url_accepts_valid_inputs() {
        assert_eq!(
            normalize_server_url("https://tycho.example.com/").unwrap(),
            "https://tycho.example.com"
        );
        assert_eq!(
            normalize_server_url("http://127.0.0.1:8799/").unwrap(),
            "http://127.0.0.1:8799"
        );
        assert_eq!(
            normalize_server_url("127.0.0.1:8799").unwrap(),
            "http://127.0.0.1:8799"
        );
        assert_eq!(
            normalize_server_url("localhost:8799").unwrap(),
            "http://localhost:8799"
        );
        assert_eq!(
            normalize_server_url("tycho.example.com").unwrap(),
            "https://tycho.example.com"
        );
        assert_eq!(
            normalize_server_url("https://tycho.example.com/console").unwrap(),
            "https://tycho.example.com/console"
        );
    }

    #[test]
    fn normalize_server_url_rejects_invalid_inputs() {
        assert!(normalize_server_url("").is_err());
        assert!(normalize_server_url("   ").is_err());
        assert!(normalize_server_url("ftp://example.com").is_err());
        assert!(normalize_server_url("javascript:alert(1)").is_err());
        assert!(normalize_server_url("https://user:pass@tycho.example.com").is_err());
        assert!(normalize_server_url("https://user@tycho.example.com").is_err());
        assert!(normalize_server_url("http://:secret@127.0.0.1:8787").is_err());
    }

    #[test]
    fn resolve_server_target_preserves_navigation_url_but_strips_secret_when_recording() {
        let (nav_url, origin) =
            resolve_server_target("https://tycho.example.com:8443/login#secret-token-123?foo=bar")
                .unwrap();
        assert_eq!(
            nav_url.as_str(),
            "https://tycho.example.com:8443/login#secret-token-123?foo=bar"
        );
        assert_eq!(origin, "https://tycho.example.com:8443");

        let (local_nav, local_origin) =
            resolve_server_target("http://127.0.0.1:8787/login#deadbeef").unwrap();
        assert_eq!(local_nav.as_str(), "http://127.0.0.1:8787/login#deadbeef");
        assert_eq!(local_origin, "http://127.0.0.1:8787");

        let (_, ipv6_origin) = resolve_server_target("http://[::1]:8787/login#tok").unwrap();
        assert_eq!(ipv6_origin, "http://[::1]:8787");

        let (_, default_port_origin) =
            resolve_server_target("https://tycho.example.com:443/login#tok").unwrap();
        assert_eq!(default_port_origin, "https://tycho.example.com");

        let mut cfg = DesktopConfig::default();
        cfg.record_connection("https://tycho.example.com:8443/login#secret-token-123");
        assert_eq!(
            cfg.server_url.as_deref(),
            Some("https://tycho.example.com:8443")
        );
        assert_eq!(
            cfg.recent_urls,
            vec!["https://tycho.example.com:8443".to_string()]
        );
    }

    #[test]
    fn origin_matching_allows_launcher_and_configured_server_only() {
        let server = Some("https://tycho.example.com:8443/app");

        assert!(is_allowed_in_app_url(
            &Url::parse("http://tauri.localhost/index.html?switch=1").unwrap(),
            server
        ));
        assert!(is_allowed_in_app_url(
            &Url::parse("tauri://localhost/").unwrap(),
            server
        ));
        assert!(is_allowed_in_app_url(
            &Url::parse("https://tycho.example.com:8443/tasks/123").unwrap(),
            server
        ));

        // External origins or mismatched scheme/port must be blocked (opened in OS browser)
        assert!(!is_allowed_in_app_url(
            &Url::parse("https://github.com/org/repo/pull/1").unwrap(),
            server
        ));
        assert!(!is_allowed_in_app_url(
            &Url::parse("https://tycho.example.com/tasks/123").unwrap(),
            server
        ));
        assert!(!is_allowed_in_app_url(
            &Url::parse("http://tycho.example.com:8443/tasks/123").unwrap(),
            server
        ));
        assert!(!is_allowed_in_app_url(
            &Url::parse("https://tycho.example.com:8443/tasks/123").unwrap(),
            None
        ));
    }

    #[test]
    fn origin_matching_treats_explicit_default_port_as_same_origin() {
        let server = Some("https://tycho.example.com");
        assert!(is_allowed_in_app_url(
            &Url::parse("https://tycho.example.com:443/tasks").unwrap(),
            server
        ));
    }

    #[test]
    fn config_records_and_deduplicates_recent_urls() {
        let mut cfg = DesktopConfig::default();
        for i in 1..=10 {
            cfg.record_connection(&format!("https://s{i}.example.com"));
        }
        assert_eq!(cfg.recent_urls.len(), MAX_RECENT_URLS);
        assert_eq!(cfg.recent_urls[0], "https://s10.example.com");
        assert_eq!(cfg.server_url.as_deref(), Some("https://s10.example.com"));

        cfg.record_connection("https://s5.example.com");
        assert_eq!(cfg.recent_urls[0], "https://s5.example.com");
        assert_eq!(
            cfg.recent_urls
                .iter()
                .filter(|u| *u == "https://s5.example.com")
                .count(),
            1
        );

        cfg.remove_recent("https://s5.example.com");
        assert!(!cfg.recent_urls.contains(&"https://s5.example.com".to_string()));
    }

    #[test]
    fn config_round_trip_persistence() {
        let temp_dir = std::env::temp_dir().join(format!(
            "tycho-desktop-test-{}",
            std::process::id()
        ));
        let path = temp_dir.join("desktop.json");
        let mut cfg = DesktopConfig {
            server_url: Some("http://127.0.0.1:8799".to_string()),
            recent_urls: vec!["http://127.0.0.1:8799".to_string()],
            width: Some(1440),
            height: Some(900),
        };
        save_config_to(&path, &cfg).unwrap();
        let loaded = load_config_from(&path);
        assert_eq!(loaded, cfg);

        cfg.width = Some(200);
        cfg.height = Some(100);
        assert_eq!(cfg.sanitized_dimensions(), Some((MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn title_notification_filter_matches_actionable_titles() {
        assert!(!should_notify_for_title_change("", "Tycho"));
        assert!(!should_notify_for_title_change("(2) Tycho", "(2) Tycho"));
        assert!(should_notify_for_title_change("Tycho", "(1) Tycho"));
        assert!(should_notify_for_title_change("Tycho", "🔔 任务等待审批 - Tycho"));
        assert!(should_notify_for_title_change("Tycho", "任务执行失败 · Tycho"));
        assert!(!should_notify_for_title_change("Tycho", "Dashboard · Tycho"));
    }

    #[test]
    fn tray_tooltip_formats_cleanly() {
        assert_eq!(format_tray_tooltip(None, None), "Tycho");
        assert_eq!(
            format_tray_tooltip(Some("http://127.0.0.1:8799"), None),
            "Tycho — 127.0.0.1:8799"
        );
        assert_eq!(
            format_tray_tooltip(Some("https://tycho.example.com"), Some("(2) 待审批")),
            "Tycho (tycho.example.com) — (2) 待审批"
        );
    }

    #[test]
    fn external_url_policy_and_desktop_script_cover_login_links() {
        assert!(is_external_openable_url(
            &Url::parse("https://auth.openai.com/codex/device").unwrap()
        ));
        assert!(is_external_openable_url(
            &Url::parse("http://example.com").unwrap()
        ));
        assert!(is_external_openable_url(
            &Url::parse("mailto:owner@example.com").unwrap()
        ));
        assert!(!is_external_openable_url(
            &Url::parse("javascript:alert(1)").unwrap()
        ));
        assert!(!is_external_openable_url(
            &Url::parse("file:///C:/Windows/System32/calc.exe").unwrap()
        ));
        let init_script = desktop_init_script();
        assert!(init_script.contains("__TYCHO_DESKTOP__"));
        assert!(init_script.contains("window.location.assign"));
        assert!(init_script.contains("__TYCHO_DESKTOP_SET_UPDATE__"));
        assert!(init_script.contains(CURRENT_VERSION));
    }
}
