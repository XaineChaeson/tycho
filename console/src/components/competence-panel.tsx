// Login x Tier competence & cost evidence panel for the Usage page.
// Fetches /api/usage/competence for the active time window and renders deterministic
// routing advice grounded in actual work rounds, review verdicts, escalations and cost.
import { useEffect, useState } from 'react';
import {
  COMPETENCE_ADVICE_LABELS,
  COMPETENCE_MIN_SAMPLE_SIZE,
  type CompetenceAdviceKind,
  type CompetenceReport,
  type CompetenceRow,
} from '@shared/competence.ts';
import { tierLabel } from '@shared/tiers.ts';
import { Empty, Mono, Note, Problem, SectionTitle } from '@/components/bits';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { api, messageOf } from '@/lib/api';
import { formatDuration, formatTokens, formatUsd, rangeOf, type Range } from '@/lib/usage';
import { cn } from '@/lib/utils';

const ADVICE_TONE: Record<CompetenceAdviceKind, BadgeTone> = {
  promote: 'success',
  steady: 'plain',
  caution: 'waiting',
  insufficient: 'ended',
};

function competencePath(days: Range): string {
  const { from, to } = rangeOf(days);
  return `/api/usage/competence?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function formatAvgDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return ms === 0 ? '0 秒' : `${seconds} 秒`;
  }
  return formatDuration(ms);
}

function displayTier(tier: string): string {
  return tier === 'unspecified' ? '未指定' : tierLabel(tier);
}

function formatRowCost(row: CompetenceRow): { text: string; faint: boolean } {
  if (row.total_tokens === 0 && row.list_cost_usd === 0 && row.unpriced_rounds === row.rounds) {
    return { text: '无报价', faint: true };
  }
  if (row.list_cost_usd === 0 && row.unpriced_rounds > 0) {
    return { text: '无报价', faint: true };
  }
  if (row.list_cost_usd === 0) {
    return { text: '—', faint: true };
  }
  return {
    text: `${formatUsd(row.list_cost_usd)}${row.unpriced_rounds > 0 ? '*' : ''}`,
    faint: false,
  };
}

export function CompetencePanel({ days }: { days: Range }) {
  const [loaded, setLoaded] = useState<{ days: Range; report: CompetenceReport } | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    api<CompetenceReport>(competencePath(days), { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setLoaded({ days, report: data });
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(messageOf(err));
        setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [days]);

  // Never show a previous window's report as if it belonged to the newly selected window.
  const report = error === null && loaded?.days === days ? loaded.report : null;
  const minSample = report?.min_sample_size ?? COMPETENCE_MIN_SAMPLE_SIZE;
  const hasPartialPricing = report?.rows.some((row) => row.unpriced_rounds > 0 && row.list_cost_usd > 0) ?? false;

  return (
    <section aria-labelledby="competence-title" className="mt-9">
      <SectionTitle id="competence-title" count={report ? report.rows.length : undefined}>
        胜任力与成本证据
      </SectionTitle>
      <Note className="mb-3 text-xs">
        {`基于所选时间窗内的实际工作轮次、评审结论与标价成本（不计审阅任务本身）；已评审样本 < ${minSample} 轮仅作观察。`}
      </Note>

      {error ? <Problem role="alert" className="mb-3">{error}</Problem> : null}

      {loading && report === null ? (
        <div className="rounded-xl bg-raised px-4 py-6 text-sm text-muted-foreground shadow-card" role="status" aria-live="polite">
          正在统计各登录与档位的胜任力表现…
        </div>
      ) : null}

      {!loading && error === null && report !== null && report.rows.length === 0 ? (
        <Empty title="这段时间没有工作轮次">
          选定时间窗内暂无已结束的非审阅工作轮次；产生执行与评审记录后，会在此展示各登录与档位的胜任力与成本证据。
        </Empty>
      ) : null}

      {report !== null && report.rows.length > 0 ? (
        <div className={cn('grid grid-cols-[minmax(0,1fr)] gap-4', loading && 'opacity-70 transition-opacity')}>
          <SummaryTiles summary={report.summary} />
          <CompetenceTable rows={report.rows} />
          {hasPartialPricing ? (
            <Note className="-mt-1 text-xs">
              * 这一行有一部分轮次执行器没有报价（Codex、dsh、Gemini 或未上报用量），金额只算报了的那些。
            </Note>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function SummaryTiles({ summary }: { summary: CompetenceReport['summary'] }) {
  const tiles = [
    { label: '工作轮次', value: `${summary.total_rounds} 轮`, detail: '已结束的非审阅执行轮次' },
    { label: '已评审', value: `${summary.reviewed_rounds} 轮`, detail: '有通过结论或打回返工记录' },
    { label: '触发升档', value: `${summary.escalated_rounds} 次`, detail: '审阅打回并自动升至更高档位' },
    {
      label: '标价折算',
      value: summary.total_list_cost_usd > 0 ? formatUsd(summary.total_list_cost_usd) : '无数据',
      detail: '仅含执行器上报 API 标价的轮次',
    },
  ];
  return (
    <dl className="grid grid-cols-2 overflow-hidden rounded-xl bg-raised shadow-card wide:grid-cols-4">
      {tiles.map((tile, at) => (
        <div
          key={tile.label}
          className={cn(
            'min-w-0 px-4 py-3',
            at % 2 === 1 && 'border-l border-border',
            at >= 2 && 'border-t border-border wide:border-t-0',
            at === 2 && 'wide:border-l',
          )}
        >
          <dt className="text-xs text-muted-foreground">{tile.label}</dt>
          <dd className="mt-1 text-xl font-semibold tracking-[-0.01em] tabular-nums">{tile.value}</dd>
          <dd className="mt-0.5 text-xs text-faint wrap-anywhere">{tile.detail}</dd>
        </div>
      ))}
    </dl>
  );
}

function CompetenceTable({ rows }: { rows: readonly CompetenceRow[] }) {
  const head = 'px-3 py-2 text-right text-xs font-medium text-muted-foreground whitespace-nowrap';
  const cell = 'px-3 py-2.5 text-right align-top tabular-nums whitespace-nowrap';
  return (
    <div className="overflow-x-auto rounded-xl bg-raised shadow-card">
      <table className="w-full min-w-[820px] border-collapse text-sm">
        <caption className="sr-only">各登录与档位的胜任力与成本证据</caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={cn(head, 'text-left')}>登录 × 执行器 × 档位</th>
            <th scope="col" className={head}>轮次（完成/失败）</th>
            <th scope="col" className={head}>一次通过率</th>
            <th scope="col" className={head}>打回 / 升档</th>
            <th scope="col" className={head}>平均耗时</th>
            <th scope="col" className={head} title="Token 总计与执行器按 API 标价折算；* 表示部分轮次无报价">Token / 标价</th>
            <th scope="col" className={cn(head, 'text-left')}>建议与依据</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => {
            const cost = formatRowCost(row);
            const rowKey = `${row.login_id ?? 'default'}:${row.executor}:${row.tier}`;
            return (
              <tr key={rowKey} className="hover:bg-hover/60">
                <th scope="row" className="max-w-[16rem] px-3 py-2.5 text-left align-top font-normal">
                  <div className="font-medium wrap-anywhere">{row.login_name}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                    <Mono className="text-muted-foreground">{row.executor}</Mono>
                    <span aria-hidden="true">·</span>
                    <span>{displayTier(row.tier)}</span>
                  </div>
                </th>
                <td className={cell}>
                  <div className="font-medium">{`${row.rounds} 轮`}</div>
                  <div className="mt-0.5 text-xs text-faint">
                    {`完成 ${row.completed_rounds} / 失败 ${row.failed_rounds}`}
                    {row.failed_rounds > 0 ? ` (${formatPercent(row.failure_rate)})` : ''}
                  </div>
                </td>
                <td className={cell}>
                  <div className={cn('font-medium', row.first_pass_rate === null && 'text-faint')}>
                    {row.first_pass_rate === null ? '—' : formatPercent(row.first_pass_rate)}
                  </div>
                  <div className="mt-0.5 text-xs text-faint">
                    {row.reviewed_rounds > 0 ? `${row.first_pass_count}/${row.reviewed_rounds} 已评` : '未评审'}
                  </div>
                </td>
                <td className={cell}>
                  <div className="font-medium">{`${row.rework_count} / ${row.escalated_count}`}</div>
                  <div className="mt-0.5 text-xs text-faint">打回 / 升档</div>
                </td>
                <td className={cn(cell, row.avg_duration_ms === null && 'text-faint')}>
                  {formatAvgDuration(row.avg_duration_ms)}
                </td>
                <td className={cell}>
                  <div className="font-medium">{row.total_tokens > 0 ? formatTokens(row.total_tokens) : '—'}</div>
                  <div className={cn('mt-0.5 text-xs', cost.faint ? 'text-faint' : 'text-muted-foreground')}>
                    {cost.text}
                  </div>
                </td>
                <td className="min-w-[14rem] max-w-[22rem] px-3 py-2.5 text-left align-top">
                  <Badge tone={ADVICE_TONE[row.advice.kind]}>{COMPETENCE_ADVICE_LABELS[row.advice.kind]}</Badge>
                  <p className="mt-1 text-xs text-muted-foreground wrap-anywhere">{row.advice.reason}</p>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
