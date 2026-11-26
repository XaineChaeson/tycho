// The machines page (docs/design/accounts-machines-decoupled.md "控制台"): a Master-Detail
// fleet view — compact searchable machine list on the left, focused single-machine inspection
// (runtime specs, executors, machine-own logins, diagnostics) on the right (or in a sheet on
// narrow viewports). Accounts live on their own page; machine knowledge sync lives on Knowledge.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Circle, Ellipsis, Plus, RefreshCw, Search, Server } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { joinDecisionText, loginFull, loginStatusLine, machineLoginRefusedText, machineEndLines, machineScopeText, machineSourceText, nodeReleaseText } from '@shared/labels.ts';
import { serviceObservationText } from '@shared/service-manager.ts';
import { HOST_MACHINE_UNKNOWN_TEXT } from '@shared/logins.ts';
import { formatTime } from '@shared/time.ts';
import { Callout, Card, CommandLine, Details, Dot, Empty, Fact, Facts, Field, Mono, Note, Problem, Rows, SectionTitle } from '@/components/bits';
import { CheckLine } from '@/components/check-line';
import { countOutdatedCliCells, ExecutorFleetPanel } from '@/components/executor-fleet-panel';
import { BLANK_LOGIN, LoginEditor, TierBadges, type LoginDraft } from '@/components/login-form';
import { MachineSignInSteps } from '@/components/machine-sign-in';
import { Page } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Confirm, Dialog, DialogActions, DialogContent, Sheet, SheetContent } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { Skeleton } from '@/components/ui/skeleton';
import { EARLIER_CHANGE, useChange } from '@/hooks/use-change';
import { ApiError, del, messageOf, post, put } from '@/lib/api';
import { accountsQuery, executorUpdatesQuery, LOGINS_CHANGE, nodeJoinsQuery } from '@/lib/queries';
import { formOf, loginSettingsBody, tierEditorOf, tierRefusal, type TierEditor } from '@/lib/accounts';
import {
  MACHINE_NAME_FIXED, entryLine, executorEntryText, executorsCaption, executorsEmptyText, executorInstalledText, executorLoginText, executorReadOnlyText, executorWhereText, inviteExecutorsText, inviteMaterialText,
  inviteRevocable, inviteUsedText, inviteValidText, joinExpiryText, joinGuide, machineExecutorRows, machineLoginPath, machineLoginStanding, machineRemoval, nodeRunsText, nodeStateLine,
  type JoinGuide,
  type MachineExecutorRow,
} from '@/lib/machines';
import type { AccountsAndMachines, Invite, Machine, MachineCheck, MachineLogin, MachineNode, PendingJoin } from '@/lib/types';
import { cn } from '@/lib/utils';

const WIDE_QUERY = '(min-width: 1024px)';

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

const machineKey = (id: string): string => '/machine/' + id;
// A machine's own login's form. No account has this key: an account name has no slash.
const ownKey = (machine: Machine, login: MachineLogin): string => '/login/' + (login.id ?? `${machine.uid}/${login.executor}`);
interface MachineForm { note: string }
interface MachineDraft {
  form: MachineForm | null;
  error: string | null;
  saving: boolean;
  confirm: boolean;
  checking: boolean;
  check: LoginDraft['check'];
}
const MACHINE_BLANK: MachineDraft = { form: null, error: null, saving: false, confirm: false, checking: false, check: null };
const machineForm = (machine: Machine): MachineForm => ({ note: machine.note ?? '' });
const CHECK_HINT = '让那台机器现在再看一遍本机';

function shortPlatform(platform: string | null | undefined): string {
  if (!platform) return '系统未知';
  const first = platform.trim().split(/\s+/)[0] ?? platform;
  if (first === 'win32') return 'Windows';
  if (first === 'darwin') return 'macOS';
  if (first === 'linux') return 'Linux';
  return first;
}

function machineAttention(machine: Machine): boolean {
  const { node } = machine;
  const outputIssue = node.bounded_output === 1 && (Boolean(node.output?.capacity.issue) || node.output?.capacity.available_runs === 0 || Boolean(node.output?.unknown_sources));
  const serviceIssue = Boolean(node.service_manager?.services.some((service) => Boolean(service.problem) || (service.installed && !service.running)));
  const entryIssue = Boolean(node.entry?.executors.some((each) => !['written', 'cleared'].includes(each.state)));
  return outputIssue || serviceIssue || entryIssue;
}

function JoinSteps({ guide }: { guide: JoinGuide }) {
  return (
    <ol className="grid list-decimal gap-3 pl-5 marker:text-faint">
      <li>
        在那台机器上，以将来跑活的那个普通用户（不是 root、不是管理员）装好 tycho，然后运行：
        <CommandLine value={guide.command} className="mt-1.5" />
        {guide.unreachable ? <Note className="mt-1.5 text-xs">{guide.unreachable}</Note> : null}
      </li>
      <li>命令会打印一个六位数，然后等着，这台机器也会出现在下面“等着放行的机器”里。直接在下面输入那个六位数放行，或点侧栏的“放行”，输入那个六位数，看清是哪台机器再放行。配了企业微信时，手机上的卡片也能放行。主机就在那台电脑上、地址是本机的时候不用放行。</li>
      <li>放行之后，那台机器上的命令打印“已加入”，然后就在这个终端里接着运行、不退出（关掉终端它就断开）；要它在后台、开机就运行，在那台机器上运行 <Mono>tycho node service install</Mono>。这一页出现它的卡片，状态是“已连回来”，它装了哪些执行器过一会儿会报上来。</li>
    </ol>
  );
}

