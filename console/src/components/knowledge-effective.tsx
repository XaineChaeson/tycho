// Project x Role x Machine effective context preview: shows exact brief.md resident text,
// on-demand snapshot catalog, and brief/snapshot byte budget meters.
import { useQuery } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ANY_ROLE_LABEL, KIND_LABELS, citation } from '@shared/knowledge.ts';
import { t as tr } from '@shared/i18n.ts';
import type { EffectiveContextItem, EffectiveContextReport } from '@shared/skill-catalog.ts';
import { Card, Empty, Mono, Note, Problem, Rows, SectionTitle } from '@/components/bits';
import { entryPath, kib, scopeOf, type Names } from '@/components/knowledge-bits';
import { Badge } from '@/components/ui/badge';
import { Option, Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api, messageOf } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { PAGE } from '@/lib/queries';
import { cn } from '@/lib/utils';

type MachineOption = { id: string; host: string };

export interface KnowledgeEffectivePanelProps {
  projects: readonly { id: string; name: string }[];
  roles: readonly { id: string; name: string }[];
  machines?: readonly MachineOption[];
}

const NEAR_LIMIT_RATIO = 0.8;
const EMPTY_MACHINES: readonly MachineOption[] = [];

function machineOptionText(machine: MachineOption): string {
  return machine.host && machine.host !== machine.id
    ? tr('know.machine.optionWithHost', { id: machine.id, host: machine.host })
    : machine.id;
}

function machineBadgeInfo(
  machineIds: readonly string[] | null | undefined,
  machines: readonly MachineOption[],
): { label: string; title: string; empty: boolean } | null {
  if (machineIds == null) return null;
  if (machineIds.length === 0) {
    return {
      label: tr('know.machine.unassigned'),
      title: tr('know.machine.unassignedTitle'),
      empty: true,
    };
  }
  const sep = tr('know.listSep');
  const labels = machineIds.map((id) => machines.find((machine) => machine.id === id)?.id ?? id);
  const full = labels.join(sep);
  const short = labels.length <= 2
    ? full
    : tr('know.machine.shortMore', { head: labels.slice(0, 2).join(sep), count: labels.length });
  return {
    label: tr('know.machine.onlyLabel', { short }),
    title: tr('know.machine.onlyTitle', { full }),
    empty: false,
  };
}

function BudgetMeter({ label, bytes, limitBytes }: { label: string; bytes: number; limitBytes: number }) {
  const over = limitBytes > 0 ? bytes > limitBytes : bytes > 0;
  const ratio = limitBytes > 0 ? bytes / limitBytes : 0;
  const near = !over && ratio >= NEAR_LIMIT_RATIO;
  const percent = over ? 100 : Math.min(100, Math.max(0, ratio * 100));
  const usedText = (bytes / 1024).toFixed(1);
  const limitText = (limitBytes / 1024).toFixed(0);
  const barTone = over ? 'bg-failed' : near ? 'bg-waiting' : 'bg-primary';
  const valueTone = over ? 'text-failed-foreground' : near ? 'text-waiting-foreground' : 'text-foreground';

  return (
    <Card className="p-3.5" aria-label={label}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className={cn('text-sm font-semibold tabular-nums', valueTone)}>
          {`${usedText} / ${limitText} KiB`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limitBytes}
        aria-valuenow={bytes}
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-200', barTone)}
          style={{ width: `${percent}%` }}
        />
      </div>
    </Card>
  );
}

function itemRef(item: EffectiveContextItem): string {
  if (item.origin === 'directory') {
    return item.slug ? `skills/${item.slug}/SKILL.md` : item.id;
  }
  return item.revision !== null ? citation(item.id, item.revision) : item.id;
}

function EffectiveItemRow({
  item,
  names,
  machines,
}: {
  item: EffectiveContextItem;
  names: Names;
  machines: readonly MachineOption[];
}) {
  const ref = itemRef(item);
  const machineBadge = machineBadgeInfo(item.machine_ids, machines);

  return (
    <li className="px-3.5 py-2.5 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {item.origin === 'ledger' ? (
            <Link to={entryPath(item.id)} className="min-w-0 font-medium wrap-anywhere">
              {item.title}
            </Link>
          ) : (
            <span className="min-w-0 font-medium wrap-anywhere">{item.title}</span>
          )}
          <Badge tone="plain">{KIND_LABELS[item.kind]}</Badge>
          {machineBadge ? (
            <Badge tone={machineBadge.empty ? 'waiting' : 'plain'} title={machineBadge.title}>
              {machineBadge.label}
            </Badge>
          ) : null}
        </div>
        <span className="flex-none text-xs text-muted-foreground tabular-nums">{kib(item.bytes)}</span>
      </div>
      {item.when_to_use ? (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground wrap-anywhere">{item.when_to_use}</p>
      ) : null}
      <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-xs text-faint">
        <Mono className="text-muted-foreground">{ref}</Mono>
        <span className="wrap-anywhere">{scopeOf(names, item.project_ids, item.roles)}</span>
      </p>
    </li>
  );
}

function EffectiveSection({
  title,
  items,
  names,
  machines,
  emptyText,
}: {
  title: string;
  items: readonly EffectiveContextItem[];
  names: Names;
  machines: readonly MachineOption[];
  emptyText: string;
}) {
  return (
    <section aria-label={title}>
      <SectionTitle count={items.length}>{title}</SectionTitle>
      {items.length ? (
        <Rows>
          <ul className="divide-y divide-border">
            {items.map((item) => (
              <EffectiveItemRow
                key={`${item.origin}:${item.id}`}
                item={item}
                names={names}
                machines={machines}
              />
            ))}
          </ul>
        </Rows>
      ) : (
        <Note className="rounded-xl border border-dashed border-border-strong px-4 py-5 text-center text-xs">
          {emptyText}
        </Note>
      )}
    </section>
  );
}

