// The inbound sources of the whole tycho (docs/design/triggers.md §2.2, §7): one caller each, its
// translator kind, the projects it may deliver to, its own address and rotating key, what it last
// refused and any problem of its own. Never inside a project's card: a source can reach several
// projects and belongs to none of them. A key's secret is shown once, in the answer that issued it.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Radio } from 'lucide-react';
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { InboundKind } from '@shared/triggers.ts';
import { Callout, Card, CopyButton, Copyable, Dot, Empty, Fact, Facts, Field, Mono, Note, Problem, Rows, SectionTitle, Time, type Tone } from '@/components/bits';
import { Page, PageLead } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, Choice } from '@/components/ui/checkbox';
import { Confirm, Sheet, SheetContent } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Option, Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { del, messageOf, post, put } from '@/lib/api';
import { fireLine } from '@/lib/triggers';
import { githubSigningText, inboundAddress, inboundBody, inboundDraftOf, emptyInboundDraft, keyLine, projectLine, standardWebhooksSigningText, tychoSigningText, type InboundDraft } from '@/lib/inbound';
import { inboundQuery } from '@/lib/queries';
import type { BroadcastGroupChoice, InboundPage, InboundSource, IssuedInboundKey, TriggerFire } from '@/lib/types';
import { cn } from '@/lib/utils';

const RECENT_SHOWN = 10;

// Which project a recent acceptance went to: a source may let several through, so the record
// alone does not say it. A project gone from the ledger is still told apart by its number.
const projectName = (id: string, projects: InboundPage['projects']): string => projects.find((project) => project.id === id)?.name ?? id;

function sourceDotTone(source: InboundSource): Tone {
  if (!source.enabled) return 'ended';
  if (source.problem || source.rejected) return 'failed';
  if (!source.ready) return 'waiting';
  return 'success';
}

function shortKindLabel(source: InboundSource): string {
  if (source.kind === 'github') return 'GitHub';
  if (source.kind === 'standard-webhooks') return 'Standard Webhooks';
  if (source.kind === 'tycho-v1') return 'tycho-v1';
  return source.kind_label;
}

function matchesSource(fire: TriggerFire, source: InboundSource): boolean {
  if (fire.source_id != null) return fire.source_id === source.id;
  return fire.trigger_name === source.name;
}

function replyModeText(source: InboundSource): string {
  const parts: string[] = [];
  if (source.push_final) parts.push('推送本回合终稿');
  if (source.broadcast_groups) {
    parts.push(source.broadcast_group_ids?.length
      ? `同步播报到指定的 ${source.broadcast_group_ids.length} 个绑定群`
      : '同步播报到目标项目绑定群');
  }
  if (source.result_reply) parts.push('允许来源回读答复');
  return parts.length > 0 ? parts.join('；') : '仅受理并交给负责人';
}

