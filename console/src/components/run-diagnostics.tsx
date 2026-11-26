// Offline self-explaining Run diagnostics drawer: lazy-fetches one Run's diagnostics
// bundle, renders its key findings honestly in Chinese, and offers one-click copy/download.
import { ArrowDownToLine, Check, Copy, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DiagnosticErrorSource, RunDiagnosticsBundle } from '@shared/run-diagnostics.ts';
import { Callout, Details, Fact, Facts, Mono, Note, PRE, Problem, Time } from '@/components/bits';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/dialog';
import { api, messageOf } from '@/lib/api';

const HEADING = 'mt-5 mb-2 flex items-center justify-between gap-2 text-sm font-semibold first:mt-0';

const ERROR_SOURCE_LABELS: Record<DiagnosticErrorSource, string> = {
  diagnostic: '诊断事件',
  run_error: '轮次错误',
  stderr: 'stderr',
};

const ERROR_SOURCE_TONES: Record<DiagnosticErrorSource, BadgeTone> = {
  diagnostic: 'failed',
  run_error: 'failed',
  stderr: 'waiting',
};

const CATEGORY_LABELS: Record<string, string> = {
  read: '读取',
  edit: '编辑',
  run: '运行',
  search: '搜索',
  other: '其他',
};

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '未知';
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round((seconds % 60) * 10) / 10;
  return `${minutes} 分 ${rest} 秒`;
}

