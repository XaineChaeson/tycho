import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, MessageCircle, Plus, RefreshCw, ShieldCheck, Users } from 'lucide-react';
import { useState, type ComponentType, type ReactNode } from 'react';
import {
  IM_COOLDOWN_MAX,
  IM_COOLDOWN_MIN,
  IM_INLINE_CONTEXT_MAX,
  IM_INLINE_CONTEXT_MIN,
} from '@shared/im.ts';
import { Callout, Card, Dot, Empty, Field, Mono, Note, Problem, Rows, SectionTitle, Time, type Tone } from '@/components/bits';
import { WeixinSetup } from '@/components/weixin-setup';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Choice } from '@/components/ui/checkbox';
import { Confirm, Sheet, SheetContent } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Option, Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { del, messageOf, post, put } from '@/lib/api';
import { imGroupsQuery, PAGE, stateQuery } from '@/lib/queries';
import type { DiscoveredImGroup, ImChannel, ImGroupBinding, ImGroupTriggerMode, Setting } from '@/lib/types';
import { cn } from '@/lib/utils';

export type ImChannelsTab = 'overview' | 'wecom' | 'weixin' | 'groups';

export function channelLabel(channel: ImChannel): string {
  return channel === 'wecom' ? '企业微信' : '微信';
}

export interface GroupBindingDraft {
  channel: ImChannel;
  chatId: string;
  chatName: string;
  projectId: string;
  enabled: boolean;
  triggerMode: ImGroupTriggerMode;
  allowAllSenders: boolean;
  allowedSendersText: string;
  ruleKeywordsText: string;
  cooldownSeconds: string;
  inlineContextCount: string;
  acceptMedia: boolean;
  notifyEvents: boolean;
}

export interface GroupBindingPayload {
  channel: ImChannel;
  chat_id: string;
  chat_name: string;
  project_id: string;
  enabled: boolean;
  trigger_mode: ImGroupTriggerMode;
  allow_all_senders: boolean;
  allowed_senders: string[];
  rule_keywords: string[];
  cooldown_seconds: number;
  inline_context_count: number;
  accept_media: boolean;
  notify_events: boolean;
}

function parseLines(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== '' && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

export function emptyGroupBindingDraft(over: Partial<GroupBindingDraft> = {}): GroupBindingDraft {
  return {
    channel: 'wecom',
    chatId: '',
    chatName: '',
    projectId: '',
    enabled: true,
    triggerMode: 'mention_only',
    allowAllSenders: false,
    allowedSendersText: '',
    ruleKeywordsText: '',
    cooldownSeconds: '15',
    inlineContextCount: '10',
    acceptMedia: true,
    notifyEvents: true,
    ...over,
  };
}

export function groupBindingDraftOf(binding: ImGroupBinding): GroupBindingDraft {
  return {
    channel: binding.channel,
    chatId: binding.chat_id,
    chatName: binding.chat_name,
    projectId: binding.project_id,
    enabled: binding.enabled,
    triggerMode: binding.trigger_mode,
    allowAllSenders: binding.allow_all_senders,
    allowedSendersText: binding.allowed_senders.join('\n'),
    ruleKeywordsText: binding.rule_keywords.join('\n'),
    cooldownSeconds: String(binding.cooldown_seconds),
    inlineContextCount: String(binding.inline_context_count),
    acceptMedia: binding.accept_media,
    notifyEvents: binding.notify_events,
  };
}

export function bindingToPayload(binding: ImGroupBinding, patch: Partial<GroupBindingPayload> = {}): GroupBindingPayload {
  return {
    channel: binding.channel,
    chat_id: binding.chat_id,
    chat_name: binding.chat_name,
    project_id: binding.project_id,
    enabled: binding.enabled,
    trigger_mode: binding.trigger_mode,
    allow_all_senders: binding.allow_all_senders,
    allowed_senders: [...binding.allowed_senders],
    rule_keywords: [...binding.rule_keywords],
    cooldown_seconds: binding.cooldown_seconds,
    inline_context_count: binding.inline_context_count,
    accept_media: binding.accept_media,
    notify_events: binding.notify_events,
    ...patch,
  };
}

export function parseGroupBindingPayload(draft: GroupBindingDraft):
  | { ok: true; body: GroupBindingPayload }
  | { ok: false; error: string } {
  const chatId = draft.chatId.trim();
  if (chatId === '') return { ok: false, error: '请填写群 ID。' };
  const projectId = draft.projectId.trim();
  if (projectId === '') return { ok: false, error: '请选择要绑定的项目。' };
  const cooldownRaw = draft.cooldownSeconds.trim();
  const cooldown = Number(cooldownRaw);
  if (cooldownRaw === '' || !Number.isInteger(cooldown) || cooldown < IM_COOLDOWN_MIN || cooldown > IM_COOLDOWN_MAX) {
    return { ok: false, error: `冷却合并窗口需为 ${IM_COOLDOWN_MIN} 到 ${IM_COOLDOWN_MAX} 之间的整数（秒）。` };
  }
  const contextRaw = draft.inlineContextCount.trim();
  const contextCount = Number(contextRaw);
  if (contextRaw === '' || !Number.isInteger(contextCount) || contextCount < IM_INLINE_CONTEXT_MIN || contextCount > IM_INLINE_CONTEXT_MAX) {
    return { ok: false, error: `群内联上下文条数需为 ${IM_INLINE_CONTEXT_MIN} 到 ${IM_INLINE_CONTEXT_MAX} 之间的整数。` };
  }
  return {
    ok: true,
    body: {
      channel: draft.channel,
      chat_id: chatId,
      chat_name: draft.chatName.trim(),
      project_id: projectId,
      enabled: draft.enabled,
      trigger_mode: draft.triggerMode,
      allow_all_senders: draft.allowAllSenders,
      allowed_senders: parseLines(draft.allowedSendersText),
      rule_keywords: parseLines(draft.ruleKeywordsText),
      cooldown_seconds: cooldown,
      inline_context_count: contextCount,
      accept_media: draft.acceptMedia,
      notify_events: draft.notifyEvents,
    },
  };
}

export async function invalidateGroupQueries(client: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: imGroupsQuery.queryKey }),
    client.invalidateQueries({ queryKey: [PAGE, 'project-groups'] }),
    client.invalidateQueries({ queryKey: [PAGE, 'inbound'] }),
    client.invalidateQueries({ queryKey: [PAGE, 'triggers'] }),
  ]);
}

