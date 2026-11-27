// 用量 (docs/design/usage.md §4): how much quota each login has left, and what the rounds, the
// Router and the quota reads used, in one place with one way to refresh. The quota figures are
// the ones the accounts page and the pick read; asking for them again happens here. The use is
// the executors' own report, summed: what an executor did not report is said, never guessed.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { NEEDS_LOGIN_TEXT, loginFull, quotaUsedUp, usageReadLine } from '@shared/labels.ts';
import { loginName } from '@shared/logins.ts';
import { formatTime } from '@shared/time.ts';
import { latestQuota, type LoginTelemetry, type QuotaLogin, type QuotaPage, type TaskUsage, type UsageReport } from '@shared/usage.ts';
import { formatCompactTokens, formatProviderName } from '@/components/account-quota-popover';
import { Details, Empty, Mono, Note, Problem, Rows, SectionTitle } from '@/components/bits';
import { Page, PageLead } from '@/components/page';
import { CompetencePanel } from '@/components/competence-panel';
import { QuotaWindow } from '@/components/quota';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { api, messageOf, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { PAGE } from '@/lib/queries';
import {
  DIMENSIONS, DRAWN, RANGES, axisLabel, dayLabel, daysOf, formatDuration, formatTokens, formatUsd, metricOf, niceMax, rangeOf, summarize, tokensOf, usagePath,
  type Day, type Dimension, type Group, type Metric, type Range,
} from '@/lib/usage';
import { cn } from '@/lib/utils';

const QUOTA_KEY = [PAGE, 'quota'];
const quotaQuery = {
  queryKey: QUOTA_KEY,
  queryFn: () => api<QuotaPage>('/api/quota'),
  refetchInterval: (query: { state: { data?: QuotaPage } }) => query.state.data?.logins.some((login) => login.read.reading) ? 1500 : false,
};

const QUOTA_TEXT = {
  reading: '正在读取…',
  refreshing: '正在刷新',
  unread: '还没读过，点“刷新”读一次',
};

// The range is worked out when it is read, so a page left open over midnight moves with the day.
const usageQuery = (days: Range) => ({
  queryKey: [PAGE, 'usage', days],
  queryFn: async () => {
    const range = rangeOf(days);
    return { range, report: await api<UsageReport>(usagePath(range)) };
  },
});

const SERIES = ['bg-series-1', 'bg-series-2', 'bg-series-3', 'bg-series-4', 'bg-series-5'] as const;
const OTHER = 'bg-ended';

const METRICS: readonly { value: Metric; label: string; title: string }[] = [
  { value: 'tokens', label: 'Token', title: '四类 token 相加：输入、输出、缓存读、缓存写' },
  { value: 'cost', label: '标价折算', title: '执行器按 API 标价折算的金额，只有 Claude 报；订阅账号不按它付钱' },
];

const showMetric = (value: number, metric: Metric): string => (metric === 'tokens' ? formatTokens(value) : formatUsd(value));

export function UsagePage() {
  const { t, bi } = useI18n();
  const client = useQueryClient();
  const quota = useQuery(quotaQuery);
  const [days, setDays] = useState<Range>(7);
  const [dimension, setDimension] = useState<Dimension>('project');
  const [metric, setMetric] = useState<Metric>('tokens');
  const usage = useQuery(usageQuery(days));
  const [failure, setFailure] = useState<string | null>(null);

  // Asking again: one login, or all of them. What a read used is use too, so the report is read again.
  const refresh = useMutation({
    mutationFn: (body: { login_id: string } | { all: true } | Record<string, never>) => post<QuotaPage>('/api/quota/refresh', body),
    onMutate: () => setFailure(null),
    onSuccess: (answer) => {
      client.setQueryData(QUOTA_KEY, answer);
      void client.invalidateQueries({ queryKey: [PAGE, 'usage'] });
    },
    onError: (error) => setFailure(messageOf(error)),
  });

  // Opening the page asks for the figures that are older than the setting allows, once.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    refresh.mutate({});
  }, [refresh]);

  const readable = quota.data?.logins.some((login) => login.read.available) ?? false;
  const reading = quota.data?.logins.some((login) => login.read.reading) ?? false;
  const refreshingAll = refresh.isPending && refresh.variables !== undefined && 'all' in refresh.variables;

  return (
    <Page
      title={t('usage.title')}
      width="wide"
      loading={quota.isPending && usage.isPending}
      failure={quota.error ? messageOf(quota.error) : undefined}
      actions={(
        <Button size="sm" disabled={!readable || refresh.isPending || reading} title={readable ? bi('刷新所有可读取的登录，会用掉一点点额度', 'Refresh all readable logins (uses minimal quota)') : bi('没有可以读取额度的登录', 'No logins with readable quota')} onClick={() => refresh.mutate({ all: true })}>
          <RefreshCw className={cn(refreshingAll || reading ? 'animate-spin motion-reduce:animate-none' : undefined)} />
          {refreshingAll || reading ? bi(QUOTA_TEXT.refreshing, 'Refreshing') : bi('刷新额度', 'Refresh quota')}
        </Button>
      )}
    >
      <PageLead>{bi('各个登录还剩多少额度，以及每一轮执行、负责人每个回合用掉了多少。', 'Remaining quota per login and token spend across worker rounds and router turns.')}</PageLead>
      {failure ? <Problem role="alert" className="mb-3">{failure}</Problem> : null}

      <section aria-labelledby="quota-title" className="mb-9">
        <SectionTitle id="quota-title">{bi('剩余额度', 'Remaining quota')}</SectionTitle>
        {quota.data ? <QuotaList page={quota.data} pending={refresh.isPending ? refresh.variables : undefined} onRefresh={(id) => refresh.mutate({ login_id: id })} /> : null}
      </section>

      <section aria-labelledby="spend-title">
        <SectionTitle
          id="spend-title"
          action={<Segmented label={bi('时间范围', 'Time range')} value={String(days)} options={RANGES.map((value) => ({ value: String(value), label: bi(`${value} 天`, `${value}d`) }))} onChange={(value) => setDays(Number(value) as Range)} />}
        >
          {bi('消耗', 'Spend')}
        </SectionTitle>
        {usage.error ? <Problem role="alert">{messageOf(usage.error)}</Problem> : null}
        {usage.data ? (
          <Spend report={usage.data.report} days={usage.data.range.days} dimension={dimension} metric={metric} onDimension={setDimension} onMetric={setMetric} />
        ) : null}
      </section>

      <CompetencePanel days={days} />
    </Page>
  );
}

