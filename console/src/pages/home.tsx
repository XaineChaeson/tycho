// 总览: the page the console opens on. What waits for the owner comes first and can be
// dealt with where it stands — a question answered, a round accepted, a message given its
// project; beside it, what is moving and what just ended; and under that the few things
// about the service itself that are the owner's to look after.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, CircleCheck, CircleHelp, PackageCheck, Pause, Play } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ACTION_TEXT, eventHeadline, exitKindLabels as EXIT_TEXT, missingLoginText, restoreHeadline, runStateLabels, runTime, taskLine } from '@shared/labels.ts';
import { loginName } from '@shared/logins.ts';
import { formatTime, fullTime } from '@shared/time.ts';
import { ApprovalCard } from '@/components/approval-card';
import { Callout, Chevron, Details, Dot, Empty, StatusDot, HashLink, Note, Problem, Rows, SectionTitle, Time } from '@/components/bits';
import { Page } from '@/components/page';
import { AcceptNow } from '@/components/task-actions';
import { taskPath, WorkRow, workPath } from '@/components/work-row';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Option, Select } from '@/components/ui/select';
import { useChange } from '@/hooks/use-change';
import { api, messageOf, post } from '@/lib/api';
import { EXAMPLE_ASKS, useAsk } from '@/lib/examples';
import { useI18n } from '@/lib/i18n';
import { useLive, useLiveState } from '@/lib/live-context';
import { hiddenNotices, hideNotice } from '@/lib/notices';
import { activeProjects, archivedProjectIds } from '@/lib/projects';
import { doctorQuery, overviewQuery, PAGE, POLL_MS, projectsQuery, tasksQuery, type Doctor } from '@/lib/queries';
import type { Backup, Change, DoctorCheck, Message, OrphanReport, OutboxFailure, Overview, Project, Restore, Task } from '@/lib/types';
import { cn } from '@/lib/utils';

const WARN_OPEN = 'setup-warnings';

// Whether the advice was left open is this browser's preference, and a browser may refuse
// storage outright (a policy, a full disk): reading or writing it must never take the
// overview down, and what cannot be read starts folded.
function adviceOpen(): boolean {
  try {
    return sessionStorage.getItem(WARN_OPEN) === '1';
  } catch {
    return false;
  }
}

function rememberAdvice(open: boolean): void {
  try {
    sessionStorage.setItem(WARN_OPEN, open ? '1' : '0');
  } catch {
    // This page still knows: the state it was set to is the one being shown.
  }
}

