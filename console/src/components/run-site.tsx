// What a round did, as the task page shows it (docs/design/phase1-design.md §9.1): a line
// per call with its short title and how it ended, the whole input and output a click
// away; neighbouring reads and searches folded into one line; what the executor said
// about itself folded into one line; and the files it reports it changed.
import { BookOpen, Pencil, Search, Terminal, type LucideIcon } from 'lucide-react';
import { t as translate } from '@shared/i18n.ts';
import { Markdown } from '@/components/markdown';
import { Details, Dot, Note, PRE, Problem } from '@/components/bits';
import { useI18n } from '@/lib/i18n';
import { diagnosticsSummary, groupSummary, type Diagnostic, type Site, type ToolRow, type ToolStatus } from '@/lib/timeline';
import type { FileChange } from '@/lib/types';
import { cn } from '@/lib/utils';

const TOOL_TEXT_KEYS: Record<ToolStatus, string> = {
  running: 'tsk.site.toolStatus.running',
  completed: 'tsk.site.toolStatus.completed',
  failed: 'tsk.site.toolStatus.failed',
  incomplete: 'tsk.site.toolStatus.incomplete',
};
// What a tool call does, as a picture beside its title. Any other kind reads as a command.
const TOOL_ICONS: Record<string, LucideIcon> = { read: BookOpen, edit: Pencil, run: Terminal, search: Search };
const LEVEL_TEXT_KEYS: Record<string, string> = {
  warning: 'tsk.site.diagLevel.warning',
  recovering: 'tsk.site.diagLevel.recovering',
  fatal: 'tsk.site.diagLevel.fatal',
};
const OP_TEXT_KEYS: Record<string, string> = {
  add: 'tsk.site.fileOp.add',
  update: 'tsk.site.fileOp.update',
  delete: 'tsk.site.fileOp.delete',
};
const OUT = cn(PRE, 'my-1 max-h-80 overflow-auto p-2.5');
const LABEL = 'mt-2 text-xs text-faint';
// A line that folds: the title one line long, cut at the end; the state never shrinks.
const LINE = 'min-h-7 gap-2 text-foreground';

function Status({ status }: { status: ToolStatus }) {
  const { t } = useI18n();
  return (
    <>
      {status === 'running' ? <Dot tone="running" /> : null}
      <span className={cn('flex-none text-xs whitespace-nowrap', status === 'failed' ? 'font-medium text-destructive' : 'text-faint')}>{t(TOOL_TEXT_KEYS[status])}</span>
    </>
  );
}

function ToolDetail({ row }: { row: ToolRow }) {
  const { t } = useI18n();
  const { call, output, reason, exitCode } = row;
  return (
    <div className="mb-2 ml-[22px] min-w-0">
      <Note className="text-xs">
        {exitCode === undefined
          ? t('tsk.site.toolHeader', { name: call.name })
          : t('tsk.site.toolHeaderWithExit', { name: call.name, exitCode })}
      </Note>
      {call.input ? <><p className={LABEL}>{t('tsk.site.input')}</p><pre className={OUT}>{call.input}</pre></> : null}
      {reason ? <><p className={LABEL}>{t('tsk.site.reason')}</p><pre className={cn(OUT, 'text-destructive')}>{reason}</pre></> : null}
      {output ? (
        <>
          <p className={LABEL}>{t('tsk.site.output')}</p>
          <pre className={OUT}>{output.text}</pre>
          {output.executorTruncated ? <Note className="text-xs">{t('tsk.site.executorTruncated')}</Note> : null}
          {output.omittedBytes ? <Note className="text-xs">{t('tsk.site.omittedBytes', { bytes: output.omittedBytes })}</Note> : null}
        </>
      ) : null}
      {!call.input && !output && !reason ? <Note className="text-xs">{t('tsk.site.noToolIo')}</Note> : null}
    </div>
  );
}

