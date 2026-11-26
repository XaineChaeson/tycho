// Every project in one list: where the owner goes to see them side by side, and to make
// a new one. A project's own pages (its conversation, its work, its triggers, how it is
// set up) are under its name.
import { useQuery } from '@tanstack/react-query';
import { FolderPlus, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { PROJECT_ARCHIVED_LABEL, PROJECT_PAUSED_LABEL } from '@shared/labels.ts';
import { Chevron, Dot, Empty, Problem, Rows, SectionTitle } from '@/components/bits';
import { DeleteProjectDialog } from '@/components/delete-project-dialog';
import { NewProjectDialog } from '@/components/new-project';
import { Page, PageLead } from '@/components/page';
import { ProjectDirectory } from '@/components/project-directory';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Confirm } from '@/components/ui/dialog';
import { useProjectFlag } from '@/hooks/use-project-flag';
import { activeProjects } from '@/lib/projects';
import { projectsQuery } from '@/lib/queries';
import type { Project } from '@/lib/types';

// One project's row: its name, where its code is, and whatever this list says about it.
function ProjectRow({ project, label, leading, badges, actions }: {
  project: Project;
  label: string;
  leading?: ReactNode;
  badges: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-2 transition-colors duration-100 hover:bg-muted/60">
      <Link
        to={`/projects/${encodeURIComponent(project.id)}`}
        aria-label={label}
        className="flex min-w-0 flex-1 items-center gap-3 px-3.5 py-3 no-underline focus-visible:-outline-offset-2"
      >
        {leading}
        <span className="min-w-0 flex-1">
          <span className="block font-medium wrap-anywhere">{project.name}</span>
          {project.sources.length
            ? <span className="block truncate text-muted-foreground">{project.sources[0]!.label}{project.sources.length > 1 ? ` 等 ${project.sources.length} 个来源` : ''}</span>
            : <span className="block text-xs text-faint">没有代码来源</span>}
        </span>
        {badges}
        <Chevron />
      </Link>
      {actions ? <div className="flex flex-none items-center gap-1.5 pr-3">{actions}</div> : null}
    </li>
  );
}

function ActiveProjectRow({ project }: { project: Project }) {
  const archive = useProjectFlag(project, 'archived');
  const [confirmArchive, setConfirmArchive] = useState(false);
  const notDone = project.unfinished ?? project.moving + project.waiting;
  return (
    <>
      <ProjectRow
        project={project}
        label={`项目 ${project.name}`}
        leading={(
          <span className="flex size-4 flex-none items-center justify-center">
            {project.waiting ? <Dot tone="waiting" /> : project.moving ? <Dot tone="running" /> : <span aria-hidden="true" className="size-2 rounded-full border border-border-strong" />}
          </span>
        )}
        badges={<>
          {project.paused_at != null ? <Badge tone="ended">{PROJECT_PAUSED_LABEL}</Badge> : null}
          <Badge tone={project.moving ? 'running' : 'plain'}>{`在进行 ${project.moving}`}</Badge>
          <Badge tone={project.waiting ? 'waiting' : 'plain'}>{`等你 ${project.waiting}`}</Badge>
        </>}
        actions={(
          <Button
            size="sm"
            variant="ghost"
            disabled={archive.busy}
            onClick={() => {
              if (notDone > 0) setConfirmArchive(true);
              else void archive.set(true);
            }}
          >
            归档
          </Button>
        )}
      />
      {archive.error ? <li className="px-3.5 pb-2"><Problem role="alert">{archive.error}</Problem></li> : null}
      <Confirm
        open={confirmArchive}
        danger={false}
        title={`归档项目 ${project.name}？`}
        description={`还有 ${notDone} 项工作没结束：在跑的那一轮会做完，其余停在原地，恢复后接着做。`}
        confirm="确认归档"
        busy={archive.busy}
        onConfirm={() => { void archive.set(true).then(() => setConfirmArchive(false)); }}
        onCancel={() => setConfirmArchive(false)}
      />
    </>
  );
}

function ArchivedProjectRow({ project }: { project: Project }) {
  const archive = useProjectFlag(project, 'archived');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deletable = project.deletable;
  const canDelete = deletable?.allowed !== false;
  return (
    <>
      <ProjectRow
        project={project}
        label={`已归档的项目 ${project.name}`}
        badges={<Badge tone="ended">{PROJECT_ARCHIVED_LABEL}</Badge>}
        actions={<>
          <Button size="sm" variant="ghost" disabled={archive.busy} onClick={() => void archive.set(false)}>恢复</Button>
          <Button
            size="sm"
            variant="danger"
            disabled={!canDelete}
            title={canDelete ? undefined : deletable?.reason ?? undefined}
            onClick={() => setConfirmDelete(true)}
          >
            删除
          </Button>
        </>}
      />
      {archive.error ? <li className="px-3.5 pb-2"><Problem role="alert">{archive.error}</Problem></li> : null}
      <DeleteProjectDialog project={project} open={confirmDelete} onOpenChange={setConfirmDelete} />
    </>
  );
}

export function ProjectsPage() {
  const { data, isPending, error } = useQuery(projectsQuery);
  const [creating, setCreating] = useState(false);
  const open = activeProjects(data ?? []);
  const archived = (data ?? []).filter((project) => project.archived_at != null);
  return (
    <Page
      title="项目"
      loading={isPending}
      failure={error?.message}
      actions={<Button variant="primary" onClick={() => setCreating(true)}><Plus />新建项目</Button>}
    >
      <PageLead>任务属于项目，每个项目有自己的负责人，可限定项目允许使用的账号与执行机器。</PageLead>
      {open.length ? (
        <Rows>
          <ul aria-label="项目" className="divide-y divide-border">
            {open.map((project) => <ActiveProjectRow key={project.id} project={project} />)}
          </ul>
        </Rows>
      ) : data ? (
        <Empty icon={<FolderPlus />} title={archived.length ? '项目都归档了' : '还没有项目'}>
          <p>{archived.length ? '在下面的“已归档”里直接恢复或删除，或者建一个新的。' : '建一个，就能和它的负责人说话：只要名字，代码来源可以不填。'}</p>
          <Button variant="primary" className="mt-4" onClick={() => setCreating(true)}><Plus />新建项目</Button>
        </Empty>
      ) : null}
      {archived.length ? (
        <section id="archived" aria-label={`已归档（${archived.length}）`} className="mt-6">
          <SectionTitle count={archived.length}>已归档</SectionTitle>
          <Rows>
            <ul aria-label="已归档的项目" className="divide-y divide-border">
              {archived.map((project) => <ArchivedProjectRow key={project.id} project={project} />)}
            </ul>
          </Rows>
        </section>
      ) : null}
      <ProjectDirectory />
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </Page>
  );
}
