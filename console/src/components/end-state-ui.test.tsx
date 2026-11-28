// Guards the end-state Knowledge (Domain Wiki, Streamable HTTP MCP, token rotation, JSONL
// portable import/export, dotfiles boundary) and Project Collaboration (authorized Wikis,
// cross-project pinned refs, intra-project task artifact contracts) Console UI views.
import { screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { open, type Call } from '@/test/harness';

const AT = '2026-11-28T10:00:00Z';

function baseKnowledgeResponse() {
  return {
    legacy: [],
    awaiting: [],
    to_review: [],
    proposals: [],
    entries: [],
    directory_skills: [],
    ignored_skills: [],
    skills_dir: '/srv/tycho/skills',
    entry_machines: {},
    machines: [],
    clients: [
      {
        id: 'c1',
        created_at: AT,
        name: 'workstation-claude',
        executor: 'claude',
        grants: ['read', 'propose'],
        revoked_at: null,
        last_used_at: AT,
        request_count: 14,
      },
    ],
    projects: [
      { id: 'p1', name: 'ClusterOps' },
      { id: 'p2', name: 'MarketData' },
    ],
    roles: [{ id: 'implement', name: '实现' }],
    executors: ['claude', 'codex', 'gemini'],
    public_url: 'https://tycho.example.com',
  };
}

test('Knowledge Domain Wiki tab displays vaults, syncs, lints, searches, and approves proposals', async () => {
  const calls: Call[] = [];
  let proposalStatus: 'pending' | 'applied' = 'pending';
  const { user } = open('#/knowledge?view=wiki', (call) => {
    calls.push(call);
    if (call.method === 'GET' && call.path === '/api/knowledge') return baseKnowledgeResponse();
    if (call.method === 'GET' && call.path === '/api/wiki') {
      return {
        vaults: [
          {
            id: 'v1',
            created_at: AT,
            updated_at: AT,
            name: 'Infra Wiki',
            description: 'Cluster architecture docs',
            repo_path: '/srv/wiki/infra',
            branch: 'main',
            published_commit: 'abcdef1234567890',
            last_synced_at: AT,
            sync_error: null,
            page_count: 1,
            pending_proposals: proposalStatus === 'pending' ? 1 : 0,
            grants: [
              { vault_id: 'v1', project_id: 'p1', created_at: AT, pinned_commit: null, can_propose: true, granted_by: 'console' },
            ],
          },
        ],
        proposals: [
          {
            id: 'wp1',
            created_at: AT,
            vault_id: 'v1',
            project_id: 'p1',
            page_id: 'cgroup-v2',
            path: 'cgroup-v2.md',
            proposed_by: 'router',
            source: 'router',
            base_commit: 'abcdef1234567890',
            base_mutation_version: 1,
            branch_name: 'tycho/wiki-wp1',
            title: 'Cgroup v2 Memory Guardrail',
            summary: 'Clarify leaf vs parent memory.max',
            new_content: '# Cgroup v2 Memory Guardrail\n\nUpdated body.',
            rationale: 'Verified in production',
            status: proposalStatus,
            status_reason: null,
            decided_at: proposalStatus === 'applied' ? AT : null,
            decided_by: proposalStatus === 'applied' ? 'console' : null,
            applied_commit: proposalStatus === 'applied' ? '9988776655443322' : null,
          },
        ],
        projects: [{ id: 'p1', name: 'ClusterOps' }, { id: 'p2', name: 'MarketData' }],
      };
    }
    if (call.method === 'GET' && call.path === '/api/wiki/vaults/v1/pages') {
      return {
        pages: [
          {
            vault_id: 'v1',
            page_id: 'cgroup-v2',
            path: 'cgroup-v2.md',
            title: 'Cgroup v2 Memory Guardrail',
            summary: 'Memory cap details',
            body: '# Cgroup v2 Memory Guardrail\n\nLeaf cgroup notes.',
            owner: 'ops-team',
            scope: 'cluster',
            status: 'active',
            search_phrases: ['memory.max'],
            sources: [],
            links: ['clickhouse'],
            locked_sections: ['## My Notes\nDo not overwrite'],
            content_sha256: 'deadbeef',
            commit_sha: 'abcdef1234567890',
            mutation_version: 1,
            dirty: false,
            updated_at: AT,
          },
        ],
      };
    }
    if (call.method === 'GET' && call.path.startsWith('/api/wiki/vaults/v1/page')) {
      return {
        vault_id: 'v1',
        vault_name: 'Infra Wiki',
        page_id: 'cgroup-v2',
        path: 'cgroup-v2.md',
        title: 'Cgroup v2 Memory Guardrail',
        summary: 'Memory cap details',
        body: '# Cgroup v2 Memory Guardrail\n\nLeaf cgroup notes.',
        owner: 'ops-team',
        scope: 'cluster',
        status: 'active',
        search_phrases: ['memory.max'],
        sources: [],
        links: ['clickhouse'],
        backlinks: ['overview'],
        locked_sections: ['## My Notes\nDo not overwrite'],
        content_sha256: 'deadbeef',
        commit_sha: 'abcdef1234567890',
        mutation_version: 1,
        dirty: false,
        updated_at: AT,
      };
    }
    if (call.method === 'GET' && call.path === '/api/wiki/vaults/v1/lint') {
      return { vault_id: 'v1', commit_sha: 'abcdef1234567890', checked_pages: 1, issues: [] };
    }
    if (call.method === 'GET' && call.path.startsWith('/api/wiki/search')) {
      return {
        hits: [
          {
            vault_id: 'v1',
            vault_name: 'Infra Wiki',
            page_id: 'cgroup-v2',
            path: 'cgroup-v2.md',
            title: 'Cgroup v2 Memory Guardrail',
            summary: 'Memory cap details',
            owner: 'ops-team',
            scope: 'cluster',
            status: 'active',
            commit_sha: 'abcdef1234567890',
            score: 1.2,
            coverage: 1,
          },
        ],
      };
    }
    if (call.method === 'POST' && call.path === '/api/wiki/proposals/wp1/decide') {
      proposalStatus = 'applied';
      return { proposal: { id: 'wp1', status: 'applied', applied_commit: '9988776655443322' } };
    }
    return undefined;
  });

  expect(await screen.findByRole('heading', { name: 'Infra Wiki' })).toBeInTheDocument();
  expect(await screen.findByText('含 1 处人类锁定区块')).toBeInTheDocument();
  expect(screen.getByText('反向引用（1）:')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '健康巡检' }));
  expect(await screen.findByText(/全部页面健康/)).toBeInTheDocument();

  await user.type(screen.getByRole('searchbox', { name: '检索领域 Wiki' }), 'cgroup');
  await user.click(screen.getByRole('button', { name: '检索' }));
  expect(await screen.findByText('命中 1 页')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '审批并写入 Git' }));
  expect(await screen.findByText(/已审批并提交到 Git 仓库（99887766）/)).toBeInTheDocument();
  expect(calls.some((c) => c.method === 'POST' && c.path === '/api/wiki/proposals/wp1/decide')).toBe(true);
});

