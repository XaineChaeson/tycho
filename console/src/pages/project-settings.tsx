// How a project is set up: its name, where its code is on this host, which logins its tasks may
// run as, which machines its work may go to, whether its tasks may bring in
// machines of their own, and what its Router may do without asking. Nothing of those is saved
// until "保存": what was changed waits in a bar under them, with the way to drop it. Things not
// part of that draft act at once: the pause, the archive, and the delete of an empty or archived
// project once its name is typed again. The project's standing rules are knowledge entries,
// edited directly in place.
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BookOpen, FolderGit2, MessageSquare, RotateCcw, Server, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { loginName } from '@shared/logins.ts';
import { sameDispatchSlotsConfig, type DispatchSlotsConfig, type TierDispatchSlots } from '@shared/dispatch-slots.ts';
import { TIERS, tierLabel, tierValueFrom, type TierId } from '@shared/tiers.ts';
import { PROJECT_ARCHIVED_LABEL, PROJECT_PAUSED_LABEL } from '@shared/labels.ts';
import { GRANT_IDS, GRANTS } from '@shared/grants.ts';
import { Callout, Card, Dot, Mono, Note, Problem, Rows, Time } from '@/components/bits';
import { DeleteProjectDialog } from '@/components/delete-project-dialog';
import { buildLogicalAccountEntries, DispatchSlotsPanel, effectiveSlotsByTier, type LogicalAccountEntry } from '@/components/dispatch-slots-panel';
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
import { useI18n, type TranslationParams } from '@/lib/i18n';
import { changed, draftOf, machinesGoneText, machinesMoved, projectBody, sameNames, withName, withoutName, withProject, type ProjectDraft } from '@/lib/projects';
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

interface LoginMeta {
  id: string;
  name: string;
  shortLabel: string;
  executor?: string;
  tiers: TierId[];
  supportsTier: (tierId: TierId) => boolean;
}