export function ToolLine({ row, id }: { row: ToolRow; id: string }) {
  const { t } = useI18n();
  const Icon = TOOL_ICONS[row.call.category] ?? Terminal;
  const running = row.status === 'running';
  // Why it failed: the executor's reason, else its exit code, else the first line it printed.
  const printed = row.output?.text.split('\n').find((line) => line.trim());
  const why = row.status === 'failed' ? row.reason ?? (row.exitCode === undefined ? printed : t('tsk.site.exitCode', { code: row.exitCode })) : undefined;
  return (
    <div data-tool={row.call.category} data-status={row.status} className="min-w-0 text-sm">
      <Details
        id={`tool:${id}`}
        summaryClassName={cn(LINE, running && '-mx-1.5 rounded-md px-1.5 animate-shimmer-subtle')}
        title={(
          <>
            <Icon className="size-3.5 flex-none text-faint" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={row.call.title}>{row.call.title}</span>
            <Status status={row.status} />
          </>
        )}
      >
        <ToolDetail row={row} />
      </Details>
      {why ? <p className="ml-[42px] truncate text-xs text-destructive" title={why}>{why.split('\n').find((line) => line.trim()) ?? why}</p> : null}
    </div>
  );
}

function groupStatus(tools: readonly ToolRow[]): ToolStatus {
  if (tools.some((row) => row.status === 'running')) return 'running';
  return tools.some((row) => row.status === 'incomplete') ? 'incomplete' : 'completed';
}

function ToolGroup({ tools, id }: { tools: ToolRow[]; id: string }) {
  const { t } = useI18n();
  const current = tools.findLast((row) => row.status === 'running');
  const status = groupStatus(tools);
  const running = status === 'running';
  const Icon = tools.every((row) => row.call.category === 'read')
    ? BookOpen
    : tools.every((row) => row.call.category === 'read' || row.call.category === 'search')
      ? Search
      : tools.every((row) => row.call.category === 'edit')
        ? Pencil
        : Terminal;
  const summary = groupSummary(tools);
  const stepHint = running
    ? t('tsk.site.stepsRunning', { count: tools.length })
    : t('tsk.site.stepsDone', { count: tools.length });
  return (
    <div data-group data-status={status} data-steps={tools.length} className="min-w-0 text-sm">
      <Details
        id={`group:${id}`}
        summaryClassName={cn(LINE, running && '-mx-1.5 rounded-md px-1.5 animate-shimmer-subtle')}
        title={(
          <>
            <Icon className="size-3.5 flex-none text-faint" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-xs" title={`${stepHint} · ${summary}`}>
              {summary}
              {current ? <span className="text-muted-foreground">{t('tsk.site.runningCurrent', { title: current.call.title })}</span> : null}
            </span>
            <Status status={status} />
          </>
        )}
      >
        <div className="ml-[22px]">
          <p className="mb-0.5 text-2xs text-faint tabular-nums">{stepHint}</p>
          {tools.map((row) => <ToolLine key={row.id} row={row} id={`${id}:${row.id}`} />)}
        </div>
      </Details>
    </div>
  );
}

function DiagnosticItem({ item }: { item: Diagnostic }) {
  const { t } = useI18n();
  const level = LEVEL_TEXT_KEYS[item.level] ? t(LEVEL_TEXT_KEYS[item.level]!) : item.level;
  return (
    <li className="min-w-0">
      <span className="text-xs">{item.count > 1 ? t('tsk.site.diagCount', { level, count: item.count }) : level}</span>
      <pre className={OUT}>{item.message}</pre>
    </li>
  );
}

// Warnings and retries fold into one gray line; the words are a click away.
export function Diagnostics({ list, id }: { list: Diagnostic[]; id: string }) {
  useI18n();
  if (!list.length) return null;
  return (
    <div data-diagnostics className="min-w-0 text-sm text-muted-foreground">
      <Details id={`diagnostics:${id}`} summaryClassName="min-h-7 text-xs" title={diagnosticsSummary(list)}>
        <ul className="ml-[22px]">{list.map((item, index) => <DiagnosticItem key={index} item={item} />)}</ul>
      </Details>
    </div>
  );
}

