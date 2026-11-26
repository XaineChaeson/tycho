# Changelog

All notable changes to Tycho are documented in this file.

> **Versioning note**:
> - **Host & Node Server releases** use `v<major>.<minor>.<commit-count>` tags (e.g., `v0.2.1`).
> - **Desktop thin-shell releases** use independent `app-v<semver>` tags (e.g., `app-v0.2.0`), because all console UI is served live from your Tycho host.

## [0.2.12] - 2026-11-27

### Highlights (Milestone: Route-Aware Priority Slots, Dynamic Discovery & Desktop Self-Updater)
- **Route-Aware Priority Slots & Project-Level Overrides**:
  - Replaced legacy linear dispatch ordering with tier-specific `P1 / P2 / off` priority slots supporting route-qualified logical keys (`executor:<executor>:<route>`, e.g., LAN gateway vs paid official API) with Least-Active → Quota-Aware load balancing inside P1 and strict failover to P2.
  - Unified project-level slot overrides in Project Settings (`putProject` `dispatch_slots`), consistent alias resolution across Accounts / Dispatch Policy / Project Settings, and automatic slot inheritance for covered same-identity machine logins.
- **100% Dynamic Model & Reasoning-Effort Discovery**:
  - Removed hardcoded model catalogs and effort allowlists in `dsh` and `gemini`: `dsh` dynamically parses `dsh --profile headless --dump-config-schema` alongside custom `cordis.patch.yml` providers; `gemini` (`agy`) dynamically parses `agy models` + `agy --help`.
  - Preserved 3-state reasoning efforts (`string[]` supported / `[]` explicitly unsupported / `undefined` unreported) across all 4 adapters and the console tier form, with inline mismatch warnings.
- **Closed-Loop Fleet CLI Updater & Machine Target Pinning (Ledger 48)**:
  - Self-contained user-local npm fallback (`~/.tycho/cli`) for read-only system prefixes (`EACCES`), proxy-stall direct retry with shared absolute deadline, concurrent-run update locking, and scheduled auto-update eligibility filtering for manual/desktop-bundled CLIs.
  - Added direct task target machine selection (`task.machine_id`), official Windows `agy` CLI install path discovery (`%LOCALAPPDATA%\agy\bin\agy.exe`), POSIX canonical-path checkout exclusion in `locate`, and same-identity `adoptMachineLogin` deduplication.
- **Desktop Thin-Shell Self-Updater (`app-v0.2.2`)**:
  - Built-in dual-source update checker (self-hosted `/api/desktop/latest` first with same-origin & SHA-256 verification, GitHub Releases `app-v*` paginated fallback) with one-click in-place Windows Portable / Linux AppImage replacement and NSIS / macOS DMG support.
  - Hardened update security: strict filename/semver validation, same-origin + no-HTTPS-downgrade checks, 512 MiB download cap, trusted-origin navigation guard, and allowlisted stream error handling on `/api/desktop/download/:name`.

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
