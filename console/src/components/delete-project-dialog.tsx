import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Confirm } from '@/components/ui/dialog';
import { del, messageOf } from '@/lib/api';
import { projectsQuery } from '@/lib/queries';
import type { DeletionCount, Project, ProjectDeletion } from '@/lib/types';

function counted(each: readonly DeletionCount[]): string {
  return each.map(({ label, count, unit }) => (label === '轮次' ? `${count} 轮` : `${count} ${unit}${label}`)).join('、');
}

export function projectDeleteDescription(deletion: ProjectDeletion | undefined): string {
  return [
    '删掉的东西不能恢复。',
    deletion?.counts.length ? `会删掉：${counted(deletion.counts)}。` : '这个项目没有留下任务、消息或触发器。',
    deletion?.scope_removed.length ? `会保留、但去掉这个项目：${counted(deletion.scope_removed)}。` : '',
    deletion?.canceled.length ? `会中止：${counted(deletion.canceled)}（它们要处理的东西跟着删了）。` : '',
    deletion?.reduced.length ? `会接着排队、材料里去掉这个项目：${counted(deletion.reduced)}。` : '',
    deletion?.finished.length ? `已经结束、只是记录里不再提被删的内容：${counted(deletion.finished)}。` : '',
    '会保留：适用于所有项目的知识、用量总数、主机上的代码目录和 GitHub 仓库。',
  ].join('');
}

export function DeleteProjectDialog({
  project,
  open,
  onOpenChange,
  onDeleted,
}: {
  project: Pick<Project, 'id' | 'name' | 'deletable'>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const client = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(): Promise<void> {
    setDeleting(true);
    setError(null);
    try {
      await del(`/api/projects/${encodeURIComponent(project.id)}`, {});
      await client.invalidateQueries({ queryKey: projectsQuery.queryKey });
      onOpenChange(false);
      onDeleted?.();
    } catch (refused) {
      setError(messageOf(refused));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Confirm
      open={open}
      title={`删除项目 ${project.name}？`}
      description={projectDeleteDescription(project.deletable)}
      confirm={`确认删除 ${project.name}`}
      busy={deleting}
      confirmDisabled={project.deletable?.allowed === false}
      error={error}
      onConfirm={() => void remove()}
      onCancel={() => {
        if (deleting) return;
        setError(null);
        onOpenChange(false);
      }}
    />
  );
}
