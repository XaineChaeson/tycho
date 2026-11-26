use reqwest::blocking::Client;
use reqwest::redirect::Policy as RedirectPolicy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
#[cfg(target_os = "linux")]
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const DEFAULT_GITHUB_REPO: &str = "XaineChaeson/tycho";
const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
const GITHUB_RELEASES_PER_PAGE: usize = 50;
const GITHUB_RELEASES_MAX_PAGES: usize = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DesktopUpdateInfo {
    pub version: String,
    pub download_url: String,
    pub sha256: String,
    pub filename: String,
    pub source: String,
    pub installer_url: Option<String>,
    pub installer_sha256: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HostArtifact {
    pub filename: String,
    pub sha256: String,
    pub url: String,
    #[serde(default)]
    pub installer_url: Option<String>,
    #[serde(default)]
    pub installer_sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HostLatestManifest {
    pub version: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub artifact: Option<HostArtifact>,
    #[serde(default)]
    pub platforms: HashMap<String, HostArtifact>,
}

#[derive(Debug, Deserialize)]
pub struct GithubAsset {
    pub name: String,
    pub browser_download_url: String,
}

#[derive(Debug, Deserialize)]
pub struct GithubRelease {
    pub tag_name: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub assets: Vec<GithubAsset>,
}

pub fn platform_query_parts() -> (&'static str, &'static str, &'static str) {
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        ("windows", "arm64", "windows-arm64")
    }
    #[cfg(all(target_os = "windows", not(target_arch = "aarch64")))]
    {
        ("windows", "x64", "windows-x64")
    }
    #[cfg(target_os = "macos")]
    {
        ("macos", "universal", "macos-universal")
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        ("linux", "aarch64", "linux-aarch64")
    }
    #[cfg(all(target_os = "linux", not(target_arch = "aarch64")))]
    {
        ("linux", "x86_64", "linux-x86_64")
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        ("unknown", "unknown", "unknown")
    }
}

pub fn github_repo_slug() -> String {
    if let Ok(custom) = std::env::var("TYCHO_GITHUB_REPO") {
        let trimmed = custom.trim().trim_matches('/');
        if is_valid_github_slug(trimmed) {
            return trimmed.to_string();
        }
    }
    if let Some(slug) = env!("CARGO_PKG_REPOSITORY")
        .strip_prefix("https://github.com/")
        .map(|s| s.trim_end_matches(".git").trim_matches('/'))
        .filter(|s| is_valid_github_slug(s))
    {
        return slug.to_string();
    }
    DEFAULT_GITHUB_REPO.to_string()
}

fn is_valid_github_slug(slug: &str) -> bool {
    let mut parts = slug.split('/');
    let Some(owner) = parts.next() else { return false };
    let Some(repo) = parts.next() else { return false };
    if parts.next().is_some() || owner.is_empty() || repo.is_empty() {
        return false;
    }
    let valid_part = |p: &str| {
        p.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    valid_part(owner) && valid_part(repo)
}

pub fn is_valid_sha256(raw: &str) -> bool {
    raw.len() == 64 && raw.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn is_safe_artifact_filename(name: &str) -> bool {
    if name.is_empty() || name.len() > 160 || name.contains("..") {
        return false;
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".exe")
        || lower.ends_with(".dmg")
        || lower.ends_with(".appimage")
        || lower.ends_with(".deb")
}

pub fn parse_semver(raw: &str) -> Option<(u64, u64, u64)> {
    let trimmed = raw
        .trim()
        .strip_prefix("app-v")
        .or_else(|| raw.trim().strip_prefix('v'))
        .unwrap_or(raw.trim());
    if trimmed.is_empty() || trimmed.len() > 64 || trimmed.contains("..") {
        return None;
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
    {
        return None;
    }
    let core = trimmed.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    let patch = parts.next()?.parse::<u64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

pub fn is_newer_version(candidate: &str, current: &str) -> bool {
    match (parse_semver(candidate), parse_semver(current)) {
        (Some(c), Some(cur)) => c > cur,
        _ => false,
    }
}

pub fn parse_sha256sums(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut iter = trimmed.split_whitespace();
        let Some(hash) = iter.next() else { continue };
        let Some(name_raw) = iter.next() else { continue };
        if !is_valid_sha256(hash) {
            continue;
        }
        let name = name_raw.trim_start_matches('*');
        if !name.is_empty() {
            map.insert(name.to_string(), hash.to_ascii_lowercase());
        }
    }
    map
}

// Resolve a host-manifest artifact URL while enforcing same-origin with the connected Tycho host
// (no cross-origin redirects, no protocol-relative host swaps, and no HTTPS -> HTTP downgrade).
fn resolve_same_origin_url(base: &str, path_or_url: &str) -> Option<String> {
    let base_url = Url::parse(base).ok()?;
    if !matches!(base_url.scheme(), "http" | "https") {
        return None;
    }
    let trimmed = path_or_url.trim();
    if trimmed.is_empty() || trimmed.starts_with("//") {
        return None;
    }
    let resolved = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        Url::parse(trimmed).ok()?
    } else {
        base_url.join(trimmed).ok()?
    };
    if !matches!(resolved.scheme(), "http" | "https") {
        return None;
    }
    if resolved.origin() != base_url.origin() {
        return None;
    }
    if !resolved.username().is_empty() || resolved.password().is_some() {
        return None;
    }
    Some(resolved.to_string())
}

pub fn resolve_host_update(
    manifest: &HostLatestManifest,
    current_version: &str,
    server_url: &str,
    platform_key: &str,
) -> Option<DesktopUpdateInfo> {
    let version = manifest.version.as_deref()?.trim();
    if !is_newer_version(version, current_version) {
        return None;
    }
    let artifact = manifest
        .artifact
        .as_ref()
        .or_else(|| manifest.platforms.get(platform_key))?;
    if !is_safe_artifact_filename(&artifact.filename) || !is_valid_sha256(&artifact.sha256) {
        return None;
    }
    let download_url = resolve_same_origin_url(server_url, &artifact.url)?;
    let (installer_url, installer_sha256) = match (
        artifact.installer_url.as_deref(),
        artifact.installer_sha256.as_deref(),
    ) {
        (Some(raw_url), Some(raw_sha)) if is_valid_sha256(raw_sha) => {
            match resolve_same_origin_url(server_url, raw_url) {
                Some(url) => (Some(url), Some(raw_sha.to_ascii_lowercase())),
                None => (None, None),
            }
        }
        _ => (None, None),
    };
    Some(DesktopUpdateInfo {
        version: version.to_string(),
        download_url,
        sha256: artifact.sha256.to_ascii_lowercase(),
        filename: artifact.filename.clone(),
        source: "host".to_string(),
        installer_url,
        installer_sha256,
        notes: manifest.notes.clone(),
    })
}

pub fn resolve_github_update<F>(
    releases: &[GithubRelease],
    current_version: &str,
    platform_key: &str,
    fetch_sums: F,
) -> Option<DesktopUpdateInfo>
where
    F: Fn(&str) -> Option<String>,
{
    let mut best: Option<(&GithubRelease, String)> = None;
    for rel in releases {
        if rel.draft || rel.prerelease {
            continue;
        }
        let Some(ver) = rel.tag_name.strip_prefix("app-v") else {
            continue;
        };
        if !is_newer_version(ver, current_version) {
            continue;
        }
        if best
            .as_ref()
            .is_none_or(|(_, best_ver)| is_newer_version(ver, best_ver))
        {
            best = Some((rel, ver.to_string()));
        }
    }
    let (release, version) = best?;
    let sums_asset = release
        .assets
        .iter()
        .find(|a| a.name.eq_ignore_ascii_case("SHA256SUMS.txt"))?;
    let sums_text = fetch_sums(&sums_asset.browser_download_url)?;
    let sums = parse_sha256sums(&sums_text);

    let (primary_suffix, installer_suffix): (&str, Option<&str>) = match platform_key {
        "windows-x64" => ("windows-x64-portable.exe", Some("windows-x64-setup.exe")),
        "windows-arm64" => ("windows-arm64-portable.exe", Some("windows-arm64-setup.exe")),
        "macos-universal" => ("macos-universal.dmg", None),
        "linux-x86_64" => ("linux-x86_64.AppImage", None),
        "linux-aarch64" => ("linux-aarch64.AppImage", None),
        _ => return None,
    };

    let primary = release
        .assets
        .iter()
        .find(|a| a.name.ends_with(primary_suffix) && is_safe_artifact_filename(&a.name))?;
    let sha256 = sums.get(&primary.name)?.clone();
    let installer = installer_suffix.and_then(|suf| {
        let asset = release
            .assets
            .iter()
            .find(|a| a.name.ends_with(suf) && is_safe_artifact_filename(&a.name))?;
        let hash = sums.get(&asset.name)?.clone();
        Some((asset.browser_download_url.clone(), hash))
    });

    Some(DesktopUpdateInfo {
        version,
        download_url: primary.browser_download_url.clone(),
        sha256,
        filename: primary.name.clone(),
        source: "github".to_string(),
        installer_url: installer.as_ref().map(|(u, _)| u.clone()),
        installer_sha256: installer.map(|(_, h)| h),
        notes: release.body.clone(),
    })
}

fn build_http_client(timeout_secs: u64) -> Result<Client, String> {
    let policy = RedirectPolicy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("重定向次数过多");
        }
        if let Some(prev) = attempt.previous().last() {
            if prev.scheme() == "https" && attempt.url().scheme() != "https" {
                return attempt.error("拒绝从 HTTPS 降级重定向到非加密地址");
            }
        }
        attempt.follow()
    });
    Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .redirect(policy)
        .user_agent(format!("tycho-desktop/{CURRENT_VERSION}"))
        .build()
        .map_err(|err| format!("创建网络客户端失败: {err}"))
}

