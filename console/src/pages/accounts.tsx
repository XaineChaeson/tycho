import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Ellipsis, KeyRound, Layers, Pencil, Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, UserCheck, X } from 'lucide-react';
import { NEEDS_LOGIN_TEXT, credentialText, loginFull, loginStatusLine, machineLoginRefusedText, modelText, tierText, usageReadLine } from '@shared/labels.ts';
import { loginName, RETIRED_TIER_STANDING, takesTypedLogin } from '@shared/logins.ts';
import { isTierId, TIERS, type TierId } from '@shared/tiers.ts';
import { effectiveRouteOfLogin, executionPermissionSummary, logicalAccountKey, normalizeRouteKey, type DispatchSlotsConfig, type TierDispatchSlots } from '@shared/dispatch-slots.ts';
import { latestQuota } from '@shared/usage.ts';
import { formatTime } from '@shared/time.ts';
import { formatCompactTokens, formatProviderName, formatSpecialQuotaLabel } from '@/components/account-quota-popover';
import { buildLogicalAccountEntries, coveredMachineLoginsByAccount, DispatchSlotsPanel, effectiveSlotsByTier } from '@/components/dispatch-slots-panel';
import { Callout, Dot, Empty, Field, HashLink, Mono, Note, Problem, type Tone } from '@/components/bits';
import { QuotaWindow } from '@/components/quota';
import { CheckLine } from '@/components/check-line';
import type { ProviderDraft } from '@shared/provider-form.ts';
import { AddAccountWindow } from '@/components/add-account';
import { LineFields, sendableLine } from '@/components/provider-steps';
import { ReloginWindow, type LoginTarget } from '@/components/claude-login';
import { CodexReloginWindow } from '@/components/codex-login';
import { BLANK_LOGIN, LoginEditor, type LoginDraft } from '@/components/login-form';
import { Page, PageLead } from '@/components/page';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, Choice } from '@/components/ui/checkbox';
import { Confirm, Dialog, DialogActions, DialogContent, Sheet, SheetContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { EARLIER_CHANGE, useChange } from '@/hooks/use-change';
import { ApiError, del, messageOf, post, put } from '@/lib/api';
import { accountsQuery, LOGINS_CHANGE } from '@/lib/queries';
import { machineLoginPath, machineLoginStanding } from '@/lib/machines';
import {
  accountBody, formOf, loginSettingsBody, modelsLine, tierEditorOf, tierRefusal, withAccount, withField, type AccountForm,
} from '@/lib/accounts';
import type { Account, AccountModels, AccountsAndMachines, LoginTelemetry, Machine, MachineCheck, MachineLogin } from '@/lib/types';
import { cn } from '@/lib/utils';

const ADD = '添加账号';
const CHECK_HINT = '挑一台在线、装了这个执行器的机器现在去问一次，不改任何东西';

interface CredentialDraft { value: string; saving: boolean; error: string | null }
const CREDENTIAL_BLANK: CredentialDraft = { value: '', saving: false, error: null };

function CredentialForm({ account, draft, busy, onEdit, onSave, onCancel }: {
  account: Account; draft: CredentialDraft; busy: boolean;
  onEdit: (value: string) => void; onSave: () => void; onCancel: () => void;
}) {
  const id = useId();
  return (
    <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <Field htmlFor={id} label={credentialText.typed.label} hint={credentialText.typed.help}>
        <p className={cn('text-sm', account.credential !== 'set' ? 'text-destructive' : 'text-muted-foreground')}>{`现在：${credentialText.typed.states[account.credential]}`}</p>
        <Input id={id} type="password" autoComplete="new-password" value={draft.value} disabled={draft.saving}
          onChange={(event) => onEdit(event.target.value)} />
      </Field>
      {draft.error ? <Problem role="alert">{draft.error}</Problem> : null}
      <DialogActions>
        <Button variant="ghost" disabled={draft.saving} onClick={onCancel}>取消</Button>
        <Button type="submit" variant="primary" disabled={busy}>{draft.saving ? credentialText.typed.saving : credentialText.typed.save}</Button>
      </DialogActions>
    </form>
  );
}

function standingOf(account: Account): { text: string; tone: BadgeTone } {
  const { status } = account;
  if (account.retired_tiers?.length) return { text: RETIRED_TIER_STANDING, tone: 'failed' };
  if (account.credential === 'missing') return { text: '凭据缺失', tone: 'failed' };
  if (account.credential === 'rejected' || status?.rejected === true) return { text: '登录失效', tone: 'failed' };
  if (status?.rest) return { text: '歇着', tone: 'waiting' };
  if (status && loginFull(status)) return { text: '到上限', tone: 'waiting' };
  return { text: '可用', tone: 'success' };
}

function dotToneOf(tone: BadgeTone): Tone {
  if (tone === 'success' || tone === 'waiting' || tone === 'failed' || tone === 'running') return tone;
  return 'ended';
}

function railQuotaHint(usage: NonNullable<Account['status']>['usage']): string | null {
  if (usage.length === 0) return null;
  for (const item of usage) {
    const special = formatSpecialQuotaLabel(item.window);
    if (special) return `${special.label} ${special.value}`;
  }
  let peak = usage[0]!;
  for (const item of usage) {
    if (item.used > peak.used) peak = item;
  }
  const pct = `${Math.round(peak.used * 100)}%`;
  if (peak.window === 'five_hour') return `5h ${pct}`;
  if (peak.window === 'seven_day') return `7d ${pct}`;
  return pct;
}

const ownKey = (machine: Machine, login: MachineLogin): string => `/own/${machine.id}/${login.executor}`;
const groupKey = (executor: string): string => `/group/${executor}`;

interface OwnMember {
  key: string;
  machine: Machine;
  login: MachineLogin;
}

const PROVIDER_ORDER = ['codex', 'claude', 'gemini', 'dsh'];

const PROVIDER_ACCENT: Record<string, string> = {
  codex: 'bg-emerald-500',
  claude: 'bg-amber-500',
  gemini: 'bg-blue-500',
  dsh: 'bg-sky-500',
};

function providerRank(executor: string): number {
  const idx = PROVIDER_ORDER.indexOf(executor);
  return idx === -1 ? 99 : idx;
}

function accountIdentityLine(account: Account): string {
  const parts = [account.account_label, account.plan_label].filter((v): v is string => Boolean(v));
  if (parts.length > 0) return parts.join(' · ');
  if (account.provider?.line === 'official') return '官方 API Key';
  if (account.provider?.line === 'custom') {
    const rawUrl = typeof account.provider.baseURL === 'string' ? account.provider.baseURL : '';
    try {
      return rawUrl ? `自定义网关 · ${new URL(rawUrl).host}` : '自定义网关';
    } catch {
      return '自定义网关';
    }
  }
  return account.signed_in ? '官方 OAuth 授权' : '托管密钥';
}

function InlineAliasTitle({
  title,
  placeholder,
  disabled,
  allowClear,
  onSave,
}: {
  title: string;
  placeholder?: string;
  disabled?: boolean;
  allowClear?: boolean;
  onSave: (nextName: string | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const start = () => {
    setValue(title);
    setErr(null);
    setEditing(true);
  };

  const commit = async () => {
    const trimmed = value.trim();
    if (!allowClear && trimmed === '') {
      setErr('名字不能为空');
      return;
    }
    if (trimmed === title) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await onSave(trimmed === '' ? null : trimmed);
      setEditing(false);
    } catch (e) {
      setErr(messageOf(e));
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="inline-flex flex-wrap items-center gap-1.5">
        <Input
          autoFocus
          aria-label="修改账号名称"
          placeholder={placeholder ?? '输入便于辨识的别名…'}
          className="h-7 w-48 text-sm font-semibold"
          value={value}
          disabled={saving}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(false);
              setErr(null);
            }
          }}
        />
        <Button type="button" size="icon-sm" variant="primary" aria-label="保存名称" disabled={saving} onClick={() => void commit()}>
          <Check className="size-3.5" />
        </Button>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="取消改名" disabled={saving} onClick={() => { setEditing(false); setErr(null); }}>
          <X className="size-3.5" />
        </Button>
        {err ? <span role="alert" className="text-xs text-failed-foreground">{err}</span> : null}
      </div>
    );
  }

  return (
    <div className="group inline-flex min-w-0 items-center gap-1.5">
      <h2 className="min-w-0 text-lg font-semibold tracking-[-0.01em] wrap-anywhere">{title}</h2>
      <button
        type="button"
        disabled={disabled}
        title="修改显示别名"
        aria-label={`重命名 ${title}`}
        onClick={start}
        className="inline-flex size-6 flex-none cursor-pointer items-center justify-center rounded-md text-faint opacity-60 transition-all hover:bg-hover hover:text-foreground group-hover:opacity-100 disabled:opacity-30"
      >
        <Pencil className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

type LoginRow =
  | { kind: 'account'; key: string; account: Account }
  | { kind: 'group'; key: string; executor: string; identityLabel: string | null; planLabel: string | null; members: OwnMember[] }
  | { kind: 'machine'; key: string; machine: Machine; login: MachineLogin };

function sumTelemetry(ids: readonly (string | null | undefined)[], map: Readonly<Record<string, LoginTelemetry>> | undefined): LoginTelemetry | null {
  if (!map) return null;
  let fiveHourTokens = 0;
  let fiveHourRuns = 0;
  let dayTokens = 0;
  let dayRuns = 0;
  let weekTokens = 0;
  let weekRuns = 0;
  let totalTokens = 0;
  let totalRuns = 0;
  let lastAt: string | null = null;
  let found = false;
  for (const id of ids) {
    if (!id) continue;
    const item = map[id];
    if (!item) continue;
    found = true;
    fiveHourTokens += item.five_hour_tokens;
    fiveHourRuns += item.five_hour_runs;
    dayTokens += item.day_tokens;
    dayRuns += item.day_runs;
    weekTokens += item.week_tokens ?? item.day_tokens;
    weekRuns += item.week_runs ?? item.day_runs;
    totalTokens += item.total_tokens ?? item.week_tokens ?? item.day_tokens;
    totalRuns += item.total_runs ?? item.week_runs ?? item.day_runs;
    if (item.last_at && (!lastAt || item.last_at > lastAt)) lastAt = item.last_at;
  }
  return found
    ? {
        five_hour_tokens: fiveHourTokens,
        five_hour_runs: fiveHourRuns,
        day_tokens: dayTokens,
        day_runs: dayRuns,
        week_tokens: weekTokens,
        week_runs: weekRuns,
        total_tokens: totalTokens,
        total_runs: totalRuns,
        last_at: lastAt,
      }
    : null;
}

function TelemetrySummaryCard({ telemetry, note }: { telemetry: LoginTelemetry | null; note?: string }) {
  const weekTokens = telemetry ? (telemetry.week_tokens ?? telemetry.day_tokens) : 0;
  const weekRuns = telemetry ? (telemetry.week_runs ?? telemetry.day_runs) : 0;
  const totalTokens = telemetry ? (telemetry.total_tokens ?? weekTokens) : 0;
  const totalRuns = telemetry ? (telemetry.total_runs ?? weekRuns) : 0;
  return (
    <div className="grid gap-2 rounded-lg border border-border/70 bg-muted/35 px-3.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-xs font-semibold text-muted-foreground">账本消耗遥测</h3>
          {note ? <span className="text-2xs text-faint">· {note}</span> : null}
        </div>
        <HashLink href="#/usage" className="text-xs text-link hover:underline">查看完整用量 →</HashLink>
      </div>
      <div className="grid grid-cols-2 gap-2.5 text-xs sm:grid-cols-4">
        <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2">
          <div className="text-faint">近 5 小时</div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-foreground tabular-nums">
            {telemetry ? `${formatCompactTokens(telemetry.five_hour_tokens)} tok` : '0 tok'}
          </div>
          <div className="text-2xs text-muted-foreground tabular-nums">
            {telemetry ? `${telemetry.five_hour_runs} 轮` : '暂无轮次'}
          </div>
        </div>
        <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2">
          <div className="text-faint">近 24 小时</div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-foreground tabular-nums">
            {telemetry ? `${formatCompactTokens(telemetry.day_tokens)} tok` : '0 tok'}
          </div>
          <div className="text-2xs text-muted-foreground tabular-nums">
            {telemetry ? `${telemetry.day_runs} 轮` : '暂无轮次'}
          </div>
        </div>
        <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2">
          <div className="text-faint">近 7 天</div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-foreground tabular-nums">
            {`${formatCompactTokens(weekTokens)} tok`}
          </div>
          <div className="text-2xs text-muted-foreground tabular-nums">
            {`${weekRuns} 轮`}
          </div>
        </div>
        <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2">
          <div className="text-faint">累计总量</div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-foreground tabular-nums">
            {`${formatCompactTokens(totalTokens)} tok`}
          </div>
          <div className="text-2xs text-muted-foreground tabular-nums">
            {telemetry?.last_at ? `最近 ${formatTime(telemetry.last_at)}` : `${totalRuns} 轮`}
          </div>
        </div>
      </div>
    </div>
  );
}

function SlotMiniPills({ logicalKey, slotsByTier, onOpenPolicy }: {
  logicalKey: string;
  slotsByTier: Record<TierId, TierDispatchSlots>;
  onOpenPolicy: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpenPolicy}
      title="点击前往「派发策略」调整 P1 / P2 优先级槽"
      className="mt-1 flex cursor-pointer flex-wrap gap-1 text-left"
    >
      {TIERS.map((tier) => {
        const slot = slotsByTier[tier.id];
        const tag = slot.p1.includes(logicalKey) ? 'P1' : slot.p2.includes(logicalKey) ? 'P2' : '停';
        const tone = tag === 'P1'
          ? 'border-brand-border bg-brand-soft text-brand-foreground'
          : tag === 'P2'
            ? 'border-waiting-border bg-waiting-soft text-waiting-foreground'
            : 'border-border bg-muted text-muted-foreground';
        return (
          <span key={tier.id} className={cn('rounded border px-1.5 py-0.5 font-mono text-2xs tabular-nums', tone)}>
            {`${tier.label.slice(0, 2)}·${tag}`}
          </span>
        );
      })}
    </button>
  );
}

