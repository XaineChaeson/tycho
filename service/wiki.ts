// Git-backed LLM Wiki subsystem (end-state architecture):
// - Registers Git Markdown Wiki vaults with pinned `published_commit` snapshots (reads directly
//   from Git objects via `git ls-tree` / `git show <commit>:<path>`, never dirty working trees).
// - Explicit per-project authorization (`wiki_grant`) with optional pinned commit & propose right.
// - Native SQLite FTS5 search index with CJK/Latin hybrid tokenization, `search_phrases`, and
//   coverage floor (`service/search-index.ts`).
// - Incremental lint over changed pages + 1-hop backlinks + Guardrail authority reconciliation.
// - Safe Worker/Router proposals (`wiki_proposal`) enforcing CAS (`base_commit` + `base_mutation_version`)
//   and hard preservation of human-locked sections (`## My Notes` / `<!-- tycho:human-locked -->`).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import type { Ctx, Db } from './db.ts';
import { nowIso, writeChange } from './db.ts';
import { InputError } from './errors.ts';
import { ulid } from './ids.ts';
import type { Entry } from './knowledge.ts';
import { FtsIndex, defaultMinCoverage, rrfFuse, tokenizeQueryTerms } from './search-index.ts';
import {
  findViolatedHumanLockedSection,
  parseWikiMarkdown,
  type WikiGrant,
  type WikiLintIssue,
  type WikiLintReport,
  type WikiPage,
  type WikiPageStatus,
  type WikiProposal,
  type WikiProposalStatus,
  type WikiVault,
} from '../shared/wiki.ts';

const MAX_NAME_CHARS = 120;
const MAX_DESC_CHARS = 600;
const MAX_CONTENT_BYTES = 256 * 1024;
const COMMIT_HEX = /^[0-9a-f]{7,40}$/i;

const SECRET_PATTERNS: { pattern: RegExp; what: string }[] = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: '私钥' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/, what: 'Bearer 令牌' },
  { pattern: /\b(?:sk|ghp|gho|glpat)[-_][A-Za-z0-9_-]{20,}/, what: '访问令牌' },
  { pattern: /\bTYCHO_[A-Z0-9_]*(?:TOKEN|SECRET|KEY|MATERIALS)\b\s*[=:]/, what: '环境变量里的 tycho 令牌' },
];

function assertNoWikiSecrets(text: string, where: string): void {
  for (const { pattern, what } of SECRET_PATTERNS) {
    if (pattern.test(text)) throw new InputError(`${where}里像是有${what}：凭据不能写入 Wiki，删掉后再提交`);
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function runGit(repoPath: string, args: readonly string[]): string {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd();
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') ?? '';
    throw new InputError(`Git 操作失败（git ${args.slice(0, 3).join(' ')}）：${(stderr || e.message || String(err)).trim()}`);
  }
}

function safeWikiRelativePath(raw: string): string {
  const cleaned = raw.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!cleaned || cleaned.includes('..') || !cleaned.toLowerCase().endsWith('.md')) {
    throw new InputError(`Wiki 页面路径必须是仓库内合法的 .md 相对路径：${raw}`);
  }
  const norm = normalize(cleaned).replace(/\\/g, '/');
  if (norm.startsWith('..') || isAbsolute(norm)) {
    throw new InputError(`Wiki 页面路径越界：${raw}`);
  }
  return norm;
}

interface VaultRow {
  id: string;
  created_at: string;
  updated_at: string;
  name: string;
  description: string;
  repo_path: string;
  branch: string;
  published_commit: string | null;
  last_synced_at: string | null;
  sync_error: string | null;
}

interface GrantRow {
  vault_id: string;
  project_id: string;
  created_at: string;
  pinned_commit: string | null;
  can_propose: number;
  granted_by: string;
}

interface PageRow {
  vault_id: string;
  page_id: string;
  path: string;
  title: string;
  summary: string;
  body: string;
  owner: string;
  scope: string;
  status: WikiPageStatus;
  search_phrases_json: string;
  sources_json: string;
  links_json: string;
  locked_sections_json: string;
  content_sha256: string;
  commit_sha: string;
  mutation_version: number;
  dirty: number;
  updated_at: string;
}

interface ProposalRow {
  id: string;
  created_at: string;
  vault_id: string;
  project_id: string | null;
  page_id: string;
  path: string;
  proposed_by: string;
  source: string;
  base_commit: string;
  base_mutation_version: number;
  branch_name: string | null;
  title: string;
  summary: string;
  new_content: string;
  rationale: string;
  status: WikiProposalStatus;
  status_reason: string | null;
  decided_at: string | null;
  decided_by: string | null;
  applied_commit: string | null;
}

const grantOf = (row: GrantRow): WikiGrant => ({
  vault_id: row.vault_id,
  project_id: row.project_id,
  created_at: row.created_at,
  pinned_commit: row.pinned_commit,
  can_propose: row.can_propose === 1,
  granted_by: row.granted_by,
});