pub fn check_for_update(server_url: Option<&str>) -> Result<Option<DesktopUpdateInfo>, String> {
    let (os, arch, platform_key) = platform_query_parts();
    let client = build_http_client(12)?;
    let mut host_checked_ok = false;

    if let Some(base) = server_url {
        let trimmed = base.trim_end_matches('/');
        let endpoint = format!("{trimmed}/api/desktop/latest?platform={os}&arch={arch}");
        if let Ok(resp) = client.get(&endpoint).send() {
            if resp.status().is_success() {
                if let Ok(manifest) = resp.json::<HostLatestManifest>() {
                    if manifest.version.is_some() {
                        host_checked_ok = true;
                    }
                    if let Some(info) =
                        resolve_host_update(&manifest, CURRENT_VERSION, trimmed, platform_key)
                    {
                        return Ok(Some(info));
                    }
                }
            }
        }
    }

    let slug = github_repo_slug();
    let mut all_releases: Vec<GithubRelease> = Vec::new();
    for page in 1..=GITHUB_RELEASES_MAX_PAGES {
        let url = format!(
            "https://api.github.com/repos/{slug}/releases?per_page={GITHUB_RELEASES_PER_PAGE}&page={page}"
        );
        let resp = match client
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .send()
        {
            Ok(r) => r,
            Err(err) => {
                if host_checked_ok {
                    return Ok(None);
                }
                return Err(format!("检查 GitHub 发布失败: {err}"));
            }
        };
        if !resp.status().is_success() {
            if host_checked_ok {
                return Ok(None);
            }
            return Err(format!(
                "检查 GitHub 发布失败（HTTP {}）",
                resp.status().as_u16()
            ));
        }
        let page_items: Vec<GithubRelease> = resp
            .json()
            .map_err(|err| format!("解析发布信息失败: {err}"))?;
        let count = page_items.len();
        let found_desktop_tag = page_items
            .iter()
            .any(|r| !r.draft && !r.prerelease && r.tag_name.starts_with("app-v"));
        all_releases.extend(page_items);
        if found_desktop_tag || count < GITHUB_RELEASES_PER_PAGE {
            break;
        }
    }

    Ok(resolve_github_update(
        &all_releases,
        CURRENT_VERSION,
        platform_key,
        |url| {
            client
                .get(url)
                .send()
                .ok()
                .filter(|r| r.status().is_success())
                .and_then(|r| r.text().ok())
        },
    ))
}