function UnifiedGroupDetail({
  groupKeyId,
  executor,
  identityLabel,
  planLabel,
  members,
  page,
  slotsByTier,
  busy,
  failure,
  refreshingQuota,
  quotaError,
  onRename,
  onRefreshQuota,
  onOpenPolicy,
  onBatchEdit,
  onEditMember,
  onRetryMember,
  onDeleteMember,
}: {
  groupKeyId: string;
  executor: string;
  identityLabel: string | null;
  planLabel: string | null;
  members: readonly OwnMember[];
  page: AccountsAndMachines;
  slotsByTier: Record<TierId, TierDispatchSlots>;
  busy: boolean;
  failure: string | null;
  refreshingQuota: boolean;
  quotaError: string | null;
  onRename: (nextName: string | null) => Promise<void>;
  onRefreshQuota: () => void;
  onOpenPolicy: () => void;
  onBatchEdit: () => void;
  onEditMember: (member: OwnMember) => void;
  onRetryMember: (member: OwnMember) => void;
  onDeleteMember: (member: OwnMember) => void;
}) {
  const provider = formatProviderName(executor);
  const sampleRoute = effectiveRouteOfLogin({ routeLabel: members[0]!.login.route_label, tiers: members[0]!.login.tiers });
  const displayTitle = page.login_aliases?.[groupKeyId] || identityLabel || (sampleRoute ? `${provider} · ${sampleRoute}` : provider);
  const verifiedIdentity = [identityLabel, planLabel, sampleRoute ? `线路 ${sampleRoute}` : null].filter(Boolean).join(' · ') || '各机本地 OAuth 授权';
  const onlineCount = members.filter((m) => m.machine.node.connected).length;
  const readyCount = members.filter((m) => machineLoginStanding(m.login).tone === 'success').length;
  const telemetry = sumTelemetry(members.map((m) => m.login.id), page.login_telemetry);
  const latestUsage = latestQuota(members, (m) => m.login.status?.usage ?? []).login.status?.usage ?? [];
  const sample = members[0]!.login;
  const editor = tierEditorOf(page.tier_forms, executor);
  const perm = executionPermissionSummary(executor, sample.permission_mode);
  const logicalKey = logicalAccountKey({
    id: sample.id ?? executor,
    executor,
    machine: members[0]!.machine.id,
    routeLabel: sample.route_label,
    tiers: sample.tiers,
  });
  const maxRuns = members.map((m) => m.login.max_runs).find((v): v is number => typeof v === 'number' && v > 0) ?? null;

  return (
    <section
      id={groupKeyId}
      aria-label={`${provider} 统一逻辑账号`}
      className="grid gap-5 rounded-xl bg-raised p-5 shadow-card"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Dot tone={readyCount > 0 ? 'success' : 'waiting'} />
            <InlineAliasTitle title={displayTitle} placeholder={provider} disabled={busy} allowClear onSave={onRename} />
            <Mono title="执行器" className="rounded bg-hover px-1.5 py-0.5 text-xs text-muted-foreground">{executor}</Mono>
            <Badge tone="running">{`${members.length} 台授权`}</Badge>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/50 px-2 py-0.5 font-mono text-[11px] text-foreground">
              <UserCheck className="size-3 text-primary" aria-hidden="true" />
              {verifiedIdentity}
            </span>
            <span>凭据留在各机本地防互踢；档位、权限和并发可一键同步全部 {members.length} 台。</span>
          </div>
        </div>
        <Button size="sm" variant="primary" disabled={busy} onClick={onBatchEdit}>
          <Layers className="size-3.5" aria-hidden="true" />
          统一修改全部 {members.length} 台
        </Button>
      </header>

      <div className="grid grid-cols-1 gap-3 rounded-lg border border-border/70 bg-muted/40 px-3.5 py-3 text-xs sm:grid-cols-3">
        <div>
          <div className="text-faint">执行权限（防卡死保障）</div>
          <div className="mt-0.5 flex items-center gap-1.5 font-medium text-foreground">
            <ShieldCheck className={cn('size-3.5 flex-none', perm.autoFullAccess ? 'text-success' : 'text-waiting')} />
            <span>{perm.label}</span>
          </div>
          <div className="mt-0.5 font-mono text-2xs text-faint">{perm.mode}</div>
        </div>
        <div>
          <div className="text-faint">已授权机器 · 并发上限</div>
          <div className="mt-0.5 font-mono font-semibold text-foreground tabular-nums">{onlineCount} / {members.length} 在线 · {readyCount} 就绪</div>
          <div className="mt-0.5 text-2xs text-muted-foreground">{maxRuns ? `上限 ${maxRuns} 并发 / 机` : '默认不限并发'}</div>
        </div>
        <div>
          <div className="text-faint">当前路由槽位</div>
          <SlotMiniPills logicalKey={logicalKey} slotsByTier={slotsByTier} onOpenPolicy={onOpenPolicy} />
        </div>
      </div>

      {latestUsage.length > 0 ? (
        <div className="grid gap-2.5 rounded-lg border border-border/70 bg-muted/35 px-3.5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-muted-foreground">
              {`账号剩余额度${usageReadLine(latestUsage) ? ` · ${usageReadLine(latestUsage)}` : ''}`}
            </h3>
            <div className="flex items-center gap-2">
              <HashLink href="#/usage" className="text-xs text-link hover:underline">查看完整用量 →</HashLink>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                disabled={refreshingQuota}
                onClick={onRefreshQuota}
              >
                <RefreshCw aria-hidden="true" className={cn('size-3.5', refreshingQuota && 'animate-spin motion-reduce:animate-none')} />
                {refreshingQuota ? '刷新中…' : '刷新额度'}
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {latestUsage.map((figure) => {
              const special = formatSpecialQuotaLabel(figure.window);
              if (special) {
                return (
                  <div key={figure.window} className="rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs">
                    <div className="text-faint">{special.label}</div>
                    <div className="mt-0.5 font-mono text-sm font-semibold text-foreground tabular-nums">{special.value}</div>
                  </div>
                );
              }
              return <QuotaWindow key={figure.window} figure={figure} />;
            })}
          </div>
          {quotaError ? <Problem role="alert" className="text-xs">{quotaError}</Problem> : null}
        </div>
      ) : null}

      <TelemetrySummaryCard telemetry={telemetry} note="多机聚合账本消耗" />

      <div className="grid gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-muted-foreground">档位模型配置（统一快照）</h3>
          <span className="text-xs text-faint">点右上角可一键同步全部机器</span>
        </div>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          {TIERS.map((decl) => {
            const tier = sample.tiers?.[decl.id];
            if (!tier) {
              return (
                <div key={decl.id} className="grid gap-1 rounded-lg border border-dashed border-border/80 bg-muted/25 px-3 py-2.5">
                  <span className="text-xs font-medium text-muted-foreground">{decl.label}</span>
                  <span className="text-xs text-faint">未配置</span>
                </div>
              );
            }
            const parsed = editor?.parse(tier.text);
            return (
              <div key={decl.id} className="grid content-start gap-1 rounded-lg border border-border bg-background/70 px-3 py-2.5">
                <span className="text-xs font-semibold text-foreground">{decl.label}</span>
                {parsed?.model ? (
                  <>
                    <Mono className="text-xs font-medium text-foreground">{parsed.model}</Mono>
                    {parsed.effort ? <span className="text-[11px] text-muted-foreground">{`推理强度 ${parsed.effort}`}</span> : null}
                  </>
                ) : tier.text.trim() === '' ? (
                  <span className="text-xs text-muted-foreground">使用各机默认配置</span>
                ) : (
                  <Mono className="line-clamp-2 text-[11px] text-muted-foreground">{tier.text.trim()}</Mono>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground">已授权机器矩阵（自动负载均衡，无需手工排序）</h3>
        <div className="divide-y divide-border/70 rounded-lg border border-border bg-background/70">
          {members.map((member) => {
            const { key, machine, login } = member;
            const standing = machineLoginStanding(login);
            const tierCount = Object.keys(login.tiers ?? {}).length;
            const mt = login.id ? page.login_telemetry?.[login.id] : undefined;
            return (
              <div key={key} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-xs">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Dot tone={machine.node.connected ? dotToneOf(standing.tone) : 'ended'} />
                  <span className="font-mono font-semibold text-foreground">{machine.id}</span>
                  <Badge tone={standing.tone}>{standing.text}</Badge>
                  <span className="text-muted-foreground">{tierCount} 档</span>
                  {(() => {
                    const route = effectiveRouteText(login, editor);
                    return route ? <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">{route}</span> : null;
                  })()}
                  {(() => {
                    const q = railQuotaHint(login.status?.usage ?? []);
                    return q ? <span className="font-mono text-2xs text-muted-foreground tabular-nums">{q}</span> : null;
                  })()}
                  {mt && mt.day_tokens > 0 ? (
                    <span className="font-mono text-2xs text-faint tabular-nums">24h {formatCompactTokens(mt.day_tokens)}</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-1">
                  {login.status?.rest ? (
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onRetryMember(member)}>
                      现在就试
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onEditMember(member)}>
                    微调
                  </Button>
                  {login.configured ? (
                    <Button size="sm" variant="danger" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onDeleteMember(member)}>
                      删除
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {failure ? <Problem role="alert">{failure}</Problem> : null}
    </section>
  );
}

function lineLine(page: AccountsAndMachines, account: Account): string {
  const line = account.provider!;
  const label = page.provider_forms?.[account.executor]?.lines.find(({ id }) => id === line.line)?.label ?? line.line;
  return typeof line.baseURL === 'string' ? `${label} · ${line.baseURL}` : label;
}

function effectiveRouteText(login: MachineLogin, editor: ReturnType<typeof tierEditorOf>): string | null {
  const providers: string[] = [];
  if (editor?.fields.includes('provider')) {
    for (const tier of Object.values(login.tiers ?? {})) {
      const p = editor.parse(tier.text)?.provider.trim();
      if (p && !providers.includes(p)) providers.push(p);
    }
  }
  if (providers.length === 1) {
    const p = providers[0]!;
    return login.route_label && login.route_label !== p
      ? `${p}（已覆写本机默认 ${login.route_label}）`
      : p;
  }
  if (providers.length > 1) return `${providers.join(' / ')}（分档）`;
  return login.route_label ? `默认线路 ${login.route_label}` : null;
}

function ownRailLabel(machine: Machine, login: MachineLogin): string {
  const parts = [machine.id, login.executor];
  if (login.account_label) parts.push(login.account_label);
  return `选择单机登录 ${parts.join(' · ')}`;
}

function LoginDetail({ row, page, slotsByTier, usageOverride, linkedOwns, draft, busy, failure, refreshingQuota, quotaError, onRename, onOpenPolicy, onRefreshQuota, onCheck, onRetry, onRelogin, onEdit, onToken, onDelete, onEditLinkedOwn, onDeleteLinkedOwn }: {
  row: Extract<LoginRow, { kind: 'account' | 'machine' }>; page: AccountsAndMachines;
  slotsByTier: Record<TierId, TierDispatchSlots>;
  usageOverride?: NonNullable<Account['status']>['usage'];
  linkedOwns?: readonly OwnMember[];
  draft: LoginDraft; busy: boolean; failure: string | null;
  refreshingQuota: boolean; quotaError: string | null; onRename: (nextName: string | null) => Promise<void>; onOpenPolicy: () => void; onRefreshQuota: () => void;
  onCheck: () => void; onRetry: () => void; onRelogin: (way: 'page' | 'device') => void;
  onEdit: () => void; onToken: () => void; onDelete: () => void;
  onEditLinkedOwn?: (member: OwnMember) => void;
  onDeleteLinkedOwn?: (member: OwnMember) => void;
}) {
  const account = row.kind === 'account' ? row.account : null;
  const own = row.kind === 'machine' ? row.login : null;
  const login = account ?? own!;
  const status = login.status;
  const name = account ? account.name : own!.account_label ?? loginName(own!.name);
  const standing = account ? standingOf(account) : machineLoginStanding(own!);
  const rejected = account ? account.credential !== 'set' || status?.rejected === true : false;
  const ways = account ? (page.account_logins?.[account.executor] ?? []) : [];
  const isSignedInAccount = account
    ? account.signed_in === true || (account.signed_in === undefined && ways.length > 0 && !takesTypedLogin(ways.map(({ way }) => way)))
    : false;
  const signIn = account && isSignedInAccount
    ? ways.find(({ way }) => way === 'page' || way === 'device') ?? null
    : null;
  const kept = account && !isSignedInAccount ? credentialText.typed : credentialText.signedIn;
  const usage = usageOverride ?? status?.usage ?? [];
  const read = usageReadLine(usage);
  const statusLine = account && account.credential !== 'set'
    ? `${kept.label}${kept.states[account.credential]}`
    : status
      ? status.rejected
        ? NEEDS_LOGIN_TEXT
        : loginStatusLine(status) !== standing.text
          ? loginStatusLine(status)
          : null
      : null;
  const editor = tierEditorOf(page.tier_forms, login.executor);
  const tierEntries = Object.entries(login.tiers ?? {});
  const staleTiers = tierEntries.filter(([tierName]) => !isTierId(tierName));
  const configuredCount = tierEntries.length;

  const perm = executionPermissionSummary(login.executor, login.permission_mode);
  const logicalKey = logicalAccountKey({
    id: account?.id ?? own?.id ?? login.executor,
    executor: login.executor,
    machine: row.kind === 'machine' ? row.machine.id : null,
    routeLabel: own?.route_label,
    tiers: own?.tiers,
  });

  const facts: { label: string; value: string }[] = [
    ...(row.kind === 'machine'
      ? [{ label: '范围', value: `机器 ${row.machine.id}` }]
      : [{ label: '范围', value: '全机共用' }]),
    ...(account
      ? [{ label: '凭据', value: isSignedInAccount ? '官方授权' : '托管密钥' }]
      : []),
    ...(account?.provider ? [{ label: '线路', value: lineLine(page, account) }] : []),
    ...(own ? (() => {
      const route = effectiveRouteText(own, editor);
      return route ? [{ label: '线路', value: route }] : [];
    })() : []),
  ];
  const limitBadges: string[] = [
    ...(login.permission_mode ? [`权限 ${login.permission_mode}`] : []),
    ...(login.timeout_ms ? [`时限 ${login.timeout_ms / 60_000} 分钟`] : []),
    ...(login.max_runs ? [`上限 ${login.max_runs} 轮`] : []),
    ...(login.queued_tasks > 0 ? [`排队 ${login.queued_tasks}`] : []),
  ];

  const displayTitle = account
    ? account.name
    : own!.display_name || (own!.id ? page.login_aliases?.[own!.id] : undefined) || own!.account_label || formatProviderName(login.executor);
  const verifiedIdentity = row.kind === 'account'
    ? accountIdentityLine(row.account)
    : [row.login.account_label, row.login.plan_label, row.login.route_label ? `线路 ${row.login.route_label}` : null, `机器 ${row.machine.id}`]
      .filter(Boolean)
      .join(' · ');

  return (
    <section
      id={account?.id ?? (own?.configured ? own.id ?? undefined : undefined)}
      aria-label={name}
      className="grid gap-5 rounded-xl bg-raised p-5 shadow-card"
    >
      <header className="flex flex-wrap items-start gap-x-3 gap-y-3">
        <div className="min-w-[min(100%,14rem)] flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Dot tone={dotToneOf(standing.tone)} />
            <InlineAliasTitle
              title={displayTitle}
              placeholder={account ? account.name : formatProviderName(login.executor)}
              disabled={busy}
              allowClear={!account}
              onSave={onRename}
            />
            <Mono title="执行器" className="rounded bg-hover px-1.5 py-0.5 text-xs text-muted-foreground">
              {login.executor}
            </Mono>
            <Badge tone={standing.tone}>{standing.text}</Badge>
            {row.kind === 'machine'
              ? <Badge tone="plain">{`单机 · ${row.machine.id}`}</Badge>
              : <Badge tone="running">全机分发</Badge>}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/50 px-2 py-0.5 font-mono text-[11px] text-foreground">
              <UserCheck className="size-3 text-primary" aria-hidden="true" />
              {verifiedIdentity}
            </span>
            {row.kind === 'machine' ? (
              <span>仅在所在机器本地可用的登录，不跨机分发。</span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {account && account.credential !== 'missing' ? (
            <Button size="sm" variant="ghost" title={CHECK_HINT} disabled={draft.checking} onClick={onCheck}>
              {draft.checking ? '测试中' : '测试连接'}
            </Button>
          ) : null}
          {status?.rest && !rejected ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onRetry}>
              {draft.retrying ? '正在放行' : '现在就试'}
            </Button>
          ) : null}
          {account?.credential === 'missing' && kept === credentialText.typed ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onToken}>补填密钥</Button>
          ) : null}
          {signIn ? (
            <Button size="sm" variant="ghost" disabled={busy || !signIn.available} title={signIn.available ? undefined : signIn.why} onClick={() => onRelogin(signIn.way as 'page' | 'device')}>
              重新登录
            </Button>
          ) : null}
          <Button size="sm" disabled={busy} onClick={onEdit}>{own && !own.configured ? '填档位' : '修改'}</Button>
          {account ? (
            <Menu>
              <MenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="更多" disabled={busy}><Ellipsis /></Button>
              </MenuTrigger>
              <MenuContent>
                {kept === credentialText.typed ? <MenuItem onSelect={onToken}><KeyRound />{credentialText.typed.change}</MenuItem> : null}
                <MenuItem danger onSelect={onDelete}>删除</MenuItem>
              </MenuContent>
            </Menu>
          ) : own?.configured ? (
            <Button size="sm" variant="danger" disabled={busy} onClick={onDelete}>删除</Button>
          ) : null}
        </div>
      </header>

      {(login.retired_tiers ?? []).map(({ tier, text }) => <Problem key={tier}>{text}</Problem>)}

      {statusLine || status?.rest?.reason || (rejected && signIn && !signIn.available) ? (
        <div
          className={cn(
            'grid gap-1 rounded-lg border px-3.5 py-2.5',
            rejected
              ? 'border-failed-border bg-failed-soft'
              : account && (status?.rest || (status && loginFull(status)))
                ? 'border-waiting-border bg-waiting-soft'
                : 'border-border bg-muted/60',
          )}
        >
          {statusLine ? (
            <p
              role="status"
              className={cn(
                'text-sm',
                rejected
                  ? 'text-destructive'
                  : account && (status?.rest || (status && loginFull(status)))
                    ? 'text-waiting-foreground'
                    : 'text-muted-foreground',
              )}
            >
              {statusLine}
            </p>
          ) : null}
          {rejected && signIn && !signIn.available ? <Note className="text-xs">{signIn.why}</Note> : null}
          {status?.rest?.reason ? <Note className="text-xs">{`执行器的原话：${status.rest.reason}`}</Note> : null}
        </div>
      ) : null}

      <div className="grid gap-3 rounded-lg border border-border/70 bg-muted/40 px-3.5 py-3 text-xs">
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-faint">执行权限（防卡死保障）</dt>
            <dd className="mt-0.5 flex items-center gap-1.5 font-medium text-foreground">
              <ShieldCheck className={cn('size-3.5 flex-none', perm.autoFullAccess ? 'text-success' : 'text-waiting')} />
              <span className="wrap-anywhere">{perm.label}</span>
            </dd>
            <dd className="mt-0.5 font-mono text-2xs text-faint">{perm.mode}</dd>
          </div>
          {facts.map((item) => (
            <div key={item.label} className="min-w-0">
              <dt className="text-faint">{item.label}</dt>
              <dd className="mt-0.5 font-medium text-foreground wrap-anywhere">{item.value}</dd>
            </div>
          ))}
          <div className="min-w-0">
            <dt className="text-faint">当前路由槽位</dt>
            <dd>
              <SlotMiniPills logicalKey={logicalKey} slotsByTier={slotsByTier} onOpenPolicy={onOpenPolicy} />
            </dd>
          </div>
        </dl>
        {limitBadges.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2">
            {limitBadges.map((item) => (
              <Badge key={item} tone="plain" className="wrap-anywhere">{item}</Badge>
            ))}
          </div>
        ) : null}
      </div>

      {usage.length > 0 ? (
        <div className="grid gap-2 rounded-lg border border-border/70 bg-muted/35 px-3.5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-muted-foreground">额度窗口</h3>
            <div className="flex flex-wrap items-center gap-2">
              {read ? (
                <p className="text-xs text-faint wrap-anywhere">
                  {read}
                  <span aria-hidden="true"> · </span>
                  <HashLink href="#/usage" className="text-link hover:underline">在用量页刷新</HashLink>
                </p>
              ) : null}
              {(account?.id ?? own?.id) ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={refreshingQuota}
                  onClick={onRefreshQuota}
                >
                  <RefreshCw aria-hidden="true" className={cn('size-3.5', refreshingQuota && 'animate-spin motion-reduce:animate-none')} />
                  {refreshingQuota ? '刷新中…' : '刷新额度'}
                </Button>
              ) : null}
            </div>
          </div>
          <div className="grid max-w-[600px] gap-x-6 gap-y-2 sm:grid-cols-2">
            {usage.map((figure) => {
              const special = formatSpecialQuotaLabel(figure.window);
              if (special) {
                return (
                  <div key={figure.window} className="rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs">
                    <div className="text-faint">{special.label}</div>
                    <div className="mt-0.5 font-mono text-sm font-semibold text-foreground tabular-nums">{special.value}</div>
                  </div>
                );
              }
              return <QuotaWindow key={figure.window} figure={figure} />;
            })}
          </div>
          {quotaError ? <Problem role="alert" className="text-xs">{quotaError}</Problem> : null}
        </div>
      ) : (
        <TelemetrySummaryCard
          telemetry={(account?.id ?? own?.id) ? (page.login_telemetry?.[account?.id ?? own!.id!] ?? null) : null}
          note={login.executor === 'dsh' ? '支持官方 / New-API 网关余额查询' : '实时记录每轮 Token 消耗'}
        />
      )}

      <div className="grid gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-muted-foreground">档位配置</h3>
          <span className="text-xs text-faint">{configuredCount > 0 ? `已配 ${configuredCount} 个档位` : '没有档位'}</span>
        </div>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          {TIERS.map((decl) => {
            const tier = login.tiers?.[decl.id];
            if (!tier) {
              return (
                <div key={decl.id} className="grid gap-1 rounded-lg border border-dashed border-border/80 bg-muted/25 px-3 py-2.5">
                  <span className="text-xs font-medium text-muted-foreground">{decl.label}</span>
                  <span className="text-xs text-faint">未配置</span>
                </div>
              );
            }
            const parsed = editor?.parse(tier.text);
            return (
              <div key={decl.id} title={tier.text} className="grid content-start gap-1 rounded-lg border border-border bg-background/70 px-3 py-2.5">
                <span className="text-xs font-semibold text-foreground">{decl.label}</span>
                {parsed?.model ? (
                  <>
                    <Mono className="text-xs font-medium text-foreground">{parsed.model}</Mono>
                    {parsed.effort ? <span className="text-[11px] text-muted-foreground">{`推理强度 ${parsed.effort}`}</span> : null}
                  </>
                ) : tier.text.trim() === '' ? (
                  <span className="text-xs text-muted-foreground">使用本机默认配置</span>
                ) : (
                  <Mono className="line-clamp-2 text-[11px] text-muted-foreground">{tier.text.trim()}</Mono>
                )}
              </div>
            );
          })}
        </div>
        {staleTiers.length > 0 ? (
          <div className="grid gap-2">
            {staleTiers.map(([tierName, tier]) => (
              <div key={tierName} title={tier.text} className="flex flex-wrap items-center gap-2 rounded-lg border border-waiting-border bg-waiting-soft px-3 py-2 text-xs">
                <Mono className="font-semibold text-foreground">{tierName}</Mono>
                <Badge tone="waiting">{tierText.stale}</Badge>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {own?.models?.reason ? <Note className="text-xs">{own.models.reason}</Note> : null}
      {own?.configured && own.refused ? <Problem>{machineLoginRefusedText(own.name)}</Problem> : null}

      {account && draft.check ? (
        <div className="grid gap-1 rounded-lg border border-border/70 bg-muted px-3.5 py-2.5">
          {draft.check.machine ? <div><CheckLine answer={draft.check.machine} /></div> : null}
          {draft.check.unchecked ? <Note>{draft.check.unchecked}</Note> : null}
          {account.models?.at ? <Note className="text-xs">{`${modelText.label}：${modelsLine(account.models)}`}</Note> : null}
          {draft.check.modelsFailure ? <Problem>{modelText.queryFailed(draft.check.modelsFailure)}</Problem> : null}
          {draft.check.failure ? <Problem>{draft.check.failure}</Problem> : null}
          <p className="text-xs text-faint">{`${formatTime(draft.check.at)} 测试连接的结果`}</p>
        </div>
      ) : null}

      {linkedOwns && linkedOwns.length > 0 ? (
        <div className="grid gap-2 rounded-lg border border-border/75 bg-muted/35 px-3.5 py-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-muted-foreground">{`同账号本机冗余登录（${linkedOwns.length} 台）`}</h3>
            <span className="text-faint">已由当前全机分发账号覆盖并自动合并展示，可按需清理</span>
          </div>
          <ul className="divide-y divide-border/60 rounded-md border border-border/70 bg-background/70">
            {linkedOwns.map((member) => (
              <li key={member.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Dot tone={member.machine.node.connected ? 'success' : 'waiting'} />
                  <Mono className="font-medium text-foreground">{`${member.machine.id}/${member.login.executor}`}</Mono>
                  <span className="text-muted-foreground">{member.machine.node.connected ? '在线' : '离线'}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {onEditLinkedOwn ? (
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onEditLinkedOwn(member)}>
                      修改本机档位
                    </Button>
                  ) : null}
                  {onDeleteLinkedOwn ? (
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive hover:text-destructive" disabled={busy} onClick={() => onDeleteLinkedOwn(member)}>
                      删除冗余登录
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {failure ? <Problem role="alert">{failure}</Problem> : null}
    </section>
  );
}

type Taken = (accounts: Account[], answer: unknown) => Account[];

export function AccountsPage() {
  const { data, isPending, error } = useQuery(accountsQuery);
  const [query] = useSearchParams();
  const focus = query.get('login');
  const [activeTab, setActiveTab] = useState<'pool' | 'policy'>(() => {
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    return query.get('tab') === 'policy' || hash.endsWith('#policy') || hash.endsWith('#dispatch-order') ? 'policy' : 'pool';
  });
  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const [drafts, setDrafts] = useState<Record<string, LoginDraft>>({});
  const [lines, setLines] = useState<Record<string, ProviderDraft>>({});
  const [credentialDrafts, setCredentialDrafts] = useState<Record<string, CredentialDraft>>({});
  const credentialDraft = (id: string): CredentialDraft => credentialDrafts[id] ?? CREDENTIAL_BLANK;
  const patchCredential = (id: string, part: Partial<CredentialDraft>): void => setCredentialDrafts((all) => ({ ...all, [id]: { ...(all[id] ?? CREDENTIAL_BLANK), ...part } }));
  const dropCredential = (id: string): void => setCredentialDrafts(({ [id]: _dropped, ...rest }) => rest);
  const change = useChange<AccountsAndMachines>({ mutationKey: LOGINS_CHANGE, queryKey: accountsQuery.queryKey, reread: true });
  const { busy } = change;
  const [adding, setAdding] = useState(false);
  const [loginTarget, setLoginTarget] = useState<(Extract<LoginTarget, { mode: 'relogin' }> & { way: 'page' | 'device' }) | null>(null);
  const [tokenFor, setTokenFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [ownRemoving, setOwnRemoving] = useState<string | null>(null);
  const [movingOrder, setMovingOrder] = useState<string | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [preserveGroupRoutes, setPreserveGroupRoutes] = useState(true);
  const [refreshingQuota, setRefreshingQuota] = useState<Record<string, boolean>>({});
  const [quotaErrors, setQuotaErrors] = useState<Record<string, string>>({});
  const refreshingQuotaRef = useRef(new Set<string>());

  const draftOf = (key: string): LoginDraft => drafts[key] ?? BLANK_LOGIN;
  const patch = (key: string, part: Partial<LoginDraft>): void => setDrafts((all) => ({ ...all, [key]: { ...(all[key] ?? BLANK_LOGIN), ...part } }));

  async function changeAccount(key: string, request: () => Promise<unknown>, taken: Taken): Promise<boolean> {
    if (!change.free()) return false;
    patch(key, { saving: true, error: null });
    try {
      await change.send(request, (page, answer) => ({ ...page, accounts: taken(page.accounts, answer) }));
      setDrafts(({ [key]: _changed, ...rest }) => rest);
      return true;
    } catch (refused) {
      patch(key, { saving: false, confirm: refused instanceof ApiError && refused.body.needs_confirm === true, error: messageOf(refused) });
      return false;
    }
  }

  async function changeCredential(account: Account): Promise<void> {
    if (!change.free()) return;
    const value = credentialDraft(account.id).value;
    patchCredential(account.id, { value: '', saving: true, error: null });
    try {
      const path = `/api/accounts/${encodeURIComponent(account.id)}/credential`;
      await change.send(() => put(path, { value }),
        (page, answer) => ({ ...page, accounts: withAccount(page.accounts, (answer as { account: Account }).account) }));
      dropCredential(account.id);
      setTokenFor((open) => (open === account.id ? null : open));
    } catch (refused) {
      patchCredential(account.id, { saving: false, error: messageOf(refused) });
    }
  }

  async function retryAccount(id: string): Promise<void> {
    if (!change.free()) return;
    patch(id, { retrying: true, error: null });
    try {
      await change.send(
        () => post(`/api/accounts/${encodeURIComponent(id)}/retry`),
        (page, answer) => ({ ...page, accounts: withAccount(page.accounts, (answer as { account: Account }).account) }),
      );
      patch(id, { retrying: false });
    } catch (refused) {
      patch(id, { retrying: false, error: messageOf(refused) });
    }
  }

  const checking = useRef(new Set<string>());
  const client = useQueryClient();
  async function checkAccount(id: string): Promise<void> {
    if (checking.current.has(id)) return;
    checking.current.add(id);
    patch(id, { checking: true });
    let check: LoginDraft['check'];
    try {
      const answer = await post<{ machine: MachineCheck | null; unchecked?: string; models?: AccountModels; models_failure?: string }>(`/api/accounts/${encodeURIComponent(id)}/check`);
      check = {
        at: Date.now(), machine: answer.machine,
        ...(answer.unchecked === undefined ? {} : { unchecked: answer.unchecked }),
        ...(answer.models_failure === undefined ? {} : { modelsFailure: answer.models_failure }),
      };
      if (answer.models) {
        client.setQueryData<AccountsAndMachines>(accountsQuery.queryKey, (page) => page && {
          ...page, accounts: page.accounts.map((each) => (each.id === id ? { ...each, models: answer.models } : each)),
        });
      }
    } catch (failure) {
      check = { at: Date.now(), failure: messageOf(failure) };
    }
    checking.current.delete(id);
    patch(id, { checking: false, check });
  }

  async function refreshQuota(loginId: string): Promise<void> {
    if (refreshingQuotaRef.current.has(loginId)) return;
    refreshingQuotaRef.current.add(loginId);
    setRefreshingQuota((all) => ({ ...all, [loginId]: true }));
    setQuotaErrors(({ [loginId]: _gone, ...rest }) => rest);
    try {
      await post('/api/quota/refresh', { login_id: loginId });
      await client.invalidateQueries({ queryKey: accountsQuery.queryKey });
    } catch (failure) {
      setQuotaErrors((all) => ({ ...all, [loginId]: messageOf(failure) }));
    } finally {
      refreshingQuotaRef.current.delete(loginId);
      setRefreshingQuota(({ [loginId]: _done, ...rest }) => rest);
    }
  }

  async function createAccount(form: AccountForm, page: AccountsAndMachines, provider?: ProviderDraft): Promise<void> {
    if (!change.free()) throw new Error(EARLIER_CHANGE);
    const { name: _named, ...body } = accountBody(form, page.permission_modes[form.executor] ?? [], provider);
    let createdId: string | null = null;
    await change.send(
      () => post<{ account: Account }>('/api/accounts', body),
      (held, answer) => {
        createdId = answer.account.id;
        return { ...held, accounts: withAccount(held.accounts, answer.account) };
      },
    );
    if (createdId) setSelectedKey(createdId);
  }

  async function saveTierSlots(tier: TierId, next: TierDispatchSlots): Promise<void> {
    setMovingOrder(tier);
    setOrderError(null);
    try {
      const answer = await put<{ dispatch_slots?: DispatchSlotsConfig; dispatch_order?: Record<string, string[]> }>(
        '/api/dispatch/slots',
        { tier, p1: next.p1, p2: next.p2, off: next.off },
      );
      client.setQueryData<AccountsAndMachines>(accountsQuery.queryKey, (page) => page && {
        ...page,
        dispatch_slots: answer.dispatch_slots ?? { ...(page.dispatch_slots ?? {}), [tier]: next },
        ...(answer.dispatch_order ? { dispatch_order: answer.dispatch_order } : {}),
      });
    } catch (failure) {
      setOrderError(messageOf(failure));
    } finally {
      setMovingOrder(null);
    }
  }

  function saveAccount(account: Account, page: AccountsAndMachines): void {
    const key = account.id;
    const { form } = draftOf(key);
    if (!form || !change.free()) return;
    const name = form.name.trim();
    const refused = name === '' ? '先给这个账号起个名字'
      : page.accounts.some((each) => each.name === name && each.id !== account.id) ? `已经有叫 ${name} 的账号了。要改它，点它的“修改”`
      : null;
    const tierProblem = refused ? null : tierRefusal(form.tiers, tierEditorOf(page.tier_forms, form.executor));
    if (refused || tierProblem) {
      const beside = tierProblem !== null && tierProblem.at !== null;
      patch(key, { error: refused ?? (beside ? null : tierProblem!.message), tierProblem: beside ? tierProblem : null });
      return;
    }
    const line = lines[key];
    const route = line === undefined ? undefined : page.provider_forms?.[form.executor]?.lines.find(({ id }) => id === line.line)?.route;
    const tiers = route === undefined ? form.tiers : withField(form.tiers, tierEditorOf(page.tier_forms, form.executor), 'provider', route);
    const body = accountBody({ ...form, tiers }, page.permission_modes[form.executor] ?? [], line === undefined ? undefined : sendableLine(line, page.provider_forms?.[form.executor]));
    void changeAccount(key, () => put(`/api/accounts/${encodeURIComponent(account.id)}`, body), (accounts, answer) => withAccount(accounts, (answer as { account: Account }).account))
      .then((taken) => { if (taken) setLines(({ [key]: _saved, ...rest }) => rest); });
  }

  async function deleteAccount(account: Account): Promise<void> {
    const path = `/api/accounts/${encodeURIComponent(account.id)}`;
    const taken = await changeAccount(account.id, () => del(`${path}${draftOf(account.id).confirm ? '?confirm=1' : ''}`), (accounts) => accounts.filter((each) => each.id !== account.id));
    if (taken) setDeleting(null);
  }

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

  function saveOwn(machine: Machine, login: MachineLogin): void {
    const key = ownKey(machine, login);
    const { form } = draftOf(key);
    if (!form || !change.free() || !data) return;
    const tierProblem = tierRefusal(form.tiers, tierEditorOf(data.tier_forms, form.executor));
    if (tierProblem) {
      const beside = tierProblem.at !== null;
      patch(key, { error: beside ? null : tierProblem.message, tierProblem: beside ? tierProblem : null });
      return;
    }
    void changeOwn(key, () => put(machineLoginPath(machine, login), loginSettingsBody(form, data.permission_modes[form.executor] ?? [])));
  }

  async function deleteOwn(machine: Machine, login: MachineLogin): Promise<void> {
    if (await changeOwn(ownKey(machine, login), () => del(machineLoginPath(machine, login)))) setOwnRemoving(null);
  }

  function saveGroup(key: string, executor: string, members: readonly OwnMember[]): void {
    const { form } = draftOf(key);
    if (!form || !change.free() || !data) return;
    const tierProblem = tierRefusal(form.tiers, tierEditorOf(data.tier_forms, executor));
    if (tierProblem) {
      const beside = tierProblem.at !== null;
      patch(key, { error: beside ? null : tierProblem.message, tierProblem: beside ? tierProblem : null });
      return;
    }
    const loginIds = members.map((m) => m.login.id).filter((id): id is string => Boolean(id));
    if (loginIds.length === 0) return;
    const editor = tierEditorOf(data.tier_forms, executor);
    const keepPerMachineProvider = preserveGroupRoutes && Boolean(editor?.fields.includes('provider'));
    patch(key, { saving: true, error: null });
    if (keepPerMachineProvider && editor) {
      // Preserve each machine's own route/provider (e.g. office LAN gateway vs home official API)
      // while synchronizing model, effort, permission_mode, timeout, and max_runs.
      void change.send(
        async () => {
          const updated: Machine[] = [];
          for (const member of members) {
            const memberTiers = form.tiers.map((row) => {
              if (!isTierId(row.name) || (row.value.trim() === '' && !row.held)) return row;
              const nextParsed = editor.parse(row.value);
              const existingText = member.login.tiers?.[row.name]?.text ?? '';
              const existingProvider = editor.parse(existingText)?.provider ?? '';
              if (!nextParsed) return row;
              const mergedText = editor.render({ ...nextParsed, provider: existingProvider }, row.value);
              return { ...row, value: mergedText };
            });
            const res = await put<{ machine?: Machine }>(
              machineLoginPath(member.machine, member.login),
              loginSettingsBody({ ...form, tiers: memberTiers }, data.permission_modes[executor] ?? []),
            );
            if (res.machine) updated.push(res.machine);
          }
          return { machines: updated };
        },
        (page, answer) => {
          const updated = (answer as { machines?: Machine[] }).machines ?? [];
          if (updated.length === 0) return page;
          const byId = new Map(updated.map((m) => [m.id, m]));
          return { ...page, machines: page.machines.map((each) => byId.get(each.id) ?? each) };
        },
      ).then(() => {
        setDrafts(({ [key]: _changed, ...rest }) => rest);
      }).catch((refused) => {
        patch(key, { saving: false, error: messageOf(refused) });
      });
      return;
    }
    void change.send(
      () => put('/api/logins/batch', {
        login_ids: loginIds,
        ...loginSettingsBody(form, data.permission_modes[executor] ?? []),
      }),
      (page, answer) => {
        const updated = (answer as { machines?: Machine[] }).machines ?? [];
        if (updated.length === 0) return page;
        const byId = new Map(updated.map((m) => [m.id, m]));
        return { ...page, machines: page.machines.map((each) => byId.get(each.id) ?? each) };
      },
    ).then(() => {
      setDrafts(({ [key]: _changed, ...rest }) => rest);
    }).catch((refused) => {
      patch(key, { saving: false, error: messageOf(refused) });
    });
  }

  const earlier = busy && !Object.values(credentialDrafts).some((draft) => draft.saving) && !Object.values(drafts).some((draft) => draft.saving || draft.retrying);

  const accountOf = (id: string | null): Account | undefined => (id === null ? undefined : data?.accounts.find((each) => each.id === id));
  const edited = data?.accounts.find((each) => drafts[each.id]?.form != null);
  const editing = edited === undefined ? null : { key: edited.id, account: edited, draft: draftOf(edited.id) };
  const closeEditor = (key: string): void => patch(key, { form: null, error: null, tierProblem: null });
  const tokenAccount = accountOf(tokenFor);
  const closeToken = (id: string): void => { dropCredential(id); setTokenFor(null); };
  const doomed = accountOf(deleting);

  const owns = useMemo<OwnMember[]>(
    () => (data?.machines ?? []).flatMap((machine) =>
      (machine.logins ?? []).filter((login) => login.configured).map((login) => ({ machine, login, key: ownKey(machine, login) })),
    ),
    [data?.machines],
  );
  const coveredByAccount = useMemo(
    () => (data ? coveredMachineLoginsByAccount(data) : new Map<string, string>()),
    [data],
  );
  const linkedOwnsByAccount = useMemo(() => {
    const map = new Map<string, OwnMember[]>();
    for (const member of owns) {
      if (!member.login.id) continue;
      const parentId = coveredByAccount.get(member.login.id);
      if (!parentId) continue;
      const list = map.get(parentId);
      if (list) list.push(member);
      else map.set(parentId, [member]);
    }
    return map;
  }, [owns, coveredByAccount]);
  const independentOwns = useMemo(
    () => owns.filter((member) => !member.login.id || !coveredByAccount.has(member.login.id)),
    [owns, coveredByAccount],
  );
  const accountRows = useMemo<LoginRow[]>(
    () => (data?.accounts ?? []).map((account): LoginRow => ({ kind: 'account', key: account.id, account })),
    [data?.accounts],
  );
  const ownRows = useMemo<LoginRow[]>(
    () => independentOwns.map(({ machine, login, key }): LoginRow => ({ kind: 'machine', key, machine, login })),
    [independentOwns],
  );
  const groupRows = useMemo<Extract<LoginRow, { kind: 'group' }>[]>(() => {
    // Group machine-local logins by (executor, verified identity, effective route/provider) so two
    // distinct emails OR two distinct channels (e.g. office LAN `lan-gw` vs paid `deepseek-official`)
    // NEVER merge into one logical account.
    const buckets = new Map<string, { executor: string; identityLabel: string | null; planLabel: string | null; members: OwnMember[] }>();
    for (const member of independentOwns) {
      const idNorm = member.login.account_label?.trim().toLowerCase() || '';
      const routeNorm = normalizeRouteKey(effectiveRouteOfLogin({ routeLabel: member.login.route_label, tiers: member.login.tiers })) || '';
      const suffix = [idNorm, routeNorm].filter(Boolean).join(':');
      const bucketKey = suffix ? `${groupKey(member.login.executor)}:${suffix}` : groupKey(member.login.executor);
      const existing = buckets.get(bucketKey);
      if (existing) {
        existing.members.push(member);
        if (!existing.planLabel && member.login.plan_label) existing.planLabel = member.login.plan_label;
      } else {
        buckets.set(bucketKey, {
          executor: member.login.executor,
          identityLabel: member.login.account_label ?? null,
          planLabel: member.login.plan_label ?? null,
          members: [member],
        });
      }
    }
    const groups: Extract<LoginRow, { kind: 'group' }>[] = [];
    for (const [key, bucket] of buckets) {
      if (bucket.members.length >= 2) {
        groups.push({
          kind: 'group',
          key,
          executor: bucket.executor,
          identityLabel: bucket.identityLabel,
          planLabel: bucket.planLabel,
          members: bucket.members,
        });
      }
    }
    return groups;
  }, [independentOwns]);
  const allRows = useMemo<LoginRow[]>(() => [...accountRows, ...groupRows, ...ownRows], [accountRows, groupRows, ownRows]);

  // If a centralized account shares subscription quota with a machine login, surface the freshest
  // quota reading directly on the account card without duplicating a nested source tree.
  const usageByAccount = useMemo(() => {
    const map = new Map<string, NonNullable<Account['status']>['usage']>();
    const everyIndividual: Extract<LoginRow, { kind: 'account' | 'machine' }>[] = [
      ...accountRows.filter((row): row is Extract<LoginRow, { kind: 'account' }> => row.kind === 'account'),
      ...owns.map(({ machine, login, key }): Extract<LoginRow, { kind: 'machine' }> => ({ kind: 'machine', key, machine, login })),
    ];
    for (const ids of data?.login_groups ?? []) {
      const members = everyIndividual.filter((row) => {
        const id = row.kind === 'account' ? row.account.id : row.login.id;
        return id !== null && ids.includes(id);
      });
      if (members.length < 2) continue;
      const latest = latestQuota(members, (row) => (row.kind === 'account' ? row.account.status : row.login.status)?.usage ?? []);
      const freshest = (latest.kind === 'account' ? latest.account.status : latest.login.status)?.usage ?? [];
      for (const member of members) {
        if (member.kind === 'account') map.set(member.account.id, freshest);
      }
    }
    return map;
  }, [data?.login_groups, accountRows, owns]);

  const needle = search.trim().toLowerCase();
  const visibleAccountRows = useMemo(() => {
    if (!needle) return accountRows;
    return accountRows.filter((row) => {
      if (row.kind !== 'account') return false;
      const { account } = row;
      return account.name.toLowerCase().includes(needle)
        || account.executor.toLowerCase().includes(needle)
        || (account.account_label?.toLowerCase().includes(needle) ?? false)
        || (account.plan_label?.toLowerCase().includes(needle) ?? false)
        || (account.provider?.line?.toLowerCase().includes(needle) ?? false);
    });
  }, [accountRows, needle]);

  const visibleOwnRows = useMemo(() => {
    if (!needle) return ownRows;
    const aliases = data?.login_aliases ?? {};
    return ownRows.filter((row) => {
      if (row.kind !== 'machine') return false;
      const { machine, login } = row;
      const customAlias = login.display_name || (login.id ? aliases[login.id] : undefined) || '';
      return machine.id.toLowerCase().includes(needle)
        || login.executor.toLowerCase().includes(needle)
        || customAlias.toLowerCase().includes(needle)
        || (login.account_label?.toLowerCase().includes(needle) ?? false)
        || (login.plan_label?.toLowerCase().includes(needle) ?? false)
        || (login.route_label?.toLowerCase().includes(needle) ?? false)
        || loginName(login.name).toLowerCase().includes(needle);
    });
  }, [ownRows, needle, data?.login_aliases]);

  // Collapse multi-machine identities (>= 2 machines sharing the same executor + identity) into ONE
  // clean logical account row in the left rail; individual machines live inside the right-side matrix.
  const visibleOwnDisplayRows = useMemo<LoginRow[]>(() => {
    const ordered: LoginRow[] = [];
    const emittedGroups = new Set<string>();
    for (const row of visibleOwnRows) {
      if (row.kind !== 'machine') continue;
      const parentGroup = groupRows.find((g) => g.members.some((m) => m.key === row.key));
      if (parentGroup) {
        if (!emittedGroups.has(parentGroup.key)) {
          emittedGroups.add(parentGroup.key);
          ordered.push(parentGroup);
        }
      } else {
        ordered.push(row);
      }
    }
    return ordered;
  }, [visibleOwnRows, groupRows]);

  // Group all visible accounts (both centralized and local) by Provider / Harness in canonical order
  // so the left rail speaks ONE consistent visual language: Provider -> Alias + Identity + Scope.
  const providerSections = useMemo(() => {
    const map = new Map<string, LoginRow[]>();
    const pushRow = (exec: string, row: LoginRow) => {
      const list = map.get(exec);
      if (list) list.push(row);
      else map.set(exec, [row]);
    };
    for (const row of visibleAccountRows) {
      if (row.kind === 'account') pushRow(row.account.executor, row);
    }
    for (const row of visibleOwnDisplayRows) {
      if (row.kind === 'group') pushRow(row.executor, row);
      else if (row.kind === 'machine') pushRow(row.login.executor, row);
    }
    return [...map.entries()]
      .sort(([a], [b]) => {
        const diff = providerRank(a) - providerRank(b);
        return diff !== 0 ? diff : a.localeCompare(b);
      })
      .map(([executor, rows]) => ({ executor, label: formatProviderName(executor), rows }));
  }, [visibleAccountRows, visibleOwnDisplayRows]);

  const visibleRows = useMemo<LoginRow[]>(
    () => providerSections.flatMap((section) => section.rows),
    [providerSections],
  );

  const logicalEntries = useMemo(
    () => (data ? buildLogicalAccountEntries(data, usageByAccount) : []),
    [data, usageByAccount],
  );
  const slotsByTier = useMemo(
    () => (data ? effectiveSlotsByTier(data, logicalEntries) : {
      operate: { p1: [], p2: [], off: [] },
      execute: { p1: [], p2: [], off: [] },
      decide: { p1: [], p2: [], off: [] },
    }),
    [data, logicalEntries],
  );

  // Sync deep-linked `?login=<id>` into the active selection (resolving multi-machine logins to their logical account).
  useEffect(() => {
    if (!data || !focus) return;
    const matchedAccount = data.accounts.find((each) => each.id === focus);
    if (matchedAccount) {
      setSelectedKey(matchedAccount.id);
      return;
    }
    const matchedOwn = owns.find(({ login }) => login.id === focus);
    if (matchedOwn) {
      const parentAccountId = matchedOwn.login.id ? coveredByAccount.get(matchedOwn.login.id) : undefined;
      if (parentAccountId) {
        setSelectedKey(parentAccountId);
        return;
      }
      const group = groupRows.find((g) => g.members.some((m) => m.key === matchedOwn.key));
      setSelectedKey(group ? group.key : matchedOwn.key);
    }
  }, [data, focus, owns, groupRows, coveredByAccount]);

  const selectedRow = visibleRows.find((row) => row.key === selectedKey) ?? visibleRows[0] ?? null;

  const focusReady = data !== undefined;
  useEffect(() => {
    if (focusReady && focus) document.getElementById(focus)?.scrollIntoView({ block: 'center' });
  }, [focusReady, focus, selectedRow?.key]);

  const handleRailKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (visibleRows.length <= 1) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select') !== null) return;
    event.preventDefault();
    const index = visibleRows.findIndex((row) => row.key === selectedRow?.key);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = visibleRows[index < 0 ? 0 : (index + delta + visibleRows.length) % visibleRows.length];
    if (next) {
      setSelectedKey(next.key);
      rowRefs.current.get(next.key)?.focus();
    }
  };

  const editedOwn = owns.find(({ key }) => drafts[key]?.form != null);
  const editingOwn = editedOwn === undefined ? null : { ...editedOwn, draft: draftOf(editedOwn.key) };
  const editedGroup = groupRows.find(({ key }) => drafts[key]?.form != null);
  const editingGroup = editedGroup === undefined ? null : { ...editedGroup, draft: draftOf(editedGroup.key) };
  const ownDoomed = owns.find(({ key }) => key === ownRemoving) ?? null;

  async function renameLoginAlias(target: string, nextName: string | null): Promise<void> {
    const answer = await put<{ target: string; name: string | null; login_aliases: Record<string, string> }>(
      '/api/logins/alias',
      { target, name: nextName },
    );
    client.setQueryData<AccountsAndMachines>(accountsQuery.queryKey, (page) => {
      if (!page) return page;
      const accounts = page.accounts.map((acc) => (acc.id === target && answer.name ? { ...acc, name: answer.name } : acc));
      const machines = page.machines.map((m) => ({
        ...m,
        logins: (m.logins ?? []).map((l) => (l.id === target ? { ...l, display_name: answer.name } : l)),
      }));
      return { ...page, accounts, machines, login_aliases: answer.login_aliases };
    });
  }

  const renderDetail = (row: LoginRow) => {
    if (row.kind === 'group') {
      const draft = draftOf(row.key);
      const refreshTarget = row.members.find((m) => m.machine.node.connected && m.login.id)?.login.id
        ?? row.members.find((m) => m.login.id)?.login.id
        ?? null;
      return (
        <UnifiedGroupDetail
          key={row.key}
          groupKeyId={row.key}
          executor={row.executor}
          identityLabel={row.identityLabel}
          planLabel={row.planLabel}
          members={row.members}
          page={data!}
          slotsByTier={slotsByTier}
          busy={busy}
          failure={draft.form === null ? draft.error : null}
          refreshingQuota={refreshTarget !== null && Boolean(refreshingQuota[refreshTarget])}
          quotaError={refreshTarget !== null ? (quotaErrors[refreshTarget] ?? null) : null}
          onRename={(nextName) => renameLoginAlias(row.key, nextName)}
          onRefreshQuota={() => { if (refreshTarget) void refreshQuota(refreshTarget); }}
          onOpenPolicy={() => setActiveTab('policy')}
          onBatchEdit={() => patch(row.key, { form: formOf(row.members[0]!.login), confirm: false, error: null, tierProblem: null })}
          onEditMember={(member) => patch(member.key, { form: formOf(member.login), confirm: false, error: null, tierProblem: null })}
          onRetryMember={(member) => void changeOwn(member.key, () => post(machineLoginPath(member.machine, member.login) + '/retry'), 'retrying')}
          onDeleteMember={(member) => { patch(member.key, { confirm: false, error: null }); setOwnRemoving(member.key); }}
        />
      );
    }
    const draft = draftOf(row.key);
    const account = row.kind === 'account' ? row.account : null;
    const own = row.kind === 'machine' ? row : null;
    const loginId = account?.id ?? own?.login.id ?? null;
    const aliasTarget = account?.id ?? own?.login.id ?? row.key;
    return (
      <LoginDetail
        key={row.key}
        row={row}
        page={data!}
        slotsByTier={slotsByTier}
        usageOverride={account ? usageByAccount.get(account.id) : undefined}
        linkedOwns={account ? linkedOwnsByAccount.get(account.id) : undefined}
        draft={draft}
        busy={busy}
        failure={draft.form === null && (account ? deleting !== row.key : ownRemoving !== row.key) ? draft.error : null}
        refreshingQuota={loginId !== null && Boolean(refreshingQuota[loginId])}
        quotaError={loginId !== null ? (quotaErrors[loginId] ?? null) : null}
        onRename={(nextName) => renameLoginAlias(aliasTarget, nextName)}
        onOpenPolicy={() => setActiveTab('policy')}
        onRefreshQuota={() => { if (loginId) void refreshQuota(loginId); }}
        onCheck={() => { if (account) void checkAccount(account.id); }}
        onRetry={() => { if (account) void retryAccount(account.id); else if (own) void changeOwn(row.key, () => post(machineLoginPath(own.machine, own.login) + '/retry'), 'retrying'); }}
        onRelogin={(way) => { if (account) setLoginTarget({ mode: 'relogin', account: account.id, name: account.name, way }); }}
        onEdit={() => patch(row.key, { form: formOf(account ?? own!.login), confirm: false, error: null, tierProblem: null })}
        onToken={() => { if (account) { dropCredential(account.id); setTokenFor(account.id); } }}
        onDelete={() => { patch(row.key, { confirm: false, error: null }); if (account) setDeleting(account.id); else setOwnRemoving(row.key); }}
        onEditLinkedOwn={(member) => patch(member.key, { form: formOf(member.login), confirm: false, error: null, tierProblem: null })}
        onDeleteLinkedOwn={(member) => { patch(member.key, { confirm: false, error: null }); setOwnRemoving(member.key); }}
      />
    );
  };

  const decideP1Names = slotsByTier.decide.p1
    .map((k) => logicalEntries.find((e) => e.key === k)?.name)
    .filter((name): name is string => Boolean(name));

  return (
    <Page
      title="账号"
      width="wide"
      loading={isPending}
      failure={error?.message}
      actions={data ? <Button variant="primary" disabled={busy} onClick={() => setAdding(true)}><Plus />{ADD}</Button> : undefined}
    >
      {data ? (
        <>
          {earlier ? <Callout tone="plain" role="status" className="mb-3">{EARLIER_CHANGE}</Callout> : null}

          {allRows.length > 0 ? (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div role="tablist" aria-label="账号视图切换" className="inline-flex items-center rounded-lg border border-border bg-muted/70 p-0.5 text-xs">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'pool'}
                  onClick={() => setActiveTab('pool')}
                  className={cn(
                    'cursor-pointer rounded-md px-3 py-1.5 font-medium tabular-nums transition-colors',
                    activeTab === 'pool'
                      ? 'bg-raised text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {`账号池 · ${logicalEntries.length}`}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'policy'}
                  onClick={() => setActiveTab('policy')}
                  className={cn(
                    'inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors',
                    activeTab === 'policy'
                      ? 'bg-raised text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <SlidersHorizontal className="size-3.5" aria-hidden="true" />
                  派发策略（优先级槽）
                </button>
              </div>

              {activeTab === 'pool' && decideP1Names.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setActiveTab('policy')}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-raised px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
                >
                  <span>决策档 P1：</span>
                  <strong className="font-medium text-foreground">{decideP1Names.join(' + ')}</strong>
                  <span className="text-primary">调整 →</span>
                </button>
              ) : null}
            </div>
          ) : (
            <PageLead className="mb-3">一处添加并统一保管账号，项目放行的所有在线机器共用；额度耗尽时按策略自动切换。</PageLead>
          )}

          {allRows.length === 0 ? (
            <Empty icon={<KeyRound />} title="还没有集中托管账号">
              点右上角的“添加账号”，完成一次授权或填入密钥即可分发给所有在线机器共用。
            </Empty>
          ) : activeTab === 'policy' ? (
            <DispatchSlotsPanel
              page={data}
              entries={logicalEntries}
              slotsByTier={slotsByTier}
              busy={movingOrder !== null}
              error={orderError}
              onSaveTier={(tier, next) => void saveTierSlots(tier, next)}
            />
          ) : (
            <div className="grid grid-cols-1 items-start gap-5 shell:grid-cols-[268px_minmax(0,1fr)] wide:grid-cols-[296px_minmax(0,1fr)]">
              <aside
                aria-label="账号列表"
                className="overflow-hidden rounded-xl bg-raised shadow-card shell:sticky shell:top-4"
                onKeyDown={handleRailKeyDown}
              >
                {allRows.length > 5 ? (
                  <div className="border-b border-border/70 p-2.5">
                    <div className="relative">
                      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" aria-hidden="true" />
                      <Input
                        aria-label="搜索账号"
                        placeholder="搜索别名、登录身份、渠道或机器…"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        className="h-8 pl-8 text-xs"
                      />
                    </div>
                  </div>
                ) : null}

                {providerSections.length > 0 ? (
                  <div className="divide-y divide-border/70">
                    {providerSections.map((section) => (
                      <div key={section.executor}>
                        <div className="flex items-center justify-between border-b border-border/50 bg-muted/45 px-3.5 py-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                          <span className="inline-flex items-center gap-1.5">
                            <span aria-hidden="true" className={cn('size-1.5 rounded-full', PROVIDER_ACCENT[section.executor] ?? 'bg-muted-foreground')} />
                            {section.label}
                          </span>
                          <span className="rounded-full bg-hover px-1.5 text-[10px] leading-[16px] tabular-nums">
                            {section.rows.length}
                          </span>
                        </div>
                        <ul role="group" aria-label={`${section.label} 账号`} className="divide-y divide-border/50">
                          {section.rows.map((row) => {
                            const active = selectedRow?.key === row.key;
                            if (row.kind === 'account') {
                              const { account } = row;
                              const standing = standingOf(account);
                              const usage = usageByAccount.get(account.id) ?? account.status?.usage ?? [];
                              const quota = railQuotaHint(usage);
                              const idLine = accountIdentityLine(account);
                              const subLeft = standing.tone !== 'success' ? `${idLine} · ${standing.text}` : idLine;
                              return (
                                <li key={row.key}>
                                  <button
                                    ref={(node) => {
                                      if (node) rowRefs.current.set(row.key, node);
                                      else rowRefs.current.delete(row.key);
                                    }}
                                    type="button"
                                    aria-label={`选择账号 ${account.name}`}
                                    aria-current={active ? 'true' : undefined}
                                    onClick={() => setSelectedKey(row.key)}
                                    className={cn(
                                      'relative flex w-full flex-col gap-1 px-3.5 py-2.5 text-left transition-colors hover:bg-hover/60',
                                      active && 'bg-brand-soft/45 hover:bg-brand-soft/55',
                                    )}
                                  >
                                    {active ? <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-primary" /> : null}
                                    <div className="flex items-center gap-2">
                                      <Dot tone={dotToneOf(standing.tone)} />
                                      <span className={cn('min-w-0 flex-1 truncate text-sm text-foreground', active ? 'font-semibold' : 'font-medium')}>
                                        {account.name}
                                      </span>
                                      <span className="flex-none rounded-md bg-brand-soft/80 px-1.5 py-0.5 text-[10px] font-medium text-brand-foreground">
                                        全机分发
                                      </span>
                                    </div>
                                    <div className="flex items-center justify-between gap-2 pl-4 text-xs text-muted-foreground">
                                      <span className={cn('min-w-0 truncate font-mono text-[11px]', standing.tone === 'failed' ? 'font-medium text-failed-foreground' : standing.tone === 'waiting' ? 'text-waiting-foreground' : undefined)}>
                                        {subLeft}
                                      </span>
                                      {quota ? (
                                        <span className="flex-none text-[11px] text-muted-foreground tabular-nums">{quota}</span>
                                      ) : account.queued_tasks > 0 ? (
                                        <span className="flex-none rounded-full bg-hover px-1.5 text-[10px] leading-[16px] text-muted-foreground tabular-nums">
                                          {`排队 ${account.queued_tasks}`}
                                        </span>
                                      ) : null}
                                    </div>
                                  </button>
                                </li>
                              );
                            }

                            if (row.kind === 'group') {
                              const provider = formatProviderName(row.executor);
                              const sampleRoute = row.members
                                .map((m) => effectiveRouteOfLogin({ routeLabel: m.login.route_label, tiers: m.login.tiers }))
                                .find((r): r is string => Boolean(r)) ?? null;
                              const title = data.login_aliases?.[row.key]
                                || (row.identityLabel ? (sampleRoute ? `${row.identityLabel} · ${sampleRoute}` : row.identityLabel)
                                  : sampleRoute ? `${provider} · ${sampleRoute}` : provider);
                              const readyCount = row.members.filter((m) => machineLoginStanding(m.login).tone === 'success').length;
                              const gt = sumTelemetry(row.members.map((m) => m.login.id), data.login_telemetry);
                              const freshest = latestQuota(row.members, (m) => m.login.status?.usage ?? []).login.status?.usage ?? [];
                              const groupQuota = railQuotaHint(freshest);
                              const subLeft = [
                                ...(row.identityLabel && row.identityLabel !== title ? [row.identityLabel] : []),
                                ...(row.planLabel ? [row.planLabel] : []),
                                `${readyCount}/${row.members.length} 在线`,
                              ].join(' · ');
                              return (
                                <li key={row.key}>
                                  <button
                                    ref={(node) => {
                                      if (node) rowRefs.current.set(row.key, node);
                                      else rowRefs.current.delete(row.key);
                                    }}
                                    type="button"
                                    aria-label={`选择逻辑账号 ${provider}`}
                                    aria-current={active ? 'true' : undefined}
                                    onClick={() => setSelectedKey(row.key)}
                                    className={cn(
                                      'relative flex w-full flex-col gap-1 px-3.5 py-2.5 text-left transition-colors hover:bg-hover/60',
                                      active && 'bg-brand-soft/45 hover:bg-brand-soft/55',
                                    )}
                                  >
                                    {active ? <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-primary" /> : null}
                                    <div className="flex items-center gap-2">
                                      <Dot tone={readyCount > 0 ? 'success' : 'waiting'} />
                                      <span className={cn('min-w-0 flex-1 truncate text-sm text-foreground', active ? 'font-semibold' : 'font-medium')}>
                                        {title}
                                      </span>
                                      <span className="flex-none rounded-md bg-hover px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums">
                                        {`${row.members.length} 台授权`}
                                      </span>
                                    </div>
                                    <div className="flex items-center justify-between gap-2 pl-4 text-xs text-muted-foreground">
                                      <span className="min-w-0 truncate font-mono text-[11px] tabular-nums">{subLeft}</span>
                                      {groupQuota ? (
                                        <span className="flex-none text-[11px] text-muted-foreground tabular-nums">{groupQuota}</span>
                                      ) : gt && gt.day_tokens > 0 ? (
                                        <span className="flex-none text-[11px] text-muted-foreground tabular-nums">{`24h ${formatCompactTokens(gt.day_tokens)}`}</span>
                                      ) : null}
                                    </div>
                                  </button>
                                </li>
                              );
                            }

                            const { machine, login } = row;
                            const standing = machineLoginStanding(login);
                            const quota = railQuotaHint(login.status?.usage ?? []);
                            const mt = login.id ? data.login_telemetry?.[login.id] : undefined;
                            const title = login.display_name || (login.id ? data.login_aliases?.[login.id] : undefined) || login.account_label || formatProviderName(login.executor);
                            const subLeft = [
                              ...(login.account_label && login.account_label !== title ? [login.account_label] : []),
                              ...(login.plan_label ? [login.plan_label] : []),
                              ...(login.route_label ? [login.route_label] : []),
                              machine.id,
                              ...(standing.tone !== 'success' ? [standing.text] : []),
                            ].join(' · ');
                            return (
                              <li key={row.key}>
                                <button
                                  ref={(node) => {
                                    if (node) rowRefs.current.set(row.key, node);
                                    else rowRefs.current.delete(row.key);
                                  }}
                                  type="button"
                                  aria-label={ownRailLabel(machine, login)}
                                  aria-current={active ? 'true' : undefined}
                                  onClick={() => setSelectedKey(row.key)}
                                  className={cn(
                                    'relative flex w-full flex-col gap-1 px-3.5 py-2.5 text-left transition-colors hover:bg-hover/60',
                                    active && 'bg-brand-soft/45 hover:bg-brand-soft/55',
                                  )}
                                >
                                  {active ? <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-primary" /> : null}
                                  <div className="flex items-center gap-2">
                                    <Dot tone={dotToneOf(standing.tone)} />
                                    <span className={cn('min-w-0 flex-1 truncate text-sm text-foreground', active ? 'font-semibold' : 'font-medium')}>
                                      {title}
                                    </span>
                                    <span className="flex-none rounded-md bg-hover px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                      1 台授权
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between gap-2 pl-4 text-xs text-muted-foreground">
                                    <span className={cn('min-w-0 truncate font-mono text-[11px]', standing.tone === 'failed' ? 'font-medium text-failed-foreground' : standing.tone === 'waiting' ? 'text-waiting-foreground' : undefined)}>
                                      {subLeft}
                                    </span>
                                    {quota ? (
                                      <span className="flex-none text-[11px] text-muted-foreground tabular-nums">{quota}</span>
                                    ) : mt && mt.day_tokens > 0 ? (
                                      <span className="flex-none text-[11px] text-muted-foreground tabular-nums">{`24h ${formatCompactTokens(mt.day_tokens)}`}</span>
                                    ) : null}
                                  </div>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="px-3.5 py-6 text-center text-xs text-faint">没有匹配的账号</p>
                )}
              </aside>

              <div className="min-w-0">
                {selectedRow ? renderDetail(selectedRow) : (
                  <div className="rounded-xl bg-raised px-6 py-10 text-center shadow-card">
                    <Note className="text-xs">当前筛选下没有匹配的账号。</Note>
                  </div>
                )}
              </div>
            </div>
          )}

          <Sheet open={editing !== null} onOpenChange={(open) => { if (!open && editing && !editing.draft.saving) closeEditor(editing.key); }}>
            {editing?.draft.form ? (
              <SheetContent title={`修改 ${editing.account.name}`}>
                <LoginEditor
                  account={editing.account}
                  form={editing.draft.form}
                  saving={editing.draft.saving}
                  busy={busy}
                  page={data}
                  problem={editing.draft.tierProblem}
                  {...(editing.account.provider && data.provider_forms?.[editing.account.executor] ? {
                    hidden: ['provider'] as const,
                    before: (
                      <LineFields
                        form={data.provider_forms[editing.account.executor]!}
                        draft={lines[editing.key] ?? editing.account.provider}
                        disabled={editing.draft.saving}
                        onChange={(next) => setLines((all) => ({ ...all, [editing.key]: next }))}
                      />
                    ),
                  } : {})}
                  onEdit={(name, value) => setDrafts((all) => {
                    const current = all[editing.key] ?? BLANK_LOGIN;
                    if (!current.form) return all;
                    return { ...all, [editing.key]: { ...current, form: { ...current.form, [name]: value }, ...(name === 'tiers' ? { tierProblem: null } : {}) } };
                  })}
                  onSave={() => saveAccount(editing.account, data)}
                  onCancel={() => closeEditor(editing.key)}
                />
                {editing.draft.error ? <Problem role="alert" className="mt-3">{editing.draft.error}</Problem> : null}
              </SheetContent>
            ) : null}
          </Sheet>

          <Sheet open={editingOwn !== null} onOpenChange={(open) => { if (!open && editingOwn && !editingOwn.draft.saving) closeEditor(editingOwn.key); }}>
            {editingOwn && editingOwn.draft.form ? (
              <SheetContent title={`修改 ${loginName(editingOwn.login.name)}`} description="这台机器本地已登录的执行器，仅在这台机器上使用。">
                <LoginEditor
                  own={editingOwn.login}
                  form={editingOwn.draft.form}
                  saving={editingOwn.draft.saving}
                  busy={busy}
                  page={data}
                  problem={editingOwn.draft.tierProblem}
                  onEdit={(name, value) => setDrafts((all) => {
                    const current = all[editingOwn.key] ?? BLANK_LOGIN;
                    if (!current.form) return all;
                    return { ...all, [editingOwn.key]: { ...current, form: { ...current.form, [name]: value }, ...(name === 'tiers' ? { tierProblem: null } : {}) } };
                  })}
                  onSave={() => saveOwn(editingOwn.machine, editingOwn.login)}
                  onCancel={() => closeEditor(editingOwn.key)}
                />
                {editingOwn.draft.error ? <Problem role="alert" className="mt-3">{editingOwn.draft.error}</Problem> : null}
              </SheetContent>
            ) : null}
          </Sheet>

          <Sheet open={editingGroup !== null} onOpenChange={(open) => { if (!open && editingGroup && !editingGroup.draft.saving) closeEditor(editingGroup.key); }}>
            {editingGroup && editingGroup.draft.form ? (
              <SheetContent
                title={`统一修改 ${formatProviderName(editingGroup.executor)}（${editingGroup.members.length} 台机器）`}
                description={`保存后将同步写入 ${editingGroup.members.map((m) => m.machine.id).join('、')} 的档位、权限、超时和并发设置；各机器本地 OAuth 授权不受影响。`}
              >
                {tierEditorOf(data.tier_forms, editingGroup.executor)?.fields.includes('provider') ? (
                  <div className="mb-4 rounded-lg border border-border bg-muted/45 px-3 py-2.5 text-xs">
                    <Choice className="items-start">
                      <Checkbox
                        aria-label="保留各台机器原有线路"
                        checked={preserveGroupRoutes}
                        disabled={editingGroup.draft.saving}
                        onChange={() => setPreserveGroupRoutes((prev) => !prev)}
                      />
                      <span>
                        <strong className="font-medium text-foreground">保留各台机器原有线路</strong>
                        <span className="mt-0.5 block text-muted-foreground">
                          勾选时仅同步模型、推理强度、权限与并发，避免公司与家里走不同线路时互相覆盖。
                        </span>
                      </span>
                    </Choice>
                  </div>
                ) : null}
                <LoginEditor
                  own={editingGroup.members[0]!.login}
                  form={editingGroup.draft.form}
                  saving={editingGroup.draft.saving}
                  busy={busy}
                  page={data}
                  problem={editingGroup.draft.tierProblem}
                  onEdit={(name, value) => setDrafts((all) => {
                    const current = all[editingGroup.key] ?? BLANK_LOGIN;
                    if (!current.form) return all;
                    return { ...all, [editingGroup.key]: { ...current, form: { ...current.form, [name]: value }, ...(name === 'tiers' ? { tierProblem: null } : {}) } };
                  })}
                  onSave={() => saveGroup(editingGroup.key, editingGroup.executor, editingGroup.members)}
                  onCancel={() => closeEditor(editingGroup.key)}
                />
                {editingGroup.draft.error ? <Problem role="alert" className="mt-3">{editingGroup.draft.error}</Problem> : null}
              </SheetContent>
            ) : null}
          </Sheet>

          <Dialog open={tokenAccount !== undefined} onOpenChange={(open) => { if (!open && tokenAccount && !credentialDraft(tokenAccount.id).saving) closeToken(tokenAccount.id); }}>
            {tokenAccount ? (
              <DialogContent title={`更换 ${tokenAccount.name} 的 ${credentialText.typed.label}`} description="新的存好了才替换旧的；填的内容只送出去一次，不会再显示。">
                <CredentialForm
                  account={tokenAccount}
                  draft={credentialDraft(tokenAccount.id)}
                  busy={busy}
                  onEdit={(value) => patchCredential(tokenAccount.id, { value })}
                  onSave={() => void changeCredential(tokenAccount)}
                  onCancel={() => closeToken(tokenAccount.id)}
                />
              </DialogContent>
            ) : null}
          </Dialog>

          <Confirm
            open={doomed !== undefined}
            title={`删除账号 ${doomed?.name ?? ''}？`}
            description="删掉以后，tycho 不再保管这份登录。它上面还有排队的任务或没结束的执行时，服务会先说代价，再点一次才删。"
            confirm={doomed && draftOf(doomed.id).saving ? '删除中' : `确认删除 ${doomed?.name ?? ''}`}
            cancel="不删了"
            busy={doomed ? draftOf(doomed.id).saving : false}
            error={doomed ? draftOf(doomed.id).error : null}
            onConfirm={() => { if (doomed) void deleteAccount(doomed); }}
            onCancel={() => { if (doomed) patch(doomed.id, { confirm: false, error: null }); setDeleting(null); }}
          />

          <Confirm
            open={ownDoomed !== null}
            title={ownDoomed ? `删除 ${loginName(ownDoomed.login.name)}？` : ''}
            description="删掉的是 tycho 给这份单机登录记录的档位和限制；那台机器上执行器本身的登录状态不受影响。若之后还要用，到“机器”页重新启用即可。"
            confirm={ownDoomed && draftOf(ownDoomed.key).saving ? '删除中' : '确认删除'}
            cancel="不删了"
            busy={ownDoomed ? draftOf(ownDoomed.key).saving : false}
            error={ownDoomed ? draftOf(ownDoomed.key).error : null}
            onConfirm={() => { if (ownDoomed) void deleteOwn(ownDoomed.machine, ownDoomed.login); }}
            onCancel={() => { if (ownDoomed) patch(ownDoomed.key, { error: null }); setOwnRemoving(null); }}
          />

          <AddAccountWindow open={adding} page={data} busy={busy} onCreate={(form, provider) => createAccount(form, data, provider)} onClose={() => setAdding(false)} />
          <ReloginWindow target={loginTarget?.way === 'page' ? loginTarget : null} page={data} onClose={() => setLoginTarget(null)} />
          <CodexReloginWindow target={loginTarget?.way === 'device' ? loginTarget : null} page={data} onClose={() => setLoginTarget(null)} />
        </>
      ) : null}
    </Page>
  );
}
