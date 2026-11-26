// How a project is set up: its name, where its code is on this host, which logins its tasks may
// run as, which machines its work may go to, whether its tasks may bring in
// machines of their own, and what its Router may do without asking. Nothing of those is saved
// until "保存": what was changed waits in a bar under them, with the way to drop it. Things not
// part of that draft act at once: the pause, the archive, and the delete of an empty or archived
// project once its name is typed again. The project's standing rules are knowledge entries,
// edited directly in place.
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowDown, ArrowUp, BookOpen, FolderGit2, MessageSquare, RotateCcw, Server, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { loginName } from '@shared/logins.ts';
import { TIER_IDS, TIERS, tierLabel, tierValueFrom, type TierId } from '@shared/tiers.ts';
import { PROJECT_ARCHIVED_LABEL, PROJECT_PAUSED_LABEL } from '@shared/labels.ts';
import { GRANT_IDS, GRANTS } from '@shared/grants.ts';
import { Callout, Card, Dot, Mono, Note, Problem, Rows, Time } from '@/components/bits';
import { DeleteProjectDialog } from '@/components/delete-project-dialog';
import { ProjectGroupsPanel } from '@/components/project-groups-panel';
import { ProjectRules } from '@/components/project-rules';
import { CODE_SOURCE_HINT, SourceEditor } from '@/components/source-list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, Choice, Radio } from '@/components/ui/checkbox';
import { Confirm } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Option, Select } from '@/components/ui/select';
import { useChange } from '@/hooks/use-change';
import { useProjectFlag } from '@/hooks/use-project-flag';
import { messageOf, put } from '@/lib/api';
import { changed, draftOf, machinesGoneText, machinesMoved, moveItem, projectBody, sameNames, withName, withoutName, withProject, type ProjectDraft } from '@/lib/projects';
import { accountsQuery, projectsQuery } from '@/lib/queries';
import { loginChoices } from '@/lib/logins';
import type { AccountsAndMachines, Project } from '@/lib/types';
import { cn } from '@/lib/utils';

const CHANGE = ['project-change'];

type SettingsTabId = 'basic' | 'router' | 'compute' | 'channels' | 'rules' | 'lifecycle';

function sourcesChanged(baseline: ProjectDraft['sources'], next: ProjectDraft['sources']): boolean {
  if (next.length !== baseline.length) return true;
  return next.some((item, index) => {
    const held = baseline[index]!;
    if (item.id !== held.id || item.kind !== held.kind) return true;
    if (item.kind === 'repo') return held.kind !== 'repo' || item.url.trim() !== held.url;
    return held.kind !== 'folder' || item.machine_uid !== held.machine_uid || item.path.trim() !== held.path;
  });
}

function sameGrantSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((each) => b.includes(each));
}

type ProjectDispatchOrder = Partial<Record<TierId, string[]>> | null;

function sameDispatchOrder(a: ProjectDispatchOrder, b: ProjectDispatchOrder): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return TIER_IDS.every((tier) => sameNames(a[tier] ?? [], b[tier] ?? []));
}

interface LoginMeta {
  id: string;
  name: string;
  shortLabel: string;
  executor?: string;
  tiers: TierId[];
  supportsTier: (tierId: TierId) => boolean;
}

function buildLoginMetaMap(options: AccountsAndMachines | undefined): Map<string, LoginMeta> {
  const map = new Map<string, LoginMeta>();
  if (!options) return map;
  const tiersOf = (raw: Record<string, unknown> | undefined): { configured: TierId[]; supports: (tierId: TierId) => boolean } => {
    const safe = raw ?? {};
    const configured = TIERS.filter((tier) => Boolean(safe[tier.id])).map((tier) => tier.id);
    const supports = (tierId: TierId): boolean =>
      tierValueFrom(safe as Record<string, { kind: string; text: string } | undefined>, tierId) !== undefined
      || Boolean(safe[tierId]);
    return { configured, supports };
  };
  for (const account of options.accounts) {
    const info = tiersOf(account.tiers as Record<string, unknown> | undefined);
    const name = loginName({ name: account.name });
    map.set(account.id, {
      id: account.id,
      name,
      shortLabel: name,
      executor: account.executor,
      tiers: info.configured,
      supportsTier: info.supports,
    });
  }
  for (const machine of options.machines) {
    for (const login of machine.logins ?? []) {
      if (!login.configured || login.id === null) continue;
      const info = tiersOf(login.tiers as Record<string, unknown> | undefined);
      const label = login.account_label ?? (login.route_label ? `线路 ${login.route_label}` : undefined);
      const full = loginName({ name: login.name, machine: machine.id, executor: login.executor });
      const short = [label, login.executor, machine.id].filter(Boolean).join(' · ');
      map.set(login.id, {
        id: login.id,
        name: full,
        shortLabel: short || full,
        executor: login.executor,
        tiers: info.configured,
        supportsTier: info.supports,
      });
    }
  }
  return map;
}