// ——— Quota ————————————————————————————————————————————————————————————————————————————————

function mergeLogicalTelemetry(rows: readonly QuotaLogin[]): LoginTelemetry | null {
  let five_hour_tokens = 0;
  let five_hour_runs = 0;
  let day_tokens = 0;
  let day_runs = 0;
  let week_tokens = 0;
  let week_runs = 0;
  let total_tokens = 0;
  let total_runs = 0;
  let last_at: string | null = null;
  let any = false;
  for (const row of rows) {
    if (!row.telemetry) continue;
    any = true;
    five_hour_tokens += row.telemetry.five_hour_tokens;
    five_hour_runs += row.telemetry.five_hour_runs;
    day_tokens += row.telemetry.day_tokens;
    day_runs += row.telemetry.day_runs;
    week_tokens += row.telemetry.week_tokens ?? row.telemetry.day_tokens;
    week_runs += row.telemetry.week_runs ?? row.telemetry.day_runs;
    total_tokens += row.telemetry.total_tokens ?? row.telemetry.week_tokens ?? row.telemetry.day_tokens;
    total_runs += row.telemetry.total_runs ?? row.telemetry.week_runs ?? row.telemetry.day_runs;
    if (row.telemetry.last_at && (!last_at || row.telemetry.last_at > last_at)) last_at = row.telemetry.last_at;
  }
  return any ? { five_hour_tokens, five_hour_runs, day_tokens, day_runs, week_tokens, week_runs, total_tokens, total_runs, last_at } : null;
}

function hasRecordedTelemetry(t: LoginTelemetry | null | undefined): boolean {
  if (!t) return false;
  return (t.total_tokens ?? t.week_tokens ?? t.day_tokens) > 0 || (t.total_runs ?? t.week_runs ?? t.day_runs) > 0;
}

