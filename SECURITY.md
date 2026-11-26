# Security Policy

## Supported Versions

Security fixes are applied to the latest release line on `main`:

| Component | Supported |
| --- | --- |
| Tycho Host & Node (`v0.1.x` / `v0.2.x`) | Latest release |
| Tycho Desktop (`app-v*`) | Latest release |
| Older releases | Upgrade to latest |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, report them privately via:
- **GitHub Private Vulnerability Reporting**: open the repository's **Security → Advisories → Report a vulnerability** page.

Please include:
- A clear description of the issue and affected component (`service/`, `node/`, `cli/`, `console/`, or `desktop/`).
- Minimal reproduction steps or proof of concept.
- Your environment (OS, Node version, Tycho version from `tycho version`).

We aim to acknowledge reports within **72 hours** and coordinate remediation before public disclosure.

## Security Model & Trust Boundaries

Tycho is a **self-hosted personal / small-team orchestration control plane** that dispatches tasks to native AI coding CLIs (`Claude Code`, `Codex`, `Gemini / agy`, `dsh`) running on your own machines.

Before deploying Tycho on shared or internet-reachable infrastructure, understand these explicit trust boundaries:

1. **OS User & Machine Isolation Is the Primary Sandbox**
   - Tycho orchestrates native executors with their full native capabilities so they can run tests, builds, and git workflows unattended.
   - **Project Routers and Review/Analysis roles do not guarantee a hard filesystem sandbox.** Advisory checks and prompts guide behavior, while actual blast-radius containment relies on the OS user account, filesystem permissions, container/VM boundary, or dedicated worker machine where the node runs.
   - Never run `tycho` or `tycho node` as `root` or Windows Administrator.

2. **Authentication & Network Exposure**
   - Console sessions use `HttpOnly`, `SameSite=Strict` cookies (`Secure` on HTTPS). One-time login links use `/login#<token>` fragments exchanged via same-origin `POST`.
   - Local control endpoints (`/api/login-links`, `/api/shutdown`, Knowledge MCP loopback) are bound to loopback and never exposed on the external listener.
   - When accessing Tycho across machines or over the public internet, terminate TLS via a reverse proxy (Nginx / Caddy / Tailscale HTTPS) and configure `http.publicUrl` with `https://`.

3. **Credentials & Logs**
   - Managed account credentials, channel secrets, and node tokens are stored outside the SQLite ledger in `<dataDir>/secrets/` (owner-only permissions) and excluded from ledger backups.
   - Before attaching `tycho doctor`, `service.log`, or `node.log` to any issue or report, verify no personal tokens, URLs, or private repository paths remain in the excerpt.
