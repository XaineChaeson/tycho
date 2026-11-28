// Every project in one list: where the owner goes to see them side by side, and to make
// a new one. A project's own pages (its conversation, its work, its triggers, how it is
// set up) are under its name.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderCog, FolderPlus, Pin, PinOff, Plus } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { PROJECT_ARCHIVED_LABEL, PROJECT_PAUSED_LABEL } from '@shared/labels.ts';
import { Chevron, Dot, Empty, Problem, Rows, SectionTitle } from '@/components/bits';
import { DeleteProjectDialog } from '@/components/delete-project-dialog';
import { NewProjectDialog } from '@/components/new-project';
import { Page, PageLead } from '@/components/page';
import { ProjectDirectory } from '@/components/project-directory';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Confirm, Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useProjectFlag } from '@/hooks/use-project-flag';
import { messageOf, post, put } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { activeProjects, groupActiveProjects, projectCategories, withProject } from '@/lib/projects';
import { projectsQuery } from '@/lib/queries';
import type { Project } from '@/lib/types';
import { cn } from '@/lib/utils';

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

function ActiveProjectRow({ project, showCategoryBadge = true }: { project: Project; showCategoryBadge?: boolean }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const archive = useProjectFlag(project, 'archived');
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const notDone = project.unfinished ?? project.moving + project.waiting;

  async function togglePin(): Promise<void> {
    setPinBusy(true);
    setPinError(null);
    try {
      const { project: saved } = await put<{ project: Project }>(`/api/projects/${encodeURIComponent(project.id)}`, { pinned: !project.pinned });
      client.setQueryData<Project[]>(projectsQuery.queryKey, (prev) => withProject(prev ?? [], saved));
      void client.invalidateQueries({ queryKey: projectsQuery.queryKey });
    } catch (err) {
      setPinError(messageOf(err));
    } finally {
      setPinBusy(false);
    }
  }

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
          {showCategoryBadge && project.category ? <Badge tone="plain">{project.category}</Badge> : null}
          {project.paused_at != null ? <Badge tone="ended">{PROJECT_PAUSED_LABEL}</Badge> : null}
          <Badge tone={project.moving ? 'running' : 'plain'}>{t('proj.list.badgeMoving', { count: project.moving })}</Badge>
          <Badge tone={project.waiting ? 'waiting' : 'plain'}>{t('proj.list.badgeWaiting', { count: project.waiting })}</Badge>
        </>}
        actions={<>
          <Button
            size="icon-sm"
            variant="ghost"
            type="button"
            aria-label={project.pinned ? t('nav.unpinProject') : t('nav.pinProject')}
            aria-pressed={Boolean(project.pinned)}
            title={project.pinned ? t('nav.unpinProject') : t('nav.pinProject')}
            disabled={pinBusy}
            onClick={() => void togglePin()}
          >
            {project.pinned ? <PinOff className="size-3.5 text-primary" aria-hidden="true" /> : <Pin className="size-3.5 text-muted-foreground" aria-hidden="true" />}
          </Button>
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
        </>}
      />
      {archive.error ? <li className="px-3.5 pb-2"><Problem role="alert">{archive.error}</Problem></li> : null}
      {pinError ? <li className="px-3.5 pb-2"><Problem role="alert">{pinError}</Problem></li> : null}
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