function EffectiveSkeleton() {
  return (
    <div data-slot="effective-skeleton" className="grid grid-cols-1 gap-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Skeleton className="h-[68px] w-full rounded-xl" />
        <Skeleton className="h-[68px] w-full rounded-xl" />
      </div>
      <div className="grid gap-2.5">
        <Skeleton className="h-5 w-52" />
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
      <div className="grid gap-2.5">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    </div>
  );
}

export function KnowledgeEffectivePanel({
  projects,
  roles,
  machines = EMPTY_MACHINES,
}: KnowledgeEffectivePanelProps) {
  const { t } = useI18n();
  const projectSelectId = useId();
  const roleSelectId = useId();
  const machineSelectId = useId();
  const [selectedProjectId, setSelectedProjectId] = useState<string>(() => projects[0]?.id ?? '');
  const [selectedRoleId, setSelectedRoleId] = useState<string>('');
  const [selectedMachineId, setSelectedMachineId] = useState<string>('');

  const projectId = selectedProjectId && projects.some((project) => project.id === selectedProjectId)
    ? selectedProjectId
    : '';
  const roleId = selectedRoleId && roles.some((role) => role.id === selectedRoleId)
    ? selectedRoleId
    : '';
  const machineId = selectedMachineId && machines.some((machine) => machine.id === selectedMachineId)
    ? selectedMachineId
    : '';

  const names = useMemo<Names>(() => ({ projects: [...projects], roles: [...roles] }), [projects, roles]);

  const queryUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (projectId) params.set('project_id', projectId);
    if (roleId) params.set('role_id', roleId);
    if (machineId) params.set('machine_id', machineId);
    const qs = params.toString();
    return qs ? `/api/knowledge/effective?${qs}` : '/api/knowledge/effective';
  }, [projectId, roleId, machineId]);

  const { data, isPending, error } = useQuery({
    queryKey: [PAGE, 'knowledge-effective', projectId, roleId, machineId],
    queryFn: () => api<EffectiveContextReport>(queryUrl),
  });

  const bothEmpty = data !== undefined && data.resident.length === 0 && data.on_demand.length === 0;

  return (
    <section aria-label={t('know.effective.ariaLabel')} className="grid grid-cols-1 gap-6">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border border-border bg-raised p-3.5 shadow-card">
        <div className="grid min-w-44 flex-1 gap-1.5 sm:max-w-xs">
          <label htmlFor={projectSelectId} className="text-xs font-medium text-muted-foreground">{t('know.field.project')}</label>
          <Select
            id={projectSelectId}
            aria-label={t('know.field.project')}
            wrapperClassName="flex"
            value={projectId}
            onChange={(event) => setSelectedProjectId(event.target.value)}
          >
            <Option value="">{t('know.effective.globalOnly')}</Option>
            {projects.map((project) => <Option key={project.id} value={project.id}>{project.name}</Option>)}
          </Select>
        </div>

        <div className="grid min-w-44 flex-1 gap-1.5 sm:max-w-xs">
          <label htmlFor={roleSelectId} className="text-xs font-medium text-muted-foreground">{t('know.field.role')}</label>
          <Select
            id={roleSelectId}
            aria-label={t('know.field.role')}
            wrapperClassName="flex"
            value={roleId}
            onChange={(event) => setSelectedRoleId(event.target.value)}
          >
            <Option value="">{ANY_ROLE_LABEL}</Option>
            {roles.map((role) => <Option key={role.id} value={role.id}>{role.name}</Option>)}
          </Select>
        </div>

        <div className="grid min-w-44 flex-1 gap-1.5 sm:max-w-xs">
          <label htmlFor={machineSelectId} className="text-xs font-medium text-muted-foreground">{t('know.effective.targetMachine')}</label>
          <Select
            id={machineSelectId}
            aria-label={t('know.effective.targetMachine')}
            wrapperClassName="flex"
            value={machineId}
            onChange={(event) => setSelectedMachineId(event.target.value)}
          >
            <Option value="">{t('know.effective.allMachines')}</Option>
            {machines.map((machine) => (
              <Option key={machine.id} value={machine.id}>{machineOptionText(machine)}</Option>
            ))}
          </Select>
        </div>
      </div>

      {error ? <Problem role="alert">{messageOf(error)}</Problem> : null}

      {isPending ? (
        <EffectiveSkeleton />
      ) : data ? (
        <div className="grid grid-cols-1 gap-6">
          <div className="grid grid-cols-1 gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <BudgetMeter
                label={t('know.effective.briefBudget')}
                bytes={data.budget.brief_bytes}
                limitBytes={data.budget.brief_limit_bytes}
              />
              <BudgetMeter
                label={t('know.effective.snapshotBudget')}
                bytes={data.budget.snapshot_bytes}
                limitBytes={data.budget.snapshot_limit_bytes}
              />
            </div>
            {data.budget.over_limit ? <Problem role="alert">{data.budget.over_limit}</Problem> : null}
          </div>

          {bothEmpty ? (
            <Empty title={t('know.effective.emptyTitle')}>
              {t('know.effective.emptyBody')}
            </Empty>
          ) : (
            <>
              <EffectiveSection
                title={t('know.effective.residentTitle')}
                items={data.resident}
                names={names}
                machines={machines}
                emptyText={t('know.effective.residentEmpty')}
              />
              <EffectiveSection
                title={t('know.effective.onDemandTitle')}
                items={data.on_demand}
                names={names}
                machines={machines}
                emptyText={t('know.effective.onDemandEmpty')}
              />
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