// The files completed calls report they changed. A patch only where the executor gave one.
export function FileChanges({ changes, id }: { changes: FileChange[]; id: string }) {
  const { t } = useI18n();
  if (!changes.length) return null;
  return (
    <section aria-label={t('tsk.site.fileChangesLabel')} className="min-w-0 text-sm">
      <p className="mb-1.5 text-xs text-muted-foreground">{t('task.fileChanges', { count: changes.length })}</p>
      <ul className="flex flex-col gap-0.5">
        {changes.map((change) => (
          <li key={change.path} data-change={change.op ?? 'write'} className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className={cn('w-8 flex-none text-xs whitespace-nowrap', change.op === 'add' ? 'text-success-foreground' : change.op === 'delete' ? 'text-destructive' : 'text-muted-foreground')}>
                {OP_TEXT_KEYS[change.op ?? ''] ? t(OP_TEXT_KEYS[change.op ?? '']!) : t('tsk.site.fileOp.write')}
              </span>
              <span className="min-w-0 truncate font-mono text-xs" title={change.path}>{change.path}</span>
            </div>
            {change.patch ? (
              <Details id={`patch:${id}:${change.path}`} className="ml-10" summaryClassName="min-h-7 text-xs" title={t('task.viewDiff')}>
                <pre className={OUT}>{change.patch}</pre>
              </Details>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

// The rows of a round's process, in the order it did them.
// Keys use executor call IDs (for tools & groups) and per-kind ordinal counters (for non-tool rows)
// so a tool failure splitting a group never shifts another row's React key or disclosure state.
export function SiteRows({ site, id, foldTrailingTextAt = -1 }: { site: Site; id: string; foldTrailingTextAt?: number }) {
  const { t } = useI18n();
  const kindOrdinals = new Map<string, number>();
  const nextOrdinal = (kind: string): number => {
    const n = kindOrdinals.get(kind) ?? 0;
    kindOrdinals.set(kind, n + 1);
    return n;
  };
  return (
    <>
      <Diagnostics list={site.diagnostics} id={id} />
      {site.rows.map((row, index) => {
        const key = row.kind === 'tool'
          ? `${id}:tool:${row.id}`
          : row.kind === 'group'
            ? `${id}:group:${row.tools[0]?.id ?? nextOrdinal('group')}`
            : `${id}:${row.kind}:${nextOrdinal(row.kind)}`;
        switch (row.kind) {
          case 'text':
            if (index === foldTrailingTextAt) {
              return (
                <Details key={key} id={`raw-final:${key}`} summaryClassName="min-h-7 text-xs" title={t('task.rawFinalOutput')}>
                  <div data-quotable data-quote-source={t('tsk.site.quoteFinalOutput')} data-quote-source-key="worker" className="mb-2 ml-[22px]">
                    <Markdown text={row.text} className="py-1" />
                  </div>
                </Details>
              );
            }
            return (
              <div key={key} data-quotable data-quote-source={t('tsk.site.quoteProcess')} data-quote-source-key="worker">
                <Markdown text={row.text} className="py-1" />
              </div>
            );
          case 'thinking':
            return (
              <Details key={key} id={`thinking:${key}`} summaryClassName="min-h-7 text-xs" title={row.live ? t('tsk.site.thinkingLive') : t('tsk.site.thinkingRecord')}>
                <p className="mb-2 ml-[22px] text-sm text-muted-foreground wrap-anywhere whitespace-pre-wrap">{row.text}</p>
              </Details>
            );
          case 'tool':
            return <ToolLine key={key} row={row} id={key} />;
          case 'group':
            return <ToolGroup key={key} tools={row.tools} id={key} />;
          case 'fatal':
            return <Problem key={key}>{row.count > 1 ? t('tsk.site.fatalCount', { message: row.message, count: row.count }) : row.message}</Problem>;
          case 'truncated':
            return <Note key={key}>{t('tsk.site.truncatedEvents', { dropped: row.dropped })}</Note>;
          case 'interrupted':
            return <Note key={key}>{t('tsk.site.interrupted')}</Note>;
          default:
            return null;
        }
      })}
      {site.retrying ? (
        <Note>
          {site.retrying.attempt === undefined
            ? t('tsk.site.retrying')
            : t('tsk.site.retryingAttempt', { attempt: site.retrying.attempt, max: site.retrying.maxRetries ?? '?' })}
        </Note>
      ) : null}
    </>
  );
}

// What an ended round's folded process says on its one line.
export function processTitle(site: Site): string {
  if (!site.calls) return translate('tsk.site.processTitleEmpty');
  return site.failures
    ? translate('tsk.site.processTitleWithFailures', { calls: site.calls, failures: site.failures })
    : translate('tsk.site.processTitle', { calls: site.calls });
}
