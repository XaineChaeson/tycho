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
import { translate, useI18n } from '@/lib/i18n';
import { imGroupsQuery, PAGE, stateQuery } from '@/lib/queries';
import type { DiscoveredImGroup, ImChannel, ImGroupBinding, ImGroupTriggerMode, Setting } from '@/lib/types';
import { cn } from '@/lib/utils';

export type ImChannelsTab = 'overview' | 'wecom' | 'weixin' | 'groups';

export function channelLabel(channel: ImChannel): string {
  return translate(channel === 'wecom' ? 'set.im.channel.wecom' : 'set.im.channel.weixin');
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
  if (chatId === '') return { ok: false, error: translate('set.im.err.chatIdRequired') };
  const projectId = draft.projectId.trim();
  if (projectId === '') return { ok: false, error: translate('set.im.err.projectRequired') };
  const cooldownRaw = draft.cooldownSeconds.trim();
  const cooldown = Number(cooldownRaw);
  if (cooldownRaw === '' || !Number.isInteger(cooldown) || cooldown < IM_COOLDOWN_MIN || cooldown > IM_COOLDOWN_MAX) {
    return { ok: false, error: translate('set.im.err.cooldownRange', { min: IM_COOLDOWN_MIN, max: IM_COOLDOWN_MAX }) };
  }
  const contextRaw = draft.inlineContextCount.trim();
  const contextCount = Number(contextRaw);
  if (contextRaw === '' || !Number.isInteger(contextCount) || contextCount < IM_INLINE_CONTEXT_MIN || contextCount > IM_INLINE_CONTEXT_MAX) {
    return { ok: false, error: translate('set.im.err.contextRange', { min: IM_INLINE_CONTEXT_MIN, max: IM_INLINE_CONTEXT_MAX }) };
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
  const { t } = useI18n();
  const displayName = binding.chat_name || binding.chat_id;
  const senderText = binding.allow_all_senders
    ? t('set.im.sendersAll')
    : binding.allowed_senders.length > 0
      ? t('set.im.sendersWhitelistCount', { count: binding.allowed_senders.length })
      : t('set.im.sendersOwnerOnly');

  return (
    <li aria-label={t('set.im.bindingRowAria', { name: displayName })} className="grid gap-2.5 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <Dot tone={binding.enabled ? 'success' : 'ended'} pulse={false} />
        <span className="min-w-0 text-sm font-semibold wrap-anywhere">{displayName}</span>
        {binding.chat_name ? <Mono className="text-muted-foreground">{binding.chat_id}</Mono> : null}
        <Badge tone="plain">{channelLabel(binding.channel)}</Badge>
        {showProject ? <Badge tone="running">{binding.project_name || binding.project_id}</Badge> : null}
        <Badge tone="plain">{binding.trigger_mode === 'mention_or_rules' ? t('set.im.triggerMentionOrRules') : t('set.im.triggerMentionOnly')}</Badge>
        <Badge tone={binding.enabled ? 'success' : 'ended'}>{binding.enabled ? t('common.enabled') : t('common.disabled')}</Badge>
        <span className="ml-auto flex flex-none items-center gap-0.5">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>{t('set.im.editBtn')}</Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={onDelete}>{t('set.im.unbindBtn')}</Button>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{t('set.im.metaSenders', { value: senderText })}</span>
        <span>{t('set.im.metaCooldown', { seconds: binding.cooldown_seconds })}</span>
        <span>{t('set.im.metaContext', { count: binding.inline_context_count })}</span>
        {binding.trigger_mode === 'mention_or_rules' && binding.rule_keywords.length > 0 ? (
          <span className="wrap-anywhere">{t('set.im.metaRules', { rules: binding.rule_keywords.join(t('set.listSep')) })}</span>
        ) : null}
        {binding.last_triggered_at ? <Time at={binding.last_triggered_at} prefix={t('set.im.lastTriggeredPrefix')} /> : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-border/60 pt-2">
        <Choice className="min-h-7 text-xs">
          <Switch
            aria-label={t('set.im.toggleEnableAria', { name: displayName })}
            checked={binding.enabled}
            disabled={busy}
            onCheckedChange={(on) => onPatch({ enabled: on })}
          />
          <span>{t('set.im.enableLabel')}</span>
        </Choice>
        <Choice className="min-h-7 text-xs">
          <Switch
            aria-label={t('set.im.toggleMediaAria', { name: displayName })}
            checked={binding.accept_media}
            disabled={busy}
            onCheckedChange={(on) => onPatch({ accept_media: on })}
          />
          <span>{t('set.im.lazyMediaLabel')}</span>
        </Choice>
        <Choice className="min-h-7 text-xs">
          <Switch
            aria-label={t('set.im.toggleNotifyAria', { name: displayName })}
            checked={binding.notify_events}
            disabled={busy}
            onCheckedChange={(on) => onPatch({ notify_events: on })}
          />
          <span>{t('set.im.notifyEventsLabel')}</span>
        </Choice>
      </div>
    </li>
  );
}

export function DiscoveredGroupsSection({
  discovered,
  boundKeys,
  busy,
  actionLabel,
  onQuickBind,
}: {
  discovered: DiscoveredImGroup[];
  boundKeys: Set<string>;
  busy: boolean;
  actionLabel?: string;
  onQuickBind: (group: DiscoveredImGroup) => void;
}) {
  const { t } = useI18n();
  const resolvedActionLabel = actionLabel ?? t('set.im.quickBind');
  const unbound = discovered.filter((group) => !boundKeys.has(`${group.channel}:${group.chat_id}`));
  if (unbound.length === 0) return null;

  return (
    <div className="mt-6">
      <SectionTitle count={unbound.length}>{t('set.im.discoveredTitle')}</SectionTitle>
      <Note className="mb-3 text-xs">{t('set.im.discoveredNote', { action: resolvedActionLabel })}</Note>
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
                {resolvedActionLabel}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted-foreground">
              <span className="tabular-nums">{t('set.im.discoveredMsgCount', { count: group.message_count })}</span>
              <Time at={group.last_seen_at} prefix={t('set.im.discoveredLastSeenPrefix')} />
              {group.last_actor ? <span className="wrap-anywhere">{t('set.im.discoveredLastActor', { actor: group.last_actor })}</span> : null}
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
  const { t } = useI18n();
  const isEdit = editingId !== null;
  const set = (patch: Partial<GroupBindingDraft>) => {
    if (draft) onChange({ ...draft, ...patch });
  };

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      {draft ? (
        <SheetContent
          title={isEdit ? t('set.im.sheetTitleEdit') : t('set.im.sheetTitleCreate')}
          description={t('set.im.sheetDesc')}
          footer={(
            <>
              <Button type="submit" form="im-group-binding-form" variant="primary" disabled={busy}>
                {busy ? t('set.saving') : isEdit ? t('set.im.saveEditBtn') : t('set.im.confirmBindBtn')}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
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
              <Field label={t('set.im.fieldChannel')} hint={isEdit ? t('set.im.fieldChannelHintEdit') : t('set.im.fieldChannelHintCreate')}>
                <Select
                  aria-label={t('set.im.fieldChannelAria')}
                  value={draft.channel}
                  disabled={busy || isEdit}
                  onChange={(event) => set({ channel: event.target.value as ImChannel })}
                >
                  <Option value="wecom">{t('set.im.channel.wecom')}</Option>
                  <Option value="weixin" disabled>{t('set.im.channelWeixinDmOnly')}</Option>
                </Select>
              </Field>
              <Field label={t('set.im.fieldChatId')} hint={isEdit ? t('set.im.fieldChatIdHintEdit') : t('set.im.fieldChatIdHintCreate')}>
                <Input
                  aria-label={t('set.im.fieldChatId')}
                  className="font-mono text-xs"
                  placeholder={t('set.im.fieldChatIdPlaceholder')}
                  value={draft.chatId}
                  disabled={busy || isEdit}
                  onChange={(event) => set({ chatId: event.target.value })}
                />
              </Field>
            </div>

            <Field label={t('set.im.fieldChatName')} hint={t('set.im.fieldChatNameHint')}>
              <Input
                aria-label={t('set.im.fieldChatName')}
                placeholder={t('set.im.fieldChatNamePlaceholder')}
                value={draft.chatName}
                disabled={busy}
                onChange={(event) => set({ chatName: event.target.value })}
              />
            </Field>

            {fixedProject ? (
              <Field label={t('set.im.fieldProject')}>
                <Input aria-label={t('set.im.fieldProject')} value={fixedProject.name} disabled readOnly />
              </Field>
            ) : (
              <Field label={t('set.im.fieldProject')} hint={t('set.im.fieldProjectHint')}>
                <Select
                  aria-label={t('set.im.fieldProject')}
                  value={draft.projectId}
                  disabled={busy}
                  onChange={(event) => set({ projectId: event.target.value })}
                >
                  <Option value="">{t('set.im.fieldProjectPlaceholder')}</Option>
                  {(projects ?? []).map((project) => (
                    <Option key={project.id} value={project.id}>{project.name}</Option>
                  ))}
                </Select>
              </Field>
            )}

            <Choice className="items-center">
              <Switch
                aria-label={t('set.im.fieldEnableAria')}
                checked={draft.enabled}
                disabled={busy}
                onCheckedChange={(on) => set({ enabled: on })}
              />
              <span>{t('set.im.fieldEnableLabel')}</span>
            </Choice>

            <Field
              label={t('set.im.fieldTriggerMode')}
              hint={
                draft.channel === 'wecom'
                  ? t('set.im.fieldTriggerHintWecom')
                  : t('set.im.fieldTriggerHintOther')
              }
            >
              <Segmented
                label={t('set.im.fieldTriggerMode')}
                value={draft.triggerMode}
                disabled={busy}
                options={[
                  { value: 'mention_only', label: t('set.im.triggerMentionOnly') },
                  { value: 'mention_or_rules', label: t('set.im.triggerMentionOrRules') },
                ]}
                onChange={(value) => set({ triggerMode: value })}
              />
            </Field>

            {draft.triggerMode === 'mention_or_rules' ? (
              <Field
                label={t('set.im.fieldRules')}
                hint={t('set.im.fieldRulesHint')}
              >
                <Textarea
                  aria-label={t('set.im.fieldRulesAria')}
                  rows={3}
                  className="font-mono text-xs"
                  placeholder={t('set.im.fieldRulesPlaceholder')}
                  value={draft.ruleKeywordsText}
                  disabled={busy}
                  onChange={(event) => set({ ruleKeywordsText: event.target.value })}
                />
              </Field>
            ) : null}

            <Field
              label={t('set.im.fieldSenderPolicy')}
              hint={t('set.im.fieldSenderPolicyHint')}
            >
              <Segmented
                label={t('set.im.fieldSenderPolicy')}
                value={draft.allowAllSenders ? 'all' : 'whitelist'}
                disabled={busy}
                options={[
                  { value: 'whitelist', label: t('set.im.senderWhitelistOption') },
                  { value: 'all', label: t('set.im.sendersAll') },
                ]}
                onChange={(value) => set({ allowAllSenders: value === 'all' })}
              />
            </Field>

            {!draft.allowAllSenders ? (
              <Field
                label={t('set.im.fieldAllowedSenders')}
                hint={t('set.im.fieldAllowedSendersHint')}
              >
                <Textarea
                  aria-label={t('set.im.fieldAllowedSenders')}
                  rows={2}
                  className="font-mono text-xs"
                  placeholder={t('set.im.fieldAllowedSendersPlaceholder')}
                  value={draft.allowedSendersText}
                  disabled={busy}
                  onChange={(event) => set({ allowedSendersText: event.target.value })}
                />
              </Field>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('set.im.fieldCooldown')} hint={t('set.im.fieldCooldownHint', { min: IM_COOLDOWN_MIN, max: IM_COOLDOWN_MAX })}>
                <Input
                  aria-label={t('set.im.fieldCooldown')}
                  type="number"
                  min={IM_COOLDOWN_MIN}
                  max={IM_COOLDOWN_MAX}
                  className="tabular-nums"
                  value={draft.cooldownSeconds}
                  disabled={busy}
                  onChange={(event) => set({ cooldownSeconds: event.target.value })}
                />
              </Field>
              <Field label={t('set.im.fieldContextCount')} hint={t('set.im.fieldContextCountHint', { min: IM_INLINE_CONTEXT_MIN, max: IM_INLINE_CONTEXT_MAX })}>
                <Input
                  aria-label={t('set.im.fieldContextCount')}
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
                aria-label={t('set.im.fieldMediaAria')}
                className="mt-1"
                checked={draft.acceptMedia}
                disabled={busy}
                onCheckedChange={(on) => set({ acceptMedia: on })}
              />
              <span className="py-0.5">
                {t('set.im.fieldMediaLabel')}
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t('set.im.fieldMediaHint')}
                </span>
              </span>
            </Choice>

            <Choice className="items-start">
              <Switch
                aria-label={t('set.im.fieldNotifyAria')}
                className="mt-1"
                checked={draft.notifyEvents}
                disabled={busy}
                onCheckedChange={(on) => set({ notifyEvents: on })}
              />
              <span className="py-0.5">
                {t('set.im.notifyEventsLabel')}
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t('set.im.fieldNotifyHint')}
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
  const { t } = useI18n();
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
      editing.id === null ? t('set.im.boundNotice') : t('set.im.savedNotice'),
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
    <section aria-label={t('set.im.managerAria')} className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Note>{t('set.im.managerLead')}</Note>
        </div>
        <Button variant="primary" size="sm" disabled={busy || !data} onClick={() => openCreate()}>
          <Plus />{t('set.im.sheetTitleCreate')}
        </Button>
      </div>

      {unread ? <Problem role="alert">{t('set.im.loadFailed', { reason: unread.message })}</Problem> : null}
      {!editing && !confirming && error ? <Problem role="alert">{error}</Problem> : null}
      {statusNote ? <span role="status" className="text-xs text-success-foreground">{statusNote}</span> : null}
      {isPending ? <Skeleton className="h-28" /> : null}

      {data ? (
        <>
          {bindings.length > 0 ? (
            <div>
              <SectionTitle count={bindings.length}>{t('set.im.boundListTitle')}</SectionTitle>
              <Rows>
                <ul aria-label={t('set.im.boundListTitle')} className="divide-y divide-border">
                  {bindings.map((binding) => (
                    <GroupBindingRow
                      key={binding.id}
                      binding={binding}
                      showProject
                      busy={busy}
                      onPatch={(patch) => void act(
                        () => put(`/api/im/groups/${encodeURIComponent(binding.id)}`, bindingToPayload(binding, patch)),
                        t('set.im.updatedNotice'),
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
            <Empty icon={<Users />} title={t('set.im.emptyTitle')}>
              {t('set.im.emptyDesc')}
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
        title={t('set.im.unbindConfirmTitle', { name: confirming?.chat_name || confirming?.chat_id || '' })}
        description={t('set.im.unbindConfirmDesc')}
        confirm={t('set.im.unbindConfirmBtn')}
        busy={busy}
        error={confirming ? error : null}
        onConfirm={() => {
          if (!confirming) return;
          void act(() => del(`/api/im/groups/${encodeURIComponent(confirming.id)}`), t('set.im.unboundNotice')).then((done) => {
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
  labelKey: string;
  hintKey: (channel: ImChannel) => string;
}

const CAPABILITIES: readonly CapabilitySpec[] = [
  {
    suffix: 'chat',
    labelKey: 'set.im.cap.chat',
    hintKey: (ch) => (ch === 'wecom' ? 'set.im.cap.chatHintWecom' : 'set.im.cap.chatHintWeixin'),
  },
  {
    suffix: 'notify',
    labelKey: 'set.im.cap.notify',
    hintKey: () => 'set.im.cap.notifyHint',
  },
  {
    suffix: 'approveLogin',
    labelKey: 'set.im.cap.approveLogin',
    hintKey: (ch) => (ch === 'wecom' ? 'set.im.cap.approveLoginHintWecom' : 'set.im.cap.approveLoginHintWeixin'),
  },
];

function wecomStatusInfo(
  wecom: { connected?: boolean; error?: string | null } | null | undefined,
  configured: boolean,
  t: ReturnType<typeof useI18n>['t'],
): { tone: Tone; label: string; detail?: string } {
  if (wecom?.error) return { tone: 'failed', label: t('set.im.statusError'), detail: wecom.error };
  if (wecom?.connected) return { tone: 'success', label: t('set.connected') };
  if (configured) return { tone: 'waiting', label: t('set.im.statusReconnecting') };
  return { tone: 'ended', label: t('set.im.statusUnconfigured') };
}

function weixinStatusInfo(
  weixin: { state: string; error?: string | null } | null | undefined,
  t: ReturnType<typeof useI18n>['t'],
): { tone: Tone; label: string; detail?: string } {
  if (!weixin || weixin.state === 'disconnected') return { tone: 'ended', label: t('set.im.statusDisconnected') };
  if (weixin.error || weixin.state === 'error') {
    return { tone: 'failed', label: t('set.im.statusError'), detail: weixin.error ?? undefined };
  }
  if (weixin.state === 'connected') return { tone: 'success', label: t('set.connected') };
  if (weixin.state === 'waiting' || weixin.state === 'scanned' || weixin.state === 'pin_required') {
    return { tone: 'waiting', label: t('set.im.statusWaitingScan') };
  }
  if (weixin.state === 'expired') return { tone: 'waiting', label: t('set.im.statusQrExpired') };
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
  const { t } = useI18n();
  return (
    <Card aria-label={t('set.im.cardAria', { title })} className="flex flex-col gap-3.5 p-5">
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
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t('set.im.capMatrixTitle')}</p>
        <ul aria-label={t('set.im.capListAria', { title })} className="grid divide-y divide-border/60">
          {CAPABILITIES.map((cap) => {
            const key = `im.${channel}.${cap.suffix}`;
            const item = settings.find((setting) => setting.key === key);
            const checked = item ? Boolean(item.value) : true;
            const isSaving = saving === key;
            const isSaved = saved === key;
            const failure = errors[key];
            const capLabel = t(cap.labelKey);
            return (
              <li key={key} id={`setting-${key}`} className="py-2.5 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{capLabel}</span>
                      {isSaving ? <span className="text-xs text-muted-foreground">{t('common.saving')}</span> : null}
                      {isSaved ? <span role="status" className="text-xs text-success-foreground">{t('common.saved')}</span> : null}
                    </div>
                    <Note className="mt-0.5 text-xs">{t(cap.hintKey(channel))}</Note>
                  </div>
                  <Switch
                    aria-label={`${title} · ${capLabel}`}
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

const TABS: { id: ImChannelsTab; labelKey: string; icon: ComponentType<{ className?: string }> }[] = [
  { id: 'overview', labelKey: 'set.im.tab.overview', icon: ShieldCheck },
  { id: 'wecom', labelKey: 'set.im.tab.wecom', icon: Building2 },
  { id: 'weixin', labelKey: 'set.im.tab.weixin', icon: MessageCircle },
  { id: 'groups', labelKey: 'set.im.tab.groups', icon: Users },
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
  const { t } = useI18n();
  const [tab, setTab] = useState<ImChannelsTab>(initialTab);
  const [prevNavSeq, setPrevNavSeq] = useState(navSeq);
  if (prevNavSeq !== navSeq) {
    setPrevNavSeq(navSeq);
    setTab(initialTab);
  }

  const queryClient = useQueryClient();
  const { data: serviceState } = useQuery(stateQuery);
  const wecomStatus = wecomStatusInfo(serviceState?.channels?.wecom, wecomConfigured, t);
  const weixinStatus = weixinStatusInfo(serviceState?.channels?.weixin, t);
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
        aria-label={t('set.im.tabsAria')}
        className="sticky top-0 z-10 -mx-1 mb-5 flex items-center gap-1 overflow-x-auto border-b border-border bg-background/95 px-1 pt-0.5 pb-2 backdrop-blur-xs"
      >
        {TABS.map(({ id, labelKey, icon: Icon }) => {
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
              <span>{t(labelKey)}</span>
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
              title={t('set.im.channel.wecom')}
              summary={t('set.im.wecomSummary')}
              status={wecomStatus}
              setupLabel={t('set.im.wecomSetupBtn')}
              onOpenSetup={() => setTab('wecom')}
              action={canReconnectWecom ? (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={reconnecting}
                  onClick={() => void handleReconnectWecom()}
                >
                  <RefreshCw className={cn('size-3.5', reconnecting && 'animate-spin')} aria-hidden="true" />
                  {reconnecting ? t('set.im.reconnectingBtn') : t('set.im.reconnectBtn')}
                </Button>
              ) : null}
              actionFeedback={
                <>
                  {reconnectError ? <Problem role="alert" className="mt-1.5 text-xs">{reconnectError}</Problem> : null}
                  {reconnectOk ? <Note role="status" className="mt-1.5 text-xs text-success-foreground">{t('set.im.wecomReconnectSent')}</Note> : null}
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
              title={t('set.im.channel.weixin')}
              summary={t('set.im.weixinSummary')}
              status={weixinStatus}
              setupLabel={t('set.im.weixinSetupBtn')}
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
            {t('set.im.gatewayNote')}
          </Callout>
        </div>
      ) : null}

      {tab === 'wecom' ? (
        <div
          role="tabpanel"
          id="im-channels-panel-wecom"
          aria-labelledby="im-channels-tab-wecom"
        >
          <Note className="mb-4">{t('set.im.wecomConfigNote')}</Note>
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
