// Unified searchable, multi-dimensional catalog for ledger entries and native skills/<slug>/SKILL.md files,
// with desktop Master-Detail split view, mobile/narrow preview sheet, and inline Registry + machine scope editors.
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  ANY_ROLE_LABEL, ENTRY_STATE_LABELS, GLOBAL_LABEL, KIND_LABELS, LOADING_LABELS, citation,
  type KnowledgeKind, type Loading,
} from '@shared/knowledge.ts';
import type {
  DirectorySkill, EntryMachinesMap, IgnoredSkillEntry, SkillRegistryBinding,
} from '@shared/skill-catalog.ts';
import { Copyable, Details, Empty, Mono, Note, Problem, Rows, SectionTitle } from '@/components/bits';
import { entryPath, kib, loadingText, reviewText, rolesText, scopeOf, type Names } from '@/components/knowledge-bits';
import { Markdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, Choice } from '@/components/ui/checkbox';
import { Sheet, SheetContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Option, Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { messageOf, put } from '@/lib/api';
import { KNOWLEDGE, PAGE } from '@/lib/queries';
import type { KnowledgeEntry } from '@/lib/types';
import { cn } from '@/lib/utils';

export interface KnowledgeCatalogProps {
  entries: readonly KnowledgeEntry[];
  directorySkills: readonly DirectorySkill[];
  ignoredSkills: readonly IgnoredSkillEntry[];
  skillsDir?: string;
  projects: readonly { id: string; name: string }[];
  roles: readonly { id: string; name: string }[];
  machines?: readonly { id: string; host: string }[];
  entryMachines?: EntryMachinesMap;
  initialQuery?: string;
  initialSelectedId?: string | null;
  onSelectedChange?: (id: string | null) => void;
}

type MachineOption = { id: string; host: string };
type LoadingFilter = 'all' | Loading;

type CatalogItem =
  | {
      origin: 'ledger';
      id: string;
      title: string;
      summary: string;
      kind: KnowledgeKind;
      loading: Loading;
      project_ids: string[] | null;
      roles: string[];
      machine_ids: string[] | null;
      inactive: boolean;
      inactiveLabel: string | null;
      bytes: number;
      refText: string;
      searchText: string;
      entry: KnowledgeEntry;
    }
  | {
      origin: 'directory';
      id: string;
      title: string;
      summary: string;
      kind: 'skill';
      loading: Loading;
      project_ids: string[] | null;
      roles: string[];
      machine_ids: string[] | null;
      inactive: boolean;
      inactiveLabel: string | null;
      bytes: number;
      refText: string;
      searchText: string;
      skill: DirectorySkill;
    };

const utf8 = new TextEncoder();
const byteLength = (text: string): number => utf8.encode(text).length;

const SCOPE_GLOBAL = '__global__';
const ROLE_ANY = '__any__';
const MACHINE_ALL_ONLY = '__all_machines__';
const WIDE_QUERY = '(min-width: 1024px)';

const LOADING_FILTER_OPTIONS: readonly { value: LoadingFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'resident', label: LOADING_LABELS.resident },
  { value: 'on_demand', label: LOADING_LABELS.on_demand },
];

const BINDING_LOADING_OPTIONS: readonly { value: Loading; label: string }[] = [
  { value: 'on_demand', label: LOADING_LABELS.on_demand },
  { value: 'resident', label: LOADING_LABELS.resident },
];

const BINDING_SCOPE_OPTIONS = [
  { value: 'global', label: GLOBAL_LABEL },
  { value: 'projects', label: '指定项目' },
] as const;

const MACHINE_SCOPE_OPTIONS = [
  { value: 'all', label: '全部机器' },
  { value: 'machines', label: '指定机器' },
] as const;

const BOUNDARY_NOTE = '控制 Tycho 派发轮次的注入范围、加载方式与节点同步；不修改 SKILL.md 原文件。';

const EMPTY_MACHINES: readonly MachineOption[] = [];
const EMPTY_ENTRY_MACHINES: EntryMachinesMap = {};

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

const normalizeIds = (ids: readonly string[] | null | undefined): string[] | null =>
  ids == null ? null : [...ids].sort();

const normalizeBinding = (binding: SkillRegistryBinding): SkillRegistryBinding => ({
  enabled: binding.enabled,
  loading: binding.loading,
  project_ids: normalizeIds(binding.project_ids),
  roles: [...binding.roles].sort(),
  machine_ids: normalizeIds(binding.machine_ids),
});

function sameBinding(a: SkillRegistryBinding, b: SkillRegistryBinding): boolean {
  return JSON.stringify(normalizeBinding(a)) === JSON.stringify(normalizeBinding(b));
}

function machineOptionText(machine: MachineOption): string {
  return machine.host && machine.host !== machine.id ? `${machine.id}（${machine.host}）` : machine.id;
}

function machineBadgeInfo(
  machineIds: readonly string[] | null,
  machines: readonly MachineOption[],
): { label: string; title: string; empty: boolean } | null {
  if (machineIds === null) return null;
  if (machineIds.length === 0) {
    return { label: '未分配机器', title: '未分配任何机器，不会派发到任何节点', empty: true };
  }
  const labels = machineIds.map((id) => machines.find((machine) => machine.id === id)?.id ?? id);
  const full = labels.join('、');
  const short = labels.length <= 2 ? full : `${labels.slice(0, 2).join('、')} 等 ${labels.length} 台`;
  return { label: `仅 ${short}`, title: `仅限机器：${full}`, empty: false };
}