test('Knowledge Access tab supports token rotation, telemetry, Streamable HTTP snippets, JSONL preview, and dotfiles boundary', async () => {
  const { user, calls } = open('#/knowledge?view=access', (call) => {
    if (call.method === 'GET' && call.path === '/api/knowledge') return baseKnowledgeResponse();
    if (call.method === 'GET' && call.path === '/api/accounts') return { accounts: [] };
    if (call.method === 'GET' && call.path === '/api/machines') return { machines: [], invites: [] };
    if (call.method === 'GET' && call.path === '/api/knowledge/dotfiles-boundary') {
      return {
        home_dir: '/home/dev',
        chezmoi_detected: true,
        items: [
          {
            executor: 'claude',
            path: '/home/dev/.claude/CLAUDE.md',
            ownership: 'coexist_block',
            detail: '和平共存模式',
          },
        ],
      };
    }
    if (call.method === 'POST' && call.path === '/api/knowledge/clients/c1/rotate') {
      return { token: 'tk-rotated-9999' };
    }
    if (call.method === 'POST' && call.path === '/api/knowledge/import.jsonl') {
      const body = call.body as { dry_run: boolean };
      return {
        dry_run: body.dry_run,
        total: 1,
        created: 1,
        skipped: 0,
        invalid: 0,
        items: [{ line: 2, source_id: 'k1', title: 'Exported Rule', action: 'create' }],
      };
    }
    return undefined;
  });

  expect(await screen.findByText('检测到 chezmoi')).toBeInTheDocument();
  expect(screen.getByText('已调用 14 次')).toBeInTheDocument();
  expect(screen.getByText('http://127.0.0.1:4100/api/knowledge/mcp/stream')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '轮换令牌' }));
  const dialog = screen.getByRole('alertdialog', { name: '轮换 workstation-claude 的令牌？' });
  await user.click(within(dialog).getByRole('button', { name: '确认轮换' }));
  expect(await screen.findByText('已为 workstation-claude 签发新令牌，旧令牌已失效。')).toBeInTheDocument();
  expect(screen.getAllByText('tk-rotated-9999').length).toBeGreaterThan(0);

  await user.click(screen.getByRole('tab', { name: 'Streamable HTTP' }));
  expect(screen.getByText(/"type": "http"/)).toBeInTheDocument();

  const portable = screen.getByRole('region', { name: '知识与技能 JSONL 便携导入导出' });
  const jsonlBox = within(portable).getByLabelText('粘贴或上传 JSONL 文件');
  await user.click(jsonlBox);
  await user.paste('{"type":"header"}');
  await user.click(within(portable).getByRole('button', { name: '干跑预览' }));
  expect(await within(portable).findByText(/将新增 1 条/)).toBeInTheDocument();
  await user.click(within(portable).getByRole('button', { name: '确认导入（1 条新增）' }));
  await waitFor(() => expect(calls.some((c) => c.path === '/api/knowledge/import.jsonl' && (c.body as { dry_run: boolean }).dry_run === false)).toBe(true));
});