function SourceForm({ id, draft, kind, made, projects, groups = [], busy, error, onChange, onSave }: {
  id: string;
  draft: InboundDraft;
  // The kind it was made as; a new one starts from the first the service offers.
  made: boolean;
  kind: { kind: InboundKind; label: string; about: string }[];
  projects: InboundPage['projects'];
  groups?: BroadcastGroupChoice[];
  busy: boolean;
  error: string | null;
  onChange: (draft: InboundDraft) => void;
  onSave: () => void;
}) {
  const set = (patch: Partial<InboundDraft>) => onChange({ ...draft, ...patch });
  const about = kind.find((each) => each.kind === draft.kind)?.about ?? '';
  const matchingGroups = groups.filter((group) => !group.project_id || draft.projectIds.includes(group.project_id));
  const pruneGroupsForProjects = (projectIds: string[]): string[] => (
    groups.length > 0
      ? draft.broadcastGroupIds.filter((gid) => {
          const found = groups.find((group) => group.id === gid);
          return !found || !found.project_id || projectIds.includes(found.project_id);
        })
      : draft.broadcastGroupIds
  );
  const changeKind = (nextKind: InboundKind): void => {
    if (nextKind === 'standard-webhooks' && draft.projectIds.length > 1) {
      const nextProjectIds = draft.projectIds.slice(0, 1);
      set({ kind: nextKind, projectIds: nextProjectIds, broadcastGroupIds: pruneGroupsForProjects(nextProjectIds) });
      return;
    }
    set({ kind: nextKind });
  };
  const toggle = (projectId: string): void => {
    const nextProjectIds = draft.kind === 'standard-webhooks'
      ? (draft.projectIds.length === 1 && draft.projectIds[0] === projectId ? [] : [projectId])
      : (draft.projectIds.includes(projectId)
          ? draft.projectIds.filter((each) => each !== projectId)
          : [...draft.projectIds, projectId]);
    set({ projectIds: nextProjectIds, broadcastGroupIds: pruneGroupsForProjects(nextProjectIds) });
  };
  const toggleGroup = (groupId: string): void => set({
    broadcastGroupIds: draft.broadcastGroupIds.includes(groupId)
      ? draft.broadcastGroupIds.filter((each) => each !== groupId)
      : [...draft.broadcastGroupIds, groupId],
  });
  const projectHint = draft.kind === 'standard-webhooks'
    ? 'Standard Webhooks 协议签名不含项目头，每个来源只放行 1 个项目（切换为该种类时会自动保留首个已选项目）。'
    : '至少一个。tycho-v1 在只选 1 个项目时自动路由（多项目时按签名中的项目编号头指定）；GitHub 按项目配的仓库对上。只有这里勾了的项目收得到。';
  return (
    <form id={id} className="grid gap-4" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <Field label="名字" hint="给谁投的、投的是什么，写给主人和负责人看。">
        <Input aria-label="入站来源的名字" placeholder="例如：构建服务器的部署通知" value={draft.name} disabled={busy} onChange={(event) => set({ name: event.target.value })} />
      </Field>
      <Field label="翻译器种类" hint={about}>
        <Select aria-label="翻译器种类" value={draft.kind} disabled={busy} onChange={(event) => changeKind(event.target.value as InboundKind)}>
          {kind.map((each) => <Option key={each.kind} value={each.kind}>{each.label}</Option>)}
        </Select>
      </Field>
      <Field label="放行的项目" hint={projectHint}>
        <div className="grid gap-1">
          {projects.length === 0 ? <Note className="text-xs">还没有项目：先在项目列表里建一个。</Note> : null}
          {projects.map((project) => (
            <Choice key={project.id} className="min-h-9">
              <Checkbox aria-label={project.name} checked={draft.projectIds.includes(project.id)} disabled={busy} onChange={() => toggle(project.id)} />
              <span>{project.name}</span>
              {draft.kind !== 'github'
                ? <Mono className="ml-auto text-xs text-muted-foreground">{project.id}</Mono>
                : project.repos.length > 0
                  ? <Mono className="ml-auto text-xs text-muted-foreground">{project.repos.join('、')}</Mono>
                  : <span className="ml-auto text-xs text-waiting-foreground">没配仓库</span>}
            </Choice>
          ))}
        </div>
      </Field>
      <Field label="说明（可选）" hint="写给负责人看的：这是谁、它的请求一般怎么处理。会随每条消息一起交给负责人，是资料，不是指令。">
        <Textarea aria-label="来源说明" rows={3} className="max-h-[40vh] overflow-y-auto" value={draft.note} disabled={busy} onChange={(event) => set({ note: event.target.value })} />
      </Field>
      <Choice className="items-start">
        <Switch aria-label="推送本回合终稿" className="mt-1.5" checked={draft.pushFinal} disabled={busy} onCheckedChange={(on) => set({ pushFinal: on })} />
        <span className="py-1.5">推送本回合终稿：负责人处理完这条消息后，把它这一回合的最终回复推给你</span>
      </Choice>
      <div className="grid gap-2">
        <Choice className="items-start">
          <Switch aria-label="同步播报到绑定群" className="mt-1.5" checked={draft.broadcastGroups} disabled={busy} onCheckedChange={(on) => set({ broadcastGroups: on })} />
          <span className="py-1.5">
            同步播报到绑定群
            <span className="mt-0.5 block text-xs text-muted-foreground">
              开启后，负责人处理完告警/事件会把结论同步播报到目标项目已开启播报的绑定群（默认广播到全部符合条件的群，也可在下方限定特定群）
            </span>
          </span>
        </Choice>
        {draft.broadcastGroups && matchingGroups.length > 0 ? (
          <div className="ml-11 grid gap-1 rounded-lg border border-border bg-muted/60 p-3">
            <span className="mb-0.5 text-xs font-medium text-muted-foreground">限定播报群（全不选则广播到全部符合条件的绑定群）</span>
            {matchingGroups.map((group) => (
              <Choice key={group.id} className="min-h-8">
                <Checkbox
                  aria-label={group.chat_name || group.chat_id}
                  checked={draft.broadcastGroupIds.includes(group.id)}
                  disabled={busy}
                  onChange={() => toggleGroup(group.id)}
                />
                <span className="min-w-0 truncate text-sm">{group.chat_name || group.chat_id}</span>
                <Badge tone="plain" className="text-2xs">{group.channel === 'wecom' ? '企业微信' : '微信'}</Badge>
                {(!group.enabled || !group.notify_events) ? (
                  <Badge tone="waiting" className="ml-auto text-2xs">{!group.enabled ? '已停用' : '未开播报'}</Badge>
                ) : null}
              </Choice>
            ))}
          </div>
        ) : null}
      </div>
      {draft.kind === 'tycho-v1' ? (
        <Choice className="items-start">
          <Switch aria-label="允许来源回读答复" className="mt-1.5" checked={draft.resultReply} disabled={busy} onCheckedChange={(on) => set({ resultReply: on })} />
          <span className="py-1.5">允许来源回读答复。新事件可以凭原回执读取负责人专门提供的答复。</span>
        </Choice>
      ) : null}
      {!made ? null : <Note className="text-xs">名字、种类、放行的项目和说明改了之后，已经在排队或处理过的消息不改，新的请求开始用新的。</Note>}
      {error ? <Problem role="alert">{error}</Problem> : null}
    </form>
  );
}