// Collapse multi-machine local authorizations of the same executor (>= 2 machines) into one
// unified logical account row on the Usage page so 3 Gemini machines show one account-level total.
function unifyQuotaLogins(logins: readonly QuotaLogin[]): (QuotaLogin & { logicalMachines?: string[] })[] {
  const result: (QuotaLogin & { logicalMachines?: string[] })[] = [];
  const machineByExecutor = new Map<string, QuotaLogin[]>();
  for (const login of logins) {
    if (login.machine === null) {
      result.push(login);
      continue;
    }
    const bucket = machineByExecutor.get(login.executor);
    if (bucket) bucket.push(login);
    else machineByExecutor.set(login.executor, [login]);
  }
  for (const [executor, list] of machineByExecutor) {
    if (list.length < 2) {
      result.push(list[0]!);
      continue;
    }
    const latest = latestQuota(list, (row) => row.status.usage);
    const readable = list.find((row) => row.read.available) ?? list[0]!;
    const telemetry = mergeLogicalTelemetry(list);
    result.push({
      login_id: readable.login_id,
      name: `${formatProviderName(executor)}（${list.length} 台机器）`,
      machine: null,
      executor,
      status: {
        ...readable.status,
        active_runs: list.reduce((sum, r) => sum + r.status.active_runs, 0),
        usage: latest.status.usage,
        rejected: list.every((r) => r.status.rejected === true),
      },
      read: readable.read,
      ...(telemetry ? { telemetry } : {}),
      logicalMachines: list.map((r) => r.machine!).filter(Boolean),
    });
  }
  return result;
}

function QuotaList({ page, pending, onRefresh }: { page: QuotaPage; pending: unknown; onRefresh: (loginId: string) => void }) {
  if (page.logins.length === 0) return <Empty title="还没有登录">在“账号”页添加集中托管账号后，可在此查看剩余额度与消耗统计。</Empty>;
  const unified = useMemo(() => unifyQuotaLogins(page.logins), [page.logins]);
  const isAsking = (login: QuotaLogin): boolean =>
    typeof pending === 'object'
    && pending !== null
    && ((pending as { login_id?: string }).login_id === login.login_id || ('all' in pending && login.read.available));
  const primary = unified.filter((login) =>
    login.machine === null
    || login.status.usage.length > 0
    || login.read.available
    || hasRecordedTelemetry(login.telemetry)
    || login.status.rejected === true
    || login.status.rest !== null
    || login.read.failure !== null,
  );
  const secondary = unified.filter((login) => !primary.includes(login));
  return (
    <div className="grid gap-3">
      {primary.length > 0 ? (
        <Rows>
          {primary.map((login) => (
            <QuotaRow key={login.logicalMachines ? `logical:${login.executor}` : login.login_id} login={login} asking={isAsking(login)} onRefresh={() => onRefresh(login.login_id)} />
          ))}
        </Rows>
      ) : null}
      {secondary.length > 0 ? (
        <Details id="quota-unreported-machine-logins" title={`不提供额度的单机登录（${secondary.length}）`}>
          <Rows className="mt-2">
            {secondary.map((login) => (
              <QuotaRow key={login.login_id} login={login} asking={isAsking(login)} onRefresh={() => onRefresh(login.login_id)} />
            ))}
          </Rows>
        </Details>
      ) : null}
    </div>
  );
}

function standingOf(login: QuotaLogin): { text: string; tone: 'waiting' | 'success' | 'plain' } {
  // A refused credential is the owner's to fix, and is said the same way the accounts page
  // says it: never a green "可用".
  if (login.status.rejected) return { text: NEEDS_LOGIN_TEXT, tone: 'waiting' };
  if (login.status.rest) return { text: `歇到 ${formatTime(login.status.rest.until)}`, tone: 'waiting' };
  if (quotaUsedUp(login.status.usage)) return { text: '额度已用完', tone: 'waiting' };
  if (loginFull(login.status)) return { text: '到并发上限', tone: 'waiting' };
  if (login.status.active_runs > 0) return { text: `在跑 ${login.status.active_runs} 轮`, tone: 'plain' };
  return { text: '可用', tone: 'success' };
}