function ManageCategoriesDialog({
  open,
  onOpenChange,
  projects,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: readonly Project[];
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of projects) {
      if (project.archived_at != null) continue;
      const cat = project.category?.trim();
      if (!cat) continue;
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  }, [projects]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function applyRename(from: string, to: string | null): Promise<void> {
    setBusy(from);
    setError(null);
    try {
      const res = await post<{ updated: number; projects: Project[] }>('/api/projects/categories/rename', { from, to });
      if (Array.isArray(res.projects)) {
        client.setQueryData<Project[]>(projectsQuery.queryKey, res.projects);
      }
      void client.invalidateQueries({ queryKey: projectsQuery.queryKey });
      setEditing(null);
      setDraftName('');
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      {open ? (
        <DialogContent title={t('proj.list.manageCategoriesTitle')} description={t('proj.list.manageCategoriesDesc')}>
          {error ? <Problem role="alert" className="mb-3">{error}</Problem> : null}
          {categories.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('proj.list.noCategoriesYet')}</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {categories.map(([cat, count]) => {
                const isEditing = editing === cat;
                const isBusy = busy === cat;
                return (
                  <li key={cat} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                    {isEditing ? (
                      <form
                        className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const trimmed = draftName.trim();
                          if (trimmed === '' || trimmed === cat) { setEditing(null); return; }
                          void applyRename(cat, trimmed);
                        }}
                      >
                        <Input
                          aria-label={t('proj.list.renamePlaceholder')}
                          placeholder={t('proj.list.renamePlaceholder')}
                          autoFocus
                          maxLength={40}
                          className="min-w-36 flex-1"
                          value={draftName}
                          disabled={isBusy}
                          onChange={(event) => setDraftName(event.target.value)}
                        />
                        <Button type="submit" size="sm" variant="primary" disabled={isBusy || draftName.trim() === ''}>
                          {t('common.save')}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" disabled={isBusy} onClick={() => setEditing(null)}>
                          {t('common.cancel')}
                        </Button>
                      </form>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{cat}</span>
                        <span className="text-xs text-faint tabular-nums">{t('proj.list.categoryCount', { count })}</span>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy !== null}
                          onClick={() => { setEditing(cat); setDraftName(cat); setError(null); }}
                        >
                          {t('proj.list.renameCategoryBtn')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy !== null}
                          onClick={() => void applyRename(cat, null)}
                        >
                          {t('proj.list.dissolveCategoryBtn')}
                        </Button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

const FILTER_ALL = '__all__';
const FILTER_UNCATEGORIZED = '__uncategorized__';

export function ProjectsPage() {
  const { t } = useI18n();
  const { data, isPending, error } = useQuery(projectsQuery);
  const [creating, setCreating] = useState(false);
  const [managingCategories, setManagingCategories] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>(FILTER_ALL);
  const open = activeProjects(data ?? []);
  const categories = useMemo(() => projectCategories(data ?? []), [data]);
  const grouped = useMemo(() => groupActiveProjects(data ?? []), [data]);
  const archived = (data ?? []).filter((project) => project.archived_at != null);
  const activeFilter = selectedCategory === FILTER_ALL
    || selectedCategory === FILTER_UNCATEGORIZED
    || categories.includes(selectedCategory)
    ? selectedCategory
    : FILTER_ALL;
  const uncategorizedCount = open.filter((project) => !project.category).length;
  const filteredOpen = activeFilter === FILTER_ALL
    ? open
    : activeFilter === FILTER_UNCATEGORIZED
      ? open.filter((project) => !project.category)
      : open.filter((project) => project.category === activeFilter);
  return (
    <Page
      title={t('nav.projects')}
      loading={isPending}
      failure={error?.message}
      actions={(
        <div className="flex items-center gap-2">
          {categories.length > 0 ? (
            <Button variant="ghost" onClick={() => setManagingCategories(true)}>
              <FolderCog aria-hidden="true" />
              <span>{t('proj.list.manageCategories')}</span>
            </Button>
          ) : null}
          <Button variant="primary" onClick={() => setCreating(true)}><Plus />{t('nav.newProject')}</Button>
        </div>
      )}
    >
      <PageLead>{t('proj.list.lead')}</PageLead>
      {open.length > 0 && categories.length > 0 ? (
        <div role="group" aria-label={t('proj.list.categoryFilterAria')} className="mb-4 flex flex-wrap items-center gap-1.5">
          {[
            { id: FILTER_ALL, label: t('proj.list.filterAll'), count: open.length },
            ...categories.map((cat) => ({
              id: cat,
              label: cat,
              count: open.filter((project) => project.category === cat).length,
            })),
            ...(uncategorizedCount > 0 ? [{ id: FILTER_UNCATEGORIZED, label: t('proj.list.uncategorizedHeading'), count: uncategorizedCount }] : []),
          ].map(({ id, label, count }) => {
            const pressed = activeFilter === id;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={pressed}
                onClick={() => setSelectedCategory(id)}
                className={cn(
                  'inline-flex min-h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors duration-100',
                  pressed
                    ? 'border-primary/40 bg-brand-soft text-brand-foreground'
                    : 'border-border bg-raised text-muted-foreground hover:bg-hover hover:text-foreground',
                )}
              >
                <span>{label}</span>
                <span className="text-2xs opacity-75 tabular-nums">{count}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {open.length ? (
        activeFilter === FILTER_ALL && grouped.hasOrganization ? (
          <div className="grid gap-6">
            {grouped.pinned.length > 0 ? (
              <section aria-label={t('proj.list.pinnedHeading')}>
                <SectionTitle count={grouped.pinned.length}>{t('proj.list.pinnedHeading')}</SectionTitle>
                <Rows>
                  <ul aria-label={t('proj.list.pinnedHeading')} className="divide-y divide-border">
                    {grouped.pinned.map((project) => <ActiveProjectRow key={project.id} project={project} />)}
                  </ul>
                </Rows>
              </section>
            ) : null}
            {grouped.groups.map(({ category, projects: list }) => (
              <section key={category} aria-label={category}>
                <SectionTitle count={list.length}>{category}</SectionTitle>
                <Rows>
                  <ul aria-label={category} className="divide-y divide-border">
                    {list.map((project) => <ActiveProjectRow key={project.id} project={project} showCategoryBadge={false} />)}
                  </ul>
                </Rows>
              </section>
            ))}
            {grouped.uncategorized.length > 0 ? (
              <section aria-label={t('proj.list.uncategorizedHeading')}>
                {grouped.groups.length > 0 || grouped.pinned.length > 0 ? (
                  <SectionTitle count={grouped.uncategorized.length}>{t('proj.list.uncategorizedHeading')}</SectionTitle>
                ) : null}
                <Rows>
                  <ul aria-label={t('proj.list.uncategorizedHeading')} className="divide-y divide-border">
                    {grouped.uncategorized.map((project) => <ActiveProjectRow key={project.id} project={project} showCategoryBadge={false} />)}
                  </ul>
                </Rows>
              </section>
            ) : null}
          </div>
        ) : (
          <Rows>
            <ul aria-label={t('nav.projects')} className="divide-y divide-border">
              {filteredOpen.map((project) => <ActiveProjectRow key={project.id} project={project} />)}
            </ul>
          </Rows>
        )
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
      <ManageCategoriesDialog open={managingCategories} onOpenChange={setManagingCategories} projects={data ?? []} />
    </Page>
  );
}
