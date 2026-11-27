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
import { useI18n } from '@/lib/i18n';
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
  const { t } = useI18n();
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
            ? <span className="block truncate text-muted-foreground">{project.sources[0]!.label}{project.sources.length > 1 ? t('proj.list.moreSources', { count: project.sources.length }) : ''}</span>
            : <span className="block text-xs text-faint">{t('proj.list.noSources')}</span>}
        </span>
        {badges}
        <Chevron />
      </Link>
      {actions ? <div className="flex flex-none items-center gap-1.5 pr-3">{actions}</div> : null}
    </li>
  );
}

function ActiveProjectRow({ project }: { project: Project }) {
  const { t } = useI18n();
  const archive = useProjectFlag(project, 'archived');
  const [confirmArchive, setConfirmArchive] = useState(false);
  const notDone = project.unfinished ?? project.moving + project.waiting;
  return (
    <>
      <ProjectRow
        project={project}
        label={t('proj.list.projectAria', { name: project.name })}
        leading={(
          <span className="flex size-4 flex-none items-center justify-center">
            {project.waiting ? <Dot tone="waiting" /> : project.moving ? <Dot tone="running" /> : <span aria-hidden="true" className="size-2 rounded-full border border-border-strong" />}
          </span>
        )}
        badges={<>
          {project.paused_at != null ? <Badge tone="ended">{PROJECT_PAUSED_LABEL}</Badge> : null}
          <Badge tone={project.moving ? 'running' : 'plain'}>{t('proj.list.badgeMoving', { count: project.moving })}</Badge>
          <Badge tone={project.waiting ? 'waiting' : 'plain'}>{t('proj.list.badgeWaiting', { count: project.waiting })}</Badge>
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
            {t('proj.lifecycle.archive')}
          </Button>
        )}
      />
      {archive.error ? <li className="px-3.5 pb-2"><Problem role="alert">{archive.error}</Problem></li> : null}
      <Confirm
        open={confirmArchive}
        danger={false}
        title={t('proj.lifecycle.archiveConfirmTitle', { name: project.name })}
        description={t('proj.list.archiveUnfinishedDesc', { count: notDone })}
        confirm={t('proj.list.confirmArchive')}
        busy={archive.busy}
        onConfirm={() => { void archive.set(true).then(() => setConfirmArchive(false)); }}
        onCancel={() => setConfirmArchive(false)}
      />
    </>
  );
}

function ArchivedProjectRow({ project }: { project: Project }) {
  const { t } = useI18n();
  const archive = useProjectFlag(project, 'archived');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deletable = project.deletable;
  const canDelete = deletable?.allowed !== false;
  return (
    <>
      <ProjectRow
        project={project}
        label={t('proj.list.archivedProjectAria', { name: project.name })}
        badges={<Badge tone="ended">{PROJECT_ARCHIVED_LABEL}</Badge>}
        actions={<>
          <Button size="sm" variant="ghost" disabled={archive.busy} onClick={() => void archive.set(false)}>{t('common.resume')}</Button>
          <Button
            size="sm"
            variant="danger"
            disabled={!canDelete}
            title={canDelete ? undefined : deletable?.reason ?? undefined}
            onClick={() => setConfirmDelete(true)}
          >
            {t('common.delete')}
          </Button>
        </>}
      />
      {archive.error ? <li className="px-3.5 pb-2"><Problem role="alert">{archive.error}</Problem></li> : null}
      <DeleteProjectDialog project={project} open={confirmDelete} onOpenChange={setConfirmDelete} />
    </>
  );
}

export function ProjectsPage() {
  const { t } = useI18n();
  const { data, isPending, error } = useQuery(projectsQuery);
  const [creating, setCreating] = useState(false);
  const open = activeProjects(data ?? []);
  const archived = (data ?? []).filter((project) => project.archived_at != null);
  return (
    <Page
      title={t('nav.projects')}
      loading={isPending}
      failure={error?.message}
      actions={<Button variant="primary" onClick={() => setCreating(true)}><Plus />{t('nav.newProject')}</Button>}
    >
      <PageLead>{t('proj.list.lead')}</PageLead>
      {open.length ? (
        <Rows>
          <ul aria-label={t('nav.projects')} className="divide-y divide-border">
            {open.map((project) => <ActiveProjectRow key={project.id} project={project} />)}
          </ul>
        </Rows>
      ) : data ? (
        <Empty icon={<FolderPlus />} title={archived.length ? t('proj.list.allArchivedTitle') : t('proj.list.emptyTitle')}>
          <p>{archived.length ? t('proj.list.allArchivedDesc') : t('proj.list.emptyDesc')}</p>
          <Button variant="primary" className="mt-4" onClick={() => setCreating(true)}><Plus />{t('nav.newProject')}</Button>
        </Empty>
      ) : null}
      {archived.length ? (
        <section id="archived" aria-label={t('proj.list.archivedSectionAria', { count: archived.length })} className="mt-6">
          <SectionTitle count={archived.length}>{t('proj.list.archivedHeading')}</SectionTitle>
          <Rows>
            <ul aria-label={t('proj.list.archivedListAria')} className="divide-y divide-border">
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
