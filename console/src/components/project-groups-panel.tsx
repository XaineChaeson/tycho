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
import { projectGroupsQuery } from '@/lib/queries';
import type { ImGroupBinding, Project } from '@/lib/types';

export function ProjectGroupsPanel({ project }: { project: Project }) {
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
      editing.id === null ? '已绑定群聊到此项目' : '已保存群聊配置',
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
    <section aria-label={`${project.name} 的群聊与通知`} className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Note className="min-w-0 flex-1 text-xs">
          绑定到此项目的企业微信 / 微信群会直接路由给本项目负责人；开启“接收告警/结果播报”后，入站告警/触发器受理、关联任务结案结论以及负责人主动汇报都会同步播报到这些群（不附带私有控制台链接）。
          通道连接与全局权限请在<Link to="/settings/消息通道" className="mx-0.5">设置 › 消息通道</Link>管理。
        </Note>
        <Button variant="primary" size="sm" disabled={busy || !data} onClick={() => openCreate()}>
          <Plus />绑定群聊
        </Button>
      </div>

      {unread ? <Problem role="alert">{`读不到项目群聊绑定：${unread.message}`}</Problem> : null}
      {!editing && !confirming && error ? <Problem role="alert">{error}</Problem> : null}
      {statusNote ? <span role="status" className="text-xs text-success-foreground">{statusNote}</span> : null}
      {isPending ? <Skeleton className="h-24" /> : null}

      {data ? (
        <>
          {bindings.length > 0 ? (
            <div>
              <SectionTitle count={bindings.length}>已绑定到此项目的群聊</SectionTitle>
              <Rows>
                <ul aria-label={`${project.name} 已绑定群聊`} className="divide-y divide-border">
                  {bindings.map((binding) => (
                    <GroupBindingRow
                      key={binding.id}
                      binding={binding}
                      showProject={false}
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
            <Empty icon={<Users />} title="这个项目还没有绑定群聊">
              在企业微信或微信群里和机器人交互后，未绑定群会出现在下方；也可以点右上角“绑定群聊”直接绑定到此项目。
            </Empty>
          )}

          <DiscoveredGroupsSection
            discovered={data.discovered}
            boundKeys={boundKeys}
            busy={busy}
            actionLabel="绑定到此项目"
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
        title={`解绑群聊 ${confirming?.chat_name || confirming?.chat_id || ''}？`}
        description="解绑后该群不再关联到此项目，也不会再接收本项目的告警或结果播报。"
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