function SourceRailItem({ source, active, buttonRef, onSelect }: {
  source: InboundSource;
  active: boolean;
  buttonRef?: (node: HTMLButtonElement | null) => void;
  onSelect: () => void;
}) {
  const tone = sourceDotTone(source);
  const statusNote = !source.enabled
    ? '已停用'
    : source.problem
      ? '异常'
      : source.rejected
        ? `拒收 ${source.rejected.count}`
        : !source.ready
          ? '未领密钥'
          : null;
  return (
    <li>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`选择入站来源 ${source.name}`}
        aria-current={active ? 'true' : undefined}
        onClick={onSelect}
        className={cn(
          'grid w-full gap-1 px-3.5 py-2.5 text-left transition-colors duration-100',
          active ? 'bg-brand-soft/75 shadow-[inset_3px_0_0_0_var(--primary)]' : 'hover:bg-muted/70',
        )}
      >
        <div className="flex items-center gap-2">
          <Dot tone={tone} pulse={false} />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{source.name}</span>
          <Badge tone="plain" className="text-2xs">{shortKindLabel(source)}</Badge>
        </div>
        <div className="flex items-center gap-1.5 pl-4 text-xs text-muted-foreground">
          <span className="tabular-nums">{`${source.project_ids.length} 个项目`}</span>
          {source.broadcast_groups ? <Badge tone="plain" className="text-2xs">同步播报群</Badge> : null}
          {statusNote ? (
            <>
              <span aria-hidden="true" className="text-faint">·</span>
              <span className={cn(
                'truncate',
                !source.enabled ? 'text-faint' : source.problem || source.rejected ? 'text-destructive' : 'text-waiting-foreground',
              )}
              >
                {statusNote}
              </span>
            </>
          ) : null}
        </div>
      </button>
    </li>
  );
}