function downloadBundle(runId: string, bundle: RunDiagnosticsBundle): void {
  const json = `${JSON.stringify(bundle, null, 2)}\n`;
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tycho-run-${runId}-diagnostics.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function RunDiagnosticsButton({ runId, round }: { runId: string; round: number }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [bundle, setBundle] = useState<RunDiagnosticsBundle | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'refused'>('idle');
  const active = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const copyTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    epoch.current += 1;
    active.current?.abort();
    window.clearTimeout(copyTimer.current);
  }, []);

  async function load(targetRunId: string): Promise<void> {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const generation = ++epoch.current;
    setLoading(true);
    setFailure(null);
    setCopyState('idle');
    try {
      const data = await api<RunDiagnosticsBundle>(
        `/api/runs/${encodeURIComponent(targetRunId)}/diagnostics`,
        { signal: controller.signal },
      );
      if (generation === epoch.current) setBundle(data);
    } catch (error) {
      if (generation === epoch.current && !controller.signal.aborted) {
        setFailure(messageOf(error));
      }
    } finally {
      if (generation === epoch.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setBundle(null);
    void load(runId);
  }, [open, runId]);

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (!next) {
      epoch.current += 1;
      active.current?.abort();
      setLoading(false);
    }
  }

  async function handleCopy(): Promise<void> {
    if (!bundle) return;
    window.clearTimeout(copyTimer.current);
    try {
      await navigator.clipboard.writeText(`${JSON.stringify(bundle, null, 2)}\n`);
      setCopyState('copied');
      copyTimer.current = window.setTimeout(() => setCopyState('idle'), 1500);
    } catch {
      setCopyState('refused');
    }
  }

  const mismatch = Boolean(
    bundle?.models.tier_model
    && bundle.models.reported_models.length > 0
    && !bundle.models.reported_models.includes(bundle.models.tier_model),
  );

  const hasStderr = Boolean(
    bundle && (bundle.stderr.head.length > 0 || bundle.stderr.tail.length > 0),
  );

  const incomplete = Boolean(
    bundle && (
      !bundle.coverage.events_loaded
      || bundle.coverage.dropped_before_index > 0
      || bundle.coverage.incomplete_reason !== null
    ),
  );

  const CopyIcon = copyState === 'copied' ? Check : copyState === 'refused' ? X : Copy;
  const copyLabel = copyState === 'copied' ? '已复制' : copyState === 'refused' ? '复制不了' : '复制 JSON';

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        <Button size="sm" className="mt-2">诊断包</Button>
      </SheetTrigger>
      <SheetContent
        title={`第 ${round} 轮诊断包`}
        description={<Mono>{runId}</Mono>}
        footer={bundle ? (
          <>
            <Button size="sm" onClick={() => void handleCopy()}>
              <CopyIcon className="size-3.5" aria-hidden="true" />
              {copyLabel}
            </Button>
            <Button size="sm" variant="primary" onClick={() => downloadBundle(runId, bundle)}>
              <ArrowDownToLine className="size-3.5" aria-hidden="true" />
              下载诊断包
            </Button>
          </>
        ) : undefined}
      >
        {loading ? (
          <Note>正在读取诊断包…</Note>
        ) : failure ? (
          <div className="grid gap-3">
            <Problem>{failure}</Problem>
            <div>
              <Button size="sm" onClick={() => void load(runId)}>重试</Button>
            </div>
          </div>
        ) : bundle ? (
          <div>
            <section>
              <h3 className={HEADING}>
                <span>首错</span>
                {bundle.first_error ? (
                  <Badge tone={ERROR_SOURCE_TONES[bundle.first_error.source]}>
                    {ERROR_SOURCE_LABELS[bundle.first_error.source]}
                  </Badge>
                ) : (
                  <Badge tone="success">无错误</Badge>
                )}
              </h3>
              {bundle.first_error ? (
                <Callout tone="failed">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {bundle.first_error.event_index !== undefined ? (
                      <Mono>{`事件 #${bundle.first_error.event_index}`}</Mono>
                    ) : null}
                    {bundle.first_error.timestamp ? (
                      <Time at={bundle.first_error.timestamp} />
                    ) : null}
                  </div>
                  <p className="font-mono text-xs whitespace-pre-wrap wrap-anywhere">
                    {bundle.first_error.message}
                  </p>
                </Callout>
              ) : (
                <Note>无错误记录</Note>
              )}
            </section>

            <section>
              <h3 className={HEADING}>
                <span>工具调用</span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="plain">{`共 ${bundle.tools.total} 次`}</Badge>
                  {bundle.tools.error_count > 0 ? (
                    <Badge tone="failed">{`失败 ${bundle.tools.error_count}`}</Badge>
                  ) : null}
                  {bundle.tools.unfinished_count > 0 ? (
                    <Badge tone="waiting">{`未结束 ${bundle.tools.unfinished_count}`}</Badge>
                  ) : null}
                </span>
              </h3>
              {Object.keys(bundle.tools.by_category).length > 0 ? (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {Object.entries(bundle.tools.by_category).map(([category, count]) => (
                    <Badge key={category} tone="ended">
                      {`${CATEGORY_LABELS[category] ?? category} ${count}`}
                    </Badge>
                  ))}
                </div>
              ) : (
                <Note className="text-xs">未记录到工具调用。</Note>
              )}

              {bundle.tools.unfinished_tools.length > 0 ? (
                <div className="mt-2.5">
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                    {`未结束工具（${bundle.tools.unfinished_count}）`}
                  </p>
                  <ul className="grid gap-1.5">
                    {bundle.tools.unfinished_tools.map((tool) => (
                      <li
                        key={`${tool.id}:${tool.event_index}`}
                        className="rounded-md border border-waiting-border bg-waiting-soft px-2.5 py-2 text-xs"
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Mono className="font-semibold">{tool.name}</Mono>
                          {tool.category ? (
                            <Badge tone="plain">{CATEGORY_LABELS[tool.category] ?? tool.category}</Badge>
                          ) : null}
                          <span className="ml-auto text-muted-foreground">
                            <Mono>{`#${tool.event_index}`}</Mono>
                          </span>
                        </div>
                        {tool.title ? (
                          <p className="mt-1 text-muted-foreground wrap-anywhere">{tool.title}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {bundle.tools.failed_tools.length > 0 ? (
                <div className="mt-2.5">
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                    {`失败工具（${bundle.tools.error_count}${bundle.tools.error_count > bundle.tools.failed_tools.length ? `，展示前 ${bundle.tools.failed_tools.length} 项` : ''}）`}
                  </p>
                  <ul className="grid gap-1.5">
                    {bundle.tools.failed_tools.map((tool, index) => (
                      <li
                        key={`${tool.id ?? tool.name}:${tool.event_index}:${index}`}
                        className="rounded-md border border-failed-border bg-failed-soft px-2.5 py-2 text-xs"
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Mono className="font-semibold">{tool.name}</Mono>
                          {tool.exit_code !== undefined ? (
                            <Badge tone="failed">{`退出码 ${tool.exit_code}`}</Badge>
                          ) : null}
                          <span className="ml-auto text-muted-foreground">
                            <Mono>{`#${tool.event_index}`}</Mono>
                          </span>
                        </div>
                        {tool.title ? (
                          <p className="mt-1 text-muted-foreground wrap-anywhere">{tool.title}</p>
                        ) : null}
                        {tool.reason ? (
                          <p className="mt-1 font-mono whitespace-pre-wrap wrap-anywhere">{tool.reason}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>

            <section>
              <h3 className={HEADING}>
                <span>实际模型</span>
                {mismatch ? <Badge tone="waiting">与档位模型不一致</Badge> : null}
              </h3>
              <Facts>
                <Fact label="执行器"><Mono>{bundle.run.executor}</Mono></Fact>
                <Fact label="档位模型">
                  {bundle.models.tier_model ? <Mono>{bundle.models.tier_model}</Mono> : <Note className="text-xs">未声明</Note>}
                </Fact>
                <Fact label="实际回报模型">
                  {bundle.models.reported_models.length > 0 ? (
                    <span className="flex flex-wrap gap-1">
                      {bundle.models.reported_models.map((model) => (
                        <Badge key={model} tone="plain"><Mono>{model}</Mono></Badge>
                      ))}
                    </span>
                  ) : (
                    <Note className="text-xs">执行器未回报</Note>
                  )}
                </Fact>
                <Fact label="耗时">{formatDuration(bundle.run.duration_ms)}</Fact>
              </Facts>
            </section>

            <section>
              <h3 className={HEADING}>
                <span>覆盖诚实声明</span>
                <Badge tone={incomplete ? 'waiting' : 'success'}>
                  {incomplete ? '存在缺口' : '事件完整'}
                </Badge>
              </h3>
              <Callout tone={incomplete ? 'waiting' : 'plain'}>
                <Facts className="text-xs">
                  <Fact label="事件加载">{bundle.coverage.events_loaded ? '已读取' : '未读取'}</Fact>
                  <Fact label="已纳入事件">{`${bundle.coverage.events_count} 条`}</Fact>
                  <Fact label="前置丢弃">{`${bundle.coverage.dropped_before_index} 条`}</Fact>
                  <Fact label="stderr 片段">{bundle.coverage.stderr_loaded ? '已附带首尾片段' : '无内容或未读取'}</Fact>
                  {bundle.coverage.incomplete_reason ? (
                    <Fact label="缺口原因">{bundle.coverage.incomplete_reason}</Fact>
                  ) : null}
                </Facts>
              </Callout>
            </section>

            {hasStderr ? (
              <section className="mt-5 border-t border-border pt-3">
                <Details id={`diag-stderr:${runId}`} title="原始 stderr 首尾折叠预览">
                  <div className="mt-2 grid gap-3">
                    {bundle.stderr.head.length > 0 ? (
                      <div>
                        <p className="mb-1 text-xs text-muted-foreground">
                          {`开头（前 ${bundle.stderr.head.length} 行）`}
                        </p>
                        <pre className={PRE}>{bundle.stderr.head.join('\n')}</pre>
                      </div>
                    ) : null}
                    {bundle.stderr.tail.length > 0 ? (
                      <div>
                        <p className="mb-1 text-xs text-muted-foreground">
                          {`结尾（后 ${bundle.stderr.tail.length} 行）`}
                        </p>
                        <pre className={PRE}>{bundle.stderr.tail.join('\n')}</pre>
                      </div>
                    ) : null}
                  </div>
                </Details>
              </section>
            ) : null}

            <Note className="mt-5 border-t border-border pt-3 text-xs">
              生成于 <Time at={bundle.generated_at} />
              {bundle.platform_version ? ` · Tycho ${bundle.platform_version}` : ''}
              {' · 敏感凭据已自动脱敏，可离线分享排查。'}
            </Note>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
