# Contributing to Tycho

Thank you for your interest in contributing to Tycho!

## Prerequisites

- **Node.js `>= 24.3.0`** (the backend runs `.ts` natively with zero runtime `dependencies`)
- **npm** (for dev dependencies and the React/Vite `console/` frontend)
- **Rust `1.77+`** (only needed if modifying the optional Tauri v2 shell in `desktop/`)

## Local Development Setup

```bash
git clone https://github.com/XaineChaeson/tycho.git
cd tycho

# Install root devDependencies (TypeScript & @types/node) and console dependencies
npm ci
npm --prefix console ci

# Build the console once (or run `npm run dev:console` in a second terminal for HMR)
npm run build:console

# Start the Tycho host locally (default port 8787)
npm start

# In a second terminal, generate a one-time login link
npm run login-link
```

## Repository Map

| Directory | Responsibility |
| --- | --- |
| `service/` | Core control plane: SQLite ledger, HTTP/SSE server, auth, dispatcher, project routers, knowledge & backup |
| `node/` | Remote worker node daemon (`tycho node join` / `run`), executor discovery, skill mirroring, updater |
| `adapters/` | Native executor adapters (`claude`, `codex`, `gemini`, `dsh`) — CLI launch, event stream parsing, quota/model probes |
| `runner/` | Run snapshots, display truncation, secret redaction, prompt assembly |
| `cli/` | `tycho` CLI entrypoint, installer/updater, autostart service managers, `tycho doctor` |
| `shared/` | Pure TypeScript types, labels, tiers, roles, and helpers shared between `service/` and `console/` |
| `console/` | React + TypeScript + Vite + Tailwind + Radix UI web console |
| `desktop/` | Lightweight Tauri v2 desktop thin shell (Windows / macOS / Linux) |
| `channels/` | IM channel integrations (WeCom, WeChat) |
| `docs/` | User guides (`docs/guide/`), generated references (`docs/reference/`), and maintainer design specs (`docs/design/`) |
| `tests/` | Node native test runner suite covering ledger, HTTP, adapters, migrations, CLI, and nodes |

> **AI Coding Agents**: If you are working on this repo with an AI coding agent, read [AGENTS.md](AGENTS.md) for architectural invariants and single-source-of-truth rules.

## Verification Checklist Before Opening a PR

Run all relevant checks before submitting:

```bash
# 1. Typecheck root & build console
npm run typecheck
npm run build:console

# 2. Run backend & console test suites
npm test
npm run test:console

# 3. Verify generated docs reference and OSS hygiene
npm run docs:check
npm run check:hygiene

# 4. If you touched desktop/, run Rust tests
cd desktop/src-tauri && cargo test
```

## Guidelines

- **Keep the server zero-dependency**: do not add runtime `dependencies` to root `package.json`.
- **Single Source of Truth**:
  - Settings live in `service/settings.ts` — run `npm run docs:gen` after adding/changing settings or CLI help.
  - Shared UI/server labels live in `shared/`.
  - Console design tokens live in `console/src/index.css`.
- **No personal or proprietary data in tests/fixtures**: use synthetic paths (`/home/dev/...`, `C:\Users\dev\...`), synthetic emails (`alice@example.com`), and synthetic hostnames (`workstation-01`).
- **Ledger schema changes**: if you bump `tycho.ledger` in `package.json`, add a migration test in `tests/migration.test.ts` and document the change in `CHANGELOG.md`.
