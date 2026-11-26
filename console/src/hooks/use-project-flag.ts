// The owner's pause or archive of one project (docs/design/project-sessions.md, "按项目暂停"
// and "项目的生命周期"): one press, in effect at once, never part of a page's draft. The
// settings page and the project page's notice both use it, so the two cannot come to
// different answers.
import { useState } from 'react';
import { useChange } from '@/hooks/use-change';
import { messageOf, post } from '@/lib/api';
import { withProject } from '@/lib/projects';
import { projectsQuery } from '@/lib/queries';
import type { Project } from '@/lib/types';

// The same lock as the settings page's saves: a pause or an archive and a save of the same
// list go one by one.
const CHANGE = ['project-change'];

export type ProjectFlag = 'paused' | 'archived';

export function useProjectFlag(project: Pick<Project, 'id'> & Partial<Pick<Project, 'paused_at' | 'archived_at'>>, flag: ProjectFlag) {
  const change = useChange<Project[]>({ mutationKey: CHANGE, queryKey: projectsQuery.queryKey, reread: true });
  const [error, setError] = useState<string | null>(null);
  const on = project[flag === 'paused' ? 'paused_at' : 'archived_at'] != null;
  const endpoint = flag === 'paused' ? 'pause' : 'archive';
  const set = async (value: boolean): Promise<boolean> => {
    setError(null);
    try {
      await change.send(
        () => post<{ project: Project }>(`/api/projects/${encodeURIComponent(project.id)}/${endpoint}`, { [flag]: value }),
        (projects, answer) => withProject(projects, answer.project),
      );
      return true;
    } catch (refused) {
      setError(messageOf(refused));
      return false;
    }
  };
  return { on, busy: change.busy, error, set };
}
