import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { t as translate } from '@shared/i18n.ts';
import { Confirm } from '@/components/ui/dialog';
import { del, messageOf } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { projectsQuery } from '@/lib/queries';
import type { DeletionCount, Project, ProjectDeletion } from '@/lib/types';

const RUNS_LABEL = '轮次'; // i18n-ignore

function counted(each: readonly DeletionCount[]): string {
  return each
    .map(({ label, count, unit }) =>
      label === RUNS_LABEL
        ? translate('proj.delete.countRuns', { count })
        : translate('proj.delete.countItem', { count, unit, label }),
    )
    .join(translate('proj.delete.listSep'));
}

export function projectDeleteDescription(deletion: ProjectDeletion | undefined): string {
  return [
    translate('proj.delete.irreversible'),
    deletion?.counts.length
      ? translate('proj.delete.willDelete', { items: counted(deletion.counts) })
      : translate('proj.delete.nothingLeft'),
    deletion?.scope_removed.length
      ? translate('proj.delete.scopeRemoved', { items: counted(deletion.scope_removed) })
      : '',
    deletion?.canceled.length
      ? translate('proj.delete.canceled', { items: counted(deletion.canceled) })
      : '',
    deletion?.reduced.length
      ? translate('proj.delete.reduced', { items: counted(deletion.reduced) })
      : '',
    deletion?.finished.length
      ? translate('proj.delete.finished', { items: counted(deletion.finished) })
      : '',
    translate('proj.delete.retained'),
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
  const { t } = useI18n();
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
      title={t('proj.delete.title', { name: project.name })}
      description={projectDeleteDescription(project.deletable)}
      confirm={t('proj.delete.confirm', { name: project.name })}
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