pub fn download_and_verify(url: &str, expected_sha256: &str, dest: &Path) -> Result<(), String> {
    if !is_valid_sha256(expected_sha256.trim()) {
        return Err("更新包校验和格式无效".to_string());
    }
    let client = build_http_client(180)?;
    let mut resp = client
        .get(url)
        .send()
        .map_err(|err| format!("下载更新包失败: {err}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载更新包失败（HTTP {}）", resp.status().as_u16()));
    }
    if let Some(len) = resp.content_length() {
        if len > MAX_DOWNLOAD_BYTES {
            return Err(format!("更新包体积异常（{len} 字节），已中止下载"));
        }
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("创建临时目录失败: {err}"))?;
    }
    let mut file = File::create(dest).map_err(|err| format!("写入更新包失败: {err}"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    let mut total: u64 = 0;
    loop {
        let n = resp
            .read(&mut buf)
            .map_err(|err| format!("读取更新包流失败: {err}"))?;
        if n == 0 {
            break;
        }
        total = total.saturating_add(n as u64);
        if total > MAX_DOWNLOAD_BYTES {
            drop(file);
            let _ = fs::remove_file(dest);
            return Err("更新包体积超出安全上限，已中止下载".to_string());
        }
        file.write_all(&buf[..n])
            .map_err(|err| format!("保存更新包失败: {err}"))?;
        hasher.update(&buf[..n]);
    }
    file.flush().map_err(|err| format!("刷新更新包失败: {err}"))?;
    drop(file);

    let actual = format_sha256_digest(&hasher.finalize());
    if !actual.eq_ignore_ascii_case(expected_sha256.trim()) {
        let _ = fs::remove_file(dest);
        return Err(format!(
            "更新包 SHA-256 校验失败（期望 {}，实际 {}）",
            expected_sha256.trim(),
            actual
        ));
    }
    Ok(())
}

fn format_sha256_digest(digest: &[u8]) -> String {
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn unique_nonce() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos:x}", std::process::id())
}