export function GroupBindingRow({
  binding,
  showProject = true,
  busy,
  onPatch,
  onEdit,
  onDelete,
}: {
  binding: ImGroupBinding;
  showProject?: boolean;
  busy: boolean;
  onPatch: (patch: Partial<GroupBindingPayload>) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const displayName = binding.chat_name || binding.chat_id;
  const senderText = binding.allow_all_senders
    ? '允许群内全员'
    : binding.allowed_senders.length > 0
      ? `白名单（额外 ${binding.allowed_senders.length} 人）`
      : '仅主人 / 默认白名单';

  return (
    <li aria-label={`群聊绑定 ${displayName}`} className="grid gap-2.5 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <Dot tone={binding.enabled ? 'success' : 'ended'} pulse={false} />
        <span className="min-w-0 text-sm font-semibold wrap-anywhere">{displayName}</span>
        {binding.chat_name ? <Mono className="text-muted-foreground">{binding.chat_id}</Mono> : null}
        <Badge tone="plain">{channelLabel(binding.channel)}</Badge>
        {showProject ? <Badge tone="running">{binding.project_name || binding.project_id}</Badge> : null}
        <Badge tone="plain">{binding.trigger_mode === 'mention_or_rules' ? '@ 或快通道规则' : '仅 @ 机器人'}</Badge>
        <Badge tone={binding.enabled ? 'success' : 'ended'}>{binding.enabled ? '已启用' : '已停用'}</Badge>
        <span className="ml-auto flex flex-none items-center gap-0.5">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>编辑</Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={onDelete}>解绑</Button>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>发送者：{senderText}</span>
        <span>冷却合并：{binding.cooldown_seconds} 秒</span>
        <span>上下文：{binding.inline_context_count} 条</span>
        {binding.trigger_mode === 'mention_or_rules' && binding.rule_keywords.length > 0 ? (
          <span className="wrap-anywhere">规则：{binding.rule_keywords.join('、')}</span>
        ) : null}
        {binding.last_triggered_at ? <Time at={binding.last_triggered_at} prefix="最近触发 " /> : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-border/60 pt-2">
        <Choice className="min-h-7 text-xs">
          <Switch
            aria-label={`启用 ${displayName}`}
            checked={binding.enabled}
            disabled={busy}
            onCheckedChange={(on) => onPatch({ enabled: on })}
          />
          <span>启用</span>
        </Choice>
        <Choice className="min-h-7 text-xs">
          <Switch
            aria-label={`延迟收图/文件 ${displayName}`}
            checked={binding.accept_media}
            disabled={busy}
            onCheckedChange={(on) => onPatch({ accept_media: on })}
          />
          <span>延迟收图/文件</span>
        </Choice>
        <Choice className="min-h-7 text-xs">
          <Switch
            aria-label={`接收播报 ${displayName}`}
            checked={binding.notify_events}
            disabled={busy}
            onCheckedChange={(on) => onPatch({ notify_events: on })}
          />
          <span>接收告警/结果播报</span>
        </Choice>
      </div>
    </li>
  );
}

export function DiscoveredGroupsSection({
  discovered,
  boundKeys,
  busy,
  actionLabel = '一键绑定',
  onQuickBind,
}: {
  discovered: DiscoveredImGroup[];
  boundKeys: Set<string>;
  busy: boolean;
  actionLabel?: string;
  onQuickBind: (group: DiscoveredImGroup) => void;
}) {
  const unbound = discovered.filter((group) => !boundKeys.has(`${group.channel}:${group.chat_id}`));
  if (unbound.length === 0) return null;

  return (
    <div className="mt-6">
      <SectionTitle count={unbound.length}>最近发现的未绑定群</SectionTitle>
      <Note className="mb-3 text-xs">机器人在这些群收到过消息但尚未绑定项目。点击“{actionLabel}”会自动填入通道与群 ID。</Note>
      <div className="grid gap-3 wide:grid-cols-2">
        {unbound.map((group) => (
          <div
            key={`${group.channel}:${group.chat_id}`}
            className="flex flex-col gap-2 rounded-xl border border-border bg-raised p-3.5 shadow-card"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Badge tone="plain">{channelLabel(group.channel)}</Badge>
                <Mono className="font-medium text-foreground">{group.chat_id}</Mono>
              </div>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => onQuickBind(group)}>
                {actionLabel}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted-foreground">
              <span className="tabular-nums">{group.message_count} 条消息</span>
              <Time at={group.last_seen_at} prefix="最近活跃 " />
              {group.last_actor ? <span className="wrap-anywhere">最近发言：{group.last_actor}</span> : null}
            </div>
            {group.last_text ? (
              <p className="line-clamp-2 border-l-2 border-border pl-2 text-xs text-muted-foreground wrap-anywhere">
                {group.last_text}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function GroupBindingSheet({
  open,
  editingId,
  draft,
  projects,
  fixedProject,
  busy,
  error,
  onChange,
  onSave,
  onClose,
}: {
  open: boolean;
  editingId: string | null;
  draft: GroupBindingDraft | null;
  projects?: { id: string; name: string }[];
  fixedProject?: { id: string; name: string };
  busy: boolean;
  error: string | null;
  onChange: (next: GroupBindingDraft) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const isEdit = editingId !== null;
  const set = (patch: Partial<GroupBindingDraft>) => {
    if (draft) onChange({ ...draft, ...patch });
  };

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      {draft ? (
        <SheetContent
          title={isEdit ? '编辑群聊绑定' : '绑定群聊'}
          description="配置群聊触发策略、发送者范围、上下文窗口与播报能力。"
          footer={(
            <>
              <Button type="submit" form="im-group-binding-form" variant="primary" disabled={busy}>
                {busy ? '保存中' : isEdit ? '保存修改' : '确认绑定'}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button>
            </>
          )}
        >
          <form
            id="im-group-binding-form"
            noValidate
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              onSave();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="通道" hint={isEdit ? '已绑定群聊的通道不可更改。' : '当前群聊绑定支持企业微信；微信暂仅支持私聊。'}>
                <Select
                  aria-label="群聊通道"
                  value={draft.channel}
                  disabled={busy || isEdit}
                  onChange={(event) => set({ channel: event.target.value as ImChannel })}
                >
                  <Option value="wecom">企业微信</Option>
                  <Option value="weixin" disabled>微信（暂仅支持私聊）</Option>
                </Select>
              </Field>
              <Field label="群 ID" hint={isEdit ? '已绑定群 ID 不可更改。' : '从群消息记录或下方未绑定群列表获取。'}>
                <Input
                  aria-label="群 ID"
                  className="font-mono text-xs"
                  placeholder="例如：wr_xxxxxxxx"
                  value={draft.chatId}
                  disabled={busy || isEdit}
                  onChange={(event) => set({ chatId: event.target.value })}
                />
              </Field>
            </div>

            <Field label="群备注名" hint="便于在控制台和播报列表中识别这个群。">
              <Input
                aria-label="群备注名"
                placeholder="例如：核心研发告警群"
                value={draft.chatName}
                disabled={busy}
                onChange={(event) => set({ chatName: event.target.value })}
              />
            </Field>

            {fixedProject ? (
              <Field label="绑定项目">
                <Input aria-label="绑定项目" value={fixedProject.name} disabled readOnly />
              </Field>
            ) : (
              <Field label="绑定项目" hint="群内触发的消息会路由给该项目的负责人。">
                <Select
                  aria-label="绑定项目"
                  value={draft.projectId}
                  disabled={busy}
                  onChange={(event) => set({ projectId: event.target.value })}
                >
                  <Option value="">请选择项目</Option>
                  {(projects ?? []).map((project) => (
                    <Option key={project.id} value={project.id}>{project.name}</Option>
                  ))}
                </Select>
              </Field>
            )}

            <Choice className="items-center">
              <Switch
                aria-label="启用群聊绑定"
                checked={draft.enabled}
                disabled={busy}
                onCheckedChange={(on) => set({ enabled: on })}
              />
              <span>启用该群聊绑定</span>
            </Choice>

            <Field
              label="触发策略"
              hint={
                draft.channel === 'wecom'
                  ? '“仅 @ 机器人”只在被 @ 时响应。注：企业微信智能机器人目前仅在群内被 @ 时推送回调，收不到未 @ 的普通群消息；快通道规则仅对支持全量群消息推送的通道生效。'
                  : '“仅 @ 机器人”只在被 @ 时响应（慢通道）；“@ 或快通道规则”在命中关键词/正则时也会自动响应。'
              }
            >
              <Segmented
                label="触发策略"
                value={draft.triggerMode}
                disabled={busy}
                options={[
                  { value: 'mention_only', label: '仅 @ 机器人' },
                  { value: 'mention_or_rules', label: '@ 或快通道规则' },
                ]}
                onChange={(value) => set({ triggerMode: value })}
              />
            </Field>

            {draft.triggerMode === 'mention_or_rules' ? (
              <Field
                label="快通道关键词 / 正则列表"
                hint="每行一条，命中任意一条即把整条消息连同上下文送入项目对话。正则须用 /pattern/flags 写法（如 /error|panic/i），其余按不区分大小写的关键词包含匹配。"
              >
                <Textarea
                  aria-label="快通道关键词或正则"
                  rows={3}
                  className="font-mono text-xs"
                  placeholder={'P0告警\n/error|panic/i'}
                  value={draft.ruleKeywordsText}
                  disabled={busy}
                  onChange={(event) => set({ ruleKeywordsText: event.target.value })}
                />
              </Field>
            ) : null}

            <Field
              label="发送者策略"
              hint="控制群里哪些成员发出的消息可以触发机器人。"
            >
              <Segmented
                label="发送者策略"
                value={draft.allowAllSenders ? 'all' : 'whitelist'}
                disabled={busy}
                options={[
                  { value: 'whitelist', label: '仅白名单/指定发送者' },
                  { value: 'all', label: '允许群内全员' },
                ]}
                onChange={(value) => set({ allowAllSenders: value === 'all' })}
              />
            </Field>

            {!draft.allowAllSenders ? (
              <Field
                label="额外允许的发送者"
                hint="每行填写一个成员 ID（主人默认放行，留空表示仅主人可触发）。"
              >
                <Textarea
                  aria-label="额外允许的发送者"
                  rows={2}
                  className="font-mono text-xs"
                  placeholder="每行一个发送者 ID"
                  value={draft.allowedSendersText}
                  disabled={busy}
                  onChange={(event) => set({ allowedSendersText: event.target.value })}
                />
              </Field>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="冷却合并窗口（秒）" hint={`窗口内连续触发合并处理，范围 ${IM_COOLDOWN_MIN}～${IM_COOLDOWN_MAX} 秒，默认 15 秒。`}>
                <Input
                  aria-label="冷却合并窗口（秒）"
                  type="number"
                  min={IM_COOLDOWN_MIN}
                  max={IM_COOLDOWN_MAX}
                  className="tabular-nums"
                  value={draft.cooldownSeconds}
                  disabled={busy}
                  onChange={(event) => set({ cooldownSeconds: event.target.value })}
                />
              </Field>
              <Field label="群内联上下文条数" hint={`触发时附带该群最近聊天条数，范围 ${IM_INLINE_CONTEXT_MIN}～${IM_INLINE_CONTEXT_MAX} 条，默认 10 条。`}>
                <Input
                  aria-label="群内联上下文条数"
                  type="number"
                  min={IM_INLINE_CONTEXT_MIN}
                  max={IM_INLINE_CONTEXT_MAX}
                  className="tabular-nums"
                  value={draft.inlineContextCount}
                  disabled={busy}
                  onChange={(event) => set({ inlineContextCount: event.target.value })}
                />
              </Field>
            </div>

            <Choice className="items-start">
              <Switch
                aria-label="延迟接收群图片或文件"
                className="mt-1"
                checked={draft.acceptMedia}
                disabled={busy}
                onCheckedChange={(on) => set({ acceptMedia: on })}
              />
              <span className="py-0.5">
                延迟接收群图片/文件
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  仅在群聊实际触发时才拉取近期图片与文件，避免无关闲聊占用带宽与存储。
                </span>
              </span>
            </Choice>

            <Choice className="items-start">
              <Switch
                aria-label="接收告警与结果播报"
                className="mt-1"
                checked={draft.notifyEvents}
                disabled={busy}
                onCheckedChange={(on) => set({ notifyEvents: on })}
              />
              <span className="py-0.5">
                接收告警/结果播报
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  允许入站来源与项目触发器把处理结论同步播报到该群。
                </span>
              </span>
            </Choice>

            {error ? <Problem role="alert">{error}</Problem> : null}
          </form>
        </SheetContent>
      ) : null}
    </Sheet>
  );
}

export function GroupBindingsManager() {
  const { data, isPending, error: unread } = useQuery(imGroupsQuery);
  const client = useQueryClient();
  const [editing, setEditing] = useState<{ id: string | null; draft: GroupBindingDraft } | null>(null);
  const [confirming, setConfirming] = useState<ImGroupBinding | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);

  async function act(send: () => Promise<unknown>, okText?: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setStatusNote(null);
    try {
      await send();
      await invalidateGroupQueries(client);
      if (okText) setStatusNote(okText);
      return true;
    } catch (refused) {
      setError(messageOf(refused));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    if (!editing) return;
    const parsed = parseGroupBindingPayload(editing.draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const done = await act(
      () => (editing.id === null
        ? post('/api/im/groups', parsed.body)
        : put(`/api/im/groups/${encodeURIComponent(editing.id)}`, parsed.body)),
      editing.id === null ? '已绑定群聊' : '已保存群聊配置',
    );
    if (done) setEditing(null);
  }

  const openCreate = (over: Partial<GroupBindingDraft> = {}): void => {
    const defaultProjectId = data?.projects[0]?.id ?? '';
    setEditing({
      id: null,
      draft: emptyGroupBindingDraft({ projectId: defaultProjectId, ...over }),
    });
    setError(null);
  };

  const bindings = data?.bindings ?? [];
  const boundKeys = new Set(bindings.map((b) => `${b.channel}:${b.chat_id}`));

  return (
    <section aria-label="群聊绑定管理" className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Note>将企业微信或微信群聊绑定到指定项目，支持 @ 触发与关键词快通道、发送者白名单及告警播报。</Note>
        </div>
        <Button variant="primary" size="sm" disabled={busy || !data} onClick={() => openCreate()}>
          <Plus />绑定群聊
        </Button>
      </div>

      {unread ? <Problem role="alert">{`读不到群聊绑定：${unread.message}`}</Problem> : null}
      {!editing && !confirming && error ? <Problem role="alert">{error}</Problem> : null}
      {statusNote ? <span role="status" className="text-xs text-success-foreground">{statusNote}</span> : null}
      {isPending ? <Skeleton className="h-28" /> : null}

      {data ? (
        <>
          {bindings.length > 0 ? (
            <div>
              <SectionTitle count={bindings.length}>已绑定群聊</SectionTitle>
              <Rows>
                <ul aria-label="已绑定群聊" className="divide-y divide-border">
                  {bindings.map((binding) => (
                    <GroupBindingRow
                      key={binding.id}
                      binding={binding}
                      showProject
                      busy={busy}
                      onPatch={(patch) => void act(
                        () => put(`/api/im/groups/${encodeURIComponent(binding.id)}`, bindingToPayload(binding, patch)),
                        '已更新群聊设置',
                      )}
                      onEdit={() => {
                        setEditing({ id: binding.id, draft: groupBindingDraftOf(binding) });
                        setError(null);
                      }}
                      onDelete={() => {
                        setConfirming(binding);
                        setError(null);
                      }}
                    />
                  ))}
                </ul>
              </Rows>
            </div>
          ) : (
            <Empty icon={<Users />} title="还没有绑定群聊">
              把机器人拉进企业微信或微信群并发送消息后，群聊会自动出现在下方“最近发现的未绑定群”，也可以点右上角“绑定群聊”手动添加。
            </Empty>
          )}

          <DiscoveredGroupsSection
            discovered={data.discovered}
            boundKeys={boundKeys}
            busy={busy}
            onQuickBind={(group) => openCreate({
              channel: group.channel,
              chatId: group.chat_id,
              chatName: '',
            })}
          />
        </>
      ) : null}

      <GroupBindingSheet
        open={editing !== null}
        editingId={editing?.id ?? null}
        draft={editing?.draft ?? null}
        projects={data?.projects}
        busy={busy}
        error={editing ? error : null}
        onChange={(draft) => setEditing((curr) => (curr ? { ...curr, draft } : null))}
        onSave={() => void save()}
        onClose={() => { setEditing(null); setError(null); }}
      />

      <Confirm
        open={confirming !== null}
        title={`解绑群聊 ${confirming?.chat_name || confirming?.chat_id || ''}？`}
        description="解绑后机器人不再响应这个群的消息，也不会向该群播报告警或结果。项目历史记录不受影响。"
        confirm="确认解绑"
        busy={busy}
        error={confirming ? error : null}
        onConfirm={() => {
          if (!confirming) return;
          void act(() => del(`/api/im/groups/${encodeURIComponent(confirming.id)}`), '已解绑群聊').then((done) => {
            if (done) setConfirming(null);
          });
        }}
        onCancel={() => { setConfirming(null); setError(null); }}
      />
    </section>
  );
}

interface CapabilitySpec {
  suffix: 'chat' | 'notify' | 'approveLogin';
  label: string;
  hint: (channel: ImChannel) => string;
}

const CAPABILITIES: readonly CapabilitySpec[] = [
  {
    suffix: 'chat',
    label: '项目对话',
    hint: (ch) => (ch === 'wecom'
      ? '允许通过企业微信私聊与绑定群向项目负责人发送消息。'
      : '允许通过微信私聊与绑定群向项目负责人发送消息。'),
  },
  {
    suffix: 'notify',
    label: '主动通知',
    hint: () => '任务就绪、阻塞提问、异常告警与触发器终稿主动推送到该通道。',
  },
  {
    suffix: 'approveLogin',
    label: '放行控制台登录',
    hint: (ch) => (ch === 'wecom'
      ? '允许在企业微信私聊发送「登录 123456」放行新设备登录控制台。'
      : '允许在微信私聊发送「登录 123456」放行新设备登录控制台。'),
  },
];

function wecomStatusInfo(
  wecom: { connected?: boolean; error?: string | null } | null | undefined,
  configured: boolean,
): { tone: Tone; label: string; detail?: string } {
  if (wecom?.error) return { tone: 'failed', label: '连接异常', detail: wecom.error };
  if (wecom?.connected) return { tone: 'success', label: '已连接' };
  if (configured) return { tone: 'waiting', label: '重连中' };
  return { tone: 'ended', label: '未配置' };
}

function weixinStatusInfo(
  weixin: { state: string; error?: string | null } | null | undefined,
): { tone: Tone; label: string; detail?: string } {
  if (!weixin || weixin.state === 'disconnected') return { tone: 'ended', label: '未连接' };
  if (weixin.error || weixin.state === 'error') {
    return { tone: 'failed', label: '连接异常', detail: weixin.error ?? undefined };
  }
  if (weixin.state === 'connected') return { tone: 'success', label: '已连接' };
  if (weixin.state === 'waiting' || weixin.state === 'scanned' || weixin.state === 'pin_required') {
    return { tone: 'waiting', label: '等待扫码确认' };
  }
  if (weixin.state === 'expired') return { tone: 'waiting', label: '二维码已过期' };
  return { tone: 'ended', label: weixin.state };
}

function ChannelOverviewCard({
  channel,
  title,
  summary,
  status,
  setupLabel,
  onOpenSetup,
  action,
  actionFeedback,
  settings,
  busy,
  saving,
  saved,
  errors,
  onToggleCapability,
}: {
  channel: ImChannel;
  title: string;
  summary: string;
  status: { tone: Tone; label: string; detail?: string };
  setupLabel: string;
  onOpenSetup: () => void;
  action?: ReactNode;
  actionFeedback?: ReactNode;
  settings: Setting[];
  busy: boolean;
  saving: string | null;
  saved: string | null;
  errors: Record<string, string | undefined>;
  onToggleCapability: (key: string, nextValue: boolean) => void;
}) {
  return (
    <Card aria-label={`${title} 通道权限`} className="flex flex-col gap-3.5 p-5">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Dot tone={status.tone} pulse={status.tone === 'waiting'} />
            <h3 className="text-sm font-semibold">{title}</h3>
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>
          <Note className="mt-1 text-xs">{summary}</Note>
          {status.detail ? <Problem role="alert" className="mt-1.5 text-xs">{status.detail}</Problem> : null}
          {actionFeedback}
        </div>
        <div className="flex flex-none flex-wrap items-center justify-end gap-1.5">
          {action}
          <Button size="sm" variant="ghost" className="flex-none" onClick={onOpenSetup}>
            {setupLabel}
          </Button>
        </div>
      </header>

      <div className="border-t border-border/80 pt-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">能力权限矩阵</p>
        <ul aria-label={`${title}能力权限`} className="grid divide-y divide-border/60">
          {CAPABILITIES.map((cap) => {
            const key = `im.${channel}.${cap.suffix}`;
            const item = settings.find((setting) => setting.key === key);
            const checked = item ? Boolean(item.value) : true;
            const isSaving = saving === key;
            const isSaved = saved === key;
            const failure = errors[key];
            return (
              <li key={key} id={`setting-${key}`} className="py-2.5 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{cap.label}</span>
                      {isSaving ? <span className="text-xs text-muted-foreground">保存中…</span> : null}
                      {isSaved ? <span role="status" className="text-xs text-success-foreground">已保存</span> : null}
                    </div>
                    <Note className="mt-0.5 text-xs">{cap.hint(channel)}</Note>
                  </div>
                  <Switch
                    aria-label={`${title} · ${cap.label}`}
                    checked={checked}
                    disabled={busy}
                    onCheckedChange={(on) => onToggleCapability(key, on)}
                  />
                </div>
                {failure ? <Problem role="alert" className="mt-1.5 text-xs">{failure}</Problem> : null}
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}

const TABS: { id: ImChannelsTab; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { id: 'overview', label: '总览与权限', icon: ShieldCheck },
  { id: 'wecom', label: '企业微信配置', icon: Building2 },
  { id: 'weixin', label: '微信连接', icon: MessageCircle },
  { id: 'groups', label: '群聊绑定', icon: Users },
];

export function ImChannelsPanel({
  initialTab,
  navSeq,
  settings,
  wecomConfigured,
  wecomConfig,
  busy,
  saving,
  saved,
  errors,
  onToggleCapability,
}: {
  initialTab: ImChannelsTab;
  navSeq: string;
  settings: Setting[];
  wecomConfigured: boolean;
  wecomConfig: ReactNode;
  busy: boolean;
  saving: string | null;
  saved: string | null;
  errors: Record<string, string | undefined>;
  onToggleCapability: (key: string, nextValue: boolean) => void;
}) {
  const [tab, setTab] = useState<ImChannelsTab>(initialTab);
  const [prevNavSeq, setPrevNavSeq] = useState(navSeq);
  if (prevNavSeq !== navSeq) {
    setPrevNavSeq(navSeq);
    setTab(initialTab);
  }

  const queryClient = useQueryClient();
  const { data: serviceState } = useQuery(stateQuery);
  const wecomStatus = wecomStatusInfo(serviceState?.channels?.wecom, wecomConfigured);
  const weixinStatus = weixinStatusInfo(serviceState?.channels?.weixin);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);
  const [reconnectOk, setReconnectOk] = useState(false);
  const canReconnectWecom = wecomConfigured && (!serviceState?.channels?.wecom?.connected || Boolean(serviceState?.channels?.wecom?.error));

  async function handleReconnectWecom(): Promise<void> {
    if (reconnecting) return;
    setReconnecting(true);
    setReconnectError(null);
    setReconnectOk(false);
    try {
      await post('/api/wecom/reconnect');
      setReconnectOk(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: stateQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: [PAGE, 'settings'] }),
      ]);
    } catch (err) {
      setReconnectError(messageOf(err));
    } finally {
      setReconnecting(false);
    }
  }

  return (
    <div className="mt-2">
      <div
        role="tablist"
        aria-label="消息通道分组"
        className="sticky top-0 z-10 -mx-1 mb-5 flex items-center gap-1 overflow-x-auto border-b border-border bg-background/95 px-1 pt-0.5 pb-2 backdrop-blur-xs"
      >
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`im-channels-tab-${id}`}
              aria-selected={active}
              aria-controls={`im-channels-panel-${id}`}
              onClick={() => setTab(id)}
              className={cn(
                'flex min-h-8 flex-none items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition-colors duration-100',
                active
                  ? 'bg-brand-soft/80 font-medium text-brand-foreground'
                  : 'text-muted-foreground hover:bg-hover hover:text-foreground',
              )}
            >
              <Icon className="size-3.5 flex-none" aria-hidden="true" />
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      {tab === 'overview' ? (
        <div
          role="tabpanel"
          id="im-channels-panel-overview"
          aria-labelledby="im-channels-tab-overview"
          className="grid gap-4"
        >
          <div className="grid gap-4 wide:grid-cols-2">
            <ChannelOverviewCard
              channel="wecom"
              title="企业微信"
              summary="企业微信智能机器人长连接，适合团队群协作、运维告警播报与私聊放行。"
              status={wecomStatus}
              setupLabel="配置参数"
              onOpenSetup={() => setTab('wecom')}
              action={canReconnectWecom ? (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={reconnecting}
                  onClick={() => void handleReconnectWecom()}
                >
                  <RefreshCw className={cn('size-3.5', reconnecting && 'animate-spin')} aria-hidden="true" />
                  {reconnecting ? '重连中…' : '重新连接'}
                </Button>
              ) : null}
              actionFeedback={
                <>
                  {reconnectError ? <Problem role="alert" className="mt-1.5 text-xs">{reconnectError}</Problem> : null}
                  {reconnectOk ? <Note role="status" className="mt-1.5 text-xs text-success-foreground">已发起企微重连，请稍候查看连接状态。</Note> : null}
                </>
              }
              settings={settings}
              busy={busy}
              saving={saving}
              saved={saved}
              errors={errors}
              onToggleCapability={onToggleCapability}
            />
            <ChannelOverviewCard
              channel="weixin"
              title="微信"
              summary="扫码连接微信 ClawBot，支持私聊项目对话，并支持私聊发送「登录 123456」放行控制台登录。"
              status={weixinStatus}
              setupLabel="扫码连接"
              onOpenSetup={() => setTab('weixin')}
              settings={settings}
              busy={busy}
              saving={saving}
              saved={saved}
              errors={errors}
              onToggleCapability={onToggleCapability}
            />
          </div>

          <Callout tone="plain" className="text-xs text-muted-foreground">
            统一消息网关已按通道解耦：所有 IM 通道共用同一套权限矩阵、群聊绑定与消息路由能力，后续接入飞书 / 钉钉等适配器可无缝挂载到此处。
          </Callout>
        </div>
      ) : null}

      {tab === 'wecom' ? (
        <div
          role="tabpanel"
          id="im-channels-panel-wecom"
          aria-labelledby="im-channels-tab-wecom"
        >
          <Note className="mb-4">改完即时生效；Secret 仅保存在本机，保存后自动按新凭据重连。</Note>
          {wecomConfig}
        </div>
      ) : null}

      {tab === 'weixin' ? (
        <div
          role="tabpanel"
          id="im-channels-panel-weixin"
          aria-labelledby="im-channels-tab-weixin"
        >
          <Card className="p-1">
            <WeixinSetup />
          </Card>
        </div>
      ) : null}

      {tab === 'groups' ? (
        <div
          role="tabpanel"
          id="im-channels-panel-groups"
          aria-labelledby="im-channels-tab-groups"
        >
          <GroupBindingsManager />
        </div>
      ) : null}
    </div>
  );
}