function SourceDetail({ source, page, issued, busy, onEdit, onToggle, onDelete, onIssue, onDismiss }: {
  source: InboundSource;
  page: InboundPage;
  issued: IssuedInboundKey | null;
  busy: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onIssue: () => void;
  onDismiss: () => void;
}) {
  const projects = source.project_ids.flatMap((id) => page.projects.filter((project) => project.id === id));
  const missing = projects.length !== source.project_ids.length;
  const address = inboundAddress(source.path, page.reach.public_url);
  return (
    <Card aria-label={`入站来源 ${source.name}`} className="p-5">
      <header className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b border-border/80 pb-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Dot tone={sourceDotTone(source)} pulse={false} />
            <h2 className="min-w-0 text-base font-semibold wrap-anywhere">{source.name}</h2>
            <Badge tone="plain">{source.kind_label}</Badge>
            <Badge tone={source.enabled ? 'success' : 'ended'}>{source.enabled ? '启用' : '已停用'}</Badge>
            {source.result_reply ? <Badge tone="plain">可回读答复</Badge> : null}
            {source.push_final ? <Badge tone="plain">推送终稿</Badge> : null}
            {source.broadcast_groups ? <Badge tone="plain">同步播报群</Badge> : null}
          </div>
          {source.note ? (
            <p className="mt-2 border-l-2 border-border pl-2.5 text-sm text-muted-foreground wrap-anywhere">{source.note}</p>
          ) : null}
        </div>
        <div className="flex flex-none items-center gap-0.5">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>修改</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onToggle}>{source.enabled ? '停用' : '启用'}</Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={onDelete}>删除</Button>
        </div>
      </header>

      {source.problem ? (
        <Callout tone="failed" role="alert" className="mt-4 text-xs">
          {`出了问题，已推给你：${source.problem.text}`}（<Time at={source.problem.since} prefix="从 " />）
        </Callout>
      ) : null}
      {source.rejected ? (
        <Callout tone="waiting" className="mt-3 text-xs">
          <span className="text-destructive">{`拒收 ${source.rejected.count} 次，最近一次：${source.rejected.text}`}（<Time at={source.rejected.at} />）</span>
        </Callout>
      ) : null}

      <div className="mt-4">
        <Facts className="gap-y-2.5">
          <Fact label="投递地址">
            <span className="inline-flex flex-wrap items-center gap-1">
              <Copyable value={address} />
              <span className="text-xs text-muted-foreground">（POST）</span>
            </span>
          </Fact>
          <Fact label="放行的项目">
            <span className="text-sm wrap-anywhere">
              {projects.length === 0 && !missing
                ? '还没有放行项目'
                : `${projects.map((project) => projectLine(project, source.kind)).join('、')}${missing ? `${projects.length ? '、' : ''}（有的项目已经不在了）` : ''}`}
            </span>
          </Fact>
          <Fact label="路由规则">
            <span className="text-xs text-muted-foreground">
              {source.kind === 'github'
                ? '按项目配置的仓库地址匹配'
                : source.kind === 'standard-webhooks'
                  ? '单项目直达（Standard Webhooks v1 签名不含项目头）'
                  : '由调用方在签名头中指定项目编号'}
            </span>
          </Fact>
          <Fact label="结果回传">
            <span className="text-xs text-muted-foreground">{replyModeText(source)}</span>
          </Fact>
        </Facts>
      </div>

      <section aria-label="签名密钥" className="mt-5 grid gap-2 border-t border-border/80 pt-4 text-xs">
        <h3 className="text-xs font-semibold text-muted-foreground">签名密钥</h3>
        {source.keys.map((key) => (
          <p key={key.id} className="font-mono text-muted-foreground wrap-anywhere">
            {keyLine(key)}{key.retires_at ? <> <Time at={key.retires_at} /></> : null}
          </p>
        ))}
        {!source.ready ? <p className="text-destructive">还没领取密钥：领取之后外面才投得进来</p> : null}
        {issued ? (
          <Callout tone="waiting" role="status" aria-label="新密钥" className="mt-1 grid gap-1.5 text-xs">
            <p>新密钥只显示这一次，关掉之后再也看不到，请现在交给调用方：</p>
            <div className="flex items-center gap-1.5 rounded-sm bg-background px-2 py-1">
              <code className="min-w-0 flex-1 font-mono break-all select-all">{issued.secret}</code>
              <CopyButton value={issued.secret} label="复制密钥" />
            </div>
            <p className="text-muted-foreground">{source.kind === 'github' ? githubSigningText() : source.kind === 'standard-webhooks' ? standardWebhooksSigningText() : tychoSigningText()}</p>
            <div><Button size="sm" onClick={onDismiss}>我已保存，关掉</Button></div>
          </Callout>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <Button size="sm" disabled={busy} onClick={onIssue}>{source.ready ? '换密钥' : '领取密钥'}</Button>
          {source.ready ? <span className="text-muted-foreground">换了之后，旧密钥在过渡期内还能用</span> : null}
        </div>
      </section>
    </Card>
  );
}

function RecentDeliveries({ fires, projects, emptyText }: {
  fires: TriggerFire[];
  projects: InboundPage['projects'];
  emptyText: string;
}) {
  if (fires.length === 0) {
    return <Note className="py-3 text-xs">{emptyText}</Note>;
  }
  return (
    <Rows>
      <ul aria-label="最近的受理记录" className="divide-y divide-border">
        {fires.slice(0, RECENT_SHOWN).map((fire) => (
          <li key={fire.id} className="flex flex-wrap items-baseline gap-x-3 px-3.5 py-2.5 text-sm">
            <Time at={fire.created_at} className="w-24 flex-none text-xs text-faint" />
            <span className="min-w-0 font-medium wrap-anywhere">{fire.trigger_name}</span>
            <span className="text-xs text-muted-foreground wrap-anywhere">{`${projectName(fire.project_id, projects)} · ${fire.event_id}`}</span>
            <span className="ml-auto text-xs text-muted-foreground">{fireLine(fire)}</span>
            {fire.public_reply ? (
              <details className="mt-1 w-full text-xs text-muted-foreground">
                <summary className="cursor-pointer">已向来源发布的答复</summary>
                <p className="mt-1 whitespace-pre-wrap wrap-anywhere">{fire.public_reply}</p>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
    </Rows>
  );
}

export function InboundPage() {
  const query = useQuery(inboundQuery);
  const { data, error: unread, isPending } = query;
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const [recentScope, setRecentScope] = useState<'selected' | 'all'>('selected');
  const [editing, setEditing] = useState<{ id: string | null; draft: InboundDraft } | null>(null);
  const [confirming, setConfirming] = useState<InboundSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The key just issued: its secret is in this answer and nowhere the page can read it again.
  const [issued, setIssued] = useState<IssuedInboundKey | null>(null);

  const sources = data?.sources ?? [];
  const selectedSource = sources.find((each) => each.id === selectedId) ?? sources[0] ?? null;

  const handleRailKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (sources.length <= 1 || editing !== null || confirming !== null) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const currentIndex = selectedSource ? sources.findIndex((each) => each.id === selectedSource.id) : -1;
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + delta + sources.length) % sources.length;
    const next = sources[nextIndex];
    if (next) {
      event.preventDefault();
      setSelectedId(next.id);
      rowRefs.current.get(next.id)?.focus();
    }
  };

  async function act<T = unknown>(send: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    setBusy(true);
    setError(null);
    try {
      const value = await send();
      await client.invalidateQueries({ queryKey: inboundQuery.queryKey });
      return { ok: true, value };
    } catch (refused) {
      setError(messageOf(refused));
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    if (!editing) return;
    const body = inboundBody(editing.draft);
    const result = await act<{ source?: InboundSource }>(() => (
      editing.id === null
        ? post<{ source?: InboundSource }>('/api/inbound', body)
        : put<{ source?: InboundSource }>(`/api/inbound/${encodeURIComponent(editing.id)}`, body)
    ));
    if (result.ok) {
      if (editing.id === null && result.value?.source?.id) setSelectedId(result.value.source.id);
      setEditing(null);
    }
  }

  const begin = (): void => {
    if (!data) return;
    setEditing({ id: null, draft: emptyInboundDraft(data.kinds[0]?.kind ?? 'tycho-v1') });
    setError(null);
  };

  const selectedRecent = selectedSource && data
    ? data.recent.filter((fire) => matchesSource(fire, selectedSource))
    : [];
  const shownRecent = data
    ? (recentScope === 'all' ? data.recent : selectedRecent)
    : [];

  return (
    <Page
      title="入站来源"
      width="wide"
      loading={isPending}
      failure={unread ? `读不到入站来源：${unread.message}` : null}
      actions={<Button variant="primary" disabled={busy || !data} onClick={begin}><Plus />新建来源</Button>}
    >
      <PageLead>外部系统按它们自己的规则，把一次次的请求投到这里；每个来源一个地址、一把可换的密钥和一组放行的项目。收到的事件会作为资料交给对应项目的负责人，做什么由负责人定。</PageLead>
      {data ? (
        <>
          <Callout tone={data.reach.reach === 'ready' ? 'plain' : 'failed'} className="mb-5">
            <p>{data.reach.reach_text}</p>
            {data.reach.public_url ? (
              <p className="mt-1 text-muted-foreground wrap-anywhere">
                对外地址：<Copyable value={data.reach.public_url} />
              </p>
            ) : null}
          </Callout>

          {sources.length > 0 && selectedSource ? (
            <div className="grid grid-cols-1 items-start gap-5 shell:grid-cols-[260px_minmax(0,1fr)] wide:grid-cols-[296px_minmax(0,1fr)]">
              <aside
                aria-label="入站来源列表"
                className="flex flex-col overflow-hidden rounded-xl border border-border bg-raised shadow-card shell:sticky shell:top-4 shell:max-h-[calc(100dvh-9rem)]"
              >
                <div className="flex items-center justify-between gap-2 border-b border-border px-3.5 py-2.5">
                  <span className="text-xs font-semibold text-muted-foreground">全部来源</span>
                  <span className="rounded-full bg-hover px-1.5 text-xs leading-[18px] font-medium text-muted-foreground tabular-nums">{sources.length}</span>
                </div>
                <ul aria-label="入站来源" className="min-h-0 flex-1 divide-y divide-border/70 overflow-y-auto" onKeyDown={handleRailKeyDown}>
                  {sources.map((source) => (
                    <SourceRailItem
                      key={source.id}
                      source={source}
                      active={selectedSource.id === source.id}
                      buttonRef={(node) => {
                        if (node) rowRefs.current.set(source.id, node);
                        else rowRefs.current.delete(source.id);
                      }}
                      onSelect={() => setSelectedId(source.id)}
                    />
                  ))}
                </ul>
              </aside>

              <div className="grid min-w-0 gap-5">
                <SourceDetail
                  source={selectedSource}
                  page={data}
                  busy={busy}
                  issued={issued?.source.id === selectedSource.id ? issued : null}
                  onEdit={() => { setEditing({ id: selectedSource.id, draft: inboundDraftOf(selectedSource) }); setError(null); }}
                  onToggle={() => void act(() => post(`/api/inbound/${encodeURIComponent(selectedSource.id)}/enabled`, { enabled: !selectedSource.enabled }))}
                  onDelete={() => { setConfirming(selectedSource); setError(null); }}
                  onIssue={() => void act(async () => setIssued(await post<IssuedInboundKey>(`/api/inbound/${encodeURIComponent(selectedSource.id)}/key`, {})))}
                  onDismiss={() => setIssued(null)}
                />

                {!editing && !confirming && error ? <Problem role="alert">{error}</Problem> : null}

                <Card className="p-5">
                  <SectionTitle
                    count={shownRecent.length}
                    action={data.recent.length > 0 ? (
                      <div role="group" aria-label="受理记录范围" className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant={recentScope === 'selected' ? 'primary' : 'ghost'}
                          className="h-7 px-2 text-xs"
                          onClick={() => setRecentScope('selected')}
                        >
                          {`当前来源 ${selectedRecent.length}`}
                        </Button>
                        <Button
                          size="sm"
                          variant={recentScope === 'all' ? 'primary' : 'ghost'}
                          className="h-7 px-2 text-xs"
                          onClick={() => setRecentScope('all')}
                        >
                          {`全部来源 ${data.recent.length}`}
                        </Button>
                      </div>
                    ) : undefined}
                  >
                    最近的受理记录
                  </SectionTitle>
                  <RecentDeliveries
                    fires={shownRecent}
                    projects={data.projects}
                    emptyText={recentScope === 'selected' && data.recent.length > 0
                      ? '这个来源还没有最近的受理记录；可以切到“全部来源”查看其他记录。'
                      : '还没有受理记录。外部系统把请求投进来之后，受理和投递结果会列在这里。'}
                  />
                </Card>
              </div>
            </div>
          ) : (
            <>
              <Empty icon={<Radio />} title="还没有入站来源">GitHub 的仓库通知、别的项目的调度器、n8n 之类，各建一个来源：一个地址、一把密钥，放行要投的项目。</Empty>
              {!editing && !confirming && error ? <Problem role="alert" className="mt-3">{error}</Problem> : null}
              {data.recent.length ? (
                <Card className="mt-6 p-5">
                  <SectionTitle count={data.recent.length}>最近的受理记录</SectionTitle>
                  <RecentDeliveries fires={data.recent} projects={data.projects} emptyText="还没有受理记录。" />
                </Card>
              ) : null}
            </>
          )}

          <Sheet open={editing !== null} onOpenChange={(open) => { if (!open && !busy) { setEditing(null); setError(null); } }}>
            {editing && data ? (
              <SheetContent
                title={editing.id === null ? '新建入站来源' : '修改入站来源'}
                footer={(
                  <>
                    <Button type="submit" form="inbound-form" variant="primary" disabled={busy}>{busy ? '保存中' : '保存来源'}</Button>
                    <Button variant="ghost" disabled={busy} onClick={() => { setEditing(null); setError(null); }}>取消</Button>
                  </>
                )}
              >
                <SourceForm
                  id="inbound-form"
                  draft={editing.draft}
                  kind={data.kinds}
                  projects={data.projects}
                  groups={data.groups}
                  made={editing.id !== null}
                  busy={busy}
                  error={error}
                  onChange={(draft) => setEditing({ ...editing, draft })}
                  onSave={() => void save()}
                />
              </SheetContent>
            ) : null}
          </Sheet>
          <Confirm
            open={confirming !== null}
            title={`删除入站来源 ${confirming?.name ?? ''}？`}
            description="删掉以后它的地址和密钥都不再接收，已经受理的记录留着。"
            confirm={`确认删除 ${confirming?.name ?? ''}`}
            busy={busy}
            error={confirming ? error : null}
            onConfirm={() => { if (confirming) void act(() => del(`/api/inbound/${encodeURIComponent(confirming.id)}`)).then((res) => { if (res.ok) setConfirming(null); }); }}
            onCancel={() => { setConfirming(null); setError(null); }}
          />
        </>
      ) : null}
    </Page>
  );
}
