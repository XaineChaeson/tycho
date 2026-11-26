# Changelog

All notable changes to Tycho are documented in this file.

> **Versioning note**:
> - **Host & Node Server releases** use `v<major>.<minor>.<commit-count>` tags (e.g., `v0.2.1`).
> - **Desktop thin-shell releases** use independent `app-v<semver>` tags (e.g., `app-v0.2.0`), because all console UI is served live from your Tycho host.

## [0.2.1] - 2026-11-26

### Highlights (Initial Public Release)
- **Zero-Dependency Native Agent Control Plane**:
  - Orchestrates native `claude`, `codex`, `agy` (Gemini), and `dsh` CLIs over one zero-dependency Node 24 + `node:sqlite` ledger with outbound worker fleet (`tycho node join`).
  - Unified `Provider × Masked Identity × Machine` accounts pool with 3 fixed tiers (`decide` / `execute` / `operate`), 5h/7d quota telemetry, P1→P2 failover, local quota probe plugins (`~/.tycho/quota-probes/`), and idle-safe fleet CLI upgrades.
  - Built-in WeCom WebSocket, Personal WeChat iLink QR, Feishu bridge, and open signed `tycho-v1` bidirectional IM protocol, plus Cron, transactional ledger lifecycle events, and GitHub / `tycho-v1` HMAC webhooks.
  - Cross-machine `SKILL.md` fleet mirror, scoped Knowledge MCP (`tycho knowledge-mcp`), and hot-reloadable JSON themes (`<dataDir>/themes/*.json`).
- **Multi-Platform Client Distribution & Mobile PWA (`app-v0.2.0`)**:
  - Lightweight 3.6 MB Tauri v2 desktop wrapper for Windows (Portable `.exe` & NSIS installer), macOS (Universal `.dmg`), and Linux (`.AppImage` & `.deb`) with origin-only URL persistence, launcher CSP, and default port `8787`.
  - Standalone mobile PWA support for iOS Safari & Android Chrome (`manifest.webmanifest`, icons, safe-area inset CSS, zero-cache Service Worker).
- **Open-Source Governance, Security & Documentation**:
  - MIT `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, Issue/PR templates, and `THIRD_PARTY_NOTICES.txt` bundled into release archives.
  - PR CI (`.github/workflows/ci.yml`), automated Server Release (`server-release.yml`), Desktop Release (`desktop-release.yml` with `make_latest: "false"`), and static Product Website + 17-page Docs Reader (`docs-pages.yml`).
  - Anonymous public HTTPS `tycho update` with `gh` fallback, SHA256 verification on one-line installers, Windows node token ACL tightening, and masked HTTP 500 error responses with `request_id`.
