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
import { t as translate } from '@shared/i18n.ts';
import { tierDisplayLabel } from '@shared/labels.ts';
import { Empty, Mono, Note, Problem, SectionTitle } from '@/components/bits';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { api, messageOf } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
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
    return translate('acct.comp.sec', { seconds: ms === 0 ? 0 : seconds });
  }
  return formatDuration(ms);
}

function displayTier(tier: string, locale: string): string {
  return tier === 'unspecified' ? translate('acct.comp.unspecifiedTier') : tierDisplayLabel(tier, locale);
}

function formatRowCost(row: CompetenceRow): { text: string; faint: boolean } {
  if (row.total_tokens === 0 && row.list_cost_usd === 0 && row.unpriced_rounds === row.rounds) {
    return { text: translate('acct.usage.unpriced'), faint: true };
  }
  if (row.list_cost_usd === 0 && row.unpriced_rounds > 0) {
    return { text: translate('acct.usage.unpriced'), faint: true };
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
  const { t } = useI18n();
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
        {t('acct.comp.title')}
      </SectionTitle>
      <Note className="mb-3 text-xs">
        {t('acct.comp.note', { minSample })}
      </Note>

      {error ? <Problem role="alert" className="mb-3">{error}</Problem> : null}

      {loading && report === null ? (
        <div className="rounded-xl bg-raised px-4 py-6 text-sm text-muted-foreground shadow-card" role="status" aria-live="polite">
          {t('acct.comp.loading')}
        </div>
      ) : null}

      {!loading && error === null && report !== null && report.rows.length === 0 ? (
        <Empty title={t('acct.comp.emptyTitle')}>
          {t('acct.comp.emptyBody')}
        </Empty>
      ) : null}

      {report !== null && report.rows.length > 0 ? (
        <div className={cn('grid grid-cols-[minmax(0,1fr)] gap-4', loading && 'opacity-70 transition-opacity')}>
          <SummaryTiles summary={report.summary} />
          <CompetenceTable rows={report.rows} />
          {hasPartialPricing ? (
            <Note className="-mt-1 text-xs">
              {t('acct.comp.partialPriceFootnote')}
            </Note>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function SummaryTiles({ summary }: { summary: CompetenceReport['summary'] }) {
  const { t } = useI18n();
  const tiles = [
    { label: t('acct.comp.tileRounds'), value: t('acct.telemetry.runsCount', { count: summary.total_rounds }), detail: t('acct.comp.tileRoundsDetail') },
    { label: t('acct.comp.tileReviewed'), value: t('acct.telemetry.runsCount', { count: summary.reviewed_rounds }), detail: t('acct.comp.tileReviewedDetail') },
    { label: t('acct.comp.tileEscalated'), value: t('acct.comp.timesCount', { count: summary.escalated_rounds }), detail: t('acct.comp.tileEscalatedDetail') },
    {
      label: t('acct.usage.metricCost'),
      value: summary.total_list_cost_usd > 0 ? formatUsd(summary.total_list_cost_usd) : t('acct.usage.noData'),
      detail: t('acct.comp.tileCostDetail'),
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
  const { t, locale } = useI18n();
  const head = 'px-3 py-2 text-right text-xs font-medium text-muted-foreground whitespace-nowrap';
  const cell = 'px-3 py-2.5 text-right align-top tabular-nums whitespace-nowrap';
  return (
    <div className="overflow-x-auto rounded-xl bg-raised shadow-card">
      <table className="w-full min-w-[820px] border-collapse text-sm">
        <caption className="sr-only">{t('acct.comp.tableCaption')}</caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={cn(head, 'text-left')}>{t('acct.comp.colIdentity')}</th>
            <th scope="col" className={head}>{t('acct.comp.colRounds')}</th>
            <th scope="col" className={head}>{t('acct.comp.colFirstPass')}</th>
            <th scope="col" className={head}>{t('acct.comp.colReworkEscalate')}</th>
            <th scope="col" className={head}>{t('acct.comp.colAvgDuration')}</th>
            <th scope="col" className={head} title={t('acct.comp.colTokensCostHint')}>{t('acct.comp.colTokensCost')}</th>
            <th scope="col" className={cn(head, 'text-left')}>{t('acct.comp.colAdvice')}</th>
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
                    <span>{displayTier(row.tier, locale)}</span>
                  </div>
                </th>
                <td className={cell}>
                  <div className="font-medium">{t('acct.telemetry.runsCount', { count: row.rounds })}</div>
                  <div className="mt-0.5 text-xs text-faint">
                    {t('acct.comp.doneFailed', { done: row.completed_rounds, failed: row.failed_rounds })}
                    {row.failed_rounds > 0 ? ` (${formatPercent(row.failure_rate)})` : ''}
                  </div>
                </td>
                <td className={cell}>
                  <div className={cn('font-medium', row.first_pass_rate === null && 'text-faint')}>
                    {row.first_pass_rate === null ? '—' : formatPercent(row.first_pass_rate)}
                  </div>
                  <div className="mt-0.5 text-xs text-faint">
                    {row.reviewed_rounds > 0 ? t('acct.comp.reviewedRatio', { pass: row.first_pass_count, total: row.reviewed_rounds }) : t('acct.comp.unreviewed')}
                  </div>
                </td>
                <td className={cell}>
                  <div className="font-medium">{`${row.rework_count} / ${row.escalated_count}`}</div>
                  <div className="mt-0.5 text-xs text-faint">{t('acct.comp.colReworkEscalate')}</div>
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