function CatalogRow({
  item,
  names,
  machines,
  active,
  compact = false,
  onSelect,
  buttonRef,
}: {
  item: CatalogItem;
  names: Names;
  machines: readonly MachineOption[];
  active: boolean;
  compact?: boolean;
  onSelect: (id: string) => void;
  buttonRef?: (node: HTMLButtonElement | null) => void;
}) {
  const machineBadge = machineBadgeInfo(item.machine_ids, machines);

  return (
    <li>
      <button
        ref={buttonRef}
        type="button"
        aria-current={active ? 'true' : undefined}
        className={cn(
          'block w-full cursor-pointer text-left text-sm transition-colors duration-100 focus-visible:-outline-offset-2',
          compact ? 'px-3.5 py-2.5' : 'px-3.5 py-2.5',
          active
            ? 'bg-brand-soft/75 shadow-[inset_3px_0_0_0_var(--primary)]'
            : 'hover:bg-muted/70',
        )}
        onClick={() => onSelect(item.id)}
      >
        <span className="flex items-baseline justify-between gap-3">
          <span
            className={cn(
              'min-w-0 font-semibold text-foreground',
              compact ? 'truncate' : 'wrap-anywhere',
              item.inactive && 'text-muted-foreground line-through',
            )}
          >
            {item.title}
          </span>
          <span className="flex-none text-xs text-faint tabular-nums">{kib(item.bytes)}</span>
        </span>

        {!compact && item.summary ? (
          <span className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground wrap-anywhere">
            {item.summary}
          </span>
        ) : null}

        <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-faint">
          {item.loading === 'resident' ? (
            <Badge className="border-brand-border bg-brand-soft text-brand-foreground">
              {LOADING_LABELS.resident}
            </Badge>
          ) : (
            <span className="text-muted-foreground">{LOADING_LABELS.on_demand}</span>
          )}

          <span aria-hidden="true">·</span>
          <span className="text-muted-foreground">{KIND_LABELS[item.kind]}</span>

          {item.origin === 'ledger' ? (
            <>
              <span aria-hidden="true">·</span>
              <Mono className="text-muted-foreground">{item.refText}</Mono>
            </>
          ) : null}

          {(!compact || item.roles.length > 0) ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate text-muted-foreground">{rolesText(names, item.roles)}</span>
            </>
          ) : null}

          <span aria-hidden="true">·</span>
          {machineBadge ? (
            <Badge tone={machineBadge.empty ? 'waiting' : 'plain'} title={machineBadge.title}>
              {machineBadge.label}
            </Badge>
          ) : (
            <span>全机</span>
          )}

          {item.inactiveLabel ? <Badge tone="ended">{item.inactiveLabel}</Badge> : null}

          {item.origin === 'ledger' && (!compact || item.entry.reviewed_at === null) ? (
            <>
              <span aria-hidden="true">·</span>
              <span className={item.entry.reviewed_at === null ? 'text-waiting-foreground' : undefined}>
                {reviewText(item.entry.reviewed_at)}
              </span>
            </>
          ) : null}
        </span>
      </button>
    </li>
  );
}

