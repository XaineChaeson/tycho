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
import { useI18n } from '@/lib/i18n';
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

function replyModeText(source: InboundSource, t: ReturnType<typeof useI18n>['t']): string {
  const parts: string[] = [];
  if (source.push_final) parts.push(t('set.inbound.replyPushFinal'));
  if (source.broadcast_groups) {
    parts.push(source.broadcast_group_ids?.length
      ? t('set.inbound.replyBroadcastSelected', { count: source.broadcast_group_ids.length })
      : t('set.inbound.replyBroadcastAll'));
  }
  if (source.result_reply) parts.push(t('set.inbound.replyResultReply'));
  return parts.length > 0 ? parts.join(t('set.semiSep')) : t('set.inbound.replyAcceptOnly');
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
  const { t } = useI18n();
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
    ? t('set.inbound.projectHintStandardWebhooks')
    : t('set.inbound.projectHintMulti');
  return (
    <form id={id} className="grid gap-4" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <Field label={t('set.inbound.fieldName')} hint={t('set.inbound.fieldNameHint')}>
        <Input aria-label={t('set.inbound.fieldNameAria')} placeholder={t('set.inbound.fieldNamePlaceholder')} value={draft.name} disabled={busy} onChange={(event) => set({ name: event.target.value })} />
      </Field>
      <Field label={t('set.inbound.fieldKind')} hint={about}>
        <Select aria-label={t('set.inbound.fieldKind')} value={draft.kind} disabled={busy} onChange={(event) => changeKind(event.target.value as InboundKind)}>
          {kind.map((each) => <Option key={each.kind} value={each.kind}>{each.label}</Option>)}
        </Select>
      </Field>
      <Field label={t('set.inbound.fieldProjects')} hint={projectHint}>
        <div className="grid gap-1">
          {projects.length === 0 ? <Note className="text-xs">{t('set.inbound.noProjectsYet')}</Note> : null}
          {projects.map((project) => (
            <Choice key={project.id} className="min-h-9">
              <Checkbox aria-label={project.name} checked={draft.projectIds.includes(project.id)} disabled={busy} onChange={() => toggle(project.id)} />
              <span>{project.name}</span>
              {draft.kind !== 'github'
                ? <Mono className="ml-auto text-xs text-muted-foreground">{project.id}</Mono>
                : project.repos.length > 0
                  ? <Mono className="ml-auto text-xs text-muted-foreground">{project.repos.join(t('set.listSep'))}</Mono>
                  : <span className="ml-auto text-xs text-waiting-foreground">{t('set.inbound.noRepoConfigured')}</span>}
            </Choice>
          ))}
        </div>
      </Field>
      <Field label={t('set.inbound.fieldNote')} hint={t('set.inbound.fieldNoteHint')}>
        <Textarea aria-label={t('set.inbound.fieldNoteAria')} rows={3} className="max-h-[40vh] overflow-y-auto" value={draft.note} disabled={busy} onChange={(event) => set({ note: event.target.value })} />
      </Field>
      <Choice className="items-start">
        <Switch aria-label={t('set.inbound.replyPushFinal')} className="mt-1.5" checked={draft.pushFinal} disabled={busy} onCheckedChange={(on) => set({ pushFinal: on })} />
        <span className="py-1.5">{t('set.inbound.fieldPushFinalLabel')}</span>
      </Choice>
      <div className="grid gap-2">
        <Choice className="items-start">
          <Switch aria-label={t('set.inbound.fieldBroadcastLabel')} className="mt-1.5" checked={draft.broadcastGroups} disabled={busy} onCheckedChange={(on) => set({ broadcastGroups: on })} />
          <span className="py-1.5">
            {t('set.inbound.fieldBroadcastLabel')}
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {t('set.inbound.fieldBroadcastHint')}
            </span>
          </span>
        </Choice>
        {draft.broadcastGroups && matchingGroups.length > 0 ? (
          <div className="ml-11 grid gap-1 rounded-lg border border-border bg-muted/60 p-3">
            <span className="mb-0.5 text-xs font-medium text-muted-foreground">{t('set.inbound.fieldBroadcastGroupsHint')}</span>
            {matchingGroups.map((group) => (
              <Choice key={group.id} className="min-h-8">
                <Checkbox
                  aria-label={group.chat_name || group.chat_id}
                  checked={draft.broadcastGroupIds.includes(group.id)}
                  disabled={busy}
                  onChange={() => toggleGroup(group.id)}
                />
                <span className="min-w-0 truncate text-sm">{group.chat_name || group.chat_id}</span>
                <Badge tone="plain" className="text-2xs">{group.channel === 'wecom' ? t('set.im.channel.wecom') : t('set.im.channel.weixin')}</Badge>
                {(!group.enabled || !group.notify_events) ? (
                  <Badge tone="waiting" className="ml-auto text-2xs">{!group.enabled ? t('common.disabled') : t('set.inbound.groupBroadcastOff')}</Badge>
                ) : null}
              </Choice>
            ))}
          </div>
        ) : null}
      </div>
      {draft.kind === 'tycho-v1' ? (
        <Choice className="items-start">
          <Switch aria-label={t('set.inbound.replyResultReply')} className="mt-1.5" checked={draft.resultReply} disabled={busy} onCheckedChange={(on) => set({ resultReply: on })} />
          <span className="py-1.5">{t('set.inbound.fieldResultReplyLabel')}</span>
        </Choice>
      ) : null}
      {!made ? null : <Note className="text-xs">{t('set.inbound.editAppliesToNewNote')}</Note>}
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
  const { t } = useI18n();
  const tone = sourceDotTone(source);
  const statusNote = !source.enabled
    ? t('common.disabled')
    : source.problem
      ? t('set.inbound.statusProblem')
      : source.rejected
        ? t('set.inbound.statusRejected', { count: source.rejected.count })
        : !source.ready
          ? t('set.inbound.statusNoKey')
          : null;
  return (
    <li>
      <button
        ref={buttonRef}
        type="button"
        aria-label={t('set.inbound.selectSourceAria', { name: source.name })}
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
          <span className="tabular-nums">{t('set.inbound.projectCount', { count: source.project_ids.length })}</span>
          {source.broadcast_groups ? <Badge tone="plain" className="text-2xs">{t('set.inbound.badgeBroadcastGroups')}</Badge> : null}
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
  const { t } = useI18n();
  const projects = source.project_ids.flatMap((id) => page.projects.filter((project) => project.id === id));
  const missing = projects.length !== source.project_ids.length;
  const address = inboundAddress(source.path, page.reach.public_url);
  return (
    <Card aria-label={t('set.inbound.sourceCardAria', { name: source.name })} className="p-5">
      <header className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b border-border/80 pb-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Dot tone={sourceDotTone(source)} pulse={false} />
            <h2 className="min-w-0 text-base font-semibold wrap-anywhere">{source.name}</h2>
            <Badge tone="plain">{source.kind_label}</Badge>
            <Badge tone={source.enabled ? 'success' : 'ended'}>{source.enabled ? t('set.inbound.badgeEnabled') : t('common.disabled')}</Badge>
            {source.result_reply ? <Badge tone="plain">{t('set.inbound.badgeResultReply')}</Badge> : null}
            {source.push_final ? <Badge tone="plain">{t('set.inbound.badgePushFinal')}</Badge> : null}
            {source.broadcast_groups ? <Badge tone="plain">{t('set.inbound.badgeBroadcastGroups')}</Badge> : null}
          </div>
          {source.note ? (
            <p className="mt-2 border-l-2 border-border pl-2.5 text-sm text-muted-foreground wrap-anywhere">{source.note}</p>
          ) : null}
        </div>
        <div className="flex flex-none items-center gap-0.5">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>{t('common.edit')}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onToggle}>{source.enabled ? t('set.inbound.disableBtn') : t('set.inbound.enableBtn')}</Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={onDelete}>{t('common.delete')}</Button>
        </div>
      </header>

      {source.problem ? (
        <Callout tone="failed" role="alert" className="mt-4 text-xs">
          {t('set.inbound.problemBanner', { text: source.problem.text })}{t('set.parenOpen')}<Time at={source.problem.since} prefix={t('set.inbound.sincePrefix')} />{t('set.parenClose')}
        </Callout>
      ) : null}
      {source.rejected ? (
        <Callout tone="waiting" className="mt-3 text-xs">
          <span className="text-destructive">{t('set.inbound.rejectedBanner', { count: source.rejected.count, text: source.rejected.text })}{t('set.parenOpen')}<Time at={source.rejected.at} />{t('set.parenClose')}</span>
        </Callout>
      ) : null}

      <div className="mt-4">
        <Facts className="gap-y-2.5">
          <Fact label={t('set.inbound.factAddress')}>
            <span className="inline-flex flex-wrap items-center gap-1">
              <Copyable value={address} />
              <span className="text-xs text-muted-foreground">{t('set.inbound.postMethod')}</span>
            </span>
          </Fact>
          <Fact label={t('set.inbound.fieldProjects')}>
            <span className="text-sm wrap-anywhere">
              {projects.length === 0 && !missing
                ? t('set.inbound.noAllowedProjects')
                : `${projects.map((project) => projectLine(project, source.kind)).join(t('set.listSep'))}${missing ? `${projects.length ? t('set.listSep') : ''}${t('set.inbound.missingProjectsNote')}` : ''}`}
            </span>
          </Fact>
          <Fact label={t('set.inbound.factRouting')}>
            <span className="text-xs text-muted-foreground">
              {source.kind === 'github'
                ? t('set.inbound.routingGithub')
                : source.kind === 'standard-webhooks'
                  ? t('set.inbound.routingStandardWebhooks')
                  : t('set.inbound.routingTycho')}
            </span>
          </Fact>
          <Fact label={t('set.inbound.factReply')}>
            <span className="text-xs text-muted-foreground">{replyModeText(source, t)}</span>
          </Fact>
        </Facts>
      </div>

      <section aria-label={t('set.inbound.keysTitle')} className="mt-5 grid gap-2 border-t border-border/80 pt-4 text-xs">
        <h3 className="text-xs font-semibold text-muted-foreground">{t('set.inbound.keysTitle')}</h3>
        {source.keys.map((key) => (
          <p key={key.id} className="font-mono text-muted-foreground wrap-anywhere">
            {keyLine(key)}{key.retires_at ? <> <Time at={key.retires_at} /></> : null}
          </p>
        ))}
        {!source.ready ? <p className="text-destructive">{t('set.inbound.noKeyHint')}</p> : null}
        {issued ? (
          <Callout tone="waiting" role="status" aria-label={t('set.inbound.newKeyAria')} className="mt-1 grid gap-1.5 text-xs">
            <p>{t('set.inbound.newKeyNotice')}</p>
            <div className="flex items-center gap-1.5 rounded-sm bg-background px-2 py-1">
              <code className="min-w-0 flex-1 font-mono break-all select-all">{issued.secret}</code>
              <CopyButton value={issued.secret} label={t('set.inbound.copyKeyLabel')} />
            </div>
            <p className="text-muted-foreground">{source.kind === 'github' ? githubSigningText() : source.kind === 'standard-webhooks' ? standardWebhooksSigningText() : tychoSigningText()}</p>
            <div><Button size="sm" onClick={onDismiss}>{t('set.inbound.dismissKeyBtn')}</Button></div>
          </Callout>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <Button size="sm" disabled={busy} onClick={onIssue}>{source.ready ? t('set.inbound.rotateKeyBtn') : t('set.inbound.issueKeyBtn')}</Button>
          {source.ready ? <span className="text-muted-foreground">{t('set.inbound.rotateKeyHint')}</span> : null}
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
  const { t } = useI18n();
  if (fires.length === 0) {
    return <Note className="py-3 text-xs">{emptyText}</Note>;
  }
  return (
    <Rows>
      <ul aria-label={t('set.inbound.recentTitle')} className="divide-y divide-border">
        {fires.slice(0, RECENT_SHOWN).map((fire) => (
          <li key={fire.id} className="flex flex-wrap items-baseline gap-x-3 px-3.5 py-2.5 text-sm">
            <Time at={fire.created_at} className="w-24 flex-none text-xs text-faint" />
            <span className="min-w-0 font-medium wrap-anywhere">{fire.trigger_name}</span>
            <span className="text-xs text-muted-foreground wrap-anywhere">{`${projectName(fire.project_id, projects)} · ${fire.event_id}`}</span>
            <span className="ml-auto text-xs text-muted-foreground">{fireLine(fire)}</span>
            {fire.public_reply ? (
              <details className="mt-1 w-full text-xs text-muted-foreground">
                <summary className="cursor-pointer">{t('set.inbound.publishedReply')}</summary>
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
  const { t } = useI18n();
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
      title={t('inbound.title')}
      width="wide"
      loading={isPending}
      failure={unread ? t('set.inbound.loadFailed', { reason: unread.message }) : null}
      actions={<Button variant="primary" disabled={busy || !data} onClick={begin}><Plus />{t('set.inbound.newSourceBtn')}</Button>}
    >
      <PageLead>{t('set.inbound.pageLead')}</PageLead>
      {data ? (
        <>
          <Callout tone={data.reach.reach === 'ready' ? 'plain' : 'failed'} className="mb-5">
            <p>{data.reach.reach_text}</p>
            {data.reach.public_url ? (
              <p className="mt-1 text-muted-foreground wrap-anywhere">
                {t('set.inbound.publicUrlLabel')}<Copyable value={data.reach.public_url} />
              </p>
            ) : null}
          </Callout>

          {sources.length > 0 && selectedSource ? (
            <div className="grid grid-cols-1 items-start gap-5 shell:grid-cols-[260px_minmax(0,1fr)] wide:grid-cols-[296px_minmax(0,1fr)]">
              <aside
                aria-label={t('set.inbound.railAria')}
                className="flex flex-col overflow-hidden rounded-xl border border-border bg-raised shadow-card shell:sticky shell:top-4 shell:max-h-[calc(100dvh-9rem)]"
              >
                <div className="flex items-center justify-between gap-2 border-b border-border px-3.5 py-2.5">
                  <span className="text-xs font-semibold text-muted-foreground">{t('set.inbound.allSources')}</span>
                  <span className="rounded-full bg-hover px-1.5 text-xs leading-[18px] font-medium text-muted-foreground tabular-nums">{sources.length}</span>
                </div>
                <ul aria-label={t('inbound.title')} className="min-h-0 flex-1 divide-y divide-border/70 overflow-y-auto" onKeyDown={handleRailKeyDown}>
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
                      <div role="group" aria-label={t('set.inbound.recentScopeAria')} className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant={recentScope === 'selected' ? 'primary' : 'ghost'}
                          className="h-7 px-2 text-xs"
                          onClick={() => setRecentScope('selected')}
                        >
                          {t('set.inbound.scopeSelected', { count: selectedRecent.length })}
                        </Button>
                        <Button
                          size="sm"
                          variant={recentScope === 'all' ? 'primary' : 'ghost'}
                          className="h-7 px-2 text-xs"
                          onClick={() => setRecentScope('all')}
                        >
                          {t('set.inbound.scopeAll', { count: data.recent.length })}
                        </Button>
                      </div>
                    ) : undefined}
                  >
                    {t('set.inbound.recentTitle')}
                  </SectionTitle>
                  <RecentDeliveries
                    fires={shownRecent}
                    projects={data.projects}
                    emptyText={recentScope === 'selected' && data.recent.length > 0
                      ? t('set.inbound.recentEmptySelected')
                      : t('set.inbound.recentEmptyAll')}
                  />
                </Card>
              </div>
            </div>
          ) : (
            <>
              <Empty icon={<Radio />} title={t('set.inbound.emptyTitle')}>{t('set.inbound.emptyDesc')}</Empty>
              {!editing && !confirming && error ? <Problem role="alert" className="mt-3">{error}</Problem> : null}
              {data.recent.length ? (
                <Card className="mt-6 p-5">
                  <SectionTitle count={data.recent.length}>{t('set.inbound.recentTitle')}</SectionTitle>
                  <RecentDeliveries fires={data.recent} projects={data.projects} emptyText={t('set.inbound.recentEmptyShort')} />
                </Card>
              ) : null}
            </>
          )}

          <Sheet open={editing !== null} onOpenChange={(open) => { if (!open && !busy) { setEditing(null); setError(null); } }}>
            {editing && data ? (
              <SheetContent
                title={editing.id === null ? t('set.inbound.sheetTitleCreate') : t('set.inbound.sheetTitleEdit')}
                footer={(
                  <>
                    <Button type="submit" form="inbound-form" variant="primary" disabled={busy}>{busy ? t('set.saving') : t('set.inbound.saveSourceBtn')}</Button>
                    <Button variant="ghost" disabled={busy} onClick={() => { setEditing(null); setError(null); }}>{t('common.cancel')}</Button>
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
            title={t('set.inbound.deleteConfirmTitle', { name: confirming?.name ?? '' })}
            description={t('set.inbound.deleteConfirmDesc')}
            confirm={t('set.inbound.deleteConfirmBtn', { name: confirming?.name ?? '' })}
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