function PendingJoinRow({ join, onDecided }: { join: PendingJoin; onDecided: (message: string) => void }) {
  const client = useQueryClient();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expired = Date.parse(join.expires_at) <= Date.now();
  const validCode = /^[0-9]{6}$/.test(code);

  async function decide(approve: boolean): Promise<void> {
    if (busy || !validCode) return;
    if (join.code && code !== join.code) {
      setError('输入的六位数字与这台机器不匹配，请核对机器屏幕上的数字');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const decision = await post<{ name: string }>('/api/admissions/' + (approve ? 'approve' : 'reject'), {
        kind: 'machine',
        code,
      });
      onDecided(joinDecisionText(approve, decision.name));
      void client.invalidateQueries({ queryKey: accountsQuery.queryKey });
      void client.invalidateQueries({ queryKey: nodeJoinsQuery.queryKey });
    } catch (refused) {
      setError(messageOf(refused));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="grid gap-1.5 px-3.5 py-2.5">
      <div>
        <strong className="font-semibold wrap-anywhere">{join.name}</strong>
        <p className="text-xs text-muted-foreground wrap-anywhere">{join.platform} · {join.hostname}</p>
        <p className="text-xs text-muted-foreground">{joinExpiryText(join.expires_at)}</p>
      </div>
      {!expired ? (
        <form
          className="flex flex-wrap items-center gap-2 pt-0.5"
          onSubmit={(event) => {
            event.preventDefault();
            void decide(true);
          }}
        >
          <Input
            aria-label={`放行 ${join.name} 的六位数字`}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            pattern="[0-9]{6}"
            maxLength={6}
            placeholder="输入 6 位数字"
            className="h-8 w-36 font-mono text-xs tracking-[0.2em]"
            value={code}
            disabled={busy}
            onChange={(event) => {
              setCode(event.target.value);
              if (error) setError(null);
            }}
          />
          <Button type="submit" size="sm" variant="primary" disabled={busy || !validCode}>
            {busy ? '处理中' : '放行'}
          </Button>
          <Button type="button" size="sm" variant="danger" disabled={busy || !validCode} onClick={() => void decide(false)}>
            拒绝
          </Button>
        </form>
      ) : null}
      {error ? <Problem role="alert" className="text-xs">{error}</Problem> : null}
    </li>
  );
}

function PendingJoins() {
  const { data, isPending, error } = useQuery(nodeJoinsQuery);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <section aria-label="等着放行的机器" className="mt-5 border-t border-border pt-4">
      <h3 className="text-sm font-semibold">等着放行的机器</h3>
      <Note className="mt-0.5 mb-2 text-xs">跑了加入命令的机器会出现在这里。可直接输入机器屏幕上的六位数字放行，也可点侧栏的“放行”。</Note>
      {notice ? <Callout tone="plain" role="status" className="mb-2">{notice}</Callout> : null}
      {isPending ? <Skeleton className="h-12" /> : null}
      {error ? <Problem role="alert">{messageOf(error)}</Problem> : null}
      {data?.length ? (
        <Rows>
          <ul className="divide-y divide-border">
            {data.map((join) => (
              <PendingJoinRow key={join.code} join={join} onDecided={setNotice} />
            ))}
          </ul>
        </Rows>
      ) : null}
      {data && data.length === 0 ? <Note>现在没有等着放行的机器。在那台机器上跑了上面的加入命令，它就会出现在这里。</Note> : null}
    </section>
  );
}

function EndLines({ ends }: { ends: MachineNode['ends'] }) {
  if (!ends) return null;
  return (
    <ul aria-label="结束情况" className="grid gap-1 text-xs">
      {machineEndLines(ends).map((line) => (
        <li key={line.key} data-done={line.done} className="flex items-baseline gap-2">
          {line.done
            ? <Check aria-hidden="true" className="size-3.5 flex-none translate-y-0.5 text-success" />
            : <Circle aria-hidden="true" className="size-3.5 flex-none translate-y-0.5 text-faint" />}
          <span className="w-20 flex-none text-muted-foreground">{line.label}</span>
          <span className={cn('min-w-0 wrap-anywhere', line.done ? undefined : 'text-muted-foreground')}>{line.text}</span>
        </li>
      ))}
    </ul>
  );
}

function Invites({ invites, busy, revoking, failures, onRevoke }: {
  invites: Invite[];
  busy: boolean;
  revoking: string | null;
  failures: Record<string, string>;
  onRevoke: (invite: Invite) => void;
}) {
  return (
    <section aria-label="接入名额" className="mt-8">
      <SectionTitle>接入名额</SectionTitle>
      <Note className="mb-2 max-w-[72ch] text-xs">任务为了开新机器申请的名额。新机器凭一次性接入材料自己加入，只接名额规定的活。撤销名额后不再发材料、发出去没用的也作废；已经接进来的机器不受影响。</Note>
      <Rows>
        <ul className="divide-y divide-border">
          {invites.map((invite) => (
            <li key={invite.id} className="grid gap-1.5 px-3.5 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm font-semibold wrap-anywhere">{'任务 '}<Mono>{invite.task_id}</Mono></span>
                <span className="text-xs text-muted-foreground wrap-anywhere">{'项目 '}<Mono>{invite.project_id}</Mono></span>
                <span className="text-xs">{inviteUsedText(invite)}</span>
                <span className="text-xs text-muted-foreground">{inviteValidText(invite)}</span>
                {inviteRevocable(invite) ? (
                  <Button size="sm" variant="danger" className="ml-auto" disabled={busy || revoking !== null} onClick={() => onRevoke(invite)}>
                    {revoking === invite.id ? '撤销中' : '撤销名额'}
                  </Button>
                ) : null}
              </div>
              <Facts className="gap-y-0.5 text-xs">
                <Fact label="执行器">{inviteExecutorsText(invite.executors)}</Fact>
                <Fact label="接入材料">{inviteMaterialText(invite.material)}</Fact>
                <Fact label="带进来的机器">{invite.machines.length ? invite.machines.join('、') : '还没有'}</Fact>
              </Facts>
              {failures[invite.id] ? <Problem role="alert">{failures[invite.id]}</Problem> : null}
            </li>
          ))}
        </ul>
      </Rows>
    </section>
  );
}