test('Project Collaboration tab shows authorized Wiki vaults, cross-project refs with copy notice, and task contracts', async () => {
  const { user, calls } = open('#/projects/p1/collaboration', (call) => {
    if (call.method === 'GET' && call.path === '/api/projects') {
      return {
        projects: [
          { id: 'p1', name: 'ClusterOps', sources: [], logins: [], login_mode: 'all', machines: [], spawn_machines: false, moving: 0, waiting: 0 },
          { id: 'p2', name: 'MarketData', sources: [], logins: [], login_mode: 'all', machines: [], spawn_machines: false, moving: 0, waiting: 0 },
        ],
      };
    }
    if (call.method === 'GET' && call.path === '/api/tasks?top=1') {
      return {
        tasks: [
          { id: 't1', project_id: 'p1', title: 'Produce Schema', state: 'running', parent_id: null, created_at: AT, updated_at: AT },
          { id: 't2', project_id: 'p1', title: 'Consume Schema', state: 'queued', parent_id: null, created_at: AT, updated_at: AT },
        ],
        children: [],
      };
    }
    if (call.method === 'GET' && call.path === '/api/projects/p1/collaboration') {
      return {
        wiki_vaults: [
          {
            id: 'v1',
            created_at: AT,
            updated_at: AT,
            name: 'Infra Wiki',
            description: '',
            repo_path: '/srv/wiki/infra',
            branch: 'main',
            published_commit: 'abcdef12',
            last_synced_at: AT,
            sync_error: null,
            grant: { vault_id: 'v1', project_id: 'p1', created_at: AT, pinned_commit: null, can_propose: true, granted_by: 'console' },
            effective_commit: 'abcdef12',
            page_count: 3,
          },
        ],
        incoming_refs: [],
        outgoing_refs: [
          {
            id: 'r1',
            created_at: AT,
            source_project_id: 'p1',
            target_project_id: 'p2',
            ref_kind: 'knowledge',
            source_ref_id: 'k1',
            pinned_version: 'rev:2',
            title: 'Cluster SLA Contract',
            summary: '99.95% uptime target',
            content_sha256: '1234567890abcdef',
            frozen_bytes: 256,
            granted_by: 'console',
            revoked_at: null,
            revoked_by: null,
            revoke_reason: null,
          },
        ],
        contracts: [
          {
            id: 'ct1',
            created_at: AT,
            updated_at: AT,
            project_id: 'p1',
            producer_task_id: 't1',
            consumer_task_id: 't2',
            contract_name: 'dnob-schema',
            artifact_path: 'artifacts/dnob.json',
            registered_version: 1,
            status: 'blocked',
            delivered_run_id: null,
            delivered_sha256: null,
            delivery_summary: null,
            clarifications: [
              { id: 'cl1', at: AT, by: 'consumer', producer_revision: 1, contract_version: 1, question: 'Is level 10 nullable?' },
            ],
            coalesced_revision: 1,
            notified_version: 1,
          },
        ],
      };
    }
    if (call.method === 'GET' && call.path === '/api/projects/p1/files') return { files: [] };
    if (call.method === 'GET' && call.path === '/api/knowledge') return baseKnowledgeResponse();
    if (call.method === 'POST' && call.path === '/api/projects/p1/contracts/ct1/clarify') return { contract: { id: 'ct1' } };
    return undefined;
  });

  expect(await screen.findByText('Infra Wiki')).toBeInTheDocument();
  expect(screen.getByText('Cluster SLA Contract')).toBeInTheDocument();
  expect(screen.getByText('dnob-schema')).toBeInTheDocument();
  expect(screen.getByText('Q: Is level 10 nullable?')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '向其他项目授予只读引用' }));
  expect(await screen.findByText(/副本传递声明/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '取消' }));

  await user.click(screen.getByRole('button', { name: '回复澄清' }));
  const modal = screen.getByRole('dialog');
  await user.type(within(modal).getByRole('textbox'), 'No, always numeric.');
  await user.click(within(modal).getByRole('button', { name: '确认' }));
  await waitFor(() => expect(calls.some((c) => c.path === '/api/projects/p1/contracts/ct1/clarify')).toBe(true));
});