function dirtyTabsOf(
  project: Project,
  draft: ProjectDraft | null,
  dispatchOrderDirty: boolean,
): Record<SettingsTabId, boolean> {
  if (draft === null) {
    return { basic: false, router: false, compute: dispatchOrderDirty, channels: false, rules: false, lifecycle: false };
  }
  const baseline = draftOf(project);
  return {
    basic: draft.name.trim() !== baseline.name || sourcesChanged(baseline.sources, draft.sources),
    router: baseline.router?.account !== draft.router?.account
      || baseline.router?.tier !== draft.router?.tier
      || !sameGrantSet(baseline.grants, draft.grants),
    compute: draft.loginMode !== baseline.loginMode
      || !sameNames(baseline.logins, draft.logins)
      || machinesMoved(project, draft)
      || draft.spawnMachines !== baseline.spawnMachines
      || dispatchOrderDirty,
    channels: false,
    rules: false,
    lifecycle: false,
  };
}

function SettingsGroup({ tabId, title, caption, children }: {
  tabId: SettingsTabId;
  title: string;
  caption: string;
  children: ReactNode;
}) {
  return (
    <Card
      role="tabpanel"
      id={`project-settings-panel-${tabId}`}
      aria-labelledby={`project-settings-tab-${tabId}`}
      className="p-5"
    >
      <header className="mb-1 border-b border-border/80 pb-3.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{caption}</p>
      </header>
      <div>{children}</div>
    </Card>
  );
}

// One thing about the project: what it is and what it means on the left, the control that
// sets it on the right (under it, where there is no room beside).
function Setting({ label, title, hint, danger = false, children }: {
  label: string;
  title: string;
  hint: ReactNode;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        'grid gap-x-8 gap-y-3 border-b border-border/60 py-4 last:border-b-0 last:pb-0 sm:grid-cols-[200px_minmax(0,1fr)] wide:grid-cols-[220px_minmax(0,1fr)]',
        danger && '-mx-2 mt-2 rounded-lg border border-failed-border/70 bg-failed-soft/35 px-3 py-3.5 last:border-b',
      )}
    >
      <div>
        <h3 className={cn('text-sm font-semibold', danger && 'text-destructive')}>{title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

// The list only says which logins a project may use; which one comes first is the tier's
// own order, set on the accounts page (roles-and-tiers.md §11). Ticking is the whole edit.
// A login the project names stays on the list while the page cannot read all of them, and one
// deleted since is still shown as such: hiding either would let a save of another field drop
// a choice the owner never saw.
type LoginRow = {
  id: string;
  name: string;
  executor?: string;
  tiers?: TierId[];
  unread?: boolean;
};

function LoginChoice({ login, checked, busy, readOnly = false, onToggle }: { login: LoginRow; checked: boolean; busy: boolean; readOnly?: boolean; onToggle: (on: boolean) => void }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
      <Choice className="min-h-0 min-w-0 flex-1">
        <Checkbox checked={checked} disabled={busy || readOnly} onChange={(event) => onToggle(event.target.checked)} />
        <span className="min-w-0 text-sm wrap-anywhere">{login.name}</span>
      </Choice>
      {login.executor || (login.tiers && login.tiers.length > 0) ? (
        <span className="flex flex-none flex-wrap items-center gap-1">
          {login.executor ? (
            <Mono className="rounded bg-hover px-1.5 py-0.5 text-2xs text-muted-foreground">{login.executor}</Mono>
          ) : null}
          {login.tiers?.map((tierId) => (
            <Badge key={tierId} tone="plain" className="min-h-4 px-1.5 py-0 text-2xs leading-3.5">
              {tierLabel(tierId)}
            </Badge>
          ))}
        </span>
      ) : null}
    </li>
  );
}