function MachineCheckboxes({
  machines,
  selectedIds,
  disabled,
  onChange,
}: {
  machines: readonly MachineOption[];
  selectedIds: readonly string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  if (!machines.length) {
    return <Note className="text-xs">还没有接入机器。</Note>;
  }
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">适用机器</legend>
      <ul className="flex flex-wrap gap-x-4 gap-y-0.5">
        {machines.map((machine) => (
          <li key={machine.id}>
            <Choice className="min-h-hit-sm text-xs">
              <Checkbox
                checked={selectedIds.includes(machine.id)}
                disabled={disabled}
                onChange={(event) => {
                  onChange(
                    event.target.checked
                      ? [...selectedIds, machine.id]
                      : selectedIds.filter((each) => each !== machine.id),
                  );
                }}
              />
              <span>{machineOptionText(machine)}</span>
            </Choice>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

function LedgerDetailPane({
  item,
  names,
  machines,
  entryMachines,
  showHeader,
}: {
  item: Extract<CatalogItem, { origin: 'ledger' }>;
  names: Names;
  machines: readonly MachineOption[];
  entryMachines: EntryMachinesMap;
  showHeader: boolean;
}) {
  const queryClient = useQueryClient();
  const { entry } = item;
  const retired = entry.state === 'retired';
  const ref = citation(entry.id, entry.revision);

  const serverMachineIds = useMemo(
    () => normalizeIds(entryMachines[entry.id]),
    [entryMachines, entry.id],
  );
  const serverKey = JSON.stringify(serverMachineIds);
  const machineIdsKey = machines.map((machine) => machine.id).join('\0');
  const knownMachineIds = useMemo(() => new Set(machines.map((machine) => machine.id)), [machineIdsKey]);
  const filterMachines = (ids: readonly string[] | null): string[] => {
    if (!ids) return [];
    return machines.length > 0 ? ids.filter((id) => knownMachineIds.has(id)) : [...ids];
  };

  const [machineScope, setMachineScope] = useState<'all' | 'machines'>(serverMachineIds === null ? 'all' : 'machines');
  const [selectedMachines, setSelectedMachines] = useState<string[]>(() => filterMachines(serverMachineIds));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setMachineScope(serverMachineIds === null ? 'all' : 'machines');
    setSelectedMachines(filterMachines(serverMachineIds));
  }, [entry.id, serverKey, machineIdsKey]);

  const draftMachineIds: string[] | null = machineScope === 'all' ? null : [...selectedMachines].sort();
  const invalidMachines = machineScope === 'machines' && selectedMachines.length === 0;
  const dirty = JSON.stringify(draftMachineIds) !== serverKey;
  const machineBadge = machineBadgeInfo(draftMachineIds, machines);

  const markEdited = () => {
    setSaved(false);
    setError(null);
  };

  async function saveMachines(): Promise<void> {
    if (busy || invalidMachines || !dirty) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await put(`/api/knowledge/entries/${encodeURIComponent(entry.id)}/machines`, {
        machine_ids: draftMachineIds,
      });
      setSaved(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: KNOWLEDGE }),
        queryClient.invalidateQueries({ queryKey: [PAGE, 'knowledge-effective'] }),
      ]);
    } catch (refused) {
      setError(messageOf(refused));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col">
      {showHeader ? (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold wrap-anywhere">{entry.title}</h2>
              <Mono className="rounded-sm bg-muted px-1.5 py-0.5 text-muted-foreground">{ref}</Mono>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {entry.loading === 'resident' ? (
                <Badge className="border-brand-border bg-brand-soft text-brand-foreground">
                  {LOADING_LABELS[entry.loading]}
                </Badge>
              ) : (
                <Badge tone="plain">{LOADING_LABELS[entry.loading]}</Badge>
              )}
              <Badge tone="plain">{KIND_LABELS[entry.kind]}</Badge>
              <Badge tone={retired ? 'ended' : 'success'}>{ENTRY_STATE_LABELS[entry.state]}</Badge>
              <Badge tone={entry.reviewed_at === null ? 'waiting' : 'plain'}>{reviewText(entry.reviewed_at)}</Badge>
              {machineBadge ? (
                <Badge tone={machineBadge.empty ? 'waiting' : 'plain'} title={machineBadge.title}>
                  {machineBadge.label}
                </Badge>
              ) : null}
            </div>
          </div>
          <Button size="sm" asChild className="flex-none">
            <Link to={entryPath(entry.id)}>
              查看完整详情
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </Link>
          </Button>
        </header>
      ) : (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {entry.loading === 'resident' ? (
              <Badge className="border-brand-border bg-brand-soft text-brand-foreground">
                {LOADING_LABELS[entry.loading]}
              </Badge>
            ) : (
              <Badge tone="plain">{LOADING_LABELS[entry.loading]}</Badge>
            )}
            <Badge tone="plain">{KIND_LABELS[entry.kind]}</Badge>
            <Badge tone={retired ? 'ended' : 'success'}>{ENTRY_STATE_LABELS[entry.state]}</Badge>
            <Badge tone={entry.reviewed_at === null ? 'waiting' : 'plain'}>{reviewText(entry.reviewed_at)}</Badge>
            {machineBadge ? (
              <Badge tone={machineBadge.empty ? 'waiting' : 'plain'} title={machineBadge.title}>
                {machineBadge.label}
              </Badge>
            ) : null}
          </div>
          <Button size="sm" asChild>
            <Link to={entryPath(entry.id)}>
              查看完整详情
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </Link>
          </Button>
        </div>
      )}

      {/* Compact inline metadata + editable machine distribution strip */}
      <div className={cn('grid gap-3 border-b border-border bg-muted/40 text-xs', showHeader ? 'px-5 py-3.5' : 'mb-4 rounded-xl border p-3.5')}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-muted-foreground">
          <span>
            <span className="text-faint">作用域 </span>
            <span className="font-medium text-foreground">{scopeOf(names, entry.project_ids, entry.roles)}</span>
          </span>
          <span>
            <span className="text-faint">职能 </span>
            <span className="font-medium text-foreground">{rolesText(names, entry.roles)}</span>
          </span>
          <span>
            <span className="text-faint">加载 </span>
            <span className="font-medium text-foreground">{loadingText(entry.kind, entry.loading)}</span>
          </span>
          <span className="tabular-nums">
            <span className="text-faint">大小 </span>
            <span className="font-medium text-foreground">{kib(item.bytes)}</span>
          </span>
        </div>

        <div className="grid gap-2 border-t border-border/70 pt-2.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="text-xs font-medium text-muted-foreground">可用机器</span>
            <Segmented
              label="可用机器"
              value={machineScope}
              options={MACHINE_SCOPE_OPTIONS}
              disabled={busy}
              onChange={(value) => { setMachineScope(value); markEdited(); }}
            />
            <Button
              size="sm"
              variant={dirty ? 'primary' : 'secondary'}
              className="ml-auto"
              disabled={busy || invalidMachines || !dirty}
              onClick={() => void saveMachines()}
            >
              {busy ? '保存中' : '保存机器范围'}
            </Button>
          </div>

          {machineScope === 'machines' ? (
            <MachineCheckboxes
              machines={machines}
              selectedIds={selectedMachines}
              disabled={busy}
              onChange={(next) => { setSelectedMachines(next); markEdited(); }}
            />
          ) : null}

          {invalidMachines ? <Note className="text-xs">请至少选择一台机器，或切换为全部机器。</Note> : null}
          {error ? <Problem role="alert" className="text-xs">{error}</Problem> : null}
          {saved && !error ? <p role="status" className="text-xs text-success-foreground">已保存可用机器范围。</p> : null}
        </div>
      </div>

      {/* Reading body */}
      <div className={cn('grid gap-4', showHeader ? 'px-5 py-5' : '')}>
        {entry.when_to_use ? (
          <div className="rounded-lg border border-border bg-muted/45 px-3.5 py-2.5">
            <p className="text-xs font-medium text-muted-foreground">触发场景</p>
            <p className="mt-1 text-sm leading-relaxed wrap-anywhere">{entry.when_to_use}</p>
          </div>
        ) : null}

        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">正文</p>
          <Markdown text={entry.body} />
        </div>
      </div>
    </div>
  );
}