#[cfg(target_os = "windows")]
fn is_dir_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".tycho-update-probe-{}", unique_nonce()));
    match File::create(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

#[cfg(target_os = "windows")]
pub fn apply_update_and_prepare_exit(info: &DesktopUpdateInfo) -> Result<bool, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;

    let current_exe =
        std::env::current_exe().map_err(|err| format!("无法定位当前程序路径: {err}"))?;
    let exe_dir = current_exe
        .parent()
        .ok_or_else(|| "无法解析程序所在目录".to_string())?;
    let exe_name = current_exe
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("tycho-desktop.exe");
    let nonce = unique_nonce();

    if is_dir_writable(exe_dir) {
        let staged = exe_dir.join(format!("{exe_name}.{nonce}.new"));
        download_and_verify(&info.download_url, &info.sha256, &staged)?;

        let pid = std::process::id();
        let script_dir = exe_dir.join(format!(".tycho-update-{nonce}"));
        fs::create_dir_all(&script_dir)
            .map_err(|err| format!("创建更新脚本目录失败: {err}"))?;
        let script_path = script_dir.join("replace.ps1");
        let esc = |p: &Path| p.to_string_lossy().replace('\'', "''");
        let ps_script = format!(
            "$targetPid = {pid}\r\n\
             $staged = '{staged}'\r\n\
             $target = '{target}'\r\n\
             $scriptDir = '{script_dir}'\r\n\
             for ($i = 0; $i -lt 60; $i++) {{\r\n\
               if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) {{ break }}\r\n\
               Start-Sleep -Milliseconds 250\r\n\
             }}\r\n\
             $replaced = $false\r\n\
             for ($j = 0; $j -lt 24; $j++) {{\r\n\
               try {{\r\n\
                 Move-Item -LiteralPath $staged -Destination $target -Force -ErrorAction Stop\r\n\
                 $replaced = $true\r\n\
                 break\r\n\
               }} catch {{\r\n\
                 Start-Sleep -Milliseconds 250\r\n\
               }}\r\n\
             }}\r\n\
             if ($replaced -and (Test-Path -LiteralPath $target)) {{\r\n\
               Start-Process -FilePath $target\r\n\
             }} else {{\r\n\
               Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue\r\n\
             }}\r\n\
             Remove-Item -LiteralPath $scriptDir -Recurse -Force -ErrorAction SilentlyContinue\r\n",
            pid = pid,
            staged = esc(&staged),
            target = esc(&current_exe),
            script_dir = esc(&script_dir),
        );
        fs::write(&script_path, ps_script)
            .map_err(|err| format!("创建热更新脚本失败: {err}"))?;

        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                &script_path.to_string_lossy(),
            ])
            .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
            .spawn()
            .map_err(|err| format!("启动更新替换进程失败: {err}"))?;
        return Ok(true);
    }

    if let (Some(inst_url), Some(inst_sha)) = (&info.installer_url, &info.installer_sha256) {
        let stage_dir = std::env::temp_dir().join(format!("tycho-update-{nonce}"));
        let installer_path = stage_dir.join("tycho-setup.exe");
        download_and_verify(inst_url, inst_sha, &installer_path)?;
        Command::new(&installer_path)
            .arg("/S")
            .spawn()
            .map_err(|err| format!("启动静默安装程序失败: {err}"))?;
        return Ok(true);
    }

    Err(format!(
        "当前安装目录不可写（{}），且未找到安装程序，请手动下载新版覆盖安装",
        exe_dir.display()
    ))
}