const rowName = (machine: Machine, row: MachineExecutorRow): string =>
  row.login === null ? `${machine.id} 上的 ${row.executor}` : machine.id + ' 上的 ' + row.executor + ' 登录';

const isUninstalledRow = (row: MachineExecutorRow): boolean =>
  row.login === null && row.reported?.installed === false && !row.reported.error && !row.reported.unusable;

function ExecutorBlock({ machine, row, login, editor, draft, busy, failure, canSignIn, onEdit, onRetry, onDelete, onSignIn }: {
  machine: Machine;
  row: MachineExecutorRow;
  login: MachineLogin | null;
  editor: TierEditor | undefined;
  draft: LoginDraft;
  busy: boolean;
  failure: string | null;
  canSignIn: boolean;
  onEdit: () => void;
  onRetry: () => void;
  onDelete: () => void;
  onSignIn: () => void;
}) {
  const where = executorWhereText(row);
  const entryStatus = machine.node.entry?.executors.find((each) => each.executor === row.executor);
  const entryAbnormal = entryStatus !== undefined && !['written', 'cleared'].includes(entryStatus.state);
  const standing = login ? machineLoginStanding(login) : null;
  const status = login?.status;
  const facts: [string, string][] = [
    ['本机登录', executorLoginText(row)],
    ['只读沙箱', executorReadOnlyText(row)],
    ...(entryAbnormal ? [['全局知识入口', executorEntryText(row, machine.node.entry)] as [string, string]] : []),
  ];
  return (
    <div
      role="group"
      aria-label={rowName(machine, row)}
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-surface/65 p-3"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Mono className="text-sm font-semibold">{row.executor}</Mono>
        <span className="text-xs text-muted-foreground wrap-anywhere">{executorInstalledText(row)}</span>
        {standing ? <Badge tone={standing.tone} className="ml-auto">{standing.text}</Badge> : null}
      </div>
      {where ? <p title={where} className="truncate font-mono text-[11px] text-faint">{where}</p> : null}
      {row.reported?.unusable ? <Problem className="text-xs">{row.reported.unusable}</Problem> : null}
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-faint">{label}</dt>
            <dd className="min-w-0 wrap-anywhere">{value}</dd>
          </div>
        ))}
      </dl>
      {login || canSignIn ? (
        <div className="mt-auto grid gap-1.5 border-t border-border/60 pt-2">
          {login ? (
            <>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[11px] text-faint">本机登录</span>
                {login.configured ? <TierBadges tiers={login.tiers} editor={editor} /> : null}
                {login.queued_tasks > 0 ? <span className="text-xs text-muted-foreground">{`排队 ${login.queued_tasks}`}</span> : null}
              </div>
              {login.models?.reason ? <Note className="text-xs">{login.models.reason}</Note> : null}
              {(login.retired_tiers ?? []).map(({ tier, text }) => <Problem key={tier} className="text-xs">{text}</Problem>)}
              {login.configured && status && (status.rest || loginFull(status)) ? <Note className="text-xs">{loginStatusLine(status)}</Note> : null}
              {login.configured && login.refused ? <Problem className="text-xs">{machineLoginRefusedText(login.name)}</Problem> : null}
            </>
          ) : null}
          <div className="-ml-2 flex flex-wrap items-center gap-1">
            {login ? <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>{login.configured ? '修改' : '填档位'}</Button> : null}
            {canSignIn ? <Button size="sm" variant="ghost" disabled={busy} onClick={onSignIn}>重新登录</Button> : null}
            {login && status?.rest ? <Button size="sm" variant="ghost" disabled={busy} onClick={onRetry}>{draft.retrying ? '正在放行' : '现在就试'}</Button> : null}
            {login && login.configured ? <Button size="sm" variant="danger" disabled={busy} onClick={onDelete}>删除</Button> : null}
          </div>
          {failure ? <Problem role="alert" className="text-xs">{failure}</Problem> : null}
        </div>
      ) : null}
    </div>
  );
}