function formatTelemetryStrip(t: LoginTelemetry | null | undefined): string | null {
  if (!hasRecordedTelemetry(t) || !t) return null;
  const parts: string[] = [];
  if (t.five_hour_tokens > 0) parts.push(`近 5h ${formatCompactTokens(t.five_hour_tokens)}`);
  if (t.day_tokens > 0) parts.push(`24h ${formatCompactTokens(t.day_tokens)}`);
  const week = t.week_tokens ?? t.day_tokens;
  if (week > 0 && week !== t.day_tokens) parts.push(`7 天 ${formatCompactTokens(week)}`);
  const total = t.total_tokens ?? week;
  if (total > 0 && total !== week) parts.push(`累计 ${formatCompactTokens(total)}`);
  else if (parts.length === 0 && total > 0) parts.push(`累计 ${formatCompactTokens(total)}`);
  const runs = t.total_runs ?? t.week_runs ?? t.day_runs;
  if (runs > 0) parts.push(`${runs} 轮`);
  return parts.length > 0 ? `账本用量：${parts.join(' · ')}` : null;
}

function QuotaRow({ login, asking, onRefresh }: { login: QuotaLogin & { logicalMachines?: string[] }; asking: boolean; onRefresh: () => void }) {
  const name = login.machine === null ? login.name : loginName({ name: login.name, machine: login.machine, executor: login.executor });
  const standing = standingOf(login);
  const read = usageReadLine(login.status.usage);
  const busy = asking || login.read.reading;
  const telemetryLine = formatTelemetryStrip(login.telemetry);
  const noQuotaText = login.read.why;
  return (
    <section aria-label={name} className="grid gap-x-6 gap-y-2.5 px-4 py-3.5 shell:grid-cols-[minmax(10rem,14rem)_minmax(0,1fr)_auto] shell:items-start">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="text-sm font-semibold wrap-anywhere">{name}</h3>
          <Mono className="text-muted-foreground">{login.executor}</Mono>
        </div>
        <Badge tone={standing.tone} className="mt-1.5">{standing.text}</Badge>
        {login.logicalMachines?.length ? (
          <Note className="mt-1 font-mono text-xs wrap-anywhere" title={login.logicalMachines.join(' · ')}>
            {login.logicalMachines.join(' · ')}
          </Note>
        ) : null}
        {login.aliases?.length ? (
          <Note className="mt-1 text-xs wrap-anywhere" title={login.aliases.map((alias) => loginName({ name: alias.name, machine: alias.machine ?? undefined, executor: alias.executor })).join('、')}>
            {`已合并 ${login.aliases.length} 处同订阅登录`}
          </Note>
        ) : null}
      </div>
      <div className="grid min-w-0 gap-2">
        {login.status.usage.length ? (
          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {login.status.usage.map((figure) => <QuotaWindow key={figure.window} figure={figure} />)}
          </div>
        ) : null}
        {telemetryLine ? (
          <p className="font-mono text-xs text-muted-foreground tabular-nums">{telemetryLine}</p>
        ) : null}
        <p className="text-xs text-faint wrap-anywhere" aria-live="polite">
          {read ?? (busy ? QUOTA_TEXT.reading : login.read.available ? QUOTA_TEXT.unread : noQuotaText)}
          {read && busy ? ` · ${QUOTA_TEXT.refreshing}` : null}
          {read && !login.read.available && noQuotaText ? `。${noQuotaText}` : null}
        </p>
        {login.read.failure && !busy ? (
          <p className="text-xs text-destructive wrap-anywhere">{`${login.read.tried_at ? `${formatTime(login.read.tried_at)} ` : ''}没读到：${login.read.failure}`}</p>
        ) : null}
        {/* A 429 with nothing to read is not a broken command: said plainly, with the held
            figures still above it. */}
        {login.read.limited && !busy ? (
          <p className="text-xs text-muted-foreground wrap-anywhere">{`${login.read.tried_at ? `${formatTime(login.read.tried_at)} ` : ''}${login.read.limited}`}</p>
        ) : null}
      </div>
      <div className="flex items-start shell:justify-end">
        {login.read.available && !login.status.rejected ? (
          <Button size="sm" variant="ghost" disabled={busy} title="刷新这个登录的额度，会用掉一点点额度" onClick={onRefresh}>
            <RefreshCw className={cn(busy ? 'animate-spin motion-reduce:animate-none' : undefined)} />
            {busy ? QUOTA_TEXT.refreshing : '刷新'}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

// ——— Spend ————————————————————————————————————————————————————————————————————————————————

function Spend({ report, days, dimension, metric, onDimension, onMetric }: {
  report: UsageReport;
  days: readonly string[];
  dimension: Dimension;
  metric: Metric;
  onDimension: (value: Dimension) => void;
  onMetric: (value: Metric) => void;
}) {
  const summary = useMemo(() => summarize(report, dimension, metric), [report, dimension, metric]);
  const drawn = summary.groups.filter((group) => metricOf(group, metric) > 0).slice(0, DRAWN).map((group) => group.key);
  const chart = useMemo(() => daysOf(report, days, dimension, metric, drawn), [report, days, dimension, metric, drawn.join('\u0000')]);
  const colorOf = (key: string): string => {
    const at = drawn.indexOf(key);
    return at < 0 ? OTHER : SERIES[at]!;
  };
  const { totals } = summary;
  const nothing = totals.units === 0;
  const dimensionLabel = DIMENSIONS.find((each) => each.value === dimension)!.label;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <Tiles summary={summary} />
      {nothing ? (
        <Empty title="这段时间没有用量记录">用量从这一版开始记：每一轮执行结算时、负责人每个回合结束时、每次问额度时各记一笔。</Empty>
      ) : (
        <>
          <div className="rounded-xl bg-raised p-4 shadow-card">
            <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
              <Segmented label="按什么分" value={dimension} options={DIMENSIONS} onChange={onDimension} />
              <Segmented label="看什么" value={metric} options={METRICS} onChange={onMetric} />
            </div>
            <Legend items={[...drawn.map((key) => ({ key, label: summary.groups.find((group) => group.key === key)!.label })), ...(chart.some((day) => day.values.some((value) => value.key === '@other')) ? [{ key: '@other', label: '其他' }] : [])]} colorOf={colorOf} />
            <Chart days={chart} metric={metric} labelOf={(key) => (key === '@other' ? '其他' : summary.groups.find((group) => group.key === key)?.label ?? key)} colorOf={colorOf} caption={`每天的${METRICS.find((each) => each.value === metric)!.label}，按${dimensionLabel}分`} />
            {metric === 'cost' && totals.unpriced > 0 ? <Note className="mt-3 text-xs">{`有 ${totals.unpriced} 条记录执行器没有报价（Codex、dsh、Gemini 不报），不在这张图里。`}</Note> : null}
          </div>
          <GroupTable groups={summary.groups} dimension={dimension} dimensionLabel={dimensionLabel} colorOf={colorOf} drawn={drawn} />
          {summary.groups.some((group) => group.unpriced > 0 && group.list_cost_usd > 0) ? <Note className="-mt-2 text-xs">* 这一行有一部分记录执行器没有报价（Codex、dsh、Gemini 不报），金额只算报了的那些。</Note> : null}
          {totals.without_usage > 0 ? <Note className="-mt-2 text-xs">{`其中 ${totals.without_usage} 轮执行器没有报用量：多是被打断、丢失或在用量记录之前跑的轮次。`}</Note> : null}
          <TopTasks tasks={report.top_tasks} names={report.names.projects} />
        </>
      )}
    </div>
  );
}

function Tiles({ summary: { totals } }: { summary: ReturnType<typeof summarize> }) {
  const priced = totals.list_cost_usd > 0;
  const tiles = [
    { label: 'Token', value: formatTokens(tokensOf(totals)), detail: `输入 ${formatTokens(totals.input)} · 输出 ${formatTokens(totals.output)} · 缓存 ${formatTokens(totals.cache_read + totals.cache_write)}` },
    { label: '标价折算', value: priced ? formatUsd(totals.list_cost_usd) : '无数据', detail: '执行器按 API 标价算的，只有 Claude 报；不是账单' },
    { label: '执行', value: `${totals.rounds} 轮`, detail: `负责人 ${totals.turns} 个回合` },
    { label: '执行时长', value: formatDuration(totals.duration_ms), detail: '各轮从开始到结束相加' },
  ];
  return (
    <dl className="grid grid-cols-2 overflow-hidden rounded-xl bg-raised shadow-card wide:grid-cols-4">
      {tiles.map((tile, at) => (
        <div key={tile.label} className={cn('min-w-0 px-4 py-3.5', at % 2 === 1 && 'border-l border-border', at >= 2 && 'border-t border-border wide:border-t-0', at === 2 && 'wide:border-l')}>
          <dt className="text-xs text-muted-foreground">{tile.label}</dt>
          <dd className="mt-1 text-2xl font-semibold tracking-[-0.01em] tabular-nums">{tile.value}</dd>
          <dd className="mt-0.5 text-xs text-faint wrap-anywhere">{tile.detail}</dd>
        </div>
      ))}
    </dl>
  );
}

function Legend({ items, colorOf }: { items: { key: string; label: string }[]; colorOf: (key: string) => string }) {
  return (
    <ul aria-label="图例" className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5">
      {items.map((item) => (
        <li key={item.key} className="flex min-w-0 items-center gap-1.5 text-xs text-foreground">
          <span aria-hidden="true" className={cn('size-2.5 flex-none rounded-[3px]', colorOf(item.key))} />
          <span className="truncate">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

// Daily bars, stacked by group, on one axis that starts at zero. Every day of the range is a
// column, a day with nothing an empty one. Hovering a column says what is in it; the table
// under the chart says the same in words for every group.
function Chart({ days, metric, labelOf, colorOf, caption }: {
  days: Day[];
  metric: Metric;
  labelOf: (key: string) => string;
  colorOf: (key: string) => string;
  caption: string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const top = niceMax(Math.max(0, ...days.map((day) => day.total)));
  const every = days.length <= 7 ? 1 : days.length <= 31 ? 5 : 15;
  const shown = hovered === null ? undefined : days[hovered];
  return (
    <figure className="m-0">
      <div className="relative flex h-[200px] gap-2" role="img" aria-label={caption}>
        <div aria-hidden="true" className="flex w-12 flex-none flex-col justify-between text-right text-2xs text-faint tabular-nums">
          <span className="-translate-y-1/2">{showMetric(top, metric)}</span>
          <span>{showMetric(top / 2, metric)}</span>
          <span className="translate-y-1/2">0</span>
        </div>
        <div className="relative min-w-0 flex-1" onMouseLeave={() => setHovered(null)}>
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex flex-col justify-between">
            <span className="border-t border-dashed border-border" />
            <span className="border-t border-dashed border-border" />
            <span className="border-t border-border-strong" />
          </div>
          <div className={cn('relative flex h-full items-end', days.length > 31 ? 'gap-px' : 'gap-1')}>
            {days.map((day, at) => (
              <div
                key={day.day}
                data-day={day.day}
                className={cn('flex h-full min-w-0 flex-1 items-end justify-center rounded-t-[4px]', hovered === at && 'bg-hover')}
                onMouseEnter={() => setHovered(at)}
              >
                {day.total > 0 ? (
                  <div className="flex w-full max-w-12 flex-col-reverse overflow-hidden rounded-t-[4px]" style={{ height: `${(day.total / top) * 100}%`, minHeight: 2 }}>
                    {day.values.map((value, index) => (
                      <span key={value.key} className={cn('block w-full flex-none', colorOf(value.key), index > 0 && 'border-b-2 border-raised')} style={{ height: `${(value.value / day.total) * 100}%` }} />
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {shown && hovered !== null ? (
            <div
              role="tooltip"
              className="pointer-events-none absolute top-1 z-10 w-max max-w-[16rem] rounded-lg border border-border bg-raised px-3 py-2 text-xs shadow-card"
              style={hovered < days.length / 2
                ? { left: `calc(${((hovered + 1) / days.length) * 100}% + 8px)` }
                : { right: `calc(${((days.length - hovered) / days.length) * 100}% + 8px)` }}
            >
              <p className="mb-1 font-semibold">{dayLabel(shown.day)}</p>
              {shown.values.length ? (
                <ul className="grid gap-0.5">
                  {[...shown.values].reverse().map((value) => (
                    <li key={value.key} className="flex items-center gap-1.5">
                      <span aria-hidden="true" className={cn('size-2 flex-none rounded-[2px]', colorOf(value.key))} />
                      <span className="min-w-0 truncate text-muted-foreground">{labelOf(value.key)}</span>
                      <span className="ml-auto pl-3 tabular-nums">{showMetric(value.value, metric)}</span>
                    </li>
                  ))}
                  <li className="mt-0.5 flex border-t border-border pt-0.5 font-medium"><span>合计</span><span className="ml-auto pl-3 tabular-nums">{showMetric(shown.total, metric)}</span></li>
                </ul>
              ) : <p className="text-muted-foreground">没有用量</p>}
            </div>
          ) : null}
        </div>
      </div>
      <div aria-hidden="true" className={cn('mt-1.5 ml-14 flex text-2xs text-faint', days.length > 31 ? 'gap-px' : 'gap-1')}>
        {days.map((day, at) => (
          <span key={day.day} className="min-w-0 flex-1 overflow-visible text-center whitespace-nowrap">{at % every === 0 || at === days.length - 1 ? axisLabel(day.day) : ''}</span>
        ))}
      </div>
    </figure>
  );
}

function GroupTable({ groups, dimension, dimensionLabel, colorOf, drawn }: { groups: Group[]; dimension: Dimension; dimensionLabel: string; colorOf: (key: string) => string; drawn: string[] }) {
  // A group whose rounds reported nothing has no figure, which is not a figure of zero.
  const none = (group: Group): boolean => tokensOf(group) === 0 && group.unpriced === 0 && group.list_cost_usd === 0;
  const tokens = (group: Group, value: number): string => (none(group) ? '—' : formatTokens(value));
  const cost = (group: Group): string => {
    if (none(group)) return '—';
    if (group.list_cost_usd === 0 && group.unpriced > 0) return '无数据';
    return `${formatUsd(group.list_cost_usd)}${group.unpriced > 0 ? '*' : ''}`;
  };
  const head = 'px-3 py-2 text-right text-xs font-medium text-muted-foreground whitespace-nowrap';
  const cell = 'px-3 py-2 text-right tabular-nums whitespace-nowrap';
  return (
    <div className="overflow-x-auto rounded-xl bg-raised shadow-card">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <caption className="sr-only">{`按${dimensionLabel}分的用量`}</caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={cn(head, 'text-left')}>{dimensionLabel}</th>
            <th scope="col" className={head} title="执行的轮次、负责人的回合和问额度的次数">次数</th>
            <th scope="col" className={head}>输入</th>
            <th scope="col" className={head}>输出</th>
            <th scope="col" className={head}>缓存读</th>
            <th scope="col" className={head}>缓存写</th>
            <th scope="col" className={head}>Token 合计</th>
            <th scope="col" className={head} title="执行器按 API 标价折算；* 表示有一部分记录没有报价">标价折算</th>
            {dimension === 'model' ? null : <th scope="col" className={head}>执行时长</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {groups.map((group) => (
            <tr key={group.key} className="hover:bg-hover/60">
              <th scope="row" className="max-w-[18rem] px-3 py-2 text-left font-normal">
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden="true" className={cn('size-2.5 flex-none rounded-[3px]', drawn.includes(group.key) ? colorOf(group.key) : 'bg-transparent')} />
                  <span className="truncate" title={group.label}>{group.label}</span>
                </span>
              </th>
              <td className={cell}>{group.units}</td>
              <td className={cell}>{tokens(group, group.input)}</td>
              <td className={cell}>{tokens(group, group.output)}</td>
              <td className={cell}>{tokens(group, group.cache_read)}</td>
              <td className={cell}>{tokens(group, group.cache_write)}</td>
              <td className={cn(cell, 'font-medium')}>{tokens(group, tokensOf(group))}</td>
              <td className={cn(cell, group.list_cost_usd === 0 && group.unpriced > 0 && 'text-faint')}>{cost(group)}</td>
              {dimension === 'model' ? null : <td className={cell}>{group.duration_ms ? formatDuration(group.duration_ms) : '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TopTasks({ tasks, names }: { tasks: TaskUsage[]; names: Record<string, string> }) {
  const used = tasks.filter((task) => tokensOf(task) > 0);
  if (used.length === 0) return null;
  return (
    <section aria-labelledby="top-tasks">
      <SectionTitle id="top-tasks">用量最多的任务</SectionTitle>
      <Rows>
        {used.map((task) => (
          <Link key={task.task_id} to={`/task/${task.task_id}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-2.5 no-underline transition-colors duration-100 hover:bg-muted">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{task.title}</span>
              <span className="block truncate text-xs text-faint">{`${task.project_id ? names[task.project_id] ?? '已删除的项目' : '不属于项目'} · ${task.rounds} 轮`}</span>
            </span>
            <span className="text-right text-sm tabular-nums">
              {formatTokens(tokensOf(task))}
              <span className="block text-xs text-faint">{task.list_cost_usd > 0 ? formatUsd(task.list_cost_usd) : task.unpriced > 0 ? '无报价' : ''}</span>
            </span>
          </Link>
        ))}
      </Rows>
    </section>
  );
}