export function ProjectSettings({ project }: { project: Project }) {
  const { data: options } = useQuery(accountsQuery);
  const navigate = useNavigate();
  const change = useChange<Project[]>({ mutationKey: CHANGE, queryKey: projectsQuery.queryKey, reread: true });
  // Null until something is edited: the page then shows the project as the service has it,
  // and follows it as it changes.
  const [draft, setDraft] = useState<ProjectDraft | null>(null);
  const [dispatchOrderDraft, setDispatchOrderDraft] = useState<ProjectDispatchOrder | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmUnrestricted, setConfirmUnrestricted] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTabId>('basic');
  useEffect(() => {
    setDispatchOrderDraft(undefined);
  }, [project.id]);
  const baseline = draftOf(project);
  const shown = draft ?? baseline;
  const baselineDispatchOrder: ProjectDispatchOrder = project.dispatch_order ?? null;
  const shownDispatchOrder: ProjectDispatchOrder = dispatchOrderDraft !== undefined ? dispatchOrderDraft : baselineDispatchOrder;
  const dispatchOrderDirty = dispatchOrderDraft !== undefined && !sameDispatchOrder(baselineDispatchOrder, dispatchOrderDraft);
  const baseDirty = draft !== null && changed(project, draft);
  const dirty = baseDirty || dispatchOrderDirty;
  const tabDirty = dirtyTabsOf(project, draft, dispatchOrderDirty);

  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
  const allLogins = loginChoices(options);
  const metaByLoginId = buildLoginMetaMap(options);
  const controllerLogins = options ? [
    ...options.accounts.filter((login) => login.can_route),
    ...options.machines.flatMap((machine) => (machine.logins ?? []).filter((login) => login.can_route && login.configured && login.id !== null)),
  ] : [];
  const controller = controllerLogins.find(({ id }) => id === shown.router?.account);
  // Every login there is once the list has been read; until then, and when reading it failed,
  // the project's own ids are all that is known. Either way a login the project names that is
  // no longer there is one more row, marked as deleted.
  const loginRows: LoginRow[] = options === undefined
    ? shown.logins.map((id) => ({ id, name: '登录信息未读到', unread: true }))
    : [
        ...allLogins.map((login) => {
          const meta = metaByLoginId.get(login.id);
          return {
            id: login.id,
            name: loginName(login),
            executor: meta?.executor,
            tiers: meta?.tiers,
          };
        }),
        ...shown.logins.filter((id) => !allLogins.some((login) => login.id === id)).map((id) => ({ id, name: '已删除的登录' })),
      ];

  const allowedLoginIds: Set<string> | null = shown.loginMode === 'selected'
    ? new Set(shown.logins)
    : options !== undefined
      ? new Set(allLogins.map((each) => each.id))
      : project.pool
        ? new Set(project.pool)
        : null;

  const loginLabelFor = (id: string): { name: string; shown: string } => {
    const meta = metaByLoginId.get(id);
    if (meta) return { name: meta.name, shown: meta.shortLabel };
    const choice = allLogins.find((each) => each.id === id);
    if (choice) {
      const full = loginName(choice);
      return { name: full, shown: full };
    }
    return { name: options === undefined ? id : '已删除的登录', shown: options === undefined ? id : '已删除的登录' };
  };

  const resolveTierOrder = (tierId: TierId, source: Partial<Record<TierId, string[]>> | null | undefined): string[] => {
    const seed = source?.[tierId]
      ?? project.effective_dispatch_order?.[tierId]
      ?? options?.dispatch_order?.[tierId]
      ?? [];
    const seen = new Set<string>();
    const list: string[] = [];
    for (const id of seed) {
      if (seen.has(id)) continue;
      if (allowedLoginIds !== null && !allowedLoginIds.has(id)) continue;
      const meta = metaByLoginId.get(id);
      if (meta && !meta.supportsTier(tierId)) continue;
      seen.add(id);
      list.push(id);
    }
    if (options !== undefined) {
      for (const login of allLogins) {
        if (seen.has(login.id)) continue;
        if (allowedLoginIds !== null && !allowedLoginIds.has(login.id)) continue;
        const meta = metaByLoginId.get(login.id);
        if (meta && !meta.supportsTier(tierId)) continue;
        seen.add(login.id);
        list.push(login.id);
      }
    }
    return list;
  };

  const effectivePreviewOrder: Record<TierId, string[]> = {
    operate: resolveTierOrder('operate', project.effective_dispatch_order ?? options?.dispatch_order),
    execute: resolveTierOrder('execute', project.effective_dispatch_order ?? options?.dispatch_order),
    decide: resolveTierOrder('decide', project.effective_dispatch_order ?? options?.dispatch_order),
  };

  const customTierOrder: Record<TierId, string[]> = {
    operate: resolveTierOrder('operate', shownDispatchOrder),
    execute: resolveTierOrder('execute', shownDispatchOrder),
    decide: resolveTierOrder('decide', shownDispatchOrder),
  };

  const moveCustomTier = (tierId: TierId, from: number, to: number): void => {
    const next: Record<TierId, string[]> = {
      ...customTierOrder,
      [tierId]: moveItem(customTierOrder[tierId], from, to),
    };
    setDispatchOrderDraft(next);
  };
  // Until the machines have been read, the ones the project itself names is what is known.
  const allMachines = options?.machines.map(({ uid, id }) => ({ uid, name: id })) ?? project.machines;
  const busy = change.busy || saving;
  const edit = (patch: Partial<ProjectDraft>): void => setDraft({ ...shown, ...patch });
  const pause = useProjectFlag(project, 'paused');
  const archive = useProjectFlag(project, 'archived');
  const notDone = project.unfinished ?? project.moving + project.waiting;
  // What deleting would take, as the service counts it; the same answer tells whether the
  // section offers the step at all.
  const deletion = project.deletable;
  const archiveNote = '收起来不再接活，侧栏和企微里不再出现，记录都保留，随时可以恢复'
    + (notDone > 0 ? `。还有 ${notDone} 项工作没结束：在跑的那一轮会做完，其余停在原地，恢复后接着做` : '');
  const hasRouterGroup = Boolean(shown.router || project.grants);
  const currentTab: SettingsTabId = !hasRouterGroup && activeTab === 'router' ? 'basic' : activeTab;

  const tabs: { id: SettingsTabId; label: string; icon: ComponentType<{ className?: string }> }[] = [
    { id: 'basic', label: '基础与代码', icon: FolderGit2 },
    ...(hasRouterGroup ? [{ id: 'router' as const, label: '负责人与权限', icon: ShieldCheck }] : []),
    { id: 'compute', label: '登录与机器', icon: Server },
    { id: 'channels', label: '群聊与通知', icon: MessageSquare },
    { id: 'rules', label: '常驻规则', icon: BookOpen },
    { id: 'lifecycle', label: '生命周期与危险区', icon: AlertTriangle },
  ];

  async function save(): Promise<void> {
    if (!dirty) return;
    setSaving(true);
    setError(null);
    try {
      // An emptied field clears the directory: the service reads an empty path as none, as
      // the ledger holds it.
      const body: Record<string, unknown> = {
        ...(draft ? projectBody(project, draft) : {}),
        ...(dispatchOrderDirty
          ? { dispatch_order: shownDispatchOrder === null ? null : customTierOrder }
          : {}),
      };
      await change.send(
        () => put<{ project: Project }>(`/api/projects/${encodeURIComponent(project.id)}`, body),
        (projects, answer) => withProject(projects, answer.project),
      );
      setDraft(null);
      setDispatchOrderDraft(undefined);
      setConfirmUnrestricted(false);
    } catch (refused) {
      setError(messageOf(refused));
      setConfirmUnrestricted(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <article aria-label={`项目 ${project.name}`} className="min-w-0">
      <div
        role="tablist"
        aria-label="设置分组"
        className="sticky top-0 z-10 -mx-1 mb-5 flex items-center gap-1 overflow-x-auto border-b border-border bg-background/95 px-1 pt-0.5 pb-2 backdrop-blur-xs"
      >
        {tabs.map(({ id, label, icon: Icon }) => {
          const active = currentTab === id;
          const isDirty = tabDirty[id];
          const lifecycleBadge = id === 'lifecycle' && (archive.on || pause.on)
            ? (archive.on ? PROJECT_ARCHIVED_LABEL : PROJECT_PAUSED_LABEL)
            : null;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`project-settings-tab-${id}`}
              aria-selected={active}
              aria-controls={`project-settings-panel-${id}`}
              data-dirty={isDirty ? 'true' : undefined}
              onClick={() => setActiveTab(id)}
              className={cn(
                'flex min-h-8 flex-none items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition-colors duration-100',
                active
                  ? 'bg-brand-soft/80 font-medium text-brand-foreground'
                  : 'text-muted-foreground hover:bg-hover hover:text-foreground',
              )}
            >
              <Icon className="size-3.5 flex-none" aria-hidden="true" />
              <span>{label}</span>
              {isDirty ? (
                <span
                  aria-hidden="true"
                  data-slot="dirty-dot"
                  title="有未保存改动"
                  className="size-1.5 flex-none rounded-full bg-primary"
                />
              ) : null}
              {lifecycleBadge ? (
                <Badge tone="ended" className="min-h-4 px-1.5 py-0 text-2xs leading-4">
                  {lifecycleBadge}
                </Badge>
              ) : null}
            </button>
          );
        })}
      </div>

      {currentTab === 'basic' ? (
        <SettingsGroup
          tabId="basic"
          title="基础与代码"
          caption="项目的名称、代码来源顺序及服务归属信息。"
        >
          <Setting
            label={`${project.name} 的名字`}
            title="名字"
            hint="只是显示用的名字，改它不影响任务、记录或代码来源。"
          >
            <Input aria-label="项目名" value={shown.name} disabled={saving} onChange={(event) => edit({ name: event.target.value })} />
          </Setting>

          <Setting
            label={`${project.name} 的代码来源`}
            title="代码来源"
            hint={`这个项目的代码从哪来。第一项是默认：负责人建任务时没说用哪个，就用它。${CODE_SOURCE_HINT}`}
          >
            <SourceEditor items={shown.sources} machines={allMachines} disabled={saving} onChange={(sources) => edit({ sources })} />
          </Setting>

          {project.home && project.home.phase !== 'owned' ? (
            <Setting label="项目归属" title="项目归属" hint="服务身份来自本环境的归属记录。">
              <p className="text-sm">{project.home.phase === 'frozen' ? '正在移交，当前只读' : project.home.phase === 'incoming' ? '等待接管' : '归属待核实'}</p>
              {project.home.generation ? <Note>归属代次 {project.home.generation}</Note> : null}
              <Mono className="block break-all">{project.home.target_service ?? project.home.service_id}</Mono>
            </Setting>
          ) : null}
        </SettingsGroup>
      ) : null}

      {currentTab === 'router' && hasRouterGroup ? (
        <SettingsGroup
          tabId="router"
          title="负责人与权限"
          caption="指定本项目的负责人模型登录，以及负责人可直接完成的动作。"
        >
          {shown.router ? (
            <Setting label="项目负责人" title="项目负责人" hint="登录变更在本项目的下一条消息生效。沿用服务默认时由服务的负责人设置决定。">
              <div className="grid gap-2">
                <Select aria-label="项目负责人账号" value={shown.router.account ?? ''} disabled={saving || !options}
                  onChange={(event) => edit({ router: { account: event.target.value || null, tier: null } })}>
                  <Option value="">沿用服务默认</Option>
                  {shown.router.account && !controller ? <Option value={shown.router.account}>当前登录不可用</Option> : null}
                  {controllerLogins.map(({ id, name, executor }) => <Option key={id} value={id!}>{loginName(allLogins.find((each) => each.id === id) ?? { name })} · {executor}</Option>)}
                </Select>
                {controller ? (
                  <Select aria-label="项目负责人档位" value={shown.router.tier ?? ''} disabled={saving}
                    onChange={(event) => edit({ router: { account: controller.id, tier: event.target.value || null } })}>
                    <Option value="">使用执行器默认档位</Option>
                    {shown.router.tier && !tierValueFrom(controller.tiers, shown.router.tier) ? <Option value={shown.router.tier}>当前档位不可用</Option> : null}
                    {TIERS.filter(({ id }) => tierValueFrom(controller.tiers, id)).map(({ id, label }) => <Option key={id} value={id}>{label}</Option>)}
                  </Select>
                ) : null}
              </div>
            </Setting>
          ) : null}

          {project.grants ? (
            <Setting
              label={`${project.name} 负责人可以自己做`}
              title="负责人可以自己做"
              hint="打开的那几步，负责人在前提满足后直接做，做完服务会把结果推给你；关着的，负责人会告诉你等你在任务页做。审阅这道关不因为这里打开而放松。"
            >
              <ul aria-label="负责人可以自己做" className="grid gap-3">
                {GRANT_IDS.map((grant) => {
                  const grantDirty = shown.grants.includes(grant) !== baseline.grants.includes(grant);
                  return (
                    <li key={grant}>
                      <Choice>
                        <Switch aria-label={GRANTS[grant].label} checked={shown.grants.includes(grant)} disabled={saving}
                          onCheckedChange={(on) => edit({ grants: on ? withName(shown.grants, grant) : withoutName(shown.grants, grant) })} />
                        <span>{GRANTS[grant].label}</span>
                        {grantDirty ? <Badge tone="waiting" className="ml-1">未保存</Badge> : null}
                      </Choice>
                      <Note className="mt-0.5 ml-11 text-xs">{GRANTS[grant].hint}</Note>
                    </li>
                  );
                })}
              </ul>
            </Setting>
          ) : null}
        </SettingsGroup>
      ) : null}

      {currentTab === 'compute' ? (
        <SettingsGroup
          tabId="compute"
          title="登录与机器"
          caption="控制任务派发可用的执行登录、目标机器范围以及是否允许按需派生机器。"
        >
          <Setting
            label={`${project.name} 允许的登录`}
            title="允许的登录"
            hint={<>决定这个项目的任务允许用哪些身份执行。集中托管账号在<Link to="/accounts" className="mx-0.5">账号</Link>页管理及调整全局派发顺序，单机特例登录在<Link to="/machines" className="mx-0.5">机器</Link>页管理。</>}
          >
            <div role="radiogroup" aria-label="登录方式" className="mb-2 flex flex-wrap gap-x-5">
              {([['all', '全部登录'], ['selected', '只用所选']] as const).map(([mode, label]) => (
                <Choice key={mode}>
                  <Radio name={`login-mode-${project.id}`} checked={shown.loginMode === mode} disabled={saving} onChange={() => edit({ loginMode: mode })} />
                  {label}
                </Choice>
              ))}
            </div>
            {shown.loginMode === 'all' ? (
              <Note>
                {`全部登录：派发时按每个档位的全局顺序挑（现在 ${project.pool?.length ?? 0} 个）。`}
                {shown.logins.length ? `选过的 ${shown.logins.length} 个登录留着，现在不参与派发；切回“只用所选”就按它们派。` : ''}
              </Note>
            ) : (
              <>
                {loginRows.length ? (
                  <Rows>
                    <ul aria-label="允许的登录" className="divide-y divide-border">
                      {loginRows.map((login) => (
                        <LoginChoice
                          key={login.id}
                          login={login}
                          checked={shown.logins.includes(login.id)}
                          busy={busy}
                          readOnly={login.unread === true}
                          onToggle={(on) => edit({ logins: on ? withName(shown.logins, login.id) : withoutName(shown.logins, login.id) })}
                        />
                      ))}
                    </ul>
                  </Rows>
                ) : null}
                {options === undefined ? <Note>登录信息未读到：项目已经选定的登录先按原样留着，读到后再改。</Note> : null}
                {options !== undefined && loginRows.length === 0 ? <Note>还没有可选的登录：到“账号”或“机器”页建一个。</Note> : null}
                {shown.logins.length === 0 ? <Callout tone="waiting">只用所选，一个都没选：这个项目的任务不派发。</Callout> : null}
              </>
            )}
          </Setting>

          <Setting
            label={`${project.name} 本项目派发顺位`}
            title="本项目派发顺位"
            hint={<>决定每个档位在本项目内优先尝试哪个登录；未自定义时沿用<Link to="/accounts#dispatch-order" className="mx-0.5">账号页的全局默认顺序</Link>。</>}
          >
            <div role="radiogroup" aria-label="派发顺位方式" className="mb-2.5 flex flex-wrap items-center gap-x-5 gap-y-1">
              <Choice>
                <Radio
                  name={`dispatch-order-mode-${project.id}`}
                  checked={shownDispatchOrder === null}
                  disabled={busy}
                  onChange={() => setDispatchOrderDraft(null)}
                />
                <span>沿用全局默认顺序</span>
              </Choice>
              <Choice>
                <Radio
                  name={`dispatch-order-mode-${project.id}`}
                  checked={shownDispatchOrder !== null}
                  disabled={busy}
                  onChange={() => setDispatchOrderDraft({ ...effectivePreviewOrder })}
                />
                <span>自定义本项目顺位</span>
              </Choice>
              {dispatchOrderDirty ? <Badge tone="waiting">未保存</Badge> : null}
            </div>

            {shownDispatchOrder === null ? (
              <div className="grid grid-cols-1 gap-2 rounded-lg border border-border/75 bg-muted/35 p-3 text-xs sm:grid-cols-3">
                {TIERS.map((tier) => {
                  const list = effectivePreviewOrder[tier.id];
                  const topNames = list.slice(0, 2).map((id) => loginLabelFor(id).shown);
                  const more = list.length > 2 ? ` 等 ${list.length} 个` : '';
                  return (
                    <div key={tier.id} className="min-w-0">
                      <p className="font-medium text-foreground">{tier.label}</p>
                      <p className="mt-0.5 truncate text-muted-foreground" title={list.map((id) => loginLabelFor(id).name).join(' → ') || '未配置'}>
                        {topNames.length > 0 ? `${topNames.join(' → ')}${more}` : '暂无可用登录'}
                      </p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="grid gap-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Note className="text-xs">仅列出本项目允许且支持对应档位的登录；额度用完或离线时自动顺延。</Note>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 px-2 text-xs"
                    disabled={busy}
                    onClick={() => setDispatchOrderDraft(null)}
                  >
                    <RotateCcw className="size-3" aria-hidden="true" />
                    恢复全局
                  </Button>
                </div>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                  {TIERS.map((tier) => {
                    const list = customTierOrder[tier.id];
                    return (
                      <div key={tier.id} className="rounded-lg border border-border/75 bg-muted/35 p-2.5">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <h4 className="text-xs font-semibold text-foreground">{tier.label}</h4>
                          <span className="rounded-full bg-hover px-1.5 text-[11px] leading-[17px] text-muted-foreground tabular-nums">
                            {list.length}
                          </span>
                        </div>
                        {list.length > 0 ? (
                          <ol aria-label={`${tier.label}本项目派发顺位`} className="divide-y divide-border/60 rounded-md border border-border/70 bg-raised">
                            {list.map((id, index) => {
                              const { name, shown: short } = loginLabelFor(id);
                              return (
                                <li key={id} className="flex items-center gap-1 py-1 pr-1 pl-2">
                                  <span className="w-4 flex-none text-[11px] text-faint tabular-nums">{index + 1}</span>
                                  <span className="min-w-0 flex-1 truncate text-xs" title={name}>{short}</span>
                                  <Button
                                    type="button"
                                    size="icon-sm"
                                    variant="ghost"
                                    className="size-6"
                                    disabled={busy || index === 0}
                                    aria-label={`把 ${name} 在${tier.label}往前挪`}
                                    onClick={() => moveCustomTier(tier.id, index, index - 1)}
                                  >
                                    <ArrowUp className="size-3.5" />
                                  </Button>
                                  <Button
                                    type="button"
                                    size="icon-sm"
                                    variant="ghost"
                                    className="size-6"
                                    disabled={busy || index === list.length - 1}
                                    aria-label={`把 ${name} 在${tier.label}往后挪`}
                                    onClick={() => moveCustomTier(tier.id, index, index + 1)}
                                  >
                                    <ArrowDown className="size-3.5" />
                                  </Button>
                                </li>
                              );
                            })}
                          </ol>
                        ) : <Note className="text-xs">暂无可用登录。</Note>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </Setting>

          <Setting label={`${project.name} 允许的机器`} title="允许的机器" hint="仓库来源的活按这里的范围派发：送到勾上的机器，一台都不勾就是不限制、在线的机器都行。机器上的文件夹来源固定派到它指定的那台机器，不受这里限制。">
            {allMachines.length ? (
              <ul aria-label="允许的机器" className="grid">
                {allMachines.map(({ uid, name }) => (
                  <li key={uid}>
                    <Choice>
                      <Checkbox checked={shown.machines.includes(uid)} disabled={saving}
                        onChange={(event) => edit({ machines: event.target.checked ? withName(shown.machines, uid) : withoutName(shown.machines, uid) })} />
                      <Mono>{name}</Mono>
                    </Choice>
                  </li>
                ))}
              </ul>
            ) : <Note>还没有机器。先到<Link to="/machines" className="mx-0.5">机器</Link>页接入一台。</Note>}
            {allMachines.length && shown.machines.length === 0 && !project.machines_gone ? <Note className="mt-1 text-xs">不限制：在线的机器都可以。</Note> : null}
            {project.machines_gone ? (
              <Callout tone="failed" className="mt-2">
                <Problem>{machinesGoneText(project.machines_gone, project.machines.length)}</Problem>
                {shown.clearGoneMachines
                  ? <Note className="mt-1.5">保存后去掉已删除的机器条目，按当前勾选的机器清单派发。</Note>
                  : <Button className="mt-2" size="sm" disabled={busy} onClick={() => edit({ clearGoneMachines: true })}>去掉已删除的机器条目</Button>}
              </Callout>
            ) : null}
          </Setting>

          <Setting
            label={`${project.name} 允许派生机器`}
            title="允许派生机器"
            hint="打开后，这个项目的任务可以按技能开新的机器。新机器凭一次性接入材料自己加入，不用你逐台放行；它们只接这个项目的活。默认关。"
          >
            <Choice>
              <Switch aria-label="允许派生机器" checked={shown.spawnMachines} disabled={saving} onCheckedChange={(on) => edit({ spawnMachines: on })} />
              <span>{shown.spawnMachines ? '开着' : '关着'}</span>
              {shown.spawnMachines !== baseline.spawnMachines ? <Badge tone="waiting" className="ml-1">未保存</Badge> : null}
            </Choice>
          </Setting>
        </SettingsGroup>
      ) : null}

      {currentTab === 'channels' ? (
        <SettingsGroup
          tabId="channels"
          title="群聊与通知"
          caption="管理绑定到此项目的企业微信 / 微信群、群内触发策略与告警播报开关；改动立即生效。"
        >
          <div className="pt-4">
            <ProjectGroupsPanel project={project} />
          </div>
        </SettingsGroup>
      ) : null}

      {currentTab === 'rules' ? (
        <SettingsGroup
          tabId="rules"
          title="常驻规则"
          caption="每一轮和负责人都会带上全文的项目级规则，改动直接生效。"
        >
          <Setting
            label={`${project.name} 的常驻规则`}
            title="这个项目的常驻规则"
            hint="这个项目每一轮和它的负责人都会带上全文的规则，比如从哪个分支开工、交付前跑什么。它们是知识条目：在这里新建和修改，照常算你自己的改动，直接生效。"
          >
            <ProjectRules project={project} />
          </Setting>
        </SettingsGroup>
      ) : null}

      {currentTab === 'lifecycle' ? (
        <SettingsGroup
          tabId="lifecycle"
          title="生命周期与危险区"
          caption="暂停、归档与永久删除均立刻生效，不需要点击底部保存。"
        >
          <Setting
            label={`暂停 ${project.name}`}
            title="暂停"
            hint="立刻生效，不用点保存。暂停后负责人不接新消息、不派新任务、触发器不投递；在跑的那一轮会做完，消息照常记下，恢复后接着处理。"
          >
            <div className="flex flex-wrap items-center gap-3">
              {pause.on ? <Badge tone="ended">{PROJECT_PAUSED_LABEL}</Badge> : <Badge tone="success">在运行</Badge>}
              {pause.on && project.paused_at ? <Time at={project.paused_at} prefix="暂停于 " className="text-xs text-muted-foreground" /> : null}
              <Button disabled={pause.busy} onClick={() => void pause.set(!pause.on)}>{pause.on ? '恢复' : '暂停这个项目'}</Button>
            </div>
            {pause.error ? <Problem role="alert" className="mt-2">{pause.error}</Problem> : null}
          </Setting>

          <Setting
            label={`归档 ${project.name}`}
            title="归档"
            hint="收起来不用了。立刻生效，不用点保存；归档不改任务状态，也不删任何东西，恢复后照旧。"
          >
            <div className="flex flex-wrap items-center gap-3">
              {archive.on ? <Badge tone="ended">{PROJECT_ARCHIVED_LABEL}</Badge> : <Badge tone="success">在用</Badge>}
              {archive.on && project.archived_at ? <Time at={project.archived_at} prefix="归档于 " className="text-xs text-muted-foreground" /> : null}
              <Button
                disabled={archive.busy}
                onClick={() => {
                  if (archive.on) void archive.set(false);
                  else setConfirmArchive(true);
                }}
              >
                {archive.on ? '恢复' : '归档这个项目'}
              </Button>
            </div>
            {archive.error ? <Problem role="alert" className="mt-2">{archive.error}</Problem> : null}
          </Setting>

          {deletion ? (
            <Setting
              label={`删除 ${project.name}`}
              title="删除项目"
              hint="从没留下记录的项目随时能删；有历史的项目要先归档，并且没有在跑的轮次。删掉的东西不能恢复。"
              danger
            >
              {deletion.allowed ? (
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>删除这个项目</Button>
              ) : <Note>{deletion.reason}</Note>}
            </Setting>
          ) : null}
        </SettingsGroup>
      ) : null}

      {error ? <Problem role="alert" className="mt-4">{error}</Problem> : null}

      {dirty ? (
        <div className="sticky bottom-3 z-10 mt-5 flex flex-wrap items-center gap-2 rounded-xl border border-brand-border bg-raised/95 px-4 py-2.5 shadow-pop backdrop-blur-sm">
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
            <Dot tone="running" pulse={false} />
            <span>有改动还没保存</span>
            {(() => {
              const dirtyLabels = tabs.filter((each) => tabDirty[each.id]).map((each) => each.label);
              return dirtyLabels.length ? <span className="text-xs text-faint">{`（${dirtyLabels.join('、')}）`}</span> : null;
            })()}
          </span>
          <Button variant="ghost" disabled={saving} onClick={() => { setDraft(null); setDispatchOrderDraft(undefined); setError(null); }}>取消</Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              if (machinesMoved(project, shown) && shown.machines.length === 0 && project.machines.length + (project.machines_gone ?? 0) > 0) setConfirmUnrestricted(true);
              else void save();
            }}
          >
            {saving ? '保存中' : '保存'}
          </Button>
        </div>
      ) : null}

      <Confirm
        open={confirmArchive}
        danger={false}
        title={`归档项目 ${project.name}？`}
        description={`${archiveNote}。`}
        confirm="归档"
        busy={archive.busy}
        error={archive.error}
        onConfirm={() => { void archive.set(true).then((ok) => { if (ok) setConfirmArchive(false); }); }}
        onCancel={() => setConfirmArchive(false)}
      />

      <Confirm
        open={confirmUnrestricted}
        danger={false}
        title="允许哪台机器都接活？"
        description={`${project.name} 原来有机器限制。这次保存后不再限制机器，哪台机器都行，包括同名重新接入的机器。`}
        confirm="确认不限制机器并保存"
        busy={busy}
        onConfirm={() => void save()}
        onCancel={() => setConfirmUnrestricted(false)}
      />

      <DeleteProjectDialog
        project={project}
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        onDeleted={() => { void navigate('/projects'); }}
      />
    </article>
  );
}
