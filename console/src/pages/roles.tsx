// 职能: what kind of work a task is. Each role says which tier it runs on by default,
// whether it may change things, what it hands back, and whether another task reviews it.
// Master-Detail split view: compact role list on the left, focused viewer & editor on the right,
// and a drawer to add a new role.
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  DELIVERABLES, ENFORCED_TEXT, PERMISSIONS, REVIEW_KEEP_TEXT, REVIEW_ROLE_ID, REVIEW_SHAPE, REVIEW_SHAPE_TEXT,
  REVIEW_TIER_TEXT, deliverableLabel, permissionLabel, type DeliverableId, type PermissionId, type RoleConfig,
} from '@shared/roles.ts';
import { TIERS, tierLabel, type TierId } from '@shared/tiers.ts';
import { Callout, Card, Field, Mono, Note, Problem } from '@/components/bits';
import { Page, PageLead } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Choice } from '@/components/ui/checkbox';
import { Confirm, Sheet, SheetContent } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Option, Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useChange } from '@/hooks/use-change';
import { del, messageOf, put } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { rolesQuery } from '@/lib/queries';
import type { Role } from '@/lib/types';
import { cn } from '@/lib/utils';

const CHANGE = ['role-change'];

// A new role starts shaped like analysis: the roles the owner adds (design, diagnosis,
// research) are, by the design (docs/design/roles-and-tiers.md §3.1).
const BLANK: RoleConfig = { id: '', name: '', description: '', default_tier: 'decide', permission: 'read', deliverable: 'report', needs_review: false };

// Every field goes with a save: the service takes a role whole.
const bodyOf = ({ id: _id, ...rest }: RoleConfig) => ({ ...rest, name: rest.name.trim(), description: rest.description.trim() });

const configOf = (role: Role): RoleConfig => ({
  id: role.id, name: role.name, description: role.description, default_tier: role.default_tier,
  permission: role.permission, deliverable: role.deliverable, needs_review: role.needs_review,
});

const same = (a: RoleConfig, b: RoleConfig): boolean => JSON.stringify(bodyOf(a)) === JSON.stringify(bodyOf(b));

const withRole = (roles: readonly Role[], saved: Role): Role[] =>
  roles.some((each) => each.id === saved.id) ? roles.map((each) => (each.id === saved.id ? saved : each)) : [...roles, saved];

const shortTierLabel = (tier: TierId): string => tierLabel(tier).replace(/档$/, ''); // i18n-ignore

function RoleFields({ draft, review, saving, onChange }: { draft: RoleConfig; review: boolean; saving: boolean; onChange: (draft: RoleConfig) => void }) {
  const { t } = useI18n();
  return (
    <div className="grid gap-4">
      <Field label={t('know.field.name')}>
        <Input aria-label={t('know.field.name')} placeholder={t('know.roles.namePlaceholder')} value={draft.name} disabled={saving} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
      </Field>
      <Field label={t('know.roles.descLabel')}>
        <Textarea aria-label={t('know.roles.descLabel')} rows={3} className="max-h-[40vh] overflow-y-auto" placeholder={t('know.roles.descPlaceholder')} value={draft.description} disabled={saving} onChange={(event) => onChange({ ...draft, description: event.target.value })} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t('know.roles.defaultTier')}>
          <Select aria-label={t('know.roles.defaultTier')} wrapperClassName="flex" value={draft.default_tier} disabled={saving} onChange={(event) => onChange({ ...draft, default_tier: event.target.value as TierId })}>
            {TIERS.map((tier) => <Option key={tier.id} value={tier.id}>{tier.label}</Option>)}
          </Select>
        </Field>
        <Field label={t('know.roles.permission')}>
          <Select aria-label={t('know.roles.permission')} wrapperClassName="flex" value={draft.permission} disabled={saving || review} onChange={(event) => onChange({ ...draft, permission: event.target.value as PermissionId })}>
            {PERMISSIONS.map((each) => <Option key={each.id} value={each.id}>{each.label}</Option>)}
          </Select>
        </Field>
        <Field label={t('know.roles.deliverable')}>
          <Select aria-label={t('know.roles.deliverable')} wrapperClassName="flex" value={draft.deliverable} disabled={saving || review} onChange={(event) => onChange({ ...draft, deliverable: event.target.value as DeliverableId })}>
            {DELIVERABLES.map((each) => <Option key={each.id} value={each.id}>{each.label}</Option>)}
          </Select>
        </Field>
      </div>
      {review ? <Note className="text-xs">{REVIEW_SHAPE_TEXT}</Note> : (
        <Note className="text-xs">{t('know.roles.deliverableHint')}</Note>
      )}
      <Choice>
        <Switch aria-label={t('know.roles.needsReview')} checked={draft.needs_review} disabled={saving} onCheckedChange={(on) => onChange({ ...draft, needs_review: on })} />
        {t('know.roles.needsReview')}
      </Choice>
    </div>
  );
}

