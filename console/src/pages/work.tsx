// A work and the tasks under it. A work with none is its own task, and its page is that
// task's page: there is nothing between the two worth a stop.
import { useQuery } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { runTime } from '@shared/labels.ts';
import { fullTime } from '@shared/time.ts';
import { ApprovalCard } from '@/components/approval-card';
import { Rows, SectionTitle, StatusDot, Time } from '@/components/bits';
import { Markdown } from '@/components/markdown';
import { Page, PageTitle, type Crumb } from '@/components/page';
import { AcceptNow, TaskActions, TaskStatus, useTaskAct } from '@/components/task-actions';
import { Button } from '@/components/ui/button';
import { taskPath, WorkRow } from '@/components/work-row';
import { useI18n } from '@/lib/i18n';
import { useLive } from '@/lib/live-context';
import { approvalsQuery, projectsQuery, taskQuery } from '@/lib/queries';
import type { Task } from '@/lib/types';
import { TaskPage } from '@/pages/task';

function isChildInReview(child: Task): boolean {
  return child.state === 'ready' && (
    child.review_gate?.kind === 'in_review'
    || Boolean(child.active_review)
    || child.summary?.dot === 'running'
  );
}

function WorkWithTasks({ id }: { id: string }) {
  const { t } = useI18n();
  const { data, error } = useQuery(taskQuery(id));
  const { data: projects } = useQuery(projectsQuery);
  const { data: approvals } = useQuery(approvalsQuery);
  const navigate = useNavigate();
  const live = useLive();
  const control = useTaskAct(id);
  if (!data) return null;
  const { task } = data;
  const children = [...data.children].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
  const childIds = new Set(children.map((child) => child.id));
  const childApprovals = (approvals ?? []).filter((approval) => approval.state === 'open' && childIds.has(approval.task_id));
  const readyChildren = children.filter((child) => child.state === 'ready' && !isChildInReview(child));
  const heldChildren = children.filter((child) => child.state === 'held');
  const attentionCount = childApprovals.length + readyChildren.length + heldChildren.length;
  const projectId = task.project_id ?? data.work.project_id ?? null;
  const project = projects?.find((each) => each.id === projectId);
  // A knowledge Task belongs to no project: it sits under the knowledge page.
  const home: Crumb = task.project_id === null ? { label: t('nav.knowledge'), to: '/knowledge' }
    : { label: project?.name ?? t('project.defaultTitle'), to: projectId ? `/projects/${encodeURIComponent(projectId)}/work` : '/projects' };
  return (
    <Page
      crumbs={[home, { label: task.title }]}
      width="narrow"
      follow
      failure={error?.message}
      actions={projectId === null ? undefined : (
        <Button
          variant="ghost"
          onClick={() => {
            // In the conversation of the work's own project (docs/design/project-sessions.md §1).
            live.typeFor(projectId, t('tsk.work.chatPrefill', { title: task.title, id: task.id }));
            void navigate(`/projects/${encodeURIComponent(projectId)}`, { state: { compose: true } });
          }}
        >
          <MessageSquare />
          <span className="max-sm:sr-only">{t('tsk.work.talkInChat')}</span>
        </Button>
      )}
    >
      <article>
        <PageTitle>{task.title}</PageTitle>
        <TaskStatus task={task} className="mt-2" />
        <p className="mt-1 text-xs text-faint"><Time at={task.created_at} prefix={t('task.createdAt')} /></p>
        <TaskActions
          className="mt-5"
          task={task}
          active={data.runs.some((run) => run.state !== 'ended')}
          question={data.approvals.some((approval) => approval.state === 'open')}
          blocked={data.review?.blocked ?? null}
          gate={data.review?.gate ?? task.review_gate ?? null}
          control={control}
        />
        {attentionCount > 0 ? (
          <section aria-label={t('tsk.work.attentionSection')} className="mt-6">
            <SectionTitle count={attentionCount}>{t('tsk.work.attentionSection')}</SectionTitle>
            <div className="grid gap-3">
              {childApprovals.map((card) => <ApprovalCard key={card.id} card={card} />)}
              {readyChildren.map((child) => <AcceptNow key={child.id} task={child} context={task.title} />)}
              {heldChildren.length > 0 ? (
                <Rows>
                  {heldChildren.map((child) => (
                    <div key={child.id} className="grid gap-1.5 px-3.5 py-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusDot state="held" />
                        <Link to={taskPath(child.id)} className="font-semibold no-underline wrap-anywhere hover:underline">
                          {t('tsk.work.heldChildPrefix', { title: child.title })}
                        </Link>
                        <Link to={taskPath(child.id)} className="ml-auto text-xs">{t('tsk.work.goHandle')}</Link>
                      </div>
                      <p className="pl-6 text-sm text-muted-foreground whitespace-pre-wrap wrap-anywhere">
                        {child.reason ?? t('tsk.work.noHeldReason')}
                      </p>
                    </div>
                  ))}
                </Rows>
              ) : null}
            </div>
          </section>
        ) : null}
        <section aria-label={t('tsk.work.goalSection')} className="mt-6">
          <SectionTitle>{t('tsk.work.goalSection')}</SectionTitle>
          <div className="rounded-xl bg-muted px-4 py-3.5">
            <Markdown text={task.goal} projectId={projectId ?? undefined} />
          </div>
        </section>
        <section aria-label={t('tsk.work.tasksSection')} className="mt-7">
          <SectionTitle count={children.length}>{t('tsk.work.tasksSection')}</SectionTitle>
          <Rows>
            {children.map((child) => {
              const run = child.latest_run;
              return (
                <WorkRow
                  key={child.id}
                  task={child}
                  to={taskPath(child.id)}
                  meta={<span title={fullTime(run?.ended_at ?? run?.started_at ?? run?.created_at)}>{runTime(run)}</span>}
                />
              );
            })}
          </Rows>
        </section>
      </article>
    </Page>
  );
}

export function WorkPage({ id }: { id: string }) {
  const { data, isPending, error } = useQuery(taskQuery(id));
  // Until it is read, and when it could not be, the task's page says so: it draws the same
  // head, and a work that turns out to have tasks is drawn in its place.
  if (isPending || error || !data || data.children.length === 0) return <TaskPage id={id} />;
  return <WorkWithTasks id={id} />;
}
