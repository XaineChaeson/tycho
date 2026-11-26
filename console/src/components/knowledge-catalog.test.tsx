import { screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { DirectorySkill, EffectiveContextReport, SkillRegistryBinding } from '@shared/skill-catalog.ts';
import type { KnowledgeEntry, KnowledgePage } from '@/lib/types';
import { open, type Handler } from '@/test/harness';

const AT = '2026-11-09T01:00:00Z';
const PROJECTS = [{ id: 'p1', name: '发布平台' }, { id: 'p2', name: '数据平台' }];
const ROLES = [{ id: 'implement', name: '实现' }, { id: 'analyse', name: '分析' }];
const MACHINES = [{ id: 'work-pc', host: 'work.local' }, { id: 'home-linux', host: 'home.local' }];
const ENTRY: KnowledgeEntry = {
  id: 'k1', revision: 1, kind: 'knowledge', title: '发布准则', when_to_use: 'release: 准备发版',
  body: '先核对交付物。', project_ids: ['p1'], loading: 'resident', roles: ['analyse'],
  proposal_id: 'proposal-1', published_by: 'console', published_at: AT, reviewed_at: AT,
  created_at: AT, state: 'active', retired_at: null, retired_by: null, retired_reason: null, replaced_by: null,
};
const BODY = '## 核对步骤\n\n先读 **发布清单**。';
const SKILL: DirectorySkill = {
  id: 'dir-alpha-skill', slug: 'alpha-skill', name: 'Alpha Skill', description: 'release: 核对发布清单',
  body: BODY, bytes: new TextEncoder().encode(BODY).length, sha256: 'abcdef012345',
  rel_path: 'skills/alpha-skill/SKILL.md', managed_ledger_id: null,
  binding: { enabled: true, loading: 'on_demand', project_ids: null, roles: [], machine_ids: null },
};

function service(answer: Handler = () => undefined): Handler {
  let binding = SKILL.binding;
  let entryMachines: Record<string, string[] | null> = {};
  return (call) => {
    if (call.method === 'GET' && call.path === '/api/knowledge') {
      return {
        entries: [ENTRY],
        directory_skills: [
          { ...SKILL, binding },
          { ...SKILL, id: 'dir-release-policy', slug: 'release-policy', name: ENTRY.title, managed_ledger_id: ENTRY.id },
        ],
        ignored_skills: [{ name: 'legacy', reason: '目录内缺少 SKILL.md（已忽略）' }],
        skills_dir: '/data/skills',
        entry_machines: entryMachines,
        machines: MACHINES,
        projects: PROJECTS, roles: ROLES, proposals: [], awaiting: [], to_review: [],
        clients: [], executors: [], legacy: [], skill_folder: '/data/skills',
      } satisfies KnowledgePage;
    }
    if (call.method === 'PUT' && call.path === '/api/knowledge/registry/alpha-skill') {
      binding = call.body as SkillRegistryBinding;
      return { slug: SKILL.slug, binding };
    }
    if (call.method === 'PUT' && call.path === '/api/knowledge/entries/k1/machines') {
      const { machine_ids } = call.body as { machine_ids: string[] | null };
      entryMachines = { ...entryMachines, k1: machine_ids };
      return { entry_id: 'k1', machine_ids };
    }
    return answer(call);
  };
}

test('the unified catalog searches both sources and filters by loading, scope and role', async () => {
  const { user } = open('#/knowledge?view=entries', service());
  const catalog = within(await screen.findByRole('region', { name: '知识与技能目录' }));
  const ledgerRow = () => catalog.queryByRole('button', { name: /发布准则/ });
  const directoryRow = () => catalog.queryByRole('button', { name: /Alpha Skill/ });
  expect(within(ledgerRow()!).getByText(ENTRY.when_to_use)).toBeVisible();
  expect(within(directoryRow()!).getByText(SKILL.description)).toBeVisible();

  const search = catalog.getByRole('textbox', { name: '搜索知识与技能' });
  await user.type(search, 'release');
  expect(ledgerRow()).toBeVisible();
  expect(directoryRow()).toBeVisible();
  await user.type(search, ' alpha');
  expect(ledgerRow()).not.toBeInTheDocument();
  expect(directoryRow()).toBeVisible();
  await user.clear(search);

  const loading = within(catalog.getByRole('radiogroup', { name: '加载方式筛选' }));
  await user.click(loading.getByRole('radio', { name: '常驻' }));
  expect(ledgerRow()).toBeVisible();
  expect(directoryRow()).not.toBeInTheDocument();
  await user.click(loading.getByRole('radio', { name: '全部' }));

  const scope = catalog.getByRole('combobox', { name: '作用域筛选' });
  await user.selectOptions(scope, 'p1');
  expect(ledgerRow()).toBeVisible();
  expect(directoryRow()).not.toBeInTheDocument();
  await user.selectOptions(scope, '');

  const role = catalog.getByRole('combobox', { name: '职能筛选' });
  await user.selectOptions(role, 'analyse');
  expect(ledgerRow()).toBeVisible();
  expect(directoryRow()).not.toBeInTheDocument();
  await user.selectOptions(role, 'implement');
  expect(ledgerRow()).not.toBeInTheDocument();

  const summary = catalog.getByText('技能目录里略过 1 项非标准内容');
  const details = summary.closest('details')!;
  expect(details).not.toHaveAttribute('open');
  await user.click(summary);
  expect(details).toHaveAttribute('open');
  expect(within(details).getByText('legacy')).toBeVisible();
  expect(within(details).getByText(/缺少 SKILL.md/)).toBeVisible();
  expect(catalog.queryByRole('alert')).not.toBeInTheDocument();
  await user.click(summary);
  expect(details).not.toHaveAttribute('open');
});

test('the directory preview renders Markdown and saves the exact dispatch binding', async () => {
  const { user, calls } = open('#/knowledge?view=entries', service());
  await user.click(await screen.findByRole('button', { name: /Alpha Skill/ }));
  const sheet = within(await screen.findByRole('dialog', { name: SKILL.name }));
  expect(sheet.getByRole('heading', { name: '核对步骤' })).toBeVisible();
  expect(sheet.getByText('发布清单', { selector: 'strong' })).toBeVisible();
  expect(sheet.getByText(/Tycho 派发轮次的注入范围.*不修改 SKILL\.md/)).toBeVisible();

  const save = sheet.getByRole('button', { name: '保存配置' });
  expect(save).toBeDisabled();
  await user.click(within(sheet.getByRole('radiogroup', { name: '加载方式' })).getByRole('radio', { name: '常驻' }));
  await user.click(sheet.getByRole('switch', { name: '参与 Tycho 派发注入' }));
  await user.click(within(sheet.getByRole('radiogroup', { name: '作用域' })).getByRole('radio', { name: '指定项目' }));
  expect(save).toBeDisabled();
  await user.click(sheet.getByRole('checkbox', { name: '发布平台' }));
  await user.click(sheet.getByRole('checkbox', { name: '分析' }));
  await user.click(save);

  expect(await sheet.findByText('已保存派发注入配置。')).toBeVisible();
  expect(calls).toEqual([{
    method: 'PUT', path: '/api/knowledge/registry/alpha-skill',
    body: { enabled: false, loading: 'resident', project_ids: ['p1'], roles: ['analyse'], machine_ids: null },
  }]);
  await waitFor(() => expect(save).toBeDisabled());
});

test('the effective view fetches each selected context and displays both byte budgets', async () => {
  const warning = '快照里的知识与技能文件超过上限';
  const { user, reads } = open('#/knowledge?view=effective', service(({ method, path }) => {
    if (method !== 'GET' || !path.startsWith('/api/knowledge/effective?')) return undefined;
    const params = new URLSearchParams(path.split('?')[1]);
    const projectId = params.get('project_id');
    const roleId = params.get('role_id');
    const machineId = params.get('machine_id');
    const matched = projectId === 'p2' && roleId === 'analyse';
    return {
      project_id: projectId, project_name: PROJECTS.find(({ id }) => id === projectId)?.name ?? null,
      role_id: roleId, role_name: ROLES.find(({ id }) => id === roleId)?.name ?? null,
      machine_id: machineId, machine_host: MACHINES.find(({ id }) => id === machineId)?.host ?? null,
      resident: matched ? [{
        id: ENTRY.id, title: ENTRY.title, when_to_use: ENTRY.when_to_use, loading: 'resident',
        origin: 'ledger', kind: 'knowledge', project_ids: null, roles: [], machine_ids: null, revision: 1, slug: null, bytes: 42,
      }] : [],
      on_demand: matched ? [{
        id: SKILL.id, title: SKILL.name, when_to_use: SKILL.description, loading: 'on_demand',
        origin: 'directory', kind: 'skill', project_ids: null, roles: [], machine_ids: null, revision: null, slug: SKILL.slug, bytes: SKILL.bytes,
      }] : [],
      budget: {
        brief_bytes: matched ? 1024 : 0, brief_limit_bytes: 2048,
        snapshot_bytes: matched ? 3072 : 0, snapshot_limit_bytes: 2048, over_limit: matched ? warning : null,
      },
    } satisfies EffectiveContextReport;
  }));

  const panel = within(await screen.findByRole('region', { name: '生效上下文预览' }));
  expect(await panel.findByText('这个组合下没有生效的知识或技能')).toBeVisible();
  expect(reads).toContain('/api/knowledge/effective?project_id=p1');
  await user.selectOptions(panel.getByRole('combobox', { name: '项目' }), 'p2');
  await waitFor(() => expect(reads).toContain('/api/knowledge/effective?project_id=p2'));
  await user.selectOptions(panel.getByRole('combobox', { name: '职能' }), 'analyse');
  expect(await panel.findByRole('alert')).toHaveTextContent(warning);
  expect(reads).toContain('/api/knowledge/effective?project_id=p2&role_id=analyse');

  const resident = within(panel.getByRole('region', { name: /常驻全文/ }));
  const demand = within(panel.getByRole('region', { name: /按需目录/ }));
  expect(resident.getByRole('link', { name: ENTRY.title })).toBeVisible();
  expect(demand.getByText(SKILL.name)).toBeVisible();
  expect(demand.getByText(SKILL.rel_path)).toBeVisible();
  expect(panel.getByRole('progressbar', { name: 'brief 知识区', value: { now: 1024, max: 2048 } })).toBeVisible();
  expect(panel.getByRole('progressbar', { name: '快照附件文件', value: { now: 3072, max: 2048 } })).toBeVisible();
  expect(panel.getByText('1.0 / 2 KiB')).toBeVisible();
  expect(panel.getByText('3.0 / 2 KiB')).toBeVisible();

  await user.selectOptions(panel.getByRole('combobox', { name: '目标机器' }), 'work-pc');
  await waitFor(() => expect(reads).toContain('/api/knowledge/effective?project_id=p2&role_id=analyse&machine_id=work-pc'));
});

test('both directory skills and ledger entries can edit their machine distribution scope from the catalog', async () => {
  const { user, calls } = open('#/knowledge?view=entries', service());
  await user.click(await screen.findByRole('button', { name: /Alpha Skill/ }));
  const skillSheet = within(await screen.findByRole('dialog', { name: SKILL.name }));
  await user.click(within(skillSheet.getByRole('radiogroup', { name: '分发机器' })).getByRole('radio', { name: '指定机器' }));
  await user.click(skillSheet.getByRole('checkbox', { name: /work-pc/ }));
  await user.click(skillSheet.getByRole('button', { name: '保存配置' }));
  expect(await skillSheet.findByText('已保存派发注入配置。')).toBeVisible();
  expect(calls[0]).toEqual({
    method: 'PUT', path: '/api/knowledge/registry/alpha-skill',
    body: { enabled: true, loading: 'on_demand', project_ids: null, roles: [], machine_ids: ['work-pc'] },
  });
  await user.keyboard('{Escape}');

  await user.click(await screen.findByRole('button', { name: /发布准则/ }));
  const entrySheet = within(await screen.findByRole('dialog', { name: ENTRY.title }));
  await user.click(within(entrySheet.getByRole('radiogroup', { name: '可用机器' })).getByRole('radio', { name: '指定机器' }));
  await user.click(entrySheet.getByRole('checkbox', { name: /home-linux/ }));
  await user.click(entrySheet.getByRole('button', { name: '保存机器范围' }));
  await waitFor(() => expect(calls[1]).toEqual({
    method: 'PUT', path: '/api/knowledge/entries/k1/machines',
    body: { machine_ids: ['home-linux'] },
  }));
});

test('Ctrl+K finds ledger entries and directory skills and opens the selected skill preview', async () => {
  const { user } = open('#/', service());
  await user.keyboard('{Control>}k{/Control}');
  const palette = within(await screen.findByRole('dialog', { name: '搜索或跳转' }));
  expect(await palette.findByRole('option', { name: /发布准则/ })).toBeVisible();
  await user.type(palette.getByRole('combobox', { name: '搜索或跳转' }), SKILL.name);
  expect(palette.queryByRole('option', { name: /发布准则/ })).not.toBeInTheDocument();
  await user.click(await palette.findByRole('option', { name: /Alpha Skill/ }));

  expect(await screen.findByRole('dialog', { name: SKILL.name })).toBeVisible();
  expect(window.location.hash).toBe('#/knowledge?view=entries&select=dir-alpha-skill');
});

test('wide master-detail rail omits redundant descriptions and shows compact meta info', async () => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === '(min-width: 1024px)',
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  try {
    open('#/knowledge?view=entries', service());
    const catalog = within(await screen.findByRole('region', { name: '知识与技能目录' }));
    const skillRow = await catalog.findByRole('button', { name: /Alpha Skill/ });
    // Left rail stays compact with signal-first meta info (no redundant description, no internal storage jargon)
    expect(within(skillRow).queryByText(SKILL.description)).not.toBeInTheDocument();
    expect(within(skillRow).queryByText(/目录/)).not.toBeInTheDocument();
    expect(within(skillRow).queryByText(/不限职能/)).not.toBeInTheDocument();
    expect(within(skillRow).getByText('全机')).toBeVisible();
    expect(within(skillRow).getByText('技能')).toBeVisible();
    // Right detail pane displays the description for the active item
    expect(catalog.getByText(SKILL.description)).toBeVisible();
  } finally {
    window.matchMedia = originalMatchMedia;
  }
});