function FleetRow({ machine, isHost, active, buttonRef, onSelect }: {
  machine: Machine;
  isHost: boolean;
  active: boolean;
  buttonRef?: (node: HTMLButtonElement | null) => void;
  onSelect: () => void;
}) {
  const { node } = machine;
  const rows = machineExecutorRows(machine);
  const installed = rows.filter((row) => !isUninstalledRow(row)).map((row) => row.executor);
  const needsAttention = machineAttention(machine);
  return (
    <li>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`选择机器 ${machine.id}`}
        aria-current={active ? 'true' : undefined}
        onClick={onSelect}
        className={cn(
          'grid w-full gap-1 px-3.5 py-2.5 text-left transition-colors duration-100',
          active ? 'bg-brand-soft/75 shadow-[inset_3px_0_0_0_var(--primary)]' : 'hover:bg-muted/70',
        )}
      >
        <div className="flex items-center gap-2">
          <Dot tone={node.connected ? 'success' : 'waiting'} />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{machine.id}</span>
          {isHost ? <Badge tone="plain" className="text-[11px]">主机</Badge> : null}
          {node.ephemeral ? <Badge tone="plain" className="text-[11px]">临时</Badge> : null}
          {node.connected && node.reported_runs > 0 ? (
            <Badge tone="plain" className="text-[11px] tabular-nums">{`${node.reported_runs} 轮`}</Badge>
          ) : !node.connected ? (
            <span className="flex-none text-[11px] text-faint">离线</span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 pl-4 text-xs text-muted-foreground">
          <span className="flex-none">{shortPlatform(node.platform)}</span>
          <span aria-hidden="true" className="text-faint">·</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
            {installed.length > 0 ? installed.join(', ') : (node.executors ? '0 执行器' : '未上报')}
          </span>
          {needsAttention ? <Dot tone="waiting" className="flex-none" /> : null}
        </div>
        {machine.note ? (
          <p className="truncate pl-4 text-[11px] text-faint">{machine.note}</p>
        ) : null}
      </button>
    </li>
  );
}

function NoteForm({ draft, busy, onEdit, onSave, onCancel }: {
  draft: MachineDraft;
  busy: boolean;
  onEdit: (note: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  return (
    <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <Field htmlFor={id} label="备注" hint="只是给你自己看的，派活不看它。清空就是不要备注。">
        <Textarea id={id} rows={2} className="max-h-[40vh] overflow-y-auto" value={draft.form?.note ?? ''} disabled={draft.saving} onChange={(event) => onEdit(event.target.value)} />
      </Field>
      <Note className="text-xs">{MACHINE_NAME_FIXED}</Note>
      {draft.error ? <Problem role="alert">{draft.error}</Problem> : null}
      <DialogActions>
        <Button variant="ghost" disabled={draft.saving} onClick={onCancel}>取消</Button>
        <Button type="submit" variant="primary" disabled={busy}>{draft.saving ? '保存中' : '保存'}</Button>
      </DialogActions>
    </form>
  );
}

function removalQuestion(machine: Machine, keeps: boolean): { title: string; description: string } {
  if (keeps) return { title: `撤销机器 ${machine.id}？`, description: '撤销后它不能再连回来接活；这条记录留着，写明它是怎么结束的。' };
  if (machine.node.ephemeral) return { title: `删除机器 ${machine.id} 的记录？`, description: '它的登记已经结束，这里删掉的只是留下的这条记录。' };
  return { title: `删除机器 ${machine.id}？`, description: '删掉以后服务不再派活给它，这台机器自己的登录也从各个项目允许的登录里去掉。要再用它，在那台机器上重新加入，那时它算一台新机器。' };
}

export function MachinesPage() {
  const isWide = useMediaQuery(WIDE_QUERY);
  const { data, isPending, error } = useQuery(accountsQuery);
  const { data: fleetStatus } = useQuery(executorUpdatesQuery);
  const [activeTab, setActiveTab] = useState<'machines' | 'cli-updates'>('machines');
  const [drafts, setDrafts] = useState<Record<string, LoginDraft>>({});
  const [machineDrafts, setMachineDrafts] = useState<Record<string, MachineDraft>>({});
  const machineDraft = (key: string): MachineDraft => machineDrafts[key] ?? MACHINE_BLANK;
  const patchMachine = (key: string, part: Partial<MachineDraft>): void => setMachineDrafts((all) => ({ ...all, [key]: { ...(all[key] ?? MACHINE_BLANK), ...part } }));
  const [adding, setAdding] = useState(false);
  const [signingIn, setSigningIn] = useState<{ machine: Machine; executor: string } | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline' | 'ephemeral'>('all');
  const [query, setQuery] = useState('');
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const [removing, setRemoving] = useState<string | null>(null);
  const [ownRemoving, setOwnRemoving] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [inviteFailures, setInviteFailures] = useState<Record<string, string>>({});
  const change = useChange<AccountsAndMachines>({ mutationKey: LOGINS_CHANGE, queryKey: accountsQuery.queryKey, reread: true });
  const { busy } = change;

  const draftOf = (key: string): LoginDraft => drafts[key] ?? BLANK_LOGIN;
  const patch = (key: string, part: Partial<LoginDraft>): void => setDrafts((all) => ({ ...all, [key]: { ...(all[key] ?? BLANK_LOGIN), ...part } }));

  async function changeOwn(key: string, request: () => Promise<unknown>, doing: 'saving' | 'retrying' = 'saving'): Promise<boolean> {
    if (!change.free()) return false;
    patch(key, { [doing]: true, error: null });
    try {
      await change.send(request, (page, answer) => {
        const updated = (answer as { machine?: Machine }).machine;
        return updated ? { ...page, machines: page.machines.map((each) => (each.id === updated.id ? updated : each)) } : page;
      });
      setDrafts(({ [key]: _changed, ...rest }) => rest);
      return true;
    } catch (refused) {
      patch(key, { [doing]: false, error: messageOf(refused) });
      return false;
    }
  }

  const ownPath = (machine: Machine, login: MachineLogin): string => machineLoginPath(machine, login);

  function saveOwn(machine: Machine, login: MachineLogin, page: AccountsAndMachines): void {
    const key = ownKey(machine, login);
    const { form } = draftOf(key);
    if (!form || !change.free()) return;
    const tierProblem = tierRefusal(form.tiers, tierEditorOf(page.tier_forms, form.executor));
    if (tierProblem) {
      const beside = tierProblem.at !== null;
      patch(key, { error: beside ? null : tierProblem.message, tierProblem: beside ? tierProblem : null });
      return;
    }
    void changeOwn(key, () => put(ownPath(machine, login), loginSettingsBody(form, page.permission_modes[form.executor] ?? [])));
  }

  async function deleteOwn(machine: Machine, login: MachineLogin): Promise<void> {
    if (await changeOwn(ownKey(machine, login), () => del(ownPath(machine, login)))) setOwnRemoving(null);
  }

  async function changeMachine(key: string, request: () => Promise<unknown>, taken: (machines: Machine[], answer: unknown) => Machine[]): Promise<boolean> {
    if (!change.free()) return false;
    patchMachine(key, { saving: true, error: null });
    try {
      await change.send(request, (page, answer) => ({ ...page, machines: taken(page.machines, answer) }));
      setMachineDrafts(({ [key]: _changed, ...rest }) => rest);
      return true;
    } catch (refused) {
      patchMachine(key, { saving: false, confirm: refused instanceof ApiError && refused.body.needs_confirm === true, error: messageOf(refused) });
      return false;
    }
  }

  function saveNote(machine: Machine): void {
    const key = machineKey(machine.id);
    const { form } = machineDraft(key);
    if (!form || !change.free()) return;
    void changeMachine(key, () => put('/api/machines/' + encodeURIComponent(machine.id), { note: form.note.trim() || null }), (machines, answer) => {
      const updated = (answer as { machine: Machine }).machine;
      return machines.map((each) => (each.id === updated.id ? updated : each));
    });
  }

  async function removeMachine(machine: Machine): Promise<void> {
    const key = machineKey(machine.id);
    const path = '/api/machines/' + encodeURIComponent(machine.id);
    const { keeps } = machineRemoval(machine);
    const taken = await changeMachine(key, () => del(path + (machineDraft(key).confirm ? '?confirm=1' : '')), (machines) => (keeps ? machines : machines.filter((each) => each.id !== machine.id)));
    if (taken) {
      setRemoving(null);
      if (!keeps && selectedUid === machine.uid) setSelectedUid(null);
    }
  }

  const checking = useRef(new Set<string>());
  const client = useQueryClient();
  async function checkMachine(machine: Machine): Promise<void> {
    const key = machineKey(machine.id);
    if (checking.current.has(key)) return;
    checking.current.add(key);
    patchMachine(key, { checking: true });
    let check: MachineDraft['check'];
    try {
      const answer = await post<MachineCheck>('/api/machines/' + encodeURIComponent(machine.id) + '/check');
      check = { at: Date.now(), machine: answer };
      if (answer.reachable) void client.invalidateQueries({ queryKey: accountsQuery.queryKey });
    } catch (failure) {
      check = { at: Date.now(), failure: messageOf(failure) };
    }
    checking.current.delete(key);
    patchMachine(key, { checking: false, check });
  }

  async function revokeInvite(invite: Invite): Promise<void> {
    if (!change.free()) return;
    setRevoking(invite.id);
    setInviteFailures(({ [invite.id]: _gone, ...rest }) => rest);
    try {
      await change.send(() => del('/api/invites/' + encodeURIComponent(invite.id)), (page) => page);
    } catch (refused) {
      setInviteFailures((all) => ({ ...all, [invite.id]: messageOf(refused) }));
    } finally {
      setRevoking(null);
    }
  }

  const machines = data?.machines ?? [];
  const fleetCounts = useMemo(() => ({
    all: machines.length,
    online: machines.filter((m) => m.node.connected).length,
    offline: machines.filter((m) => !m.node.connected).length,
    ephemeral: machines.filter((m) => m.node.ephemeral).length,
  }), [machines]);
  const visibleMachines = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return machines.filter((m) => {
      if (statusFilter === 'online' && !m.node.connected) return false;
      if (statusFilter === 'offline' && m.node.connected) return false;
      if (statusFilter === 'ephemeral' && !m.node.ephemeral) return false;
      if (needle === '') return true;
      return m.id.toLowerCase().includes(needle)
        || m.host.toLowerCase().includes(needle)
        || (m.note ?? '').toLowerCase().includes(needle);
    });
  }, [machines, statusFilter, query]);

  const explicitSelected = selectedUid ? machines.find((m) => m.uid === selectedUid) ?? null : null;
  const activeMachine = isWide
    ? ((selectedUid ? visibleMachines.find((m) => m.uid === selectedUid) : undefined) ?? visibleMachines[0] ?? explicitSelected)
    : explicitSelected;

  const handleRailKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (!isWide || visibleMachines.length <= 1) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const currentIndex = activeMachine ? visibleMachines.findIndex((m) => m.uid === activeMachine.uid) : -1;
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + delta + visibleMachines.length) % visibleMachines.length;
    const next = visibleMachines[nextIndex];
    if (next) {
      event.preventDefault();
      setSelectedUid(next.uid);
      rowRefs.current.get(next.uid)?.focus();
    }
  };

  function machineDetail(machine: Machine, inSheet = false): ReactNode {
    const key = machineKey(machine.id);
    const draft = machineDraft(key);
    const node = machine.node;
    const removal = machineRemoval(machine);
    const report = node.executors ?? null;
    const rows = machineExecutorRows(machine);
    const activeRows = rows.filter((row) => !isUninstalledRow(row));
    const uninstalledRows = rows.filter(isUninstalledRow);
    const scope = machineScopeText(node.scope);
    const isHost = data?.host_machine !== undefined && data.host_machine === machine.id;

    const outputText = `${node.bounded_output !== 1 ? '新轮次等待节点升级并报告待传输出容量' : node.output?.capacity.issue ? '输出容量待核实，新轮次等待；' + node.output.capacity.issue : node.output ? `待传输出：${Math.ceil(node.output.capacity.used_bytes / 1048576)} MiB 已占用，${Math.ceil(node.output.capacity.reserved_bytes / 1048576)} MiB 预留${node.output.capacity.other_node_reserved_bytes ? '（其他登记仍预留 ' + Math.ceil(node.output.capacity.other_node_reserved_bytes / 1048576) + ' MiB）' : ''}，${Math.ceil(node.output.capacity.external_bytes / 1048576)} MiB 旧输出；总预算 ${Math.ceil(node.output.capacity.limit_bytes / 1048576)} MiB，可接 ${node.output.capacity.available_runs} 轮${node.output.capacity.issue ? '；' + node.output.capacity.issue : ''}${node.output.unknown_sources ? '；本页 ' + node.output.unknown_sources + ' 个来源不明，保留计费待核实' : ''}` : '等待机器报告待传输出容量'}。只计算输出保留根，不表示整机磁盘或内存。`;
    const outputAttention = node.bounded_output !== 1
      || Boolean(node.output?.capacity.issue)
      || node.output?.capacity.available_runs === 0
      || Boolean(node.output?.unknown_sources);
    const serviceAttention = !node.service_manager
      || !node.connected
      || node.service_manager.services.some((service) => Boolean(service.problem) || (service.installed && !service.running));
    const serviceSection = (
      <section aria-label={`${machine.id} 的系统服务`}>
        <h3 className="text-xs font-semibold text-muted-foreground">系统服务（本安装）</h3>
        {node.service_manager ? <>
          {node.service_manager.services.map((service) => <Note key={service.role}>{serviceObservationText(service)}</Note>)}
          <p className="text-xs text-faint">{formatTime(node.service_manager.observed_at)} 读取{node.connected ? '' : '；机器已离线，以上为最后报告'}</p>
        </> : <Note>机器尚未报告系统服务状态</Note>}
      </section>
    );

    const body = (
      <>
        <header className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Dot tone={node.connected ? 'success' : 'waiting'} />
              <h2 title={MACHINE_NAME_FIXED} className="min-w-0 text-base font-semibold wrap-anywhere">{machine.id}</h2>
              {isHost ? <Badge tone="plain">主机</Badge> : null}
              {node.ephemeral ? <Badge tone="plain">临时</Badge> : null}
              <Badge tone={node.connected ? 'success' : 'waiting'}>{nodeStateLine(node)}</Badge>
              {node.connected ? <span className="text-xs text-muted-foreground">{nodeRunsText(node.reported_runs, node.reported_unknown)}</span> : null}
            </div>
          </div>
          <div className="flex flex-none items-center gap-0.5">
            <Button size="sm" variant="ghost" title={CHECK_HINT} disabled={draft.checking} onClick={() => void checkMachine(machine)}>{draft.checking ? '测试中' : '测试连接'}</Button>
            <Menu>
              <MenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="更多" disabled={busy}><Ellipsis /></Button></MenuTrigger>
              <MenuContent>
                <MenuItem onSelect={() => patchMachine(key, { form: machineForm(machine), confirm: false, error: null })}>{machine.note ? '改备注' : '加备注'}</MenuItem>
                <MenuItem danger onSelect={() => { patchMachine(key, { confirm: false, error: null }); setRemoving(machine.id); }}>{removal.action}</MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </header>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-border/60 bg-surface/55 px-3 py-2.5 text-xs sm:grid-cols-4">
          <div className="min-w-0">
            <dt className="text-faint">{'主机名 '}</dt>
            <dd className="mt-0.5 wrap-anywhere"><Mono>{machine.host}</Mono></dd>
          </div>
          <div className="min-w-0">
            <dt className="text-faint">系统</dt>
            <dd className="mt-0.5 wrap-anywhere">{node.platform ?? '没说'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-faint">来源</dt>
            <dd className="mt-0.5 wrap-anywhere">{machineSourceText(node.source)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-faint">版本</dt>
            <dd className="mt-0.5 wrap-anywhere">{nodeReleaseText(node.release, data?.host_version ?? null)}</dd>
          </div>
          {scope ? (
            <div className="col-span-full border-t border-border/50 pt-1.5 text-muted-foreground wrap-anywhere">{scope}</div>
          ) : null}
        </dl>

        {machine.note ? <p className="rounded-md bg-surface/60 px-2.5 py-1.5 text-xs text-muted-foreground wrap-anywhere"><span className="mr-1.5 text-faint">备注</span>{machine.note}</p> : null}

        {draft.check ? (
          <div className="grid gap-1 rounded-md bg-muted px-3 py-2">
            {draft.check.machine ? <div><CheckLine answer={draft.check.machine} /></div> : null}
            {draft.check.failure ? <Problem>{draft.check.failure}</Problem> : null}
            <p className="text-xs text-faint">{`${formatTime(draft.check.at)} 测试连接的结果`}</p>
          </div>
        ) : null}

        {outputAttention ? <Note className="text-xs">{outputText}</Note> : null}
        {serviceAttention ? serviceSection : null}
        <EndLines ends={node.ends} />

        <section aria-label={`${machine.id} 的执行器`} className="border-t border-border/80 pt-3">
          <h3 className="mb-2.5 text-xs font-semibold text-muted-foreground">{executorsCaption(report, undefined, node.entry)}</h3>
          {rows.length === 0 ? <Note>{executorsEmptyText(report)}</Note> : (
            <>
              {activeRows.length > 0 ? (
                <div className={cn('grid grid-cols-1 gap-2.5', !inSheet && 'wide:grid-cols-2')}>
                  {activeRows.map((row) => {
                    const login = row.login;
                    const own = login ? draftOf(ownKey(machine, login)) : BLANK_LOGIN;
                    const canSignIn = Boolean(data?.account_logins?.[row.executor]?.some((offer) => offer.way === 'machine' && offer.available));
                    return (
                      <ExecutorBlock
                        key={row.executor}
                        machine={machine}
                        row={row}
                        login={login}
                        editor={tierEditorOf(data?.tier_forms ?? {}, row.executor)}
                        draft={own}
                        busy={busy}
                        failure={login && own.form === null && ownRemoving !== ownKey(machine, login) ? own.error : null}
                        canSignIn={canSignIn}
                        onEdit={() => { if (login) patch(ownKey(machine, login), { form: formOf(login), error: null, tierProblem: null }); }}
                        onRetry={() => { if (login) void changeOwn(ownKey(machine, login), () => post(ownPath(machine, login) + '/retry'), 'retrying'); }}
                        onDelete={() => { if (login) { patch(ownKey(machine, login), { error: null }); setOwnRemoving(ownKey(machine, login)); } }}
                        onSignIn={() => setSigningIn({ machine, executor: row.executor })}
                      />
                    );
                  })}
                </div>
              ) : null}
              {uninstalledRows.length > 0 ? (
                <div className={cn('flex flex-wrap items-center gap-1.5', activeRows.length > 0 ? 'mt-2.5' : '')}>
                  <span className="text-xs text-faint">未安装</span>
                  {uninstalledRows.map((row) => (
                    <div
                      key={row.executor}
                      role="group"
                      aria-label={rowName(machine, row)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border bg-surface/50 px-2 py-0.5 text-xs text-muted-foreground"
                    >
                      <Mono className="font-medium">{row.executor}</Mono>
                      <span className="text-faint">{executorInstalledText(row)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </section>

        {(!outputAttention || !serviceAttention || (node.local_skills && node.local_skills.length > 0)) ? (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border/60 pt-2.5">
            {!outputAttention || !serviceAttention ? (
              <Details id={`machine-diag-${machine.uid}`} title="系统服务与缓存诊断" className="text-xs">
                <div className="mt-1.5 grid gap-2">
                  {!outputAttention ? <Note className="text-xs">{outputText}</Note> : null}
                  {!serviceAttention ? serviceSection : null}
                </div>
              </Details>
            ) : null}
            {node.local_skills && node.local_skills.length > 0 ? (
              <Link
                to="/knowledge?view=access#machine-knowledge"
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {`本机私有技能（${node.local_skills.length}）· 在知识页查看`}
              </Link>
            ) : null}
          </div>
        ) : null}
      </>
    );

    if (inSheet) {
      return <section aria-label={'机器 ' + machine.id} className="grid gap-4">{body}</section>;
    }
    return <Card key={key} aria-label={'机器 ' + machine.id} className="grid gap-4">{body}</Card>;
  }

  const earlier = busy && revoking === null
    && !Object.values(drafts).some((draft) => draft.saving || draft.retrying)
    && !Object.values(machineDrafts).some((draft) => draft.saving);
  const guide = joinGuide(data?.public_url, window.location.origin);

  const owns = machines.flatMap((machine) => (machine.logins ?? []).map((login) => ({ machine, login, key: ownKey(machine, login) })));
  const editing = owns.find(({ key }) => draftOf(key).form !== null) ?? null;
  const ownDoomed = owns.find(({ key }) => key === ownRemoving) ?? null;
  const noting = machines.find((machine) => machineDraft(machineKey(machine.id)).form !== null) ?? null;
  const doomed = machines.find((machine) => machine.id === removing) ?? null;
  const doomedDraft = doomed ? machineDraft(machineKey(doomed.id)) : MACHINE_BLANK;
  const removal = doomed ? machineRemoval(doomed) : null;
  const question = doomed && removal ? removalQuestion(doomed, removal.keeps) : null;
  const closeEditor = (key: string): void => patch(key, { form: null, error: null, tierProblem: null });
  const closeNote = (machine: Machine): void => patchMachine(machineKey(machine.id), { form: null, error: null });

  const fleetRail = (
    <aside
      aria-label="机器列表"
      className={cn(
        'flex flex-col overflow-hidden rounded-xl border border-border bg-raised shadow-card',
        isWide && 'sticky top-4 max-h-[calc(100dvh-9rem)]',
      )}
    >
      <div className="grid gap-2 border-b border-border p-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
          <Input
            aria-label="筛选机器"
            className="h-8 pl-8 text-xs"
            placeholder="筛选机器名、主机名、备注…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div role="group" aria-label="按状态筛选机器" className="flex flex-wrap items-center gap-1">
          {([
            ['all', `全部 ${fleetCounts.all}`],
            ['online', `在线 ${fleetCounts.online}`],
            ['offline', `离线 ${fleetCounts.offline}`],
            ...(fleetCounts.ephemeral > 0 ? [['ephemeral', `临时 ${fleetCounts.ephemeral}`] as const] : []),
          ] as const).map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={statusFilter === value ? 'primary' : 'ghost'}
              className="h-7 px-2 text-xs"
              onClick={() => setStatusFilter(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      {visibleMachines.length > 0 ? (
        <ul className="min-h-0 flex-1 divide-y divide-border/70 overflow-y-auto" onKeyDown={handleRailKeyDown}>
          {visibleMachines.map((machine) => (
            <FleetRow
              key={machine.uid}
              machine={machine}
              isHost={data?.host_machine !== undefined && data.host_machine === machine.id}
              active={activeMachine?.uid === machine.uid}
              buttonRef={(node) => {
                if (node) rowRefs.current.set(machine.uid, node);
                else rowRefs.current.delete(machine.uid);
              }}
              onSelect={() => setSelectedUid(machine.uid)}
            />
          ))}
        </ul>
      ) : (
        <Note className="px-3.5 py-6 text-center text-xs">没有符合当前筛选条件的机器。</Note>
      )}
    </aside>
  );

  const outdatedCliCount = useMemo(
    () => countOutdatedCliCells(data?.machines ?? [], fleetStatus),
    [data?.machines, fleetStatus],
  );
  const activeCliUpdates = useMemo(
    () => Object.values(fleetStatus?.active_by_key ?? {}).filter((j) => j.state === 'waiting_idle' || j.state === 'updating').length,
    [fleetStatus],
  );

  return (
    <Page
      title="机器"
      width="wide"
      loading={isPending}
      failure={error?.message}
      actions={data ? <Button variant="primary" onClick={() => setAdding(true)}><Plus />接入一台机器</Button> : undefined}
    >
      {data ? (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div role="tablist" aria-label="机器视图切换" className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface/70 p-0.5">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'machines'}
                onClick={() => setActiveTab('machines')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  activeTab === 'machines'
                    ? 'bg-raised text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Server className="size-3.5" />
                机器列表 · {data.machines.length}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'cli-updates'}
                onClick={() => setActiveTab('cli-updates')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  activeTab === 'cli-updates'
                    ? 'bg-raised text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <RefreshCw className={cn('size-3.5', activeCliUpdates > 0 && 'animate-spin')} />
                CLI 更新
                {outdatedCliCount > 0 ? (
                  <Badge tone="waiting" className="ml-0.5 px-1.5 py-0 text-[10px]">{outdatedCliCount} 落后</Badge>
                ) : activeCliUpdates > 0 ? (
                  <Badge tone="plain" className="ml-0.5 px-1.5 py-0 text-[10px]">{activeCliUpdates} 进行中</Badge>
                ) : null}
              </button>
            </div>
            {fleetStatus?.policy.enabled ? (
              <span className="text-xs text-muted-foreground">
                定时自动更新已启用 · 每 {fleetStatus.policy.intervalHours} 小时
              </span>
            ) : null}
          </div>

          {earlier ? <Callout tone="plain" role="status" className="mb-3">{EARLIER_CHANGE}</Callout> : null}
          {data.host_machine === null ? <Callout tone="waiting" className="mb-3">{HOST_MACHINE_UNKNOWN_TEXT}</Callout> : null}
          {data.host_entry && data.host_entry.executors.some((each) => !['written', 'cleared'].includes(each.state)) ? (
            <p className="mb-3 text-xs text-muted-foreground wrap-anywhere">{entryLine(data.host_entry, undefined, '主机本机')}</p>
          ) : null}

          {activeTab === 'cli-updates' ? (
            <ExecutorFleetPanel machines={data.machines} />
          ) : data.machines.length ? (
            isWide ? (
              <div className="grid grid-cols-[296px_minmax(0,1fr)] items-start gap-5">
                {fleetRail}
                <div className="min-w-0">
                  {activeMachine ? machineDetail(activeMachine) : (
                    <Card className="py-10 text-center">
                      <Note>在左侧选择一台机器查看详情。</Note>
                    </Card>
                  )}
                </div>
              </div>
            ) : (
              fleetRail
            )
          ) : (
            <Empty icon={<Server />} title="还没有机器">点“接入一台机器”看怎么接。</Empty>
          )}

          {data.invites.length ? <Invites invites={data.invites} busy={busy} revoking={revoking} failures={inviteFailures} onRevoke={(invite) => void revokeInvite(invite)} /> : null}

          {!isWide && explicitSelected ? (
            <Sheet open onOpenChange={(open) => { if (!open) setSelectedUid(null); }}>
              <SheetContent title={explicitSelected.id} description={`${shortPlatform(explicitSelected.node.platform)} · ${explicitSelected.host}`}>
                {machineDetail(explicitSelected, true)}
              </SheetContent>
            </Sheet>
          ) : null}

          <Dialog open={adding} onOpenChange={setAdding}>
            {adding ? (
              <DialogContent title="接入一台机器" className="max-w-[600px]">
                <JoinSteps guide={guide} />
                <PendingJoins />
              </DialogContent>
            ) : null}
          </Dialog>

          <Sheet open={editing !== null} onOpenChange={(open) => { if (!open && editing && !draftOf(editing.key).saving) closeEditor(editing.key); }}>
            {editing && draftOf(editing.key).form ? (
              <SheetContent title={`${editing.machine.id} 上的 ${editing.login.executor} 登录`} description="这台机器上已经登录好的执行器。这里只填 tycho 加给它的：档位、权限模式和限制。">
                <LoginEditor
                  own={editing.login}
                  form={draftOf(editing.key).form!}
                  saving={draftOf(editing.key).saving}
                  busy={busy}
                  page={data}
                  problem={draftOf(editing.key).tierProblem}
                  onEdit={(name, value) => setDrafts((all) => {
                    const current = all[editing.key] ?? BLANK_LOGIN;
                    if (!current.form) return all;
                    return { ...all, [editing.key]: { ...current, form: { ...current.form, [name]: value }, ...(name === 'tiers' ? { tierProblem: null } : {}) } };
                  })}
                  onSave={() => saveOwn(editing.machine, editing.login, data)}
                  onCancel={() => closeEditor(editing.key)}
                />
                {draftOf(editing.key).error ? <Problem role="alert" className="mt-3">{draftOf(editing.key).error}</Problem> : null}
              </SheetContent>
            ) : null}
          </Sheet>

          <Dialog open={signingIn !== null} onOpenChange={(open) => { if (!open) setSigningIn(null); }}>
            {signingIn ? <DialogContent title={`重新登录 ${signingIn.machine.id} 上的 ${signingIn.executor}`}>
              <MachineSignInSteps executor={signingIn.executor} page={data} busy={busy} fixedMachine={signingIn.machine} onBack={() => setSigningIn(null)} onDone={() => setSigningIn(null)} />
            </DialogContent> : null}
          </Dialog>

          <Dialog open={noting !== null} onOpenChange={(open) => { if (!open && noting && !machineDraft(machineKey(noting.id)).saving) closeNote(noting); }}>
            {noting ? (
              <DialogContent title={`机器 ${noting.id} 的备注`}>
                <NoteForm
                  draft={machineDraft(machineKey(noting.id))}
                  busy={busy}
                  onEdit={(note) => patchMachine(machineKey(noting.id), { form: { note } })}
                  onSave={() => saveNote(noting)}
                  onCancel={() => closeNote(noting)}
                />
              </DialogContent>
            ) : null}
          </Dialog>

          <Confirm
            open={doomed !== null}
            title={question?.title ?? ''}
            description={question?.description}
            confirm={doomed && removal ? (doomedDraft.saving ? removal.sending : removal.confirm + ' ' + doomed.id) : ''}
            cancel={removal?.back}
            busy={doomedDraft.saving}
            error={doomedDraft.error}
            onConfirm={() => { if (doomed) void removeMachine(doomed); }}
            onCancel={() => { if (doomed) patchMachine(machineKey(doomed.id), { confirm: false, error: null }); setRemoving(null); }}
          />

          <Confirm
            open={ownDoomed !== null}
            title={ownDoomed ? `删除 ${ownDoomed.machine.id} 上的 ${ownDoomed.login.executor} 登录？` : ''}
            description="删掉以后服务不再用这台机器的这份登录派活，也不会从这台机器的报告里自动再建；以后还要用，重新在机器上登录或改档位即可。"
            confirm={ownDoomed ? (draftOf(ownDoomed.key).saving ? '删除中' : '确认删除') : ''}
            cancel="不删了"
            busy={ownDoomed ? draftOf(ownDoomed.key).saving : false}
            error={ownDoomed ? draftOf(ownDoomed.key).error : null}
            onConfirm={() => { if (ownDoomed) void deleteOwn(ownDoomed.machine, ownDoomed.login); }}
            onCancel={() => { if (ownDoomed) patch(ownDoomed.key, { error: null }); setOwnRemoving(null); }}
          />
        </>
      ) : null}
    </Page>
  );
}