const pageOf = (row: PageRow): WikiPage => ({
  vault_id: row.vault_id,
  page_id: row.page_id,
  path: row.path,
  title: row.title,
  summary: row.summary,
  body: row.body,
  owner: row.owner,
  scope: row.scope,
  status: row.status,
  search_phrases: JSON.parse(row.search_phrases_json) as string[],
  sources: JSON.parse(row.sources_json) as string[],
  links: JSON.parse(row.links_json) as string[],
  locked_sections: JSON.parse(row.locked_sections_json) as string[],
  content_sha256: row.content_sha256,
  commit_sha: row.commit_sha,
  mutation_version: row.mutation_version,
  dirty: row.dirty === 1,
  updated_at: row.updated_at,
});

const proposalOf = (row: ProposalRow): WikiProposal => ({ ...row });

export interface WikiSearchHit {
  vault_id: string;
  vault_name: string;
  page_id: string;
  path: string;
  title: string;
  summary: string;
  owner: string;
  scope: string;
  status: WikiPageStatus;
  commit_sha: string;
  score: number;
  coverage: number;
}

export interface WikiOptions {
  listActiveKnowledge?: () => Entry[];
}

export function createWiki(db: Db, write: <T>(fn: () => T) => T, options: WikiOptions = {}) {
  let ftsIndex: FtsIndex | null = null;
  let ftsWatermark = '';
  let ftsPages = new Map<string, PageRow>();

  function docKey(vaultId: string, pageId: string): string {
    return `${vaultId}\0${pageId}`;
  }

  function syncFts(): { index: FtsIndex; pages: Map<string, PageRow> } {
    const stats = db.get<{ cnt: number; ver_sum: number; max_upd: string | null }>(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(mutation_version), 0) AS ver_sum, MAX(updated_at) AS max_upd FROM wiki_page`,
    );
    const mark = `${stats?.cnt ?? 0}:${stats?.ver_sum ?? 0}:${stats?.max_upd ?? ''}`;
    if (ftsIndex !== null && ftsWatermark === mark) {
      return { index: ftsIndex, pages: ftsPages };
    }
    const rows = db.all<PageRow>('SELECT * FROM wiki_page ORDER BY vault_id, path');
    if (ftsIndex === null) ftsIndex = new FtsIndex();
    ftsIndex.rebuild(
      rows.map((row) => ({
        id: docKey(row.vault_id, row.page_id),
        title: row.title,
        subtitle: `${row.summary} ${row.scope} ${row.owner}`,
        body: row.body,
        phrases: JSON.parse(row.search_phrases_json) as string[],
      })),
    );
    ftsPages = new Map(rows.map((row) => [docKey(row.vault_id, row.page_id), row]));
    ftsWatermark = mark;
    return { index: ftsIndex, pages: ftsPages };
  }

  function requireVault(id: string): VaultRow {
    const row = db.get<VaultRow>('SELECT * FROM wiki_vault WHERE id = ?', id);
    if (!row) throw new InputError(`Wiki 知识库不存在：${id}`);
    return row;
  }

  function requireProject(projectId: string): void {
    if (!db.get('SELECT 1 FROM project WHERE id = ?', projectId)) {
      throw new InputError(`项目不存在：${projectId}`);
    }
  }

  function resolveCommit(repoPath: string, ref: string): string {
    const sha = runGit(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
    if (!COMMIT_HEX.test(sha)) throw new InputError(`无法解析提交号：${ref}`);
    return sha;
  }

  function listMarkdownPathsAtCommit(repoPath: string, commit: string): string[] {
    const out = runGit(repoPath, ['ls-tree', '-r', '--name-only', commit]);
    if (!out) return [];
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && line.toLowerCase().endsWith('.md') && !line.startsWith('raw/'));
  }

  function readBlobAtCommit(repoPath: string, commit: string, path: string): string {
    return runGit(repoPath, ['show', `${commit}:${path}`]);
  }

  function isWorkingTreeRepo(repoPath: string): boolean {
    try {
      const bare = runGit(repoPath, ['rev-parse', '--is-bare-repository']).trim();
      return bare === 'false';
    } catch {
      return false;
    }
  }

  // Synchronizes indexed pages of `vaultId` from `commit` (or HEAD of `vault.branch`).
  // Tracks `mutation_version` per page (incrementing only when content changes) and
  // computes changed paths for incremental lint.
  function syncVault(vaultId: string, ctx: Ctx, targetCommit?: string): {
    vault: WikiVault;
    commit: string;
    indexed: number;
    added: string[];
    updated: string[];
    removed: string[];
    lint: WikiLintReport;
  } {
    const vault = requireVault(vaultId);
    if (!existsSync(vault.repo_path)) {
      const errMsg = `Wiki 仓库路径不存在：${vault.repo_path}`;
      write(() => {
        db.run('UPDATE wiki_vault SET sync_error = ?, updated_at = ? WHERE id = ?', errMsg, nowIso(), vault.id);
      });
      throw new InputError(errMsg);
    }

    let commit: string;
    let paths: string[];
    const fileContents = new Map<string, string>();
    try {
      commit = resolveCommit(vault.repo_path, targetCommit || vault.branch || 'HEAD');
      paths = listMarkdownPathsAtCommit(vault.repo_path, commit);
      for (const relPath of paths) {
        fileContents.set(relPath, readBlobAtCommit(vault.repo_path, commit, relPath));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      write(() => {
        db.run('UPDATE wiki_vault SET sync_error = ?, updated_at = ? WHERE id = ?', msg, nowIso(), vault.id);
      });
      throw err;
    }

    const at = nowIso();
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    const seenIds = new Set<string>();

    write(() => {
      const existingRows = db.all<PageRow>('SELECT * FROM wiki_page WHERE vault_id = ?', vault.id);
      const existingById = new Map(existingRows.map((row) => [row.page_id, row]));

      for (const [relPath, raw] of fileContents.entries()) {
        const parsed = parseWikiMarkdown(relPath, raw);
        seenIds.add(parsed.page_id);
        const digest = sha256(raw);
        const prev = existingById.get(parsed.page_id);
        if (!prev) {
          db.run(
            `INSERT INTO wiki_page (
               vault_id, page_id, path, title, summary, body, owner, scope, status,
               search_phrases_json, sources_json, links_json, locked_sections_json,
               content_sha256, commit_sha, mutation_version, dirty, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`,
            vault.id, parsed.page_id, relPath, parsed.title, parsed.summary, parsed.body,
            parsed.owner, parsed.scope, parsed.status,
            JSON.stringify(parsed.search_phrases), JSON.stringify(parsed.sources),
            JSON.stringify(parsed.links), JSON.stringify(parsed.locked_sections),
            digest, commit, at,
          );
          added.push(parsed.page_id);
        } else if (prev.content_sha256 !== digest || prev.path !== relPath || prev.commit_sha !== commit) {
          const nextVersion = prev.content_sha256 !== digest ? prev.mutation_version + 1 : prev.mutation_version;
          db.run(
            `UPDATE wiki_page SET
               path = ?, title = ?, summary = ?, body = ?, owner = ?, scope = ?, status = ?,
               search_phrases_json = ?, sources_json = ?, links_json = ?, locked_sections_json = ?,
               content_sha256 = ?, commit_sha = ?, mutation_version = ?, dirty = 0, updated_at = ?
             WHERE vault_id = ? AND page_id = ?`,
            relPath, parsed.title, parsed.summary, parsed.body, parsed.owner, parsed.scope, parsed.status,
            JSON.stringify(parsed.search_phrases), JSON.stringify(parsed.sources),
            JSON.stringify(parsed.links), JSON.stringify(parsed.locked_sections),
            digest, commit, nextVersion, at, vault.id, parsed.page_id,
          );
          if (prev.content_sha256 !== digest) updated.push(parsed.page_id);
        }
      }

      for (const prev of existingRows) {
        if (!seenIds.has(prev.page_id)) {
          db.run('DELETE FROM wiki_page WHERE vault_id = ? AND page_id = ?', vault.id, prev.page_id);
          removed.push(prev.page_id);
        }
      }

      // Mark pending proposals stale if their base page changed underneath them.
      if (updated.length > 0 || removed.length > 0) {
        const changedSet = new Set([...updated, ...removed]);
        const pending = db.all<ProposalRow>(`SELECT * FROM wiki_proposal WHERE vault_id = ? AND status = 'pending'`, vault.id);
        for (const prop of pending) {
          if (!changedSet.has(prop.page_id)) continue;
          const nowPage = db.get<PageRow>('SELECT * FROM wiki_page WHERE vault_id = ? AND page_id = ?', vault.id, prop.page_id);
          if (!nowPage || nowPage.mutation_version !== prop.base_mutation_version) {
            db.run(
              `UPDATE wiki_proposal SET status = 'stale', status_reason = ? WHERE id = ?`,
              `基准页面已更新至提交 ${commit.slice(0, 8)}（版本 ${nowPage?.mutation_version ?? 0}），请基于最新版重新提交`,
              prop.id,
            );
          }
        }
      }

      db.run(
        'UPDATE wiki_vault SET published_commit = ?, last_synced_at = ?, sync_error = NULL, updated_at = ? WHERE id = ?',
        commit, at, at, vault.id,
      );
      writeChange(db, 'wiki.sync', ctx, {}, {
        vault_id: vault.id, commit, indexed: seenIds.size,
        added: added.length, updated: updated.length, removed: removed.length,
      });
    });

    const changed = [...added, ...updated];
    const lint = lintVault(vault.id, changed.length > 0 ? changed : undefined);
    return {
      vault: requireVault(vault.id),
      commit,
      indexed: seenIds.size,
      added,
      updated,
      removed,
      lint,
    };
  }

  // Incremental lint: checks changed pages + their 1-hop backlinks (or full vault when `changedPageIds` omitted).
  // Also performs ADR-042 style authority reconciliation against active SQLite Guardrail entries.
  function lintVault(vaultId: string, changedPageIds?: readonly string[]): WikiLintReport {
    const vault = requireVault(vaultId);
    const allPages = db.all<PageRow>('SELECT * FROM wiki_page WHERE vault_id = ? ORDER BY path', vault.id).map(pageOf);
    const byId = new Map(allPages.map((p) => [p.page_id, p]));
    const byPathStem = new Map(allPages.map((p) => [p.path.replace(/\.md$/i, ''), p]));
    const byBasename = new Map<string, WikiPage>();
    for (const p of allPages) {
      const base = p.path.split('/').pop()?.replace(/\.md$/i, '') ?? p.page_id;
      if (!byBasename.has(base)) byBasename.set(base, p);
    }

    const resolveLink = (target: string): WikiPage | undefined => {
      const norm = target.replace(/\\/g, '/').replace(/\.md$/i, '').replace(/^\/+/, '');
      return byId.get(norm) ?? byPathStem.get(norm) ?? byBasename.get(norm);
    };

    // Expand scope: changed pages + 1-hop backlinks (pages that link to a changed page)
    let scope: WikiPage[];
    if (changedPageIds && changedPageIds.length > 0) {
      const targetSet = new Set(changedPageIds);
      const selected = new Set<string>(changedPageIds);
      for (const p of allPages) {
        if (p.links.some((lnk) => {
          const resolved = resolveLink(lnk);
          return resolved !== undefined && targetSet.has(resolved.page_id);
        })) {
          selected.add(p.page_id);
        }
      }
      scope = allPages.filter((p) => selected.has(p.page_id));
    } else {
      scope = allPages;
    }

    const issues: WikiLintIssue[] = [];
    for (const page of scope) {
      const isMetaDoc = /^(schema|index|log|readme)\.md$/i.test(page.path.split('/').pop() ?? '');
      if (!isMetaDoc && (!page.owner || !page.scope)) {
        const missing = [!page.owner ? 'owner' : null, !page.scope ? 'scope' : null].filter(Boolean).join(', ');
        issues.push({
          severity: 'warn',
          code: 'missing_frontmatter',
          page_id: page.page_id,
          path: page.path,
          message: `页面缺少必备边界元数据（${missing}），易导致跨项目误用`,
        });
      }
      if (page.status === 'disputed') {
        issues.push({
          severity: 'warn',
          code: 'disputed_page',
          page_id: page.page_id,
          path: page.path,
          message: `页面处于争议待裁决状态（status: disputed），引用时需核对口径`,
        });
      }
      for (const link of page.links) {
        if (!resolveLink(link)) {
          issues.push({
            severity: 'error',
            code: 'broken_link',
            page_id: page.page_id,
            path: page.path,
            target: link,
            message: `悬空双向链接 [[${link}]] 未命中任何页面`,
          });
        }
      }
    }

    // ADR-042 Guardrail reconciliation: detect active SQLite Guardrails referencing deprecated/disputed wiki pages
    if (options.listActiveKnowledge) {
      const activeEntries = options.listActiveKnowledge();
      const flaggedPages = scope.filter((p) => p.status === 'deprecated' || p.status === 'disputed');
      for (const page of flaggedPages) {
        const needle = `wiki:${vault.id}/${page.page_id}`;
        for (const entry of activeEntries) {
          if (entry.body.includes(needle) || entry.body.includes(page.page_id)) {
            issues.push({
              severity: 'warn',
              code: 'guardrail_reconcile',
              page_id: page.page_id,
              path: page.path,
              target: `${entry.id}@${entry.revision}`,
              message: `活跃规则卡片 ${entry.id}@${entry.revision}（${entry.title}）引用了已${page.status === 'deprecated' ? '废弃' : '争议'}的 Wiki 页面，建议复核对账`,
            });
          }
        }
      }
    }

    return {
      vault_id: vault.id,
      commit_sha: vault.published_commit,
      checked_pages: scope.length,
      issues,
    };
  }

  return {
    createVault(fields: { name: unknown; repo_path: unknown; branch?: unknown; description?: unknown; autoSync?: boolean }, ctx: Ctx): { vault: WikiVault; sync?: ReturnType<typeof syncVault> } {
      const name = typeof fields.name === 'string' ? fields.name.trim() : '';
      if (!name || name.length > MAX_NAME_CHARS) throw new InputError(`Wiki 名称不能为空且最多 ${MAX_NAME_CHARS} 字`);
      const repoPath = typeof fields.repo_path === 'string' ? fields.repo_path.trim() : '';
      if (!repoPath || !isAbsolute(repoPath)) throw new InputError('Wiki 仓库路径必须是主机上的绝对路径');
      if (!existsSync(repoPath)) throw new InputError(`Wiki 仓库路径不存在：${repoPath}`);
      const branch = typeof fields.branch === 'string' && fields.branch.trim() !== '' ? fields.branch.trim() : 'main';
      const description = typeof fields.description === 'string' ? fields.description.trim().slice(0, MAX_DESC_CHARS) : '';
      // Verify it is a real Git repository before persisting
      runGit(repoPath, ['rev-parse', '--git-dir']);

      const id = ulid();
      const at = nowIso();
      write(() => {
        if (db.get('SELECT 1 FROM wiki_vault WHERE name = ?', name)) {
          throw new InputError(`已存在同名 Wiki 知识库：${name}`);
        }
        db.run(
          `INSERT INTO wiki_vault (id, created_at, updated_at, name, description, repo_path, branch)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          id, at, at, name, description, repoPath, branch,
        );
        writeChange(db, 'wiki.vault_create', ctx, {}, { vault_id: id, name, branch });
      });

      const vault = requireVault(id);
      if (fields.autoSync !== false) {
        try {
          const sync = syncVault(id, ctx);
          return { vault: sync.vault, sync };
        } catch {
          return { vault: requireVault(id) };
        }
      }
      return { vault };
    },

    deleteVault(vaultId: string, ctx: Ctx): void {
      write(() => {
        const vault = requireVault(vaultId);
        db.run('DELETE FROM wiki_vault WHERE id = ?', vault.id);
        writeChange(db, 'wiki.vault_delete', ctx, {}, { vault_id: vault.id, name: vault.name });
      });
    },

    listVaults(): (WikiVault & { page_count: number; pending_proposals: number; grants: WikiGrant[] })[] {
      const vaults = db.all<VaultRow>('SELECT * FROM wiki_vault ORDER BY created_at DESC');
      return vaults.map((vault) => {
        const pageCount = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM wiki_page WHERE vault_id = ?', vault.id)?.c ?? 0;
        const pendingProposals = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM wiki_proposal WHERE vault_id = ? AND status = 'pending'`, vault.id)?.c ?? 0;
        const grants = db.all<GrantRow>('SELECT * FROM wiki_grant WHERE vault_id = ? ORDER BY created_at', vault.id).map(grantOf);
        return { ...vault, page_count: pageCount, pending_proposals: pendingProposals, grants };
      });
    },

    getVault(vaultId: string): WikiVault {
      return requireVault(vaultId);
    },

    syncVault,
    lintVault,

    grantProject(vaultId: string, fields: { project_id: unknown; pinned_commit?: unknown; can_propose?: unknown }, ctx: Ctx): WikiGrant {
      const vault = requireVault(vaultId);
      const projectId = typeof fields.project_id === 'string' ? fields.project_id.trim() : '';
      if (!projectId) throw new InputError('要写项目编号');
      requireProject(projectId);
      let pinnedCommit: string | null = null;
      if (typeof fields.pinned_commit === 'string' && fields.pinned_commit.trim() !== '') {
        pinnedCommit = resolveCommit(vault.repo_path, fields.pinned_commit.trim());
      }
      const canPropose = fields.can_propose === true ? 1 : 0;
      const at = nowIso();
      write(() => {
        db.run(
          `INSERT INTO wiki_grant (vault_id, project_id, created_at, pinned_commit, can_propose, granted_by)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (vault_id, project_id) DO UPDATE SET pinned_commit = excluded.pinned_commit, can_propose = excluded.can_propose, granted_by = excluded.granted_by`,
          vault.id, projectId, at, pinnedCommit, canPropose, ctx.actor,
        );
        writeChange(db, 'wiki.grant_set', ctx, {}, { vault_id: vault.id, project_id: projectId, pinned_commit: pinnedCommit, can_propose: canPropose === 1 });
      });
      return grantOf(db.get<GrantRow>('SELECT * FROM wiki_grant WHERE vault_id = ? AND project_id = ?', vault.id, projectId)!);
    },

    revokeProject(vaultId: string, projectId: string, ctx: Ctx): void {
      write(() => {
        requireVault(vaultId);
        db.run('DELETE FROM wiki_grant WHERE vault_id = ? AND project_id = ?', vaultId, projectId);
        writeChange(db, 'wiki.grant_revoke', ctx, {}, { vault_id: vaultId, project_id: projectId });
      });
    },

    listProjectVaults(projectId: string): (WikiVault & { grant: WikiGrant; effective_commit: string | null; page_count: number })[] {
      const grants = db.all<GrantRow>('SELECT * FROM wiki_grant WHERE project_id = ? ORDER BY created_at', projectId);
      return grants.flatMap((g) => {
        const vault = db.get<VaultRow>('SELECT * FROM wiki_vault WHERE id = ?', g.vault_id);
        if (!vault) return [];
        const pageCount = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM wiki_page WHERE vault_id = ?', vault.id)?.c ?? 0;
        return [{
          ...vault,
          grant: grantOf(g),
          effective_commit: g.pinned_commit ?? vault.published_commit,
          page_count: pageCount,
        }];
      });
    },

    listPages(vaultId: string): WikiPage[] {
      requireVault(vaultId);
      return db.all<PageRow>('SELECT * FROM wiki_page WHERE vault_id = ? ORDER BY path', vaultId).map(pageOf);
    },

    readPage(vaultId: string, pageId: string, options?: { projectId?: string; commit?: string }): (WikiPage & { backlinks: string[]; vault_name: string }) {
      const vault = requireVault(vaultId);
      let effectiveCommit = options?.commit ?? vault.published_commit;
      if (options?.projectId) {
        const grant = db.get<GrantRow>('SELECT * FROM wiki_grant WHERE vault_id = ? AND project_id = ?', vault.id, options.projectId);
        if (!grant) throw new InputError(`项目 ${options.projectId} 未获授权读取 Wiki 知识库 ${vault.name}`);
        if (grant.pinned_commit && !options.commit) effectiveCommit = grant.pinned_commit;
      }
      const row = db.get<PageRow>('SELECT * FROM wiki_page WHERE vault_id = ? AND page_id = ?', vault.id, pageId)
        ?? db.get<PageRow>('SELECT * FROM wiki_page WHERE vault_id = ? AND path = ?', vault.id, pageId);
      if (!row) throw new InputError(`Wiki 知识库 ${vault.name} 中不存在页面：${pageId}`);

      const page = pageOf(row);
      // If caller requested a pinned commit different from the latest indexed commit, read directly from Git blob!
      if (effectiveCommit && effectiveCommit !== row.commit_sha && existsSync(vault.repo_path)) {
        const resolved = resolveCommit(vault.repo_path, effectiveCommit);
        const raw = readBlobAtCommit(vault.repo_path, resolved, row.path);
        const parsed = parseWikiMarkdown(row.path, raw);
        return {
          ...page,
          title: parsed.title,
          summary: parsed.summary,
          body: parsed.body,
          owner: parsed.owner,
          scope: parsed.scope,
          status: parsed.status,
          search_phrases: parsed.search_phrases,
          sources: parsed.sources,
          links: parsed.links,
          locked_sections: parsed.locked_sections,
          content_sha256: sha256(raw),
          commit_sha: resolved,
          backlinks: [],
          vault_name: vault.name,
        };
      }

      const backlinks = db
        .all<PageRow>('SELECT * FROM wiki_page WHERE vault_id = ? AND page_id != ?', vault.id, page.page_id)
        .filter((other) => {
          const links = JSON.parse(other.links_json) as string[];
          const stem = page.path.replace(/\.md$/i, '');
          const base = stem.split('/').pop() ?? page.page_id;
          return links.some((l) => l === page.page_id || l === stem || l === base);
        })
        .map((other) => other.page_id);

      return { ...page, backlinks, vault_name: vault.name };
    },

    // Authorized FTS5 search over Wiki vaults (either for a specific project's granted vaults or all vaults for owner console).
    searchPages(fields: { query: string; projectId?: string; vaultId?: string; limit?: number; minCoverage?: number }): WikiSearchHit[] {
      const query = fields.query.trim();
      if (!query) return [];
      const limit = Math.min(Math.max(fields.limit ?? 12, 1), 50);

      let vaultIds: string[];
      if (fields.projectId) {
        const grants = db.all<GrantRow>('SELECT * FROM wiki_grant WHERE project_id = ?', fields.projectId);
        vaultIds = grants.map((g) => g.vault_id);
        if (fields.vaultId) vaultIds = vaultIds.filter((id) => id === fields.vaultId);
      } else if (fields.vaultId) {
        vaultIds = [fields.vaultId];
      } else {
        vaultIds = db.all<{ id: string }>('SELECT id FROM wiki_vault').map((v) => v.id);
      }
      if (vaultIds.length === 0) return [];

      const vaultMap = new Map(db.all<VaultRow>('SELECT * FROM wiki_vault').map((v) => [v.id, v]));
      const vaultSet = new Set(vaultIds);
      const { index, pages } = syncFts();
      const allowedIds = new Set<string>();
      for (const [key, row] of pages.entries()) {
        if (!vaultSet.has(row.vault_id)) continue;
        if (row.status === 'deprecated') continue;
        allowedIds.add(key);
      }
      if (allowedIds.size === 0) return [];

      const minCov = fields.minCoverage ?? defaultMinCoverage(tokenizeQueryTerms(query));
      const ftsHits = index.search(query, { limit: limit * 2, allowedIds, minCoverage: minCov });
      if (ftsHits.length === 0) return [];

      // RRF boost when query directly names a page_id or path stem
      const lower = query.toLowerCase();
      const directMatches: string[] = [];
      for (const key of allowedIds) {
        const row = pages.get(key)!;
        if (row.page_id.toLowerCase().includes(lower) || row.title.toLowerCase().includes(lower)) {
          directMatches.push(key);
        }
      }
      const fused = rrfFuse([ftsHits.map((h) => h.id), directMatches]);
      const hitById = new Map(ftsHits.map((h) => [h.id, h]));

      const ordered = [...fused.entries()]
        .filter(([key]) => hitById.has(key))
        .sort((a, b) => b[1] - a[1] || (hitById.get(b[0])!.score - hitById.get(a[0])!.score))
        .slice(0, limit);

      return ordered.map(([key]) => {
        const row = pages.get(key)!;
        const hit = hitById.get(key)!;
        const vault = vaultMap.get(row.vault_id);
        return {
          vault_id: row.vault_id,
          vault_name: vault?.name ?? row.vault_id,
          page_id: row.page_id,
          path: row.path,
          title: row.title,
          summary: row.summary,
          owner: row.owner,
          scope: row.scope,
          status: row.status,
          commit_sha: row.commit_sha,
          score: hit.score,
          coverage: hit.coverage,
        };
      });
    },

    // Safe Worker/Router write proposal with CAS (`base_commit` + `base_mutation_version`)
    // and hard human-locked section preservation (`## My Notes`, `<!-- tycho:human-locked -->`).
    proposeUpdate(fields: {
      vault_id: unknown;
      project_id?: string | null;
      path: unknown;
      new_content: unknown;
      rationale?: unknown;
      base_commit?: unknown;
      base_mutation_version?: unknown;
      proposed_by: string;
      source: string;
    }, ctx: Ctx): WikiProposal {
      const vaultId = typeof fields.vault_id === 'string' ? fields.vault_id.trim() : '';
      const vault = requireVault(vaultId);
      if (fields.project_id) {
        const grant = db.get<GrantRow>('SELECT * FROM wiki_grant WHERE vault_id = ? AND project_id = ?', vault.id, fields.project_id);
        if (!grant || grant.can_propose !== 1) {
          throw new InputError(`项目 ${fields.project_id} 没有向 Wiki 知识库 ${vault.name} 提交修订提议的权限`);
        }
      }
      const relPath = safeWikiRelativePath(typeof fields.path === 'string' ? fields.path : '');
      const newContent = typeof fields.new_content === 'string' ? fields.new_content : '';
      if (!newContent.trim()) throw new InputError('Wiki 修订正文不能为空');
      if (Buffer.byteLength(newContent, 'utf8') > MAX_CONTENT_BYTES) {
        throw new InputError(`Wiki 页面正文超过上限（${Math.round(MAX_CONTENT_BYTES / 1024)} KiB）`);
      }
      const rationale = typeof fields.rationale === 'string' ? fields.rationale.trim().slice(0, 2000) : '';
      assertNoWikiSecrets(newContent, 'Wiki 修订正文');
      assertNoWikiSecrets(rationale, 'Wiki 修订说明');

      const parsed = parseWikiMarkdown(relPath, newContent);
      const currentCommit = vault.published_commit ?? (existsSync(vault.repo_path) ? resolveCommit(vault.repo_path, vault.branch || 'HEAD') : '');
      if (!currentCommit) throw new InputError('Wiki 知识库尚未完成首次同步，无法提议');

      const baseCommit = typeof fields.base_commit === 'string' && fields.base_commit.trim() !== ''
        ? fields.base_commit.trim()
        : currentCommit;
      if (!currentCommit.startsWith(baseCommit) && !baseCommit.startsWith(currentCommit)) {
        throw new InputError(`stale_snapshot：提议基于提交 ${baseCommit.slice(0, 8)}，但已发布版本已推进到 ${currentCommit.slice(0, 8)}，请先重读最新版`);
      }

      const existing = db.get<PageRow>('SELECT * FROM wiki_page WHERE vault_id = ? AND path = ?', vault.id, relPath)
        ?? db.get<PageRow>('SELECT * FROM wiki_page WHERE vault_id = ? AND page_id = ?', vault.id, parsed.page_id);
      const expectedVersion = existing?.mutation_version ?? 0;
      if (typeof fields.base_mutation_version === 'number' && fields.base_mutation_version !== expectedVersion) {
        throw new InputError(`stale_snapshot：页面版本已变更为 ${expectedVersion}（提议基于 ${fields.base_mutation_version}），拒绝覆盖`);
      }

      // Hard protection of human-authored locked sections (ADR-006)
      if (existing && existsSync(vault.repo_path)) {
        try {
          const originalRaw = readBlobAtCommit(vault.repo_path, existing.commit_sha, existing.path);
          const violated = findViolatedHumanLockedSection(originalRaw, newContent);
          if (violated !== null) {
            throw new InputError('提议修改或删除了人类锁定区块（`## My Notes` 或 `<!-- tycho:human-locked -->`），已拒绝');
          }
        } catch (err) {
          if (err instanceof InputError) throw err;
        }
      }

      const id = ulid();
      const at = nowIso();
      const branchName = `tycho/wiki-${id.toLowerCase().slice(-10)}`;

      write(() => {
        db.run(
          `INSERT INTO wiki_proposal (
             id, created_at, vault_id, project_id, page_id, path, proposed_by, source,
             base_commit, base_mutation_version, branch_name, title, summary, new_content, rationale, status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
          id, at, vault.id, fields.project_id ?? null, parsed.page_id, relPath,
          fields.proposed_by, fields.source, currentCommit, expectedVersion,
          branchName, parsed.title, parsed.summary, newContent, rationale,
        );
        writeChange(db, 'wiki.propose', ctx, {}, {
          proposal_id: id, vault_id: vault.id, page_id: parsed.page_id, path: relPath,
          base_commit: currentCommit, base_mutation_version: expectedVersion,
        });
      });

      return proposalOf(db.get<ProposalRow>('SELECT * FROM wiki_proposal WHERE id = ?', id)!);
    },

    listProposals(filter: { vaultId?: string; status?: WikiProposalStatus } = {}): WikiProposal[] {
      const clauses: string[] = [];
      const params: string[] = [];
      if (filter.vaultId) { clauses.push('vault_id = ?'); params.push(filter.vaultId); }
      if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
      return db.all<ProposalRow>(`SELECT * FROM wiki_proposal${where} ORDER BY created_at DESC`, ...params).map(proposalOf);
    },

    // Owner approves and applies a pending Wiki proposal:
    // 1. Re-checks CAS (`base_commit` & `base_mutation_version`) and human-locked section integrity.
    // 2. Writes the file into the Git checkout, commits cleanly on `vault.branch`, and re-syncs + lints.
    decideProposal(proposalId: string, decision: { action: 'approve' | 'reject'; reason?: string }, ctx: Ctx): { proposal: WikiProposal; sync?: ReturnType<typeof syncVault> } {
      const row = db.get<ProposalRow>('SELECT * FROM wiki_proposal WHERE id = ?', proposalId);
      if (!row) throw new InputError(`Wiki 提议不存在：${proposalId}`);
      if (row.status !== 'pending') throw new InputError(`该 Wiki 提议状态为 ${row.status}，无法再处理`);

      const at = nowIso();
      if (decision.action === 'reject') {
        const reason = decision.reason?.trim() || '主人驳回';
        write(() => {
          db.run(
            `UPDATE wiki_proposal SET status = 'rejected', status_reason = ?, decided_at = ?, decided_by = ? WHERE id = ?`,
            reason, at, ctx.actor, row.id,
          );
          writeChange(db, 'wiki.proposal_reject', ctx, {}, { proposal_id: row.id, vault_id: row.vault_id, reason });
        });
        return { proposal: proposalOf(db.get<ProposalRow>('SELECT * FROM wiki_proposal WHERE id = ?', row.id)!) };
      }

      const vault = requireVault(row.vault_id);
      const currentHead = resolveCommit(vault.repo_path, vault.branch || 'HEAD');
      if (vault.published_commit && currentHead !== row.base_commit) {
        write(() => {
          db.run(
            `UPDATE wiki_proposal SET status = 'stale', status_reason = ?, decided_at = ?, decided_by = ? WHERE id = ?`,
            `stale_snapshot：分支已推进至 ${currentHead.slice(0, 8)}（提议基于 ${row.base_commit.slice(0, 8)}）`,
            at, ctx.actor, row.id,
          );
        });
        throw new InputError(`stale_snapshot：Wiki 分支已推进至 ${currentHead.slice(0, 8)}，已标记该提议为过期，未覆盖写入`);
      }

      const existing = db.get<PageRow>('SELECT * FROM wiki_page WHERE vault_id = ? AND page_id = ?', vault.id, row.page_id);
      if ((existing?.mutation_version ?? 0) !== row.base_mutation_version) {
        write(() => {
          db.run(
            `UPDATE wiki_proposal SET status = 'stale', status_reason = ?, decided_at = ?, decided_by = ? WHERE id = ?`,
            `stale_snapshot：页面版本已变更为 ${existing?.mutation_version ?? 0}`,
            at, ctx.actor, row.id,
          );
        });
        throw new InputError(`stale_snapshot：页面版本已变更为 ${existing?.mutation_version ?? 0}，拒绝覆盖`);
      }

      if (existing && existsSync(vault.repo_path)) {
        const originalRaw = readBlobAtCommit(vault.repo_path, existing.commit_sha, existing.path);
        const violated = findViolatedHumanLockedSection(originalRaw, row.new_content);
        if (violated !== null) {
          throw new InputError('提议破坏了人类锁定区块（`## My Notes` / `<!-- tycho:human-locked -->`），拒绝合入');
        }
      }

      if (!isWorkingTreeRepo(vault.repo_path)) {
        throw new InputError(`Wiki 仓库 ${vault.repo_path} 是裸仓库，请先在工作副本中手动合入提议后再同步`);
      }

      const targetFile = join(vault.repo_path, row.path);
      const relCheck = relative(vault.repo_path, targetFile);
      if (relCheck.startsWith('..') || isAbsolute(relCheck)) {
        throw new InputError(`非法写入路径：${row.path}`);
      }
      mkdirSync(dirname(targetFile), { recursive: true });
      writeFileSync(targetFile, row.new_content, 'utf8');
      runGit(vault.repo_path, ['add', '--', row.path]);
      const commitMsg = `wiki(${row.page_id}): ${row.title}\n\nProposal: ${row.id}\nProposed-By: ${row.proposed_by}\nApproved-By: ${ctx.actor}${row.rationale ? `\n\n${row.rationale}` : ''}`;
      runGit(vault.repo_path, ['-c', 'user.name=Tycho Wiki', '-c', 'user.email=tycho@local', 'commit', '-m', commitMsg, '--', row.path]);
      const appliedCommit = resolveCommit(vault.repo_path, 'HEAD');

      write(() => {
        db.run(
          `UPDATE wiki_proposal SET status = 'applied', status_reason = NULL, decided_at = ?, decided_by = ?, applied_commit = ? WHERE id = ?`,
          at, ctx.actor, appliedCommit, row.id,
        );
        writeChange(db, 'wiki.proposal_apply', ctx, {}, {
          proposal_id: row.id, vault_id: vault.id, page_id: row.page_id, applied_commit: appliedCommit,
        });
      });

      const sync = syncVault(vault.id, ctx, appliedCommit);
      return {
        proposal: proposalOf(db.get<ProposalRow>('SELECT * FROM wiki_proposal WHERE id = ?', row.id)!),
        sync,
      };
    },

    closeSearchIndex(): void {
      ftsIndex?.close();
      ftsIndex = null;
      ftsWatermark = '';
    },
  };
}

export type WikiService = ReturnType<typeof createWiki>;
