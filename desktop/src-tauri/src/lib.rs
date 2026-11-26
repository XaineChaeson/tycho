use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, State, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use url::Url;

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_ID: &str = "tycho-tray";
const MAX_RECENT_URLS: usize = 8;
const MIN_WINDOW_WIDTH: u32 = 900;
const MIN_WINDOW_HEIGHT: u32 = 600;
const MAX_WINDOW_WIDTH: u32 = 3840;
const MAX_WINDOW_HEIGHT: u32 = 2160;

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
}

impl AppState {
    fn new(config_path: PathBuf) -> Self {
        let config = load_config_from(&config_path);
        Self {
            config: Mutex::new(config),
            config_path,
            last_title: Mutex::new(String::new()),
            launcher_base_url: Mutex::new(default_launcher_base_url().to_string()),
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

fn open_external_url(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
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

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "打开 Tycho", true, None::<&str>)?;
    let switch_item = MenuItem::with_id(app, "switch", "切换服务器地址…", true, None::<&str>)?;
    let reload_item = MenuItem::with_id(app, "reload", "重新加载", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出 Tycho", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[&show_item, &switch_item, &reload_item, &separator, &quit_item],
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

    let mut builder = WebviewWindowBuilder::from_config(app, &win_cfg)?
        .on_navigation(move |target_url| {
            let server_url = nav_app.state::<AppState>().current_config().server_url;
            if is_allowed_in_app_url(target_url, server_url.as_deref()) {
                return true;
            }
            open_external_url(&nav_app, target_url);
            false
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
        .setup(|app| {
            let handle = app.handle();
            setup_tray(handle)?;
            setup_main_window(handle)?;
            setup_global_shortcut(handle);
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
}