function RoleDetailCard({ role, busy, onDirtyChange, onSave, onDelete }: {
  role: Role;
  busy: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onSave: (draft: RoleConfig) => Promise<Role>;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const review = role.id === REVIEW_ROLE_ID;
  const [baseline, setBaseline] = useState<RoleConfig>(() => configOf(role));
  const [draft, setDraft] = useState<RoleConfig>(() => configOf(role));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync external refresh only when the owner has no unsaved edits in progress.
  useEffect(() => {
    const incoming = configOf(role);
    setBaseline((prevBaseline) => {
      if (same(prevBaseline, incoming)) return prevBaseline;
      setDraft((prevDraft) => (same(prevDraft, prevBaseline) ? incoming : prevDraft));
      return incoming;
    });
  }, [role]);

  const dirty = !same(draft, baseline);
  const ready = dirty && draft.name.trim() !== '';

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => {
    onDirtyChange?.(false);
  }, [onDirtyChange]);

  async function save(): Promise<void> {
    if (busy || saving || !ready) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await onSave({ ...draft, id: role.id });
      const next = configOf(saved);
      setBaseline(next);
      setDraft(next);
    } catch (refused) {
      setError(messageOf(refused));
    } finally {
      setSaving(false);
    }
  }

  function reset(): void {
    setDraft(baseline);
    setError(null);
  }

  return (
    <Card aria-label={t('know.roles.cardAria', { name: role.name })} className="grid gap-5 p-5">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="text-lg font-semibold tracking-[-0.01em] wrap-anywhere">{role.name}</h2>
            <Mono className="rounded bg-hover px-1.5 py-0.5 text-xs text-muted-foreground">{role.id}</Mono>
          </div>
          <p className="mt-1 text-sm text-muted-foreground wrap-anywhere">{role.description || t('know.roles.noDescription')}</p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Badge tone="plain">{t('know.roles.defaultTierBadge', { tier: tierLabel(role.default_tier) })}</Badge>
            <Badge tone={role.permission === 'read' ? 'plain' : 'running'}>{permissionLabel(role.permission)}</Badge>
            <Badge tone="plain">{t('know.roles.deliverableBadge', { deliverable: deliverableLabel(role.deliverable) })}</Badge>
            <Badge tone={role.needs_review ? 'waiting' : 'plain'}>{role.needs_review ? t('know.roles.needsReview') : t('know.roles.noReviewNeeded')}</Badge>
          </div>
        </div>
        {review ? null : (
          <div className="flex flex-none items-center gap-1">
            <Button size="sm" variant="danger" disabled={busy || saving} onClick={onDelete}>{t('common.delete')}</Button>
          </div>
        )}
      </header>

      {review ? (
        <Callout tone="plain" className="grid gap-1 text-xs">
          <Note className="text-xs">{REVIEW_KEEP_TEXT}</Note>
          <Note className="text-xs">{REVIEW_TIER_TEXT}</Note>
        </Callout>
      ) : null}

      <form
        className="grid gap-4 border-t border-border/70 pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <RoleFields draft={draft} review={review} saving={saving} onChange={setDraft} />
        {error ? <Problem role="alert">{error}</Problem> : null}
        <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-4">
          <Button type="submit" variant="primary" disabled={busy || saving || !ready}>{saving ? t('know.saving') : t('common.save')}</Button>
          {dirty || error ? (
            <Button type="button" variant="ghost" disabled={saving} onClick={reset}>{t('common.cancel')}</Button>
          ) : null}
          {dirty && !saving ? (
            <span className="ml-auto text-xs text-muted-foreground">{t('know.roles.unsavedChanges')}</span>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

// The drawer a new role is written in.
function NewRoleSheet({ roles, busy, onSave, onClose }: {
  roles: readonly Role[];
  busy: boolean;
  onSave: (draft: RoleConfig) => Promise<Role>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<RoleConfig>(BLANK);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = draft.id.trim();
  // Saving under a name that is taken would change that role, not add one.
  const taken = roles.find((each) => each.id === id);
  const ready = id !== '' && draft.name.trim() !== '' && !taken;

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...draft, id });
      onClose();
    } catch (refused) {
      setError(messageOf(refused));
      setSaving(false);
    }
  }

  return (
    <SheetContent
      title={t('know.roles.newTitle')}
      footer={(
        <>
          <Button variant="primary" disabled={busy || saving || !ready} onClick={() => void save()}>{saving ? t('know.saving') : t('know.roles.addSubmit')}</Button>
          <Button variant="ghost" disabled={saving} onClick={onClose}>{t('common.cancel')}</Button>
        </>
      )}
    >
      <div className="grid gap-4">
        <Field label={t('know.roles.idLabel')} hint={taken ? undefined : t('know.roles.idHint')} error={taken ? t('know.roles.idTaken', { id, name: taken.name }) : undefined}>
          <Input aria-label={t('know.roles.idLabel')} className="font-mono text-xs" placeholder={t('know.roles.idPlaceholder')} value={draft.id} disabled={saving} onChange={(event) => setDraft({ ...draft, id: event.target.value })} />
        </Field>
        <RoleFields draft={draft} review={false} saving={saving} onChange={setDraft} />
        {error ? <Problem role="alert">{error}</Problem> : null}
      </div>
    </SheetContent>
  );
}

