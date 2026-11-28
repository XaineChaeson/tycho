# Knowledge, Domain LLM Wiki & Cross-Project Collaboration (End-State Design)

> Status: Implemented in Ledger Schema v50 (`tycho v0.2.21`).
> Builds on `docs/design/knowledge-and-skills.md` and preserves all existing Tycho invariants (single authoritative SQLite ledger, immutable Run snapshots, read-only/write boundaries, and zero-oracle write-only MCP tokens).

## 1. Architectural Separation (4 Layers + Dotfiles Boundary)

| Layer | Authoritative Store | Scope & Lifecycle | Delivery to Execution Rounds |
| --- | --- | --- | --- |
| **L0 — Dotfiles & Shell** | External dotfiles (`chezmoi` / symlinks) | Personal machine environment | **Explicitly out of Tycho** (`inspectDotfilesBoundary()` audits single-writer boundaries read-only). |
| **L1 — Guardrails & Skills** | `ledger.db` (`knowledge_entry` / `knowledge_revision`) + host skills dir | Short operational rules (`resident` / `on_demand`) and step-by-step skills | Frozen into `Snapshot` & `brief.md`; retrieved via native SQLite FTS5 + `search_phrases`. |
| **L2 — Domain LLM Wiki** | Git Markdown repositories (`wiki_vault`, `wiki_grant`, `wiki_page`, `wiki_proposal`) | Long-lived domain architecture, runbooks, and structured concepts | Read directly from immutable Git blobs pinned to `published_commit` (or grant `pinned_commit`); `raw/` excluded. |
| **L3 — Collaboration Contracts** | `ledger.db` (`cross_project_ref`, `task_contract`) | Cross-project frozen read-only refs & intra-project producer→consumer contracts | Single-hop frozen metadata in `Snapshot` & `brief.md`; bounded clarifications with coalescing wakeup guard. |

## 2. Retrieval & Rule-First Governance (`service/search-index.ts`, `service/knowledge.ts`)

- **Zero-Dependency Native SQLite FTS5**: An ephemeral watermark-synced `:memory:` `DatabaseSync` (`node:sqlite`) indexes active knowledge entries and Wiki pages without introducing FTS5 shadow tables into `ledger.db` (preserving `verifySnapshot()` and `immutable=1` read checks).
- **Hybrid CJK + Latin Tokenization**: Extracts Latin/numeric identifiers and overlapping CJK bigrams so mixed Chinese/English queries match accurately across technical terms and prose.
- **Alternate Search Phrases (`search_phrases`)**: Up to 3 curated alias phrases per knowledge revision or Wiki page frontmatter, weighted alongside title, summary, and body in `bm25()`, fused via RRF with a dynamic `min_token_coverage` floor and `exclude_ids` snapshot deduplication.
- **Rule-First Pre-Filter (Zero-Token Cost)**:
  - Rejects automated Worker/Router proposals whose evidence consists exclusively of synthetic runtime-error Runs (`ADR-041`).
  - Merges exact/near-identical pure-new active duplicates cleanly into the existing entry without creating redundant cards or leaking a read oracle to write-only (`propose`) MCP clients (`ADR-004`).
- **Portable Versioned JSONL (`service/knowledge-portable.ts`)**: `GET /api/knowledge/export.jsonl` and `POST /api/knowledge/import.jsonl` support dry-run diff previews and idempotent deduplication.
- **Upgraded History Evidence (`service/history-evidence.ts`)**: Reuses the single history evidence index with hybrid CJK/Latin fallback, `exclude_errors`, and `exclude_run_id` (no shadow registry).

## 3. Git-Backed Domain LLM Wiki (`service/wiki.ts`, `shared/wiki.ts`)

- **Immutable Snapshot Reads**: `syncVault()` resolves `published_commit` and reads Markdown via `git ls-tree` + `git show <commit>:<path>`, never indexing dirty working trees or `raw/`.
- **Explicit Project Grants (`wiki_grant`)**: Projects receive zero Wiki access by default; owners grant read access (with optional `pinned_commit`) and optional `can_propose` permission per project.
- **Incremental Lint & Guardrail Reconciliation**: Checks changed pages + 1-hop backlinks for broken `[[wikilinks]]`, missing frontmatter, `disputed` status, and potential conflicts with active L1 Guardrails.
- **CAS + Human-Locked Section Protection**: `propose_wiki_update` validates `base_commit` and `base_mutation_version` (`stale_snapshot` refusal on drift) and blocks any proposal that mutates or removes `## My Notes` or `<!-- tycho:human-locked -->...<!-- /tycho:human-locked -->` blocks. Owner approval writes and commits cleanly to the Git repository and re-syncs.

## 4. Cross-Project Refs & Intra-Project Task Contracts (`service/collaboration.ts`)

- **Cross-Project Pinned Read-Only Refs (`cross_project_ref`)**: Freezes `(pinned_version, content_sha256, frozen_bytes)` across projects with explicit copy-delivery notice in Console UI. Single-hop only (never recursively expanded). Revoking blocks all future dispatches while preserving past Run snapshots.
- **Intra-Project Task Artifact Contracts (`task_contract`)**: Coordinates producer → consumer tasks inside one project with monotonically versioned deliveries, bounded structured clarifications pinned to `(producer_revision, contract_version)`, and a coalesced wakeup guard (`coalesced_revision` / `notified_version`) preventing notification fan-out avalanches.

## 5. Streamable HTTP MCP & Terminal Token Lifecycle (`service/http.ts`)

- `POST /api/knowledge/mcp/stream` (loopback-only `knowledge` route) and `POST /api/node/knowledge/mcp/stream` (`node` + `X-Tycho-Knowledge-Token` route) speak JSON-RPC 2.0 MCP directly over HTTP for Claude Code, Codex, Gemini, and DSH without requiring a local stdio bridge.
- Clients track `last_used_at` and `request_count`, and support zero-downtime token rotation (`POST /api/knowledge/clients/:id/rotate`).
- Knowledge MCP tokens expose only curated knowledge and granted Wiki tools — never raw Task/Run history.