function buildLoginMetaMap(
  options: AccountsAndMachines | undefined,
  t: (key: string, params?: TranslationParams) => string,
): Map<string, LoginMeta> {
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
      const label = login.account_label ?? (login.route_label ? t('proj.settings.routeLabel', { label: login.route_label }) : undefined);
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
  const { t } = useI18n();
  const { data: options } = useQuery(accountsQuery);
  const navigate = useNavigate();
  const change = useChange<Project[]>({ mutationKey: CHANGE, queryKey: projectsQuery.queryKey, reread: true });
  // Null until something is edited: the page then shows the project as the service has it,
  // and follows it as it changes.
  const [draft, setDraft] = useState<ProjectDraft | null>(null);
  const [dispatchSlotsDraft, setDispatchSlotsDraft] = useState<DispatchSlotsConfig | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmUnrestricted, setConfirmUnrestricted] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTabId>('basic');
  useEffect(() => {
    setDispatchSlotsDraft(undefined);
  }, [project.id]);
  const baseline = draftOf(project);
  const shown = draft ?? baseline;
  const baselineDispatchSlots: DispatchSlotsConfig | null = project.dispatch_slots ?? null;
  const hasLegacyDispatchOrder = project.dispatch_slots == null && project.dispatch_order != null && Object.values(project.dispatch_order).some((ids) => Array.isArray(ids) && ids.length > 0);
  const shownDispatchSlots: DispatchSlotsConfig | null = dispatchSlotsDraft !== undefined ? dispatchSlotsDraft : baselineDispatchSlots;
  const dispatchSlotsDirty = dispatchSlotsDraft !== undefined && (
    !sameDispatchSlotsConfig(baselineDispatchSlots, dispatchSlotsDraft)
    || (hasLegacyDispatchOrder && dispatchSlotsDraft === null)
  );
  const baseDirty = draft !== null && changed(project, draft);
  const dirty = baseDirty || dispatchSlotsDirty;
  const tabDirty = dirtyTabsOf(project, draft, dispatchSlotsDirty);

  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
  const allLogins = loginChoices(options);
  const metaByLoginId = buildLoginMetaMap(options, t);
  const controllerLogins = options ? [
    ...options.accounts.filter((login) => login.can_route),
    ...options.machines.flatMap((machine) => (machine.logins ?? []).filter((login) => login.can_route && login.configured && login.id !== null)),
  ] : [];
  const controller = controllerLogins.find(({ id }) => id === shown.router?.account);
  // Every login there is once the list has been read; until then, and when reading it failed,
  // the project's own ids are all that is known. Either way a login the project names that is
  // no longer there is one more row, marked as deleted.
  const loginRows: LoginRow[] = options === undefined
    ? shown.logins.map((id) => ({ id, name: t('proj.settings.loginUnread'), unread: true }))
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
        ...shown.logins.filter((id) => !allLogins.some((login) => login.id === id)).map((id) => ({ id, name: t('proj.settings.loginDeleted') })),
      ];

  const allowedLoginIds: Set<string> | null = shown.loginMode === 'selected'
    ? new Set(shown.logins)
    : options !== undefined
      ? new Set(allLogins.map((each) => each.id))
      : project.pool
        ? new Set(project.pool)
        : null;

  const projectLogicalEntries: LogicalAccountEntry[] = options
    ? buildLogicalAccountEntries(options, undefined, { allowedLoginIds })
    : [];
  const projectEntryMap = new Map(projectLogicalEntries.map((entry) => [entry.key, entry]));
  const emptyTierSlots: Record<TierId, TierDispatchSlots> = {
    operate: { p1: [], p2: [], off: [] },
    execute: { p1: [], p2: [], off: [] },
    decide: { p1: [], p2: [], off: [] },
  };
  const inheritedProjectSlots: Record<TierId, TierDispatchSlots> = options
    ? effectiveSlotsByTier(options, projectLogicalEntries, null, project.dispatch_order)
    : emptyTierSlots;
  const customProjectSlots: Record<TierId, TierDispatchSlots> = options
    ? effectiveSlotsByTier(options, projectLogicalEntries, shownDispatchSlots, project.dispatch_order)
    : emptyTierSlots;
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
  const archiveDescription = notDone > 0
    ? t('proj.settings.archiveNoteUnfinished', { count: notDone })
    : t('proj.settings.archiveNoteSimple');
  const hasRouterGroup = Boolean(shown.router || project.grants);
  const currentTab: SettingsTabId = !hasRouterGroup && activeTab === 'router' ? 'basic' : activeTab;

  const tabs: { id: SettingsTabId; label: string; icon: ComponentType<{ className?: string }> }[] = [
    { id: 'basic', label: t('proj.settings.tabBasic'), icon: FolderGit2 },
    ...(hasRouterGroup ? [{ id: 'router' as const, label: t('proj.settings.tabRouter'), icon: ShieldCheck }] : []),
    { id: 'compute', label: t('proj.settings.tabCompute'), icon: Server },
    { id: 'channels', label: t('proj.settings.tabChannels'), icon: MessageSquare },
    { id: 'rules', label: t('proj.settings.tabRules'), icon: BookOpen },
    { id: 'lifecycle', label: t('proj.settings.tabLifecycle'), icon: AlertTriangle },
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
        ...(dispatchSlotsDirty
          ? { dispatch_slots: shownDispatchSlots === null ? null : customProjectSlots }
          : {}),
      };
      await change.send(
        () => put<{ project: Project }>(`/api/projects/${encodeURIComponent(project.id)}`, body),
        (projects, answer) => withProject(projects, answer.project),
      );
      setDraft(null);
      setDispatchSlotsDraft(undefined);
      setConfirmUnrestricted(false);
    } catch (refused) {
      setError(messageOf(refused));
      setConfirmUnrestricted(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <article aria-label={t('proj.list.projectAria', { name: project.name })} className="min-w-0">
      <div
        role="tablist"
        aria-label={t('proj.settings.tabsAria')}
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
                  title={t('proj.settings.dirtyDotTitle')}
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
          title={t('proj.settings.tabBasic')}
          caption={t('proj.settings.basicCaption')}
        >
          <Setting
            label={t('proj.settings.nameSectionAria', { name: project.name })}
            title={t('proj.trig.fieldName')}
            hint={t('proj.settings.nameHint')}
          >
            <Input aria-label={t('proj.form.nameLabel')} value={shown.name} disabled={saving} onChange={(event) => edit({ name: event.target.value })} />
          </Setting>

          <Setting
            label={t('proj.settings.sourcesSectionAria', { name: project.name })}
            title={t('proj.settings.sourcesTitle')}
            hint={t('proj.settings.sourcesHint', { hint: CODE_SOURCE_HINT })}
          >
            <SourceEditor items={shown.sources} machines={allMachines} disabled={saving} onChange={(sources) => edit({ sources })} />
          </Setting>

          {project.home && project.home.phase !== 'owned' ? (
            <Setting label={t('proj.settings.homeTitle')} title={t('proj.settings.homeTitle')} hint={t('proj.settings.homeHint')}>
              <p className="text-sm">{project.home.phase === 'frozen' ? t('proj.settings.homeFrozen') : project.home.phase === 'incoming' ? t('proj.settings.homeIncoming') : t('proj.settings.homeUnknown')}</p>
              {project.home.generation ? <Note>{t('proj.settings.homeGeneration', { generation: project.home.generation })}</Note> : null}
              <Mono className="block break-all">{project.home.target_service ?? project.home.service_id}</Mono>
            </Setting>
          ) : null}
        </SettingsGroup>
      ) : null}

      {currentTab === 'router' && hasRouterGroup ? (
        <SettingsGroup
          tabId="router"
          title={t('proj.settings.tabRouter')}
          caption={t('proj.settings.routerCaption')}
        >
          {shown.router ? (
            <Setting label={t('proj.settings.routerTitle')} title={t('proj.settings.routerTitle')} hint={t('proj.settings.routerHint')}>
              <div className="grid gap-2">
                <Select aria-label={t('proj.chip.routerAccountTitle')} value={shown.router.account ?? ''} disabled={saving || !options}
                  onChange={(event) => edit({ router: { account: event.target.value || null, tier: null } })}>
                  <Option value="">{t('proj.settings.routerDefaultOption')}</Option>
                  {shown.router.account && !controller ? <Option value={shown.router.account}>{t('proj.settings.routerLoginUnavailable')}</Option> : null}
                  {controllerLogins.map(({ id, name, executor }) => <Option key={id} value={id!}>{loginName(allLogins.find((each) => each.id === id) ?? { name })} · {executor}</Option>)}
                </Select>
                {controller ? (
                  <Select aria-label={t('proj.settings.routerTierAria')} value={shown.router.tier ?? ''} disabled={saving}
                    onChange={(event) => edit({ router: { account: controller.id, tier: event.target.value || null } })}>
                    <Option value="">{t('proj.settings.routerDefaultTier')}</Option>
                    {shown.router.tier && !tierValueFrom(controller.tiers, shown.router.tier) ? <Option value={shown.router.tier}>{t('proj.settings.routerTierUnavailable')}</Option> : null}
                    {TIERS.filter(({ id }) => tierValueFrom(controller.tiers, id)).map(({ id, label }) => <Option key={id} value={id}>{label}</Option>)}
                  </Select>
                ) : null}
              </div>
            </Setting>
          ) : null}

          {project.grants ? (
            <Setting
              label={t('proj.settings.grantsSectionAria', { name: project.name })}
              title={t('proj.settings.grantsTitle')}
              hint={t('proj.settings.grantsHint')}
            >
              <ul aria-label={t('proj.settings.grantsTitle')} className="grid gap-3">
                {GRANT_IDS.map((grant) => {
                  const grantDirty = shown.grants.includes(grant) !== baseline.grants.includes(grant);
                  return (
                    <li key={grant}>
                      <Choice>
                        <Switch aria-label={GRANTS[grant].label} checked={shown.grants.includes(grant)} disabled={saving}
                          onCheckedChange={(on) => edit({ grants: on ? withName(shown.grants, grant) : withoutName(shown.grants, grant) })} />
                        <span>{GRANTS[grant].label}</span>
                        {grantDirty ? <Badge tone="waiting" className="ml-1">{t('proj.settings.unsavedBadge')}</Badge> : null}
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
          title={t('proj.settings.tabCompute')}
          caption={t('proj.settings.computeCaption')}
        >
          <Setting
            label={t('proj.settings.loginsSectionAria', { name: project.name })}
            title={t('proj.settings.loginsTitle')}
            hint={(
              <>
                {t('proj.settings.loginsHintPart1')}
                <Link to="/accounts" className="mx-0.5">{t('nav.accounts')}</Link>
                {t('proj.settings.loginsHintPart2')}
                <Link to="/machines" className="mx-0.5">{t('nav.machines')}</Link>
                {t('proj.settings.loginsHintPart3')}
              </>
            )}
          >
            <div role="radiogroup" aria-label={t('proj.settings.loginModeAria')} className="mb-2 flex flex-wrap gap-x-5">
              {([['all', t('proj.settings.loginModeAll')], ['selected', t('proj.settings.loginModeSelected')]] as const).map(([mode, label]) => (
                <Choice key={mode}>
                  <Radio name={`login-mode-${project.id}`} checked={shown.loginMode === mode} disabled={saving} onChange={() => edit({ loginMode: mode })} />
                  {label}
                </Choice>
              ))}
            </div>
            {shown.loginMode === 'all' ? (
              <Note>
                {t('proj.settings.loginAllNote', { count: project.pool?.length ?? 0 })}
                {shown.logins.length ? t('proj.settings.loginAllKeptNote', { count: shown.logins.length }) : ''}
              </Note>
            ) : (
              <>
                {loginRows.length ? (
                  <Rows>
                    <ul aria-label={t('proj.settings.loginsTitle')} className="divide-y divide-border">
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
                {options === undefined ? <Note>{t('proj.settings.loginsUnreadNote')}</Note> : null}
                {options !== undefined && loginRows.length === 0 ? <Note>{t('proj.settings.noLoginsNote')}</Note> : null}
                {shown.logins.length === 0 ? <Callout tone="waiting">{t('proj.settings.emptySelectedWarning')}</Callout> : null}
              </>
            )}
          </Setting>

          <Setting
            label={t('proj.settings.slotsSectionAria', { name: project.name })}
            title={t('proj.settings.slotsTitle')}
            hint={(
              <>
                {t('proj.settings.slotsHintPart1')}
                <Link to="/accounts#policy" className="mx-0.5">{t('proj.settings.slotsHintLink')}</Link>
                {t('proj.settings.slotsHintPart2')}
              </>
            )}
          >
            {hasLegacyDispatchOrder && dispatchSlotsDraft === undefined ? (
              <Callout tone="waiting" className="mb-2.5 text-xs">
                <span>{t('proj.settings.legacyOrderWarning')}</span>
              </Callout>
            ) : null}
            <div role="radiogroup" aria-label={t('proj.settings.slotsModeAria')} className="mb-2.5 flex flex-wrap items-center gap-x-5 gap-y-1">
              <Choice>
                <Radio
                  name={`dispatch-slots-mode-${project.id}`}
                  checked={shownDispatchSlots === null && (!hasLegacyDispatchOrder || dispatchSlotsDraft === null)}
                  disabled={busy}
                  onChange={() => setDispatchSlotsDraft(null)}
                />
                <span>{t('proj.settings.slotsModeGlobal')}</span>
              </Choice>
              <Choice>
                <Radio
                  name={`dispatch-slots-mode-${project.id}`}
                  checked={shownDispatchSlots !== null}
                  disabled={busy}
                  onChange={() => setDispatchSlotsDraft({ ...inheritedProjectSlots })}
                />
                <span>{t('proj.settings.slotsModeCustom')}</span>
              </Choice>
              {dispatchSlotsDirty ? <Badge tone="waiting">{t('proj.settings.unsavedBadge')}</Badge> : null}
            </div>

            {shownDispatchSlots === null ? (
              <div className="grid grid-cols-1 gap-2 rounded-lg border border-border/75 bg-muted/35 p-3 text-xs sm:grid-cols-3">
                {TIERS.map((tier) => {
                  const s = inheritedProjectSlots[tier.id];
                  const p1 = s.p1
                    .map((k) => projectEntryMap.get(k))
                    .filter((e): e is LogicalAccountEntry => e !== undefined && e.supportedTiers[tier.id])
                    .map((e) => e.name);
                  const p2 = s.p2
                    .map((k) => projectEntryMap.get(k))
                    .filter((e): e is LogicalAccountEntry => e !== undefined && e.supportedTiers[tier.id])
                    .map((e) => e.name);
                  return (
                    <div key={tier.id} className="min-w-0 space-y-1">
                      <p className="font-medium text-foreground">{tier.label}</p>
                      {p1.length > 0 || p2.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-1">
                          {p1.length > 0 ? (
                            <span className="rounded border border-brand-border bg-brand-soft px-1.5 py-0.5 font-medium text-brand-foreground">
                              {p1.join(' + ')}
                              {p1.length >= 2 ? <span className="ml-1 text-2xs opacity-80">{t('proj.settings.slotsBalancedTag')}</span> : null}
                            </span>
                          ) : <span className="text-faint">{t('proj.settings.slotsNoPrimary')}</span>}
                          {p2.length > 0 ? (
                            <>
                              <span className="text-faint" aria-hidden="true">→</span>
                              <span className="rounded border border-waiting-border bg-waiting-soft px-1.5 py-0.5 text-waiting-foreground">
                                {p2.join(' + ')}
                              </span>
                            </>
                          ) : null}
                        </div>
                      ) : (
                        <p className="text-muted-foreground">{t('proj.settings.slotsNoLogins')}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : options ? (
              <div className="grid gap-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Note className="text-xs">{t('proj.settings.slotsCustomHint')}</Note>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 px-2 text-xs"
                    disabled={busy}
                    onClick={() => setDispatchSlotsDraft(null)}
                  >
                    <RotateCcw className="size-3" aria-hidden="true" />
                    {t('proj.settings.slotsResetGlobal')}
                  </Button>
                </div>
                <DispatchSlotsPanel
                  page={options}
                  entries={projectLogicalEntries}
                  slotsByTier={customProjectSlots}
                  busy={busy}
                  compact
                  hideSimulator
                  showTierSupport
                  ariaLabel={t('proj.settings.slotsMatrixAria', { name: project.name })}
                  hint={null}
                  onSaveTier={(tier, next) => setDispatchSlotsDraft({ ...customProjectSlots, [tier]: next })}
                />
              </div>
            ) : (
              <Note className="text-xs">{t('proj.settings.loadingLogins')}</Note>
            )}
          </Setting>

          <Setting label={t('proj.settings.machinesSectionAria', { name: project.name })} title={t('proj.settings.machinesTitle')} hint={t('proj.settings.machinesHint')}>
            {allMachines.length ? (
              <ul aria-label={t('proj.settings.machinesTitle')} className="grid">
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
            ) : (
              <Note>
                {t('proj.settings.noMachinesPart1')}
                <Link to="/machines" className="mx-0.5">{t('nav.machines')}</Link>
                {t('proj.settings.noMachinesPart2')}
              </Note>
            )}
            {allMachines.length && shown.machines.length === 0 && !project.machines_gone ? <Note className="mt-1 text-xs">{t('proj.settings.machinesUnrestrictedNote')}</Note> : null}
            {project.machines_gone ? (
              <Callout tone="failed" className="mt-2">
                <Problem>{machinesGoneText(project.machines_gone, project.machines.length)}</Problem>
                {shown.clearGoneMachines
                  ? <Note className="mt-1.5">{t('proj.settings.machinesClearPending')}</Note>
                  : <Button className="mt-2" size="sm" disabled={busy} onClick={() => edit({ clearGoneMachines: true })}>{t('proj.settings.machinesClearBtn')}</Button>}
              </Callout>
            ) : null}
          </Setting>

          <Setting
            label={t('proj.settings.spawnSectionAria', { name: project.name })}
            title={t('proj.settings.spawnLabel')}
            hint={t('proj.settings.spawnHint')}
          >
            <Choice>
              <Switch aria-label={t('proj.settings.spawnLabel')} checked={shown.spawnMachines} disabled={saving} onCheckedChange={(on) => edit({ spawnMachines: on })} />
              <span>{shown.spawnMachines ? t('proj.settings.switchOn') : t('proj.settings.switchOff')}</span>
              {shown.spawnMachines !== baseline.spawnMachines ? <Badge tone="waiting" className="ml-1">{t('proj.settings.unsavedBadge')}</Badge> : null}
            </Choice>
          </Setting>
        </SettingsGroup>
      ) : null}

      {currentTab === 'channels' ? (
        <SettingsGroup
          tabId="channels"
          title={t('proj.settings.tabChannels')}
          caption={t('proj.settings.channelsCaption')}
        >
          <div className="pt-4">
            <ProjectGroupsPanel project={project} />
          </div>
        </SettingsGroup>
      ) : null}

      {currentTab === 'rules' ? (
        <SettingsGroup
          tabId="rules"
          title={t('proj.settings.tabRules')}
          caption={t('proj.settings.rulesCaption')}
        >
          <Setting
            label={t('proj.rules.listAria', { name: project.name })}
            title={t('proj.settings.rulesTitle')}
            hint={t('proj.settings.rulesHint')}
          >
            <ProjectRules project={project} />
          </Setting>
        </SettingsGroup>
      ) : null}

      {currentTab === 'lifecycle' ? (
        <SettingsGroup
          tabId="lifecycle"
          title={t('proj.settings.tabLifecycle')}
          caption={t('proj.settings.lifecycleCaption')}
        >
          <Setting
            label={t('proj.settings.pauseSectionAria', { name: project.name })}
            title={t('common.pause')}
            hint={t('proj.settings.pauseHint')}
          >
            <div className="flex flex-wrap items-center gap-3">
              {pause.on ? <Badge tone="ended">{PROJECT_PAUSED_LABEL}</Badge> : <Badge tone="success">{t('proj.settings.stateRunning')}</Badge>}
              {pause.on && project.paused_at ? <Time at={project.paused_at} prefix={t('proj.settings.pausedAtPrefix')} className="text-xs text-muted-foreground" /> : null}
              <Button disabled={pause.busy} onClick={() => void pause.set(!pause.on)}>{pause.on ? t('common.resume') : t('proj.settings.pauseBtn')}</Button>
            </div>
            {pause.error ? <Problem role="alert" className="mt-2">{pause.error}</Problem> : null}
          </Setting>

          <Setting
            label={t('proj.settings.archiveSectionAria', { name: project.name })}
            title={t('proj.lifecycle.archive')}
            hint={t('proj.settings.archiveHint')}
          >
            <div className="flex flex-wrap items-center gap-3">
              {archive.on ? <Badge tone="ended">{PROJECT_ARCHIVED_LABEL}</Badge> : <Badge tone="success">{t('proj.settings.stateActive')}</Badge>}
              {archive.on && project.archived_at ? <Time at={project.archived_at} prefix={t('proj.settings.archivedAtPrefix')} className="text-xs text-muted-foreground" /> : null}
              <Button
                disabled={archive.busy}
                onClick={() => {
                  if (archive.on) void archive.set(false);
                  else setConfirmArchive(true);
                }}
              >
                {archive.on ? t('common.resume') : t('proj.settings.archiveBtn')}
              </Button>
            </div>
            {archive.error ? <Problem role="alert" className="mt-2">{archive.error}</Problem> : null}
          </Setting>

          {deletion ? (
            <Setting
              label={t('proj.settings.deleteSectionAria', { name: project.name })}
              title={t('project.deleteProject')}
              hint={t('proj.settings.deleteHint')}
              danger
            >
              {deletion.allowed ? (
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>{t('proj.settings.deleteBtn')}</Button>
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
            <span>{t('proj.settings.unsavedBarText')}</span>
            {(() => {
              const dirtyLabels = tabs.filter((each) => tabDirty[each.id]).map((each) => each.label);
              return dirtyLabels.length
                ? <span className="text-xs text-faint">{t('proj.settings.unsavedTabsWrap', { tabs: dirtyLabels.join(t('proj.delete.listSep')) })}</span>
                : null;
            })()}
          </span>
          <Button variant="ghost" disabled={saving} onClick={() => { setDraft(null); setDispatchSlotsDraft(undefined); setError(null); }}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              if (machinesMoved(project, shown) && shown.machines.length === 0 && project.machines.length + (project.machines_gone ?? 0) > 0) setConfirmUnrestricted(true);
              else void save();
            }}
          >
            {saving ? t('proj.settings.saving') : t('common.save')}
          </Button>
        </div>
      ) : null}

      <Confirm
        open={confirmArchive}
        danger={false}
        title={t('proj.lifecycle.archiveConfirmTitle', { name: project.name })}
        description={archiveDescription}
        confirm={t('proj.lifecycle.archive')}
        busy={archive.busy}
        error={archive.error}
        onConfirm={() => { void archive.set(true).then((ok) => { if (ok) setConfirmArchive(false); }); }}
        onCancel={() => setConfirmArchive(false)}
      />

      <Confirm
        open={confirmUnrestricted}
        danger={false}
        title={t('proj.settings.unrestrictedConfirmTitle')}
        description={t('proj.settings.unrestrictedConfirmDesc', { name: project.name })}
        confirm={t('proj.settings.unrestrictedConfirmBtn')}
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