export function RolesPage() {
  const { t } = useI18n();
  const { data, isPending, error } = useQuery(rolesQuery);
  const change = useChange<Role[]>({ mutationKey: CHANGE, queryKey: rolesQuery.queryKey, reread: true });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailDirty, setDetailDirty] = useState(false);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Role | null>(null);
  const [removing, setRemoving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const path = (id: string): string => `/api/roles/${encodeURIComponent(id)}`;

  const save = async (draft: RoleConfig): Promise<Role> => {
    // The review role's shape is not the owner's to change; it goes as it must be.
    const body = draft.id === REVIEW_ROLE_ID ? { ...bodyOf(draft), ...REVIEW_SHAPE } : bodyOf(draft);
    let savedRole: Role | null = null;
    await change.send(
      () => put<{ role: Role }>(path(draft.id), body),
      (roles, answer) => {
        savedRole = answer.role;
        return withRole(roles, answer.role);
      },
    );
    return savedRole!;
  };

  async function remove(role: Role): Promise<void> {
    setRemoving(true);
    setRefusal(null);
    try {
      await change.send(() => del(path(role.id)), (roles) => roles.filter((each) => each.id !== role.id));
      setDeleting(null);
    } catch (refused) {
      setRefusal(messageOf(refused));
    } finally {
      setRemoving(false);
    }
  }

  const roles = data ?? [];
  const selected = roles.find((each) => each.id === selectedId) ?? roles[0] ?? null;

  useEffect(() => {
    if (!detailDirty) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [detailDirty]);

  const selectRole = (nextId: string): boolean => {
    if (selected?.id === nextId) return true;
    if (detailDirty && !window.confirm(t('know.roles.unsavedSwitchConfirm'))) {
      return false;
    }
    setDetailDirty(false);
    setSelectedId(nextId);
    return true;
  };

  const handleRailKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (roles.length <= 1) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = roles.findIndex((each) => each.id === selected?.id);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = roles[index < 0 ? 0 : (index + delta + roles.length) % roles.length];
    if (next && selectRole(next.id)) {
      rowRefs.current.get(next.id)?.focus();
    }
  };

  return (
    <Page
      title={t('roles.title')}
      width="wide"
      loading={isPending}
      failure={error?.message}
      actions={<Button variant="primary" disabled={change.busy} onClick={() => setAdding(true)}><Plus />{t('know.roles.addBtn')}</Button>}
    >
      {data ? (
        <article>
          <PageLead className="mb-2">{t('know.roles.lead')}</PageLead>
          <Note className="mb-5 max-w-[78ch] text-xs">{ENFORCED_TEXT}</Note>

          <div className="grid grid-cols-1 items-start gap-5 shell:grid-cols-[252px_minmax(0,1fr)] wide:grid-cols-[280px_minmax(0,1fr)]">
            <aside aria-label={t('know.roles.listAria')} className="overflow-hidden rounded-xl bg-raised shadow-card shell:sticky shell:top-4">
              <div className="flex items-center justify-between border-b border-border/60 bg-muted/50 px-3.5 py-2 text-[11px] font-semibold tracking-wide text-muted-foreground">
                <span>{t('know.roles.allRoles')}</span>
                <span className="rounded-full bg-hover px-1.5 leading-[17px] tabular-nums">{roles.length}</span>
              </div>
              <ul className="divide-y divide-border/60" onKeyDown={handleRailKeyDown}>
                {roles.map((role) => {
                  const active = selected?.id === role.id;
                  return (
                    <li key={role.id}>
                      <button
                        ref={(node) => {
                          if (node) rowRefs.current.set(role.id, node);
                          else rowRefs.current.delete(role.id);
                        }}
                        type="button"
                        aria-label={t('know.roles.selectAria', { name: role.name })}
                        aria-current={active ? 'true' : undefined}
                        onClick={() => { selectRole(role.id); }}
                        className={cn(
                          'relative flex w-full flex-col gap-1.5 px-3.5 py-2.5 text-left transition-colors hover:bg-hover/60',
                          active && 'bg-brand-soft/45 hover:bg-brand-soft/55',
                        )}
                      >
                        {active ? <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-primary" /> : null}
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 flex-1 items-center gap-1.5">
                            <span className={cn('min-w-0 truncate text-sm text-foreground', active ? 'font-semibold' : 'font-medium')}>
                              {role.name}
                            </span>
                            {active && detailDirty ? (
                              <span aria-hidden="true" data-slot="dirty-dot" title={t('know.roles.dirtyDotTitle')} className="size-1.5 flex-none rounded-full bg-primary" />
                            ) : null}
                          </span>
                          <Mono className="flex-none text-[11px] text-faint">{role.id}</Mono>
                        </div>
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge tone="plain" className="px-1.5 py-0 text-[11px]">{shortTierLabel(role.default_tier)}</Badge>
                          <Badge tone={role.permission === 'read' ? 'plain' : 'running'} className="px-1.5 py-0 text-[11px]">
                            {permissionLabel(role.permission)}
                          </Badge>
                          {role.needs_review ? (
                            <Badge tone="waiting" className="px-1.5 py-0 text-[11px]">{t('know.roles.reviewBadge')}</Badge>
                          ) : null}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </aside>

            <div className="min-w-0">
              {selected ? (
                <RoleDetailCard
                  key={selected.id}
                  role={selected}
                  busy={change.busy}
                  onDirtyChange={setDetailDirty}
                  onSave={save}
                  onDelete={() => { setRefusal(null); setDeleting(selected); }}
                />
              ) : null}
            </div>
          </div>

          <Sheet open={adding} onOpenChange={(open) => { if (!open) setAdding(false); }}>
            {adding ? (
              <NewRoleSheet
                roles={data}
                busy={change.busy}
                onSave={async (draft) => {
                  const created = await save(draft);
                  setSelectedId(created.id);
                  return created;
                }}
                onClose={() => setAdding(false)}
              />
            ) : null}
          </Sheet>

          <Confirm
            open={deleting !== null}
            title={t('know.roles.deleteConfirmTitle', { name: deleting?.name ?? '' })}
            confirm={t('know.roles.deleteConfirmBtn')}
            busy={removing}
            error={refusal}
            onConfirm={() => { if (deleting) void remove(deleting); }}
            onCancel={() => { setDeleting(null); setRefusal(null); }}
          />
        </article>
      ) : null}
    </Page>
  );
}