function parse(text: string): Record<string, unknown> {
  try {
    return (JSON.parse(text) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

const STAT_TONES = {
  waiting: 'bg-waiting-soft text-waiting-foreground',
  running: 'bg-running-soft text-running-foreground',
  success: 'bg-success-soft text-success-foreground',
};

// One number of the overview, readable from across the room: how many, of what. A count
// of nothing is drawn quietly, so the tiles that hold something are the ones seen.
function Stat({ label, count, tone, icon }: { label: string; count: number; tone: keyof typeof STAT_TONES; icon: ReactNode }) {
  return (
    <li className="flex items-center gap-3 rounded-xl bg-raised px-3.5 py-3 shadow-card">
      <span aria-hidden="true" className={cn('flex size-9 flex-none items-center justify-center rounded-lg [&_svg]:size-[18px]', count ? STAT_TONES[tone] : 'bg-muted text-faint')}>{icon}</span>
      <span className="min-w-0">
        <strong className={cn('block text-2xl leading-7 font-semibold tabular-nums', count ? null : 'text-faint')}>{count}</strong>
        <span className="block truncate text-xs text-muted-foreground">{label}</span>
      </span>
    </li>
  );
}

// A group in the side column of the page: a small heading and what is under it.
function Aside({ title, count, action, label, children }: { title: string; count?: number; action?: ReactNode; label?: string; children: ReactNode }) {
  const id = `home-${title}`;
  return (
    <section aria-labelledby={label ? undefined : id} aria-label={label} className="min-w-0">
      <SectionTitle id={id} count={count} action={action}>{title}</SectionTitle>
      {children}
    </section>
  );
}

// What cannot work yet is said at the top and stays there: a check that has turned into a
// fault is a fault whatever was said about it while it was merely advice.
function SetupFaults({ checks }: { checks: readonly DoctorCheck[] }) {
  if (!checks.length) return null;
  return (
    <Callout tone="failed" title="不处理就用不了" className="mb-5" aria-label="不处理就用不了" role="region">
      <div className="mt-1 grid gap-x-6 wide:grid-cols-2">
        {checks.map((check) => (
          <div key={check.id} className="border-failed-border py-2 not-first:border-t wide:nth-2:border-t-0">
            <p className="font-medium">{check.title}</p>
            <Note className="mt-0.5">{check.text}</Note>
            {check.fix ? <HashLink href={check.fix.href} className="mt-1 inline-block">{check.fix.label}</HashLink> : null}
          </div>
        ))}
      </div>
    </Callout>
  );
}

// Advice is folded into one line, opens on request, and can be told to stop repeating on
// this browser — which is about advice only.
function SetupAdvice({ checks }: { checks: readonly DoctorCheck[] }) {
  const [hidden, setHidden] = useState(hiddenNotices);
  const [open, setOpen] = useState(adviceOpen);
  const warns = checks.filter((check) => !hidden.has(check.id));
  if (!warns.length) return null;
  return (
    <section aria-label="建议配置的事" className="overflow-hidden rounded-xl bg-raised shadow-card">
      <button
        type="button"
        aria-expanded={open}
        className="flex min-h-hit w-full items-center gap-2 rounded-lg px-3 text-left text-sm hover:bg-muted"
        onClick={() => {
          const next = !open;
          setOpen(next);
          rememberAdvice(next);
        }}
      >
        <Dot tone="waiting" />
        <span className="flex-1">{`还有 ${warns.length} 件建议配置的事`}</span>
        <Chevron className={cn('transition-transform duration-100', open && 'rotate-90')} />
      </button>
      {open ? (
        <div className="divide-y divide-border border-t border-border">
          {warns.map((check) => (
            <div key={check.id} className="px-3 py-2.5">
              <p className="text-sm font-medium">{check.title}</p>
              <Note className="mt-0.5 text-xs">{check.text}</Note>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
                {check.fix ? <HashLink href={check.fix.href}>{check.fix.label}</HashLink> : null}
                <button
                  type="button"
                  className="text-faint underline decoration-border-strong underline-offset-3 hover:text-foreground"
                  onClick={() => {
                    // This page first, then the browser: a storage that refuses the write
                    // must not leave the advice the owner just dismissed here.
                    setHidden((held) => new Set([...held, check.id]));
                    hideNotice(check.id);
                  }}
                >
                  不再提醒
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

// §2: "not counted" says nothing about what is out there, so it never reads as "none".
// The machine id stands for the connection, which two machines of one host can share.
function OrphanLines({ report: { machine_id: machine, host, runs, error } }: { report: OrphanReport }) {
  if (runs === null) return <Note>{`${machine}（${host}）：未能清点。${error ?? ''}`}</Note>;
  if (!runs.length) return <Note>{`${machine}（${host}）：没有账本之外的 Run`}</Note>;
  return runs.map((run) => <p key={run.run_id}>{`${machine}（${host}）：${run.run_id} · 任务 ${run.task_id} · ${run.alive ? '仍有进程' : '已无进程'}`}</p>);
}

const operations = (changes: readonly Change[]): string =>
  changes.length ? changes.map((change) => `${ACTION_TEXT[change.action] ?? change.action}（${formatTime(change.at)}）`).join('、') : '没有已提交的操作';

function RestorePanel({ restore }: { restore: Restore }) {
  const { held_tasks: held, unverified_messages: messages, runs, orphan_runs: orphans, missing_logins: missing = [], missing_credentials: credentials = [] } = restore;
  const heading = 'mt-3 mb-1 text-xs font-semibold text-waiting-foreground';
  return (
    <Callout tone="waiting" role="region" aria-labelledby="restore-title" className="mb-5">
      <h2 id="restore-title" className="font-semibold">{restoreHeadline(fullTime(restore.backup_at))}</h2>
      <Note className="mt-0.5">{`来源：${restore.from}。恢复于 ${fullTime(restore.restored_at)}。`}</Note>
      <div className="grid gap-1">
        <h3 className={heading}>{`被停住的任务 ${held.length}`}</h3>
        {held.map((task) => <Link key={task.id} to={taskPath(task.id)} className="block wrap-anywhere">{task.title}</Link>)}
        {held.length ? null : <Note>都确认过了</Note>}
        <h3 className={heading}>{`待核实的消息 ${messages.length}`}</h3>
        {messages.map((message) => (
          <div key={message.id}>
            <p>{eventHeadline(message.text)}</p>
            <Note>{operations(message.changes)}</Note>
          </div>
        ))}
        <h3 className={heading}>{`备份里未结束的 Run ${runs.length}`}</h3>
        {runs.map((run) => (
          <Link key={run.id} to={taskPath(run.task_id)} className="block wrap-anywhere">
            {`${run.task_title} · ${run.exit_kind ? EXIT_TEXT[run.exit_kind] ?? run.exit_kind : runStateLabels[run.state] ?? run.state} · ${run.host}`}
          </Link>
        ))}
        {/* Their Runs above stay unknown: no machine was asked, and none is judged gone. */}
        {missing.map((target) => <Problem key={target}>{missingLoginText(target)}</Problem>)}
        {credentials.length ? (
          <div>
            <h3 className={heading}>需要补齐登录凭据</h3>
            <Note>备份不含登录凭据。重新登录或补填密钥后，这些账号才能接任务。</Note>
            {credentials.map(({ id, name }) => <HashLink key={id} href={`#/accounts?login=${encodeURIComponent(id)}`} className="block wrap-anywhere">{name}</HashLink>)}
          </div>
        ) : null}
        <h3 className={heading}>远端存在、账本里没有的 Run</h3>
        {orphans.map((report) => <OrphanLines key={`${report.machine_id}:${report.host}`} report={report} />)}
        {orphans.length ? null : <Note>未能清点：还没有结果</Note>}
      </div>
    </Callout>
  );
}

function BackupPanel({ backup }: { backup: Backup }) {
  const client = useQueryClient();
  const live = useLive();
  const [backingUp, setBackingUp] = useState(false);
  if (!backup.configured) {
    return (
      <Aside title="备份">
        <Note>没有配置自动备份。要打开它，到设置页填上备份目录。<Link to="/settings/backup.dir" className="ml-1">去设置</Link></Note>
      </Aside>
    );
  }
  const running = Boolean(backup.running) || backingUp;
  return (
    <Aside
      title="备份"
      action={(
        <Button
          size="sm"
          variant="ghost"
          disabled={running}
          onClick={async () => {
            setBackingUp(true);
            try {
              await post('/api/backup');
              await client.invalidateQueries({ queryKey: [PAGE] });
            } catch (error) {
              live.showError(messageOf(error));
            } finally {
              setBackingUp(false);
            }
          }}
        >
          {running ? '备份中' : '立即备份'}
        </Button>
      )}
    >
      <div className="grid gap-1 text-sm">
        <p>{`上次成功：${backup.last_ok_at ? fullTime(backup.last_ok_at) : '还没有成功过'}`}</p>
        {backup.last_ok_incomplete
          ? <Note>这份备份的日志副本不完整：账本是全的，有日志文件没复制下来。缺哪些写在备份目录的 backup.json 里。</Note> : null}
        {backup.last_error ? <Problem>{`上次失败：${fullTime(backup.last_error.at)}。原因：${backup.last_error.text}`}</Problem> : null}
        <Note className="text-xs">{`每天 ${backup.at} 备份到 ${backup.dir}`}</Note>
      </div>
    </Aside>
  );
}

function ConfirmAllFailures({ count }: { count: number }) {
  const live = useLive();
  const change = useChange<Overview>({ mutationKey: ['home-outbox-change'], queryKey: overviewQuery.queryKey, reread: true });
  async function confirmAll(): Promise<void> {
    if (!change.free()) return;
    try {
      await change.send(
        () => post('/api/outbox/confirm-all'),
        (overview) => {
          const outbox = overview.outbox ?? overview.state.outbox;
          if (!outbox) return overview;
          return { ...overview, outbox: { ...outbox, failures: [], given_up: 0 } };
        },
      );
    } catch (error) {
      live.showError(messageOf(error));
    }
  }
  if (count <= 1) return null;
  return (
    <Button size="sm" variant="ghost" disabled={change.busy} onClick={() => void confirmAll()}>
      {`全部忽略（${count} 条）`}
    </Button>
  );
}

const UNCERTAIN_DELIVERY_RE = /未确认|结果未知/;

function FailedDelivery({ row }: { row: OutboxFailure }) {
  const live = useLive();
  const change = useChange<Overview>({ mutationKey: ['home-outbox-change'], queryKey: overviewQuery.queryKey, reread: true });
  const payload = parse(row.payload_json);
  const taskId = typeof payload.task_id === 'string' && payload.task_id ? payload.task_id : null;
  const taskTitle = row.task_title ?? (typeof payload.task_title === 'string' && payload.task_title ? payload.task_title : null);
  const object = taskTitle ?? taskId ?? payload.run_id ?? payload.approval_id ?? payload.external_id ?? row.id;
  const uncertain = typeof row.error === 'string' && UNCERTAIN_DELIVERY_RE.test(row.error);
  async function send(action: 'retry' | 'confirm' | 'force-resend'): Promise<void> {
    if (!change.free()) return;
    try {
      await change.send(
        () => post(`/api/outbox/${encodeURIComponent(row.id)}/${action}`),
        (overview) => {
          if (action !== 'confirm') return overview;
          const outbox = overview.outbox ?? overview.state.outbox;
          if (!outbox?.failures?.some(({ id }) => id === row.id)) return overview;
          return { ...overview, outbox: { ...outbox, failures: outbox.failures.filter(({ id }) => id !== row.id), given_up: Math.max(0, (outbox.given_up ?? 0) - 1) } };
        },
      );
    } catch (error) {
      live.showError(messageOf(error));
    }
  }
  return (
    <div className="flex items-start gap-2 px-3 py-2.5 text-sm wrap-anywhere">
      <div className="min-w-0 flex-1">
        <p>
          对象：
          {taskId ? <Link to={taskPath(taskId)}>{String(taskTitle ?? taskId)}</Link> : String(object)}
        </p>
        <p className="text-muted-foreground">{`原因：${row.error ?? '未知'}`}</p>
        <Time at={row.first_failed_at ?? row.created_at} className="text-xs text-faint" />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" disabled={change.busy} onClick={() => void send('confirm')}>忽略</Button>
        {uncertain ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={change.busy}
            title="已核对原聊天确认未收到时使用；跳过单次发送保护强制补发一次"
            aria-label="确认未收到，强制补发"
            onClick={() => void send('force-resend')}
          >
            确认未收到，强制补发
          </Button>
        ) : (
          <Button size="sm" variant="ghost" disabled={change.busy} onClick={() => void send('retry')}>重试发送</Button>
        )}
      </div>
    </div>
  );
}

// Pausing is a state with a consequence, so the state, what it means and the button that
// changes it stand together, and the button says which way it goes.
function DispatchPanel({ overview }: { overview: Overview }) {
  const client = useQueryClient();
  const live = useLive();
  const { state, launching = [] } = overview;
  const { dispatch } = state;
  const paused = dispatch.paused === true;
  // The ledger refuses these too; the button says so before it is pressed.
  const blocked = dispatch.recovering ? '正在清点，稍后再试' : paused && overview.restore ? '先确认清点完成，再恢复派发' : null;
  const wording = dispatch.degraded ? '已停止：账本写入失败' : dispatch.recovering ? '清点中' : paused ? '已暂停' : '正常';
  return (
    <Aside
      title="派发"
      label="派发"
      action={(
        <>
          <Badge tone={dispatch.degraded ? 'failed' : dispatch.recovering || paused ? 'waiting' : 'success'}>{wording}</Badge>
          <Button
            size="sm"
            variant="ghost"
            disabled={Boolean(dispatch.degraded) || Boolean(blocked) || Boolean(dispatch.recovering)}
            title={blocked ?? undefined}
            onClick={async () => {
              try {
                await post('/api/pause', { paused: !paused });
                await Promise.all([client.invalidateQueries({ queryKey: [PAGE] }), client.invalidateQueries({ queryKey: ['state'] })]);
              } catch (error) {
                live.showError(messageOf(error));
              }
            }}
          >
            {paused ? <Play /> : <Pause />}
            {paused ? '恢复派发' : '暂停派发'}
          </Button>
        </>
      )}
    >
      <Note>{paused ? '正在跑的继续跑，不会被打断；新的任务暂时不开始。' : '新任务按全局档位派发顺序自动分发，不用你盯着。'}</Note>
      {paused && launching.length ? (
        <div className="mt-1.5 text-sm">
          <Note>暂停前已经取得启动资格的，还可能随后启动：</Note>
          {launching.map((run) => {
            const where = [run.host, run.unconfirmed ? '启动未确认' : null].filter(Boolean).join('，');
            return (
              <Link key={run.id} to={taskPath(run.task_id)} className="block wrap-anywhere">
                {`${run.task_title ?? run.id}${where ? `（${where}）` : ''}`}
              </Link>
            );
          })}
        </div>
      ) : null}
      {blocked ? <Note className="mt-1 text-xs">{blocked}</Note> : null}
    </Aside>
  );
}

function isInReview(task: Task): boolean {
  return task.state === 'ready' && (
    task.review_gate?.kind === 'in_review'
    || Boolean(task.active_review)
    || task.summary?.dot === 'running'
  );
}

// The sentence at the top: what needs the owner if anything does, else what is moving.
function headline(counts: {
  decisions: number;
  ready: number;
  held: number;
  noMachine: number;
  unassigned: number;
  moving: number;
}, isEn = false): string {
  const todo: string[] = [];
  if (isEn) {
    if (counts.decisions) todo.push(`${counts.decisions} awaiting decision`);
    if (counts.ready) todo.push(`${counts.ready} ready for review`);
    if (counts.held) todo.push(`${counts.held} held`);
    if (counts.noMachine) todo.push(`${counts.noMachine} login(s) without machine`);
    if (counts.unassigned) todo.push(`${counts.unassigned} unassigned message(s)`);
    if (todo.length) return todo.join(', ');
    return counts.moving ? `Nothing waiting on you — ${counts.moving} in progress` : 'Nothing waiting on you';
  }
  if (counts.decisions) todo.push(`${counts.decisions} 件等你决定`);
  if (counts.ready) todo.push(`${counts.ready} 件待验收`);
  if (counts.held) todo.push(`${counts.held} 件已停住`);
  if (counts.noMachine) todo.push(`${counts.noMachine} 个登录没有可用的机器`);
  if (counts.unassigned) todo.push(`${counts.unassigned} 条消息待归属`);
  if (todo.length) return todo.join('，');
  return counts.moving ? `没有等你的事，${counts.moving} 项工作在推进` : '没有等你的事';
}

// What the owner sent from WeCom that no project's Router has been given yet
// (docs/design/project-sessions.md §2): choosing a project puts it in that conversation.
function Unassigned({ messages, projects }: { messages: readonly Message[]; projects: readonly Project[] }) {
  const client = useQueryClient();
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [bulkProject, setBulkProject] = useState<string>('');
  const [problem, setProblem] = useState<string | null>(null);
  const first = projects[0]?.id ?? '';
  const selectedBulk = bulkProject && projects.some((p) => p.id === bulkProject) ? bulkProject : first;

  async function assign(ids: string[], project: string): Promise<void> {
    setProblem(null);
    try {
      await post('/api/messages/assign', { ids, project_id: project });
      await client.invalidateQueries({ queryKey: [PAGE, 'unassigned'] });
    } catch (error) {
      setProblem(messageOf(error));
    }
  }

  return (
    <section aria-label="待归属的消息" className="overflow-hidden rounded-xl border border-waiting-border bg-raised shadow-sm">
      <p className="border-b border-waiting-border bg-waiting-soft px-3.5 py-2 text-xs font-medium text-waiting-foreground">待归属的消息</p>
      <div className="grid gap-3 px-3.5 py-3">
        <Note className="text-xs">还没交给任何项目负责人的消息。选一个项目，它就进那个项目的当前对话。</Note>
        {problem ? <Problem role="alert">{problem}</Problem> : null}
        <ul className="grid gap-3">
          {messages.map((row) => (
            <li key={row.id} className="grid gap-2">
              <p className="rounded-lg bg-bubble px-3 py-2 text-sm wrap-anywhere whitespace-pre-wrap">{row.text}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Select aria-label="归到哪个项目" value={chosen[row.id] ?? first} onChange={(event) => setChosen({ ...chosen, [row.id]: event.target.value })}>
                  {projects.map((project) => <Option key={project.id} value={project.id}>{project.name}</Option>)}
                </Select>
                <Button size="sm" disabled={!(chosen[row.id] ?? first)} onClick={() => void assign([row.id], chosen[row.id] ?? first)}>归到这个项目</Button>
              </div>
            </li>
          ))}
        </ul>
        {messages.length > 1 && first ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
            <Select aria-label="全部归到哪个项目" value={selectedBulk} onChange={(event) => setBulkProject(event.target.value)}>
              {projects.map((project) => <Option key={project.id} value={project.id}>{project.name}</Option>)}
            </Select>
            <Button size="sm" variant="ghost" disabled={!selectedBulk} onClick={() => void assign(messages.map(({ id }) => id), selectedBulk)}>归到所选项目</Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

// Nothing is anywhere: the page says so, says how to start, and offers the sentences an
// owner most often begins with. Pressing one fills the conversation's box.
function NothingYet({ projects }: { projects: readonly Project[] }) {
  const { bi } = useI18n();
  // A message goes to one project's Router: the examples begin in the first project's box.
  const first = projects[0];
  const ask = useAsk(first?.id ?? '');
  return (
    <Empty icon={<CircleCheck />} title={bi('现在没有在进行的工作', 'No active work right now')} className="py-14" >
      <p>{bi('到项目里告诉它的负责人要做什么，它会拆成任务、派出去、把结果带回来。', 'Tell a project Router what you need — it breaks work into tasks, dispatches them, and reports back.')}</p>
      {first ? (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <span className="w-full text-xs text-faint">{`点一句，到 ${first.name} 的对话里问：`}</span>
          {EXAMPLE_ASKS.map((text) => <Button key={text} size="sm" onClick={() => ask(text)}>{text}</Button>)}
        </div>
      ) : <div className="mt-3 grid gap-1 text-sm">
        <p>先在<Link to="/accounts">账号</Link>页添加集中托管账号，并在<Link to="/machines">机器</Link>页接入执行机器。</p>
        <p>在<Link to="/settings/router.account">设置</Link>确认负责人账号，再于<Link to="/projects">项目</Link>页新建项目。</p>
        <p>打开项目对话，试着说：“请派一条验证任务，报告执行机器的系统和当前时间。”</p>
      </div>}
    </Empty>
  );
}

function HomeBody({ overview, doctor, tasks, children, projects, unassigned }: {
  overview: Overview;
  doctor: Doctor | undefined;
  tasks: readonly Task[];
  children: readonly Task[];
  projects: readonly Project[];
  unassigned: readonly Message[];
}) {
  const { isEn, t, bi } = useI18n();
  const { summary } = useLiveState();
  // A project picker lists only the ones in sight: archived is out of every list until restored.
  const open = activeProjects(projects);
  const archived = archivedProjectIds(projects);
  const { approvals, moving, recent, held = [], parked_waiting: parkedWaitingRaw = [], no_machine: noMachine = [] } = overview;
  // Only a Task that is itself waiting to be accepted can be accepted: a work whose
  // summary says one of its tasks waits reads as ready without being acceptable, and the
  // ledger would refuse it. Ready tasks whose automatic independent review is currently
  // running belong in 正在进行, not 需要你处理. Tasks of archived projects stay out of todo.
  const allReady = [...tasks, ...children].filter((task) => task.state === 'ready' && (task.project_id == null || !archived.has(task.project_id)));
  const ready = allReady.filter((task) => !isInReview(task));
  const reviewingTasks = allReady.filter((task) => isInReview(task));
  const movingIds = new Set(moving.map((task) => task.id));
  const extraMoving = reviewingTasks.filter((task) => !movingIds.has(task.id));
  const movingList = [...moving, ...extraMoving];

  const approvalTaskIds = new Set(approvals.map((approval) => approval.task_id));
  const parkedWaiting = parkedWaitingRaw.filter((task) => !approvalTaskIds.has(task.id) && (task.project_id == null || !archived.has(task.project_id)));

  const outbox = overview.outbox ?? overview.state.outbox ?? {};
  const decisionCount = approvalTaskIds.size + parkedWaiting.length;
  const readyCount = allReady.length > 0 ? ready.length : overview.counts.ready;
  const movingCount = overview.counts.moving + extraMoving.length;
  const todo = approvals.length + parkedWaiting.length + ready.length + held.length + noMachine.length + unassigned.length;
  const idle = !todo && !movingList.length && !recent.length;
  const projectName = (id: string | null | undefined): string | undefined => projects.find((each) => each.id === id)?.name;
  const parentOf = (task: Task): string | undefined => (task.parent_id ? [...tasks, ...children].find((each) => each.id === task.parent_id)?.title : undefined);
  const checks = doctor?.checks ?? [];
  return (
    <article>
      {doctor?.failure !== undefined ? <Note className="mb-3">{`自检结果读不到：${doctor.failure}`}</Note> : null}
      <SetupFaults checks={checks.filter((check) => check.level === 'fail')} />
      {overview.restore ? <RestorePanel restore={overview.restore} /> : null}
      <header className="mb-7">
        <h2 className="text-3xl font-semibold tracking-[-0.02em] wrap-anywhere">
          {headline({
            decisions: decisionCount,
            ready: readyCount,
            held: held.length,
            noMachine: noMachine.length,
            unassigned: unassigned.length,
            moving: movingCount,
          }, isEn)}
        </h2>
        {summary ? <p className="mt-1.5 text-sm text-muted-foreground">{summary}</p> : null}
        <ul aria-label={bi('工作概况', 'Work summary')} className="mt-5 grid grid-cols-2 gap-3 wide:grid-cols-4">
          <Stat label={t('home.waitingYou')} count={decisionCount} tone="waiting" icon={<CircleHelp />} />
          <Stat label={t('home.readyReview')} count={readyCount} tone="waiting" icon={<PackageCheck />} />
          <Stat label={bi('正在推进', 'In progress')} count={movingCount} tone="running" icon={<Activity />} />
          <Stat label={t('home.recentEnded')} count={recent.length} tone="success" icon={<CircleCheck />} />
        </ul>
      </header>
      {idle ? <NothingYet projects={open} /> : (
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-x-10 gap-y-8 wide:grid-cols-[minmax(0,1fr)_340px]">
          <section aria-labelledby="home-todo" className="min-w-0">
            <SectionTitle id="home-todo" count={todo || undefined}>{bi('需要你处理', 'Needs your attention')}</SectionTitle>
            {todo ? (
              <div className="grid gap-3">
                {approvals.map((card) => <ApprovalCard key={card.id} card={card} />)}
                {ready.map((task) => <AcceptNow key={task.id} task={task} context={parentOf(task) ?? projectName(task.project_id)} />)}
                {unassigned.length ? <Unassigned messages={unassigned} projects={open} /> : null}
                {parkedWaiting.length || held.length || noMachine.length ? (
                  <Rows>
                    {parkedWaiting.map((task) => (
                      <Link key={task.id} to={taskPath(task.id)} className="flex items-start gap-2.5 px-3 py-2.5 text-sm no-underline hover:bg-muted">
                        <StatusDot state="waiting_person" className="mt-[3px]" />
                        <span className="min-w-0 flex-1">
                          <strong className="block font-medium wrap-anywhere">{`待处理：${task.title}`}</strong>
                          <span className="block text-xs text-muted-foreground wrap-anywhere">{task.reason ?? '等待你修正配置或手动继续'}</span>
                        </span>
                        <Chevron className="mt-1" />
                      </Link>
                    ))}
                    {held.map((task) => (
                      <Link key={task.id} to={workPath(task.id)} className="flex items-start gap-2.5 px-3 py-2.5 text-sm no-underline hover:bg-muted">
                        <StatusDot state="held" className="mt-[3px]" />
                        <span className="min-w-0 flex-1">
                          <strong className="block font-medium wrap-anywhere">{`已停住：${task.title}`}</strong>
                          <span className="block text-xs text-muted-foreground wrap-anywhere">{task.summary?.leaf ? task.reason ?? '没有写原因' : taskLine(task)}</span>
                        </span>
                        <Chevron className="mt-1" />
                      </Link>
                    ))}
                    {noMachine.map((target) => (
                      <div key={target.login_id} className="flex items-start gap-2.5 px-3 py-2.5 text-sm">
                        <Dot tone="waiting" className="mt-[7px]" />
                        <span className="min-w-0 flex-1">
                          <strong className="block font-medium">{`${target.login_name ? loginName(target.login_name) : '未知登录'} 没有可用的机器`}</strong>
                          <span className="block text-xs text-muted-foreground"><Time at={target.since} prefix="从 " suffix=" 起一直连不上。排在它上面的任务在等，加上机器或机器恢复后自动继续" /></span>
                        </span>
                      </div>
                    ))}
                  </Rows>
                ) : null}
              </div>
            ) : <Empty icon={<CircleCheck />} title={bi('没有待处理的事', 'All caught up')}>{bi('有问题要你定、有成果要你验收时，会出现在这里。', 'Questions awaiting your decision and deliverables ready for review appear here.')}</Empty>}
          </section>
          <div className="grid min-w-0 gap-7">
            <Aside title={t('home.moving')} count={movingList.length || undefined}>
              {movingList.length ? (
                <Rows>
                  {movingList.map((task) => (
                    <WorkRow
                      key={task.id}
                      task={task}
                      children={children.filter((child) => child.parent_id === task.id)}
                      project={projectName(task.project_id)}
                      meta={<span title={[task.latest_run?.login_name ? loginName(task.latest_run.login_name) : null, task.latest_run?.host].filter(Boolean).join(' · ') || undefined}>{runTime(task.latest_run ?? null)}</span>}
                    />
                  ))}
                </Rows>
              ) : <Note>{bi('现在没有在进行的工作', 'No active work right now')}</Note>}
            </Aside>
            <Aside title={bi('刚结束', 'Just finished')} action={<Link to="/work?show=ended" className="text-xs text-muted-foreground">{bi('全部已结束的工作', 'All finished work')}</Link>}>
              {recent.length ? (
                <Rows>
                  {recent.map((task) => <WorkRow key={task.id} task={task} project={projectName(task.project_id)} meta={<Time at={task.finished_at} />} />)}
                </Rows>
              ) : <Note>{bi('最近没有结束的工作', 'No recently finished work')}</Note>}
            </Aside>
          </div>
        </div>
      )}
      <div className="mt-10 grid items-start gap-x-10 gap-y-7 border-t border-border pt-6 sm:grid-cols-2 wide:grid-cols-3">
        <DispatchPanel overview={overview} />
        {overview.backup ? <BackupPanel backup={overview.backup} /> : null}
        <SetupAdvice checks={checks.filter((check) => check.level === 'warn')} />
        {(outbox.given_up ?? 0) > 0 ? (
          <section aria-label="发送失败的提醒" className="min-w-0 sm:col-span-2 wide:col-span-3">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <SectionTitle className="mb-0">{`发送失败 ${outbox.given_up} 条`}</SectionTitle>
              <ConfirmAllFailures count={outbox.given_up ?? 0} />
            </div>
            <Note className="mb-2">{`待发送 ${outbox.pending ?? '未知'} 条 · 已放弃 ${outbox.given_up ?? '未知'} 条。通知未能确认送达，已停止自动重试；“忽略”仅清除提醒，不影响任务状态。`}</Note>
            <Rows>{(outbox.failures ?? []).map((row) => <FailedDelivery key={row.id} row={row} />)}</Rows>
          </section>
        ) : null}
      </div>
    </article>
  );
}

export function HomePage() {
  const { t } = useI18n();
  const { data: overview, isPending, error } = useQuery(overviewQuery);
  const { data: doctor } = useQuery(doctorQuery);
  // The works waiting to be accepted are read from the list the side column already
  // keeps in step, together with the tasks under them: the one that is acceptable is
  // never the work, it is the task that is itself waiting.
  const { data: listing } = useQuery(tasksQuery);
  const { data: projects } = useQuery(projectsQuery);
  const waiting = useQuery({ queryKey: [PAGE, 'unassigned'], queryFn: async () => (await api<{ messages: Message[] }>('/api/messages/unassigned')).messages });
  return (
    <Page title={t('home.title')} width="wide" loading={isPending} failure={error?.message}>
      {overview ? (
        <HomeBody
          overview={overview}
          doctor={doctor}
          tasks={listing?.tasks ?? []}
          children={listing?.children ?? []}
          projects={projects ?? []}
          unassigned={waiting.data ?? []}
        />
      ) : null}
    </Page>
  );
}
