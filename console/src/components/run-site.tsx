// What a round did, as the task page shows it (docs/design/phase1-design.md §9.1): a line
// per call with its short title and how it ended, the whole input and output a click
// away; neighbouring reads and searches folded into one line; what the executor said
// about itself folded into one line; and the files it reports it changed.
import { BookOpen, Pencil, Search, Terminal, type LucideIcon } from 'lucide-react';
import { Markdown } from '@/components/markdown';
import { Details, Dot, Note, PRE, Problem } from '@/components/bits';
import { diagnosticsSummary, groupSummary, type Diagnostic, type Site, type ToolRow, type ToolStatus } from '@/lib/timeline';
import type { FileChange } from '@/lib/types';
import { cn } from '@/lib/utils';

const TOOL_TEXT: Record<ToolStatus, string> = { running: '进行中', completed: '完成', failed: '失败', incomplete: '未完成' };
// What a tool call does, as a picture beside its title. Any other kind reads as a command.
const TOOL_ICONS: Record<string, LucideIcon> = { read: BookOpen, edit: Pencil, run: Terminal, search: Search };
const LEVEL_TEXT: Record<string, string> = { warning: '告警', recovering: '重试', fatal: '终止' };
const OP_TEXT: Record<string, string> = { add: '新增', update: '修改', delete: '删除' };
const OUT = cn(PRE, 'my-1 max-h-80 overflow-auto p-2.5');
const LABEL = 'mt-2 text-xs text-faint';
// A line that folds: the title one line long, cut at the end; the state never shrinks.
const LINE = 'min-h-7 gap-2 text-foreground';

function Status({ status }: { status: ToolStatus }) {
  return (
    <>
      {status === 'running' ? <Dot tone="running" /> : null}
      <span className={cn('flex-none text-xs whitespace-nowrap', status === 'failed' ? 'font-medium text-destructive' : 'text-faint')}>{TOOL_TEXT[status]}</span>
    </>
  );
}

function ToolDetail({ row }: { row: ToolRow }) {
  const { call, output, reason, exitCode } = row;
  return (
    <div className="mb-2 ml-[22px] min-w-0">
      <Note className="text-xs">{`工具：${call.name}${exitCode === undefined ? '' : ` · 退出码 ${exitCode}`}`}</Note>
      {call.input ? <><p className={LABEL}>输入</p><pre className={OUT}>{call.input}</pre></> : null}
      {reason ? <><p className={LABEL}>原因</p><pre className={cn(OUT, 'text-destructive')}>{reason}</pre></> : null}
      {output ? (
        <>
          <p className={LABEL}>输出</p>
          <pre className={OUT}>{output.text}</pre>
          {output.executorTruncated ? <Note className="text-xs">这段输出执行器自己就截断过。</Note> : null}
          {output.omittedBytes ? <Note className="text-xs">{`输出太长，tycho 只留了开头和结尾，中间省略 ${output.omittedBytes} 字节；完整的在原始日志里。`}</Note> : null}
        </>
      ) : null}
      {!call.input && !output && !reason ? <Note className="text-xs">执行器没有报告这次调用的输入和输出。</Note> : null}
    </div>
  );
}

export function ToolLine({ row, id }: { row: ToolRow; id: string }) {
  const Icon = TOOL_ICONS[row.call.category] ?? Terminal;
  const running = row.status === 'running';
  // Why it failed: the executor's reason, else its exit code, else the first line it printed.
  const printed = row.output?.text.split('\n').find((line) => line.trim());
  const why = row.status === 'failed' ? row.reason ?? (row.exitCode === undefined ? printed : `退出码 ${row.exitCode}`) : undefined;
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
  const current = tools.findLast((row) => row.status === 'running');
  const status = groupStatus(tools);
  const running = status === 'running';
  const Icon = tools.every((row) => row.call.category === 'read') ? BookOpen : Search;
  const summary = groupSummary(tools);
  const stepHint = running
    ? `正在执行 · 共 ${tools.length} 个步骤`
    : `已执行 ${tools.length} 个步骤`;
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
              {current ? <span className="text-muted-foreground">{` · 正在执行 · ${current.call.title}`}</span> : null}
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
  return (
    <li className="min-w-0">
      <span className="text-xs">{`${LEVEL_TEXT[item.level]}${item.count > 1 ? ` · 出现 ${item.count} 次` : ''}`}</span>
      <pre className={OUT}>{item.message}</pre>
    </li>
  );
}

// Warnings and retries fold into one gray line; the words are a click away.
export function Diagnostics({ list, id }: { list: Diagnostic[]; id: string }) {
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
  if (!changes.length) return null;
  return (
    <section aria-label="文件变化" className="min-w-0 text-sm">
      <p className="mb-1.5 text-xs text-muted-foreground">{`文件变化（${changes.length}）· 按执行器的报告列出，命令里改的文件不一定在这里`}</p>
      <ul className="flex flex-col gap-0.5">
        {changes.map((change) => (
          <li key={change.path} data-change={change.op ?? 'write'} className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className={cn('w-8 flex-none text-xs whitespace-nowrap', change.op === 'add' ? 'text-success-foreground' : change.op === 'delete' ? 'text-destructive' : 'text-muted-foreground')}>{OP_TEXT[change.op ?? ''] ?? '写入'}</span>
              <span className="min-w-0 truncate font-mono text-xs" title={change.path}>{change.path}</span>
            </div>
            {change.patch ? (
              <Details id={`patch:${id}:${change.path}`} className="ml-10" summaryClassName="min-h-7 text-xs" title="查看改动">
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
export function SiteRows({ site, id }: { site: Site; id: string }) {
  return (
    <>
      <Diagnostics list={site.diagnostics} id={id} />
      {site.rows.map((row, index) => {
        const key = `${id}:${index}`;
        switch (row.kind) {
          case 'text':
            return <Markdown key={key} text={row.text} className="py-1" />;
          case 'thinking':
            return (
              <Details key={key} id={`thinking:${key}`} summaryClassName="min-h-7 text-xs" title={row.live ? '思考中…' : '思考记录'}>
                <p className="mb-2 ml-[22px] text-sm text-muted-foreground wrap-anywhere whitespace-pre-wrap">{row.text}</p>
              </Details>
            );
          case 'tool':
            return <ToolLine key={key} row={row} id={key} />;
          case 'group':
            return <ToolGroup key={key} tools={row.tools} id={key} />;
          case 'fatal':
            return <Problem key={key}>{row.count > 1 ? `${row.message}（出现 ${row.count} 次）` : row.message}</Problem>;
          case 'truncated':
            return <Note key={key}>{`更早的 ${row.dropped} 条事件已丢弃，只保留最近 5000 条`}</Note>;
          case 'interrupted':
            return <Note key={key}>执行已中断</Note>;
          default:
            return null;
        }
      })}
      {site.retrying ? (
        <Note>{site.retrying.attempt === undefined ? '受阻重试中' : `受阻重试中（第 ${site.retrying.attempt}/${site.retrying.maxRetries ?? '?'} 次）`}</Note>
      ) : null}
    </>
  );
}

// What an ended round's folded process says on its one line.
export function processTitle(site: Site): string {
  if (!site.calls) return '过程记录';
  return `过程记录 · ${site.calls} 次工具调用${site.failures ? `，${site.failures} 次失败` : ''}`;
}
