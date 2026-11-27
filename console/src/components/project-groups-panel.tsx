import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Users } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Empty, Note, Problem, Rows, SectionTitle } from '@/components/bits';
import {
  bindingToPayload,
  DiscoveredGroupsSection,
  emptyGroupBindingDraft,
  groupBindingDraftOf,
  GroupBindingRow,
  GroupBindingSheet,
  invalidateGroupQueries,
  parseGroupBindingPayload,
  type GroupBindingDraft,
} from '@/components/im-channels-panel';
import { Button } from '@/components/ui/button';
import { Confirm } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { del, messageOf, post, put } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { projectGroupsQuery } from '@/lib/queries';
import type { ImGroupBinding, Project } from '@/lib/types';

const IM_CHANNELS_SETTINGS_PATH = '/settings/消息通道'; // i18n-ignore

export function ProjectGroupsPanel({ project }: { project: Project }) {
  const { t } = useI18n();
  const { data, isPending, error: unread } = useQuery(projectGroupsQuery(project.id));
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
    const parsed = parseGroupBindingPayload({ ...editing.draft, projectId: project.id });
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const done = await act(
      () => (editing.id === null
        ? post('/api/im/groups', parsed.body)
        : put(`/api/im/groups/${encodeURIComponent(editing.id)}`, parsed.body)),
      editing.id === null ? t('proj.groups.boundToast') : t('proj.groups.savedToast'),
    );
    if (done) setEditing(null);
  }

  const openCreate = (over: Partial<GroupBindingDraft> = {}): void => {
    setEditing({
      id: null,
      draft: emptyGroupBindingDraft({ projectId: project.id, ...over }),
    });
    setError(null);
  };

  const bindings = data?.bindings ?? [];
  const boundKeys = new Set(bindings.map((binding) => `${binding.channel}:${binding.chat_id}`));

  return (
    <section aria-label={t('proj.groups.sectionAria', { name: project.name })} className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Note className="min-w-0 flex-1 text-xs">
          {t('proj.groups.notePrefix')}
          <Link to={IM_CHANNELS_SETTINGS_PATH} className="mx-0.5">{t('proj.groups.settingsLink')}</Link>
          {t('proj.groups.noteSuffix')}
        </Note>
        <Button variant="primary" size="sm" disabled={busy || !data} onClick={() => openCreate()}>
          <Plus />{t('proj.groups.bindBtn')}
        </Button>
      </div>

      {unread ? <Problem role="alert">{t('proj.groups.loadFailed', { reason: unread.message })}</Problem> : null}
      {!editing && !confirming && error ? <Problem role="alert">{error}</Problem> : null}
      {statusNote ? <span role="status" className="text-xs text-success-foreground">{statusNote}</span> : null}
      {isPending ? <Skeleton className="h-24" /> : null}

      {data ? (
        <>
          {bindings.length > 0 ? (
            <div>
              <SectionTitle count={bindings.length}>{t('proj.groups.boundHeading')}</SectionTitle>
              <Rows>
                <ul aria-label={t('proj.groups.boundListAria', { name: project.name })} className="divide-y divide-border">
                  {bindings.map((binding) => (
                    <GroupBindingRow
                      key={binding.id}
                      binding={binding}
                      showProject={false}
                      busy={busy}
                      onPatch={(patch) => void act(
                        () => put(`/api/im/groups/${encodeURIComponent(binding.id)}`, bindingToPayload(binding, patch)),
                        t('proj.groups.updatedToast'),
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
            <Empty icon={<Users />} title={t('proj.groups.emptyTitle')}>
              {t('proj.groups.emptyDesc')}
            </Empty>
          )}

          <DiscoveredGroupsSection
            discovered={data.discovered}
            boundKeys={boundKeys}
            busy={busy}
            actionLabel={t('proj.groups.quickBindAction')}
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
        fixedProject={{ id: project.id, name: project.name }}
        busy={busy}
        error={editing ? error : null}
        onChange={(draft) => setEditing((curr) => (curr ? { ...curr, draft } : null))}
        onSave={() => void save()}
        onClose={() => { setEditing(null); setError(null); }}
      />

      <Confirm
        open={confirming !== null}
        title={t('proj.groups.unbindTitle', { name: confirming?.chat_name || confirming?.chat_id || '' })}
        description={t('proj.groups.unbindDesc')}
        confirm={t('proj.groups.unbindConfirm')}
        busy={busy}
        error={confirming ? error : null}
        onConfirm={() => {
          if (!confirming) return;
          void act(() => del(`/api/im/groups/${encodeURIComponent(confirming.id)}`), t('proj.groups.unboundToast')).then((done) => {
            if (done) setConfirming(null);
          });
        }}
        onCancel={() => { setConfirming(null); setError(null); }}
      />
    </section>
  );
}