#[cfg(target_os = "linux")]
pub fn apply_update_and_prepare_exit(info: &DesktopUpdateInfo) -> Result<bool, String> {
    use std::os::unix::fs::PermissionsExt;
    let target = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .ok_or_else(|| "当前不是 AppImage 运行模式，请通过包管理器或下载页升级".to_string())?;
    let parent = target
        .parent()
        .ok_or_else(|| "无法解析 AppImage 目录".to_string())?;
    let staged = parent.join(format!(".tycho-appimage-{}.new", std::process::id()));
    download_and_verify(&info.download_url, &info.sha256, &staged)?;
    fs::set_permissions(&staged, fs::Permissions::from_mode(0o755))
        .map_err(|err| format!("设置执行权限失败: {err}"))?;
    fs::rename(&staged, &target).map_err(|err| format!("替换 AppImage 失败: {err}"))?;
    Command::new(&target)
        .spawn()
        .map_err(|err| format!("重启新版失败: {err}"))?;
    Ok(true)
}

#[cfg(target_os = "macos")]
pub fn apply_update_and_prepare_exit(info: &DesktopUpdateInfo) -> Result<bool, String> {
    let stage_dir = std::env::temp_dir().join(format!("tycho-update-{}", unique_nonce()));
    let dest = stage_dir.join("Tycho-update.dmg");
    download_and_verify(&info.download_url, &info.sha256, &dest)?;
    Command::new("open")
        .arg(&dest)
        .spawn()
        .map_err(|err| format!("打开更新镜像失败: {err}"))?;
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_comparison_handles_multi_digit_components_and_rejects_traversal() {
        assert!(is_newer_version("0.2.1", "0.2.0"));
        assert!(is_newer_version("0.2.10", "0.2.9"));
        assert!(is_newer_version("app-v1.0.0", "0.9.9"));
        assert!(!is_newer_version("0.2.1", "0.2.1"));
        assert!(!is_newer_version("0.2.0", "0.2.1"));
        assert!(!is_newer_version("invalid", "0.2.0"));
        assert!(!is_newer_version("0.2.2-../../evil", "0.2.0"));
        assert!(!is_newer_version("0.2.2/evil", "0.2.0"));
    }

    #[test]
    fn safe_artifact_filename_rejects_traversal_and_unknown_extensions() {
        assert!(is_safe_artifact_filename("Tycho-0.2.2-windows-x64-portable.exe"));
        assert!(is_safe_artifact_filename("Tycho-0.2.2-macos-universal.dmg"));
        assert!(is_safe_artifact_filename("Tycho-0.2.2-linux-x86_64.AppImage"));
        assert!(!is_safe_artifact_filename("../evil.exe"));
        assert!(!is_safe_artifact_filename("dir/evil.exe"));
        assert!(!is_safe_artifact_filename("payload.sh"));
    }

    #[test]
    fn resolve_same_origin_url_blocks_cross_origin_and_protocol_relative_urls() {
        assert_eq!(
            resolve_same_origin_url(
                "https://tycho.example.com",
                "/api/desktop/download/Tycho-0.2.2-windows-x64-portable.exe"
            )
            .as_deref(),
            Some("https://tycho.example.com/api/desktop/download/Tycho-0.2.2-windows-x64-portable.exe")
        );
        assert!(resolve_same_origin_url("https://tycho.example.com", "//evil.example/x.exe").is_none());
        assert!(resolve_same_origin_url("https://tycho.example.com", "https://evil.example/x.exe").is_none());
        assert!(resolve_same_origin_url("https://tycho.example.com", "http://tycho.example.com/x.exe").is_none());
    }

    #[test]
    fn sha256sums_parser_extracts_valid_entries() {
        let hash = "a".repeat(64);
        let text = format!("{hash}  Tycho-0.2.2-windows-x64-portable.exe\nnot-a-hash foo\n");
        let map = parse_sha256sums(&text);
        assert_eq!(
            map.get("Tycho-0.2.2-windows-x64-portable.exe").map(String::as_str),
            Some(hash.as_str())
        );
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn resolve_host_update_prefers_matching_platform_and_validates_hashes_and_origin() {
        let hash = "b".repeat(64);
        let mut platforms = HashMap::new();
        platforms.insert(
            "windows-x64".to_string(),
            HostArtifact {
                filename: "Tycho-0.2.3-windows-x64-portable.exe".to_string(),
                sha256: hash.clone(),
                url: "/api/desktop/download/Tycho-0.2.3-windows-x64-portable.exe".to_string(),
                installer_url: Some("/api/desktop/download/Tycho-0.2.3-windows-x64-setup.exe".to_string()),
                installer_sha256: Some("c".repeat(64)),
            },
        );
        let manifest = HostLatestManifest {
            version: Some("0.2.3".to_string()),
            notes: Some("修复外链与一键更新".to_string()),
            artifact: None,
            platforms,
        };
        let found = resolve_host_update(
            &manifest,
            "0.2.2",
            "https://tycho.example.com",
            "windows-x64",
        )
        .expect("should resolve newer host update");
        assert_eq!(found.version, "0.2.3");
        assert_eq!(
            found.download_url,
            "https://tycho.example.com/api/desktop/download/Tycho-0.2.3-windows-x64-portable.exe"
        );
        assert_eq!(found.sha256, hash);
        assert_eq!(found.installer_sha256.as_deref(), Some("c".repeat(64).as_str()));
        assert_eq!(found.source, "host");

        // Invalid installer sha256 drops installer pair cleanly instead of accepting an unverified installer
        let mut bad_inst_platforms = HashMap::new();
        bad_inst_platforms.insert(
            "windows-x64".to_string(),
            HostArtifact {
                filename: "Tycho-0.2.3-windows-x64-portable.exe".to_string(),
                sha256: hash.clone(),
                url: "/api/desktop/download/Tycho-0.2.3-windows-x64-portable.exe".to_string(),
                installer_url: Some("/api/desktop/download/Tycho-0.2.3-windows-x64-setup.exe".to_string()),
                installer_sha256: Some("not-a-sha".to_string()),
            },
        );
        let bad_inst_manifest = HostLatestManifest {
            version: Some("0.2.3".to_string()),
            notes: None,
            artifact: None,
            platforms: bad_inst_platforms,
        };
        let sanitized = resolve_host_update(
            &bad_inst_manifest,
            "0.2.2",
            "https://tycho.example.com",
            "windows-x64",
        )
        .expect("portable artifact still valid");
        assert!(sanitized.installer_url.is_none());
        assert!(sanitized.installer_sha256.is_none());

        // Same version returns None
        assert!(resolve_host_update(
            &manifest,
            "0.2.3",
            "https://tycho.example.com",
            "windows-x64",
        )
        .is_none());
    }

    #[test]
    fn resolve_github_update_picks_highest_app_v_tag_and_verifies_checksum_presence() {
        let h1 = "1".repeat(64);
        let h2 = "2".repeat(64);
        let releases = vec![
            GithubRelease {
                tag_name: "v0.9.9".to_string(),
                draft: false,
                prerelease: false,
                body: None,
                assets: vec![],
            },
            GithubRelease {
                tag_name: "app-v0.2.3".to_string(),
                draft: false,
                prerelease: false,
                body: Some("notes".to_string()),
                assets: vec![
                    GithubAsset {
                        name: "Tycho-0.2.3-windows-x64-portable.exe".to_string(),
                        browser_download_url: "https://gh/portable.exe".to_string(),
                    },
                    GithubAsset {
                        name: "Tycho-0.2.3-windows-x64-setup.exe".to_string(),
                        browser_download_url: "https://gh/setup.exe".to_string(),
                    },
                    GithubAsset {
                        name: "SHA256SUMS.txt".to_string(),
                        browser_download_url: "https://gh/SHA256SUMS.txt".to_string(),
                    },
                ],
            },
        ];
        let sums = format!(
            "{h1}  Tycho-0.2.3-windows-x64-portable.exe\n{h2}  Tycho-0.2.3-windows-x64-setup.exe\n"
        );
        let found = resolve_github_update(&releases, "0.2.2", "windows-x64", |_| Some(sums.clone()))
            .expect("should pick app-v0.2.3");
        assert_eq!(found.version, "0.2.3");
        assert_eq!(found.download_url, "https://gh/portable.exe");
        assert_eq!(found.sha256, h1);
        assert_eq!(found.installer_url.as_deref(), Some("https://gh/setup.exe"));
        assert_eq!(found.installer_sha256.as_deref(), Some(h2.as_str()));
    }
}