function DirectorySkillPane({
  skill,
  projects,
  roles,
  machines,
  showHeader,
}: {
  skill: DirectorySkill;
  projects: readonly { id: string; name: string }[];
  roles: readonly { id: string; name: string }[];
  machines: readonly MachineOption[];
  showHeader: boolean;
}) {
  const queryClient = useQueryClient();
  const projectIdsKey = projects.map((project) => project.id).join('\0');
  const roleIdsKey = roles.map((role) => role.id).join('\0');
  const machineIdsKey = machines.map((machine) => machine.id).join('\0');
  const knownProjectIds = useMemo(() => new Set(projects.map((project) => project.id)), [projectIdsKey]);
  const knownRoleIds = useMemo(() => new Set(roles.map((role) => role.id)), [roleIdsKey]);
  const knownMachineIds = useMemo(() => new Set(machines.map((machine) => machine.id)), [machineIdsKey]);
  const filterProjects = (ids: readonly string[] | null): string[] => (ids ?? []).filter((id) => knownProjectIds.has(id));
  const filterRoles = (ids: readonly string[]): string[] => ids.filter((id) => knownRoleIds.has(id));
  const filterMachines = (ids: readonly string[] | null | undefined): string[] => {
    if (!ids) return [];
    return machines.length > 0 ? ids.filter((id) => knownMachineIds.has(id)) : [...ids];
  };

  const normalizedServer = useMemo(() => normalizeBinding(skill.binding), [skill.binding]);
  const bindingKey = JSON.stringify(normalizedServer);

  const [enabled, setEnabled] = useState(normalizedServer.enabled);
  const [loading, setLoading] = useState<Loading>(normalizedServer.loading);
  const [scope, setScope] = useState<'global' | 'projects'>(normalizedServer.project_ids === null ? 'global' : 'projects');
  const [projectIds, setProjectIds] = useState<string[]>(() => filterProjects(normalizedServer.project_ids));
  const [selectedRoles, setSelectedRoles] = useState<string[]>(() => filterRoles(normalizedServer.roles));
  const [machineScope, setMachineScope] = useState<'all' | 'machines'>(normalizedServer.machine_ids === null ? 'all' : 'machines');
  const [selectedMachines, setSelectedMachines] = useState<string[]>(() => filterMachines(normalizedServer.machine_ids));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Sync local form controls when refreshed binding arrives from server.
  useEffect(() => {
    setEnabled(normalizedServer.enabled);
    setLoading(normalizedServer.loading);
    setScope(normalizedServer.project_ids === null ? 'global' : 'projects');
    setProjectIds(filterProjects(normalizedServer.project_ids));
    setSelectedRoles(filterRoles(normalizedServer.roles));
    setMachineScope(normalizedServer.machine_ids === null ? 'all' : 'machines');
    setSelectedMachines(filterMachines(normalizedServer.machine_ids));
  }, [skill.slug, bindingKey, projectIdsKey, roleIdsKey, machineIdsKey]);

  const draftBinding: SkillRegistryBinding = {
    enabled,
    loading,
    project_ids: scope === 'global' ? null : [...projectIds].sort(),
    roles: [...selectedRoles].sort(),
    machine_ids: machineScope === 'all' ? null : [...selectedMachines].sort(),
  };

  const invalidScope = scope === 'projects' && projectIds.length === 0;
  const invalidMachines = machineScope === 'machines' && selectedMachines.length === 0;
  const dirty = !sameBinding(draftBinding, normalizedServer);
  const machineBadge = machineBadgeInfo(draftBinding.machine_ids, machines);

  const markEdited = () => {
    setSaved(false);
    setError(null);
  };

  async function save(): Promise<void> {
    if (busy || invalidScope || invalidMachines || !dirty) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await put(`/api/knowledge/registry/${encodeURIComponent(skill.slug)}`, draftBinding);
      setSaved(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: KNOWLEDGE }),
        queryClient.invalidateQueries({ queryKey: [PAGE, 'knowledge-effective'] }),
      ]);
    } catch (refused) {
      setError(messageOf(refused));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col">
      {showHeader ? (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold wrap-anywhere">{skill.name}</h2>
              {!enabled ? <Badge tone="ended">已停用</Badge> : null}
              {machineBadge ? (
                <Badge tone={machineBadge.empty ? 'waiting' : 'plain'} title={machineBadge.title}>
                  {machineBadge.label}
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <span>{KIND_LABELS.skill}</span>
              <span aria-hidden="true" className="text-faint">·</span>
              <Mono className="text-muted-foreground">{skill.rel_path}</Mono>
              <span aria-hidden="true" className="text-faint">·</span>
              <span className="tabular-nums text-faint">{kib(skill.bytes)}</span>
            </p>
          </div>
        </header>
      ) : (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <Badge tone="plain">{KIND_LABELS.skill}</Badge>
          {!enabled ? <Badge tone="ended">已停用</Badge> : null}
          {machineBadge ? (
            <Badge tone={machineBadge.empty ? 'waiting' : 'plain'} title={machineBadge.title}>
              {machineBadge.label}
            </Badge>
          ) : null}
        </div>
      )}

      {/* Compact inline property strip — stays sleek above the Markdown reading area */}
      <div className={cn('grid gap-2 border-b border-border bg-muted/40 text-xs', showHeader ? 'px-5 py-3' : 'mb-4 rounded-xl border p-3.5')}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Choice className="min-h-hit-sm text-xs">
            <Switch
              aria-label="参与 Tycho 派发注入"
              checked={enabled}
              disabled={busy}
              onCheckedChange={(checked) => { setEnabled(checked); markEdited(); }}
            />
            <span className="font-medium text-foreground">派发启用</span>
          </Choice>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">加载方式</span>
            <Segmented
              label="加载方式"
              value={loading}
              options={BINDING_LOADING_OPTIONS}
              disabled={busy}
              onChange={(value) => { setLoading(value); markEdited(); }}
            />
          </div>

          <Button
            size="sm"
            variant={dirty ? 'primary' : 'secondary'}
            className="ml-auto"
            disabled={busy || invalidScope || invalidMachines || !dirty}
            onClick={() => void save()}
          >
            {busy ? '保存中' : '保存配置'}
          </Button>
        </div>

        <div className="grid gap-2 border-t border-border/70 pt-2">
          <div className={cn(
            'grid gap-2',
            scope === 'global' && machineScope === 'all' ? 'sm:grid-cols-2 sm:gap-x-6' : 'grid-cols-1',
          )}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="w-14 flex-none text-muted-foreground">作用域</span>
              <Segmented
                label="作用域"
                value={scope}
                options={BINDING_SCOPE_OPTIONS}
                disabled={busy}
                onChange={(value) => { setScope(value); markEdited(); }}
              />
              {scope === 'projects' ? (
                projects.length ? (
                  <fieldset className="min-w-0 flex-1">
                    <legend className="sr-only">适用项目</legend>
                    <ul className="flex flex-wrap gap-x-4 gap-y-0.5">
                      {projects.map((project) => (
                        <li key={project.id}>
                          <Choice className="min-h-hit-sm text-xs">
                            <Checkbox
                              checked={projectIds.includes(project.id)}
                              disabled={busy}
                              onChange={(event) => {
                                setProjectIds(
                                  event.target.checked
                                    ? [...projectIds, project.id]
                                    : projectIds.filter((each) => each !== project.id),
                                );
                                markEdited();
                              }}
                            />
                            {project.name}
                          </Choice>
                        </li>
                      ))}
                    </ul>
                  </fieldset>
                ) : <Note className="text-xs">还没有项目。</Note>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="w-14 flex-none text-muted-foreground">分发机器</span>
              <Segmented
                label="分发机器"
                value={machineScope}
                options={MACHINE_SCOPE_OPTIONS}
                disabled={busy}
                onChange={(value) => { setMachineScope(value); markEdited(); }}
              />
              {machineScope === 'machines' ? (
                <div className="min-w-0 flex-1">
                  <MachineCheckboxes
                    machines={machines}
                    selectedIds={selectedMachines}
                    disabled={busy}
                    onChange={(next) => { setSelectedMachines(next); markEdited(); }}
                  />
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="w-14 flex-none text-muted-foreground">适用职能</span>
            {roles.length ? (
              <fieldset className="min-w-0 flex-1">
                <legend className="sr-only">适用职能</legend>
                <ul className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
                  {roles.map((role) => (
                    <li key={role.id}>
                      <Choice className="min-h-hit-sm text-xs">
                        <Checkbox
                          checked={selectedRoles.includes(role.id)}
                          disabled={busy}
                          onChange={(event) => {
                            setSelectedRoles(
                              event.target.checked
                                ? [...selectedRoles, role.id]
                                : selectedRoles.filter((each) => each !== role.id),
                            );
                            markEdited();
                          }}
                        />
                        {role.name}
                      </Choice>
                    </li>
                  ))}
                  {selectedRoles.length === 0 ? (
                    <li className="text-faint">（{ANY_ROLE_LABEL}）</li>
                  ) : null}
                </ul>
              </fieldset>
            ) : <Note className="text-xs">还没有定义职能，当前为{ANY_ROLE_LABEL}。</Note>}
          </div>
        </div>

        {invalidScope ? <Note className="text-xs">请至少选择一个项目，或切换为全局。</Note> : null}
        {invalidMachines ? <Note className="text-xs">请至少选择一台机器，或切换为全部机器。</Note> : null}
        {error ? <Problem role="alert" className="text-xs">{error}</Problem> : null}
        {saved && !error ? <p role="status" className="text-xs text-success-foreground">已保存派发注入配置。</p> : null}

        <Note className="border-t border-border/70 pt-2 text-xs">{BOUNDARY_NOTE}</Note>
      </div>

      {/* Reading body */}
      <div className={cn('grid gap-4', showHeader ? 'px-5 py-5' : '')}>
        {skill.description ? (
          <div className="rounded-lg border border-border bg-muted/45 px-3.5 py-2.5">
            <p className="text-xs font-medium text-muted-foreground">触发场景</p>
            <p className="mt-1 text-sm leading-relaxed wrap-anywhere">{skill.description}</p>
          </div>
        ) : null}

        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">正文</p>
          <Markdown text={skill.body} />
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="text-faint">文件</span>
            <Copyable value={skill.rel_path} />
          </span>
          <span className="tabular-nums">
            <span className="text-faint">大小 </span>
            {`${kib(skill.bytes)}（${skill.bytes} B）`}
          </span>
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="text-faint">SHA-256</span>
            <Copyable value={skill.sha256} />
          </span>
        </div>
      </div>
    </div>
  );
}

function ItemDetailPane({
  item,
  names,
  projects,
  roles,
  machines,
  entryMachines,
  showHeader,
}: {
  item: CatalogItem;
  names: Names;
  projects: readonly { id: string; name: string }[];
  roles: readonly { id: string; name: string }[];
  machines: readonly MachineOption[];
  entryMachines: EntryMachinesMap;
  showHeader: boolean;
}) {
  if (item.origin === 'ledger') {
    return (
      <LedgerDetailPane
        key={item.entry.id}
        item={item}
        names={names}
        machines={machines}
        entryMachines={entryMachines}
        showHeader={showHeader}
      />
    );
  }
  return (
    <DirectorySkillPane
      key={item.skill.slug}
      skill={item.skill}
      projects={projects}
      roles={roles}
      machines={machines}
      showHeader={showHeader}
    />
  );
}

function IgnoredSkillsDisclosure({
  ignoredSkills,
  skillsDir,
  className,
}: {
  ignoredSkills: readonly IgnoredSkillEntry[];
  skillsDir?: string;
  className?: string;
}) {
  if (!ignoredSkills.length) return null;
  return (
    <Details
      id="knowledge-catalog:ignored-skills"
      title={`技能目录里略过 ${ignoredSkills.length} 项非标准内容`}
      summaryClassName="min-h-hit-sm text-xs"
      className={className}
    >
      <div className="mt-2 grid gap-2 pb-1">
        {skillsDir ? (
          <Note className="text-xs">
            扫描目录：<Mono>{skillsDir}</Mono>（仅识别 <Mono>{'<slug>/SKILL.md'}</Mono> 结构）
          </Note>
        ) : null}
        <Rows>
          <ul className="divide-y divide-border">
            {ignoredSkills.map((ignored) => (
              <li
                key={`${ignored.name}:${ignored.reason}`}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-1.5 text-xs"
              >
                <Mono className="text-foreground">{ignored.name}</Mono>
                <span className="text-muted-foreground wrap-anywhere">{ignored.reason}</span>
              </li>
            ))}
          </ul>
        </Rows>
      </div>
    </Details>
  );
}

export function KnowledgeCatalog({
  entries,
  directorySkills,
  ignoredSkills,
  skillsDir,
  projects,
  roles,
  machines = EMPTY_MACHINES,
  entryMachines = EMPTY_ENTRY_MACHINES,
  initialQuery = '',
  initialSelectedId = null,
  onSelectedChange,
}: KnowledgeCatalogProps) {
  const isWide = useMediaQuery(WIDE_QUERY);
  const [query, setQuery] = useState(initialQuery);
  const [loadingFilter, setLoadingFilter] = useState<LoadingFilter>('all');
  const [scopeFilter, setScopeFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [machineFilter, setMachineFilter] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  useEffect(() => {
    setSelectedId(initialSelectedId);
  }, [initialSelectedId]);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  const selectItem = (id: string | null) => {
    setSelectedId(id);
    onSelectedChange?.(id);
  };

  const names = useMemo<Names>(() => ({ projects: [...projects], roles: [...roles] }), [projects, roles]);

  // Merge ledger entries and directory skills, skipping any managed ledger-materialized SKILL.md
  // (matching backend applicableDirectorySkills so UI and dispatch never diverge).
  const allItems = useMemo<CatalogItem[]>(() => {
    const ledgerItems: CatalogItem[] = entries.map((entry) => {
      const ref = citation(entry.id, entry.revision);
      const retired = entry.state === 'retired';
      return {
        origin: 'ledger',
        id: entry.id,
        title: entry.title,
        summary: entry.when_to_use,
        kind: entry.kind,
        loading: entry.loading,
        project_ids: entry.project_ids,
        roles: entry.roles,
        machine_ids: normalizeIds(entryMachines[entry.id]),
        inactive: retired,
        inactiveLabel: retired ? ENTRY_STATE_LABELS.retired : null,
        bytes: byteLength(entry.body),
        refText: ref,
        searchText: [entry.title, entry.when_to_use, entry.body, entry.id, ref].join('\n').toLowerCase(),
        entry,
      };
    });

    const directoryItems: CatalogItem[] = [];
    for (const skill of directorySkills) {
      if (skill.managed_ledger_id !== null) continue;
      const disabled = !skill.binding.enabled;
      directoryItems.push({
        origin: 'directory',
        id: skill.id,
        title: skill.name,
        summary: skill.description,
        kind: 'skill',
        loading: skill.binding.loading,
        project_ids: skill.binding.project_ids,
        roles: skill.binding.roles,
        machine_ids: normalizeIds(skill.binding.machine_ids),
        inactive: disabled,
        inactiveLabel: disabled ? '已停用' : null,
        bytes: skill.bytes,
        refText: skill.rel_path,
        searchText: [skill.name, skill.description, skill.body, skill.id, skill.slug, skill.rel_path].join('\n').toLowerCase(),
        skill,
      });
    }

    return [...ledgerItems, ...directoryItems];
  }, [entries, directorySkills, entryMachines]);

  const queryTokens = useMemo(
    () => query.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  );

  const matchedBase = useMemo(() => allItems.filter((item) => {
    if (loadingFilter !== 'all' && item.loading !== loadingFilter) return false;
    if (scopeFilter === SCOPE_GLOBAL) {
      if (item.project_ids !== null) return false;
    } else if (scopeFilter) {
      if (item.project_ids === null || !item.project_ids.includes(scopeFilter)) return false;
    }
    if (roleFilter === ROLE_ANY) {
      if (item.roles.length !== 0) return false;
    } else if (roleFilter) {
      if (!item.roles.includes(roleFilter)) return false;
    }
    if (machineFilter === MACHINE_ALL_ONLY) {
      if (item.machine_ids !== null) return false;
    } else if (machineFilter) {
      if (item.machine_ids === null || !item.machine_ids.includes(machineFilter)) return false;
    }
    if (queryTokens.length > 0 && !queryTokens.every((token) => item.searchText.includes(token))) return false;
    return true;
  }), [allItems, loadingFilter, scopeFilter, roleFilter, machineFilter, queryTokens]);

  const hiddenInactive = useMemo(() => matchedBase.filter((item) => item.inactive).length, [matchedBase]);
  const shown = useMemo(
    () => (showInactive ? matchedBase : matchedBase.filter((item) => !item.inactive)),
    [matchedBase, showInactive],
  );

  // 全局 first, then one group per set of projects ordered consistently with knowledge.tsx.
  const groups = useMemo(() => {
    const rank = (id: string): number => {
      const at = projects.findIndex((project) => project.id === id);
      return at === -1 ? projects.length : at;
    };
    const order = (a: readonly string[], b: readonly string[]): number => {
      for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
        const diff = rank(a[index]!) - rank(b[index]!) || a[index]!.localeCompare(b[index]!);
        if (diff) return diff;
      }
      return a.length - b.length;
    };
    const byRank = (ids: readonly string[]): string[] => [...ids].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const keyOf = (ids: readonly string[]): string => JSON.stringify([...ids].sort());

    const sets = new Map<string, string[]>();
    for (const item of shown) {
      if (item.project_ids !== null) sets.set(keyOf(item.project_ids), byRank(item.project_ids));
    }

    const sortItems = (items: CatalogItem[]) => [
      ...items.filter((item) => !item.inactive),
      ...items.filter((item) => item.inactive),
    ];

    return [
      { key: '', label: GLOBAL_LABEL, items: sortItems(shown.filter((item) => item.project_ids === null)) },
      ...[...sets.entries()]
        .sort(([, a], [, b]) => order(a, b))
        .map(([key, ids]) => ({
          key,
          label: scopeOf(names, ids, []),
          items: sortItems(shown.filter((item) => item.project_ids !== null && keyOf(item.project_ids) === key)),
        })),
    ].filter((group) => group.items.length > 0);
  }, [shown, projects, names]);

  const visibleItems = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  const hasActiveFilters = Boolean(query.trim() || loadingFilter !== 'all' || scopeFilter || roleFilter || machineFilter);
  const explicitSelectedItem = selectedId === null ? null : allItems.find((item) => item.id === selectedId) ?? null;
  const wideActiveItem = isWide
    ? ((selectedId !== null ? visibleItems.find((item) => item.id === selectedId) : undefined) ?? visibleItems[0] ?? explicitSelectedItem)
    : null;

  // Desktop keyboard navigation across visible catalog items with ArrowUp / ArrowDown.
  useEffect(() => {
    if (!isWide || visibleItems.length === 0) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const target = document.activeElement as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
        if (target.closest('[role="dialog"]')) return;
      }
      event.preventDefault();
      const currentId = wideActiveItem?.id ?? null;
      const currentIndex = currentId === null ? -1 : visibleItems.findIndex((item) => item.id === currentId);
      const nextIndex = event.key === 'ArrowDown'
        ? (currentIndex === -1 ? 0 : Math.min(currentIndex + 1, visibleItems.length - 1))
        : (currentIndex <= 0 ? 0 : currentIndex - 1);
      const next = visibleItems[nextIndex];
      if (!next) return;
      selectItem(next.id);
      rowRefs.current.get(next.id)?.scrollIntoView?.({ block: 'nearest' });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isWide, visibleItems, wideActiveItem?.id]);

  const resetFilters = () => {
    setQuery('');
    setLoadingFilter('all');
    setScopeFilter('');
    setRoleFilter('');
    setMachineFilter('');
  };

  const setRowRef = (id: string) => (node: HTMLButtonElement | null) => {
    if (node) rowRefs.current.set(id, node);
    else rowRefs.current.delete(id);
  };

  return (
    <section aria-label="知识与技能目录">
      {/* Compact single-row filter toolbar */}
      <div className="mb-4 grid gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="relative min-w-[180px] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" aria-hidden="true" />
            <Input
              aria-label="搜索知识与技能"
              placeholder="搜索知识或技能…"
              className="pr-8 pl-8"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <button
                type="button"
                aria-label="清空搜索"
                className="absolute top-1/2 right-1.5 inline-flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm text-faint hover:bg-hover hover:text-foreground"
                onClick={() => setQuery('')}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </div>

          <Segmented label="加载方式筛选" value={loadingFilter} options={LOADING_FILTER_OPTIONS} onChange={setLoadingFilter} />

          <Select aria-label="作用域筛选" className="w-auto max-w-[136px] min-w-0" value={scopeFilter} onChange={(event) => setScopeFilter(event.target.value)}>
            <Option value="">全部作用域</Option>
            <Option value={SCOPE_GLOBAL}>仅全局</Option>
            {projects.map((project) => <Option key={project.id} value={project.id}>{project.name}</Option>)}
          </Select>

          <Select aria-label="职能筛选" className="w-auto max-w-[116px] min-w-0" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
            <Option value="">全部职能</Option>
            <Option value={ROLE_ANY}>{ANY_ROLE_LABEL}</Option>
            {roles.map((role) => <Option key={role.id} value={role.id}>{role.name}</Option>)}
          </Select>

          <Select aria-label="机器筛选" className="w-auto max-w-[136px] min-w-0" value={machineFilter} onChange={(event) => setMachineFilter(event.target.value)}>
            <Option value="">全部机器</Option>
            <Option value={MACHINE_ALL_ONLY}>仅全机通用</Option>
            {machines.map((machine) => (
              <Option key={machine.id} value={machine.id}>{machineOptionText(machine)}</Option>
            ))}
          </Select>

          <Choice className="ml-auto min-h-hit-sm shrink-0 whitespace-nowrap text-xs text-muted-foreground">
            <Switch aria-label="显示已停用/退役" checked={showInactive} onCheckedChange={setShowInactive} />
            已停用/退役
          </Choice>
        </div>

        {!showInactive && hiddenInactive > 0 ? (
          <Note className="text-xs">{`另有 ${hiddenInactive} 条已停用或退役`}</Note>
        ) : null}
      </div>

      {/* Main content: Master-Detail Split View on desktop (>=1024px), compact list + Sheet on narrow/jsdom */}
      {groups.length ? (
        isWide ? (
          <>
            <div className="grid grid-cols-[296px_minmax(0,1fr)] items-start gap-5">
              <div className="sticky top-4 max-h-[calc(100dvh-9rem)] overflow-y-auto rounded-xl bg-raised shadow-card">
                {groups.map((group, groupIndex) => (
                  <section key={group.key} aria-label={group.label}>
                    <div
                      className={cn(
                        'sticky top-0 z-10 flex items-center justify-between border-b border-border/70 bg-muted/60 px-3.5 py-2 backdrop-blur-xs',
                        groupIndex > 0 && 'border-t',
                      )}
                    >
                      <h2 className="text-xs font-semibold text-muted-foreground">{group.label}</h2>
                      <span className="rounded-full bg-background/80 px-1.5 text-2xs leading-4 font-medium text-muted-foreground tabular-nums">
                        {group.items.length}
                      </span>
                    </div>
                    <ul className="divide-y divide-border/60">
                      {group.items.map((item) => (
                        <CatalogRow
                          key={item.id}
                          item={item}
                          names={names}
                          machines={machines}
                          active={wideActiveItem?.id === item.id}
                          compact
                          onSelect={selectItem}
                          buttonRef={setRowRef(item.id)}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>

              <div className="min-w-0 overflow-hidden rounded-xl bg-raised shadow-card">
                {wideActiveItem ? (
                  <ItemDetailPane
                    item={wideActiveItem}
                    names={names}
                    projects={projects}
                    roles={roles}
                    machines={machines}
                    entryMachines={entryMachines}
                    showHeader
                  />
                ) : null}
              </div>
            </div>

            <IgnoredSkillsDisclosure
              ignoredSkills={ignoredSkills}
              skillsDir={skillsDir}
              className="mt-5 border-t border-border/70 pt-3"
            />
          </>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-6">
              {groups.map((group) => (
                <section key={group.key} aria-label={group.label}>
                  <SectionTitle count={group.items.length}>{group.label}</SectionTitle>
                  <Rows>
                    <ul className="divide-y divide-border">
                      {group.items.map((item) => (
                        <CatalogRow
                          key={item.id}
                          item={item}
                          names={names}
                          machines={machines}
                          active={false}
                          onSelect={selectItem}
                        />
                      ))}
                    </ul>
                  </Rows>
                </section>
              ))}
            </div>

            <IgnoredSkillsDisclosure
              ignoredSkills={ignoredSkills}
              skillsDir={skillsDir}
              className="mt-6 border-t border-border pt-3"
            />
          </>
        )
      ) : (
        <>
          {hasActiveFilters ? (
            <Empty title="没有符合条件的知识或技能">
              <p>换个关键词或放宽筛选条件再试。</p>
              <div className="mt-3">
                <Button size="sm" onClick={resetFilters}>重置筛选</Button>
              </div>
            </Empty>
          ) : (
            <Empty title="还没有可用的知识或技能">
              通过把关的条目与 <Mono>skills/</Mono> 目录下的技能会统一出现在这里；也可以“自己写一条”。
            </Empty>
          )}

          <IgnoredSkillsDisclosure
            ignoredSkills={ignoredSkills}
            skillsDir={skillsDir}
            className="mt-6 border-t border-border pt-3"
          />
        </>
      )}

      {/* Narrow-viewport / JSDOM detail sheet */}
      {!isWide && explicitSelectedItem ? (
        <Sheet open onOpenChange={(open) => { if (!open) selectItem(null); }}>
          <SheetContent
            title={explicitSelectedItem.title}
            description={
              explicitSelectedItem.origin === 'ledger'
                ? `账本修订（${explicitSelectedItem.refText}）`
                : `文件技能（${explicitSelectedItem.skill.rel_path}）`
            }
            footer={<Button variant="ghost" onClick={() => selectItem(null)}>关闭</Button>}
          >
            <ItemDetailPane
              item={explicitSelectedItem}
              names={names}
              projects={projects}
              roles={roles}
              machines={machines}
              entryMachines={entryMachines}
              showHeader={false}
            />
          </SheetContent>
        </Sheet>
      ) : null}
    </section>
  );
}
