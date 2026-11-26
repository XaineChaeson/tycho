// What is around every page: the side column with the console's places and the projects,
// the banners that say the service is not in its normal state, and one place for an
// action's failure.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Moon, Pause, Plus, Search, Sun, X } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { bannerNotes, PROJECT_PAUSED_LABEL, restoreHeadline, WORK_GROUPS, workGroup, type BannerNote } from '@shared/labels.ts';
import { formatTime, fullTime } from '@shared/time.ts';
import { AccountQuotaPopover } from '@/components/account-quota-popover';
import { Admit } from '@/components/admit';
import { Dot, HashLink, ProjectMark, StatusDot } from '@/components/bits';
import { DeviceLogin } from '@/components/device-login';
import { ConsoleVersionNotice } from '@/components/console-version-notice';
import { Health, LastHeard } from '@/components/health';
import { SETUP_PLACES, WORK_PLACES, type Place } from '@/components/nav';
import { NewProjectDialog } from '@/components/new-project';
import { MenuContext } from '@/components/page';
import { Palette } from '@/components/palette';
import { formatAssignmentSummary } from '@/components/task-identity-strip';
import { ThemeSkinPicker } from '@/components/theme-skin-picker';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/menu';
import { Segmented } from '@/components/ui/segmented';
import { messageOf, post } from '@/lib/api';
import { useLive, useLiveState } from '@/lib/live-context';
import { activeProjects, archivedProjectIds } from '@/lib/projects';
import { PAGE, overviewQuery, projectsQuery, stateQuery, tasksQuery } from '@/lib/queries';
import { readTheme, saveTheme, syncDirectoryThemePacks, THEME_CHOICES, type ThemeChoice } from '@/lib/theme';
import type { Project, ServiceState, Task } from '@/lib/types';
import { cn } from '@/lib/utils';

// How the program is named in the side column. The version is put there by the build, as
// it is to be read (src/build-version.ts), so an installed console cannot claim another.
const VERSION = typeof __TYCHO_VERSION__ === 'string' ? __TYCHO_VERSION__ : '';
// The states in which a task waits for the owner.
const WAITS = ['waiting_person', 'ready', 'held'];
const MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
const isInReview = (task: Task): boolean =>
  task.state === 'ready' && (
    task.review_gate?.kind === 'in_review'
    || Boolean(task.active_review)
    || task.summary?.dot === 'running'
  );

function isResumableTask(task: Task): boolean {
  return task.resumable === true;
}

function sidebarThreadPriority(task: Task): number {
  const group = workGroup(task);
  if (group === WORK_GROUPS.waiting) return 0;
  if (group === WORK_GROUPS.ready) return 1;
  if (group === WORK_GROUPS.moving) return 2;
  if (task.state === 'done' && isResumableTask(task)) return 3;
  return 4;
}

function taskRecency(task: Task): number {
  const raw = task.updated_at ?? task.finished_at ?? task.created_at;
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? 0 : ms;
}

function projectSidebarThreads(tasks: readonly Task[] | undefined, projectId: string): Task[] {
  const candidates = (tasks ?? [])
    .filter((task) => task.project_id === projectId && sidebarThreadPriority(task) < 4)
    .sort((a, b) => {
      const diff = sidebarThreadPriority(a) - sidebarThreadPriority(b);
      if (diff !== 0) return diff;
      return taskRecency(b) - taskRecency(a);
    });
  // Completed resumable tasks stay out of the sidebar when active work exists (reduces noise in
  // long-lived projects); when a project is idle, show up to 2 recent resumable threads.
  const active = candidates.filter((task) => sidebarThreadPriority(task) < 3);
  if (active.length > 0) return active.slice(0, 4);
  return candidates.slice(0, 2);
}

// An entry of the side column: compact H2 architectural row with crisp left active bar.
const SIDE_ITEM = [
  'group/side flex min-h-hit min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-sm border border-transparent border-l-2 px-2 text-sm text-muted-foreground no-underline transition-colors duration-100',
  'hover:bg-hover hover:text-foreground focus-visible:-outline-offset-2',
  'aria-[current=page]:border-l-primary aria-[current=page]:bg-raised aria-[current=page]:font-medium aria-[current=page]:text-foreground aria-[current=page]:shadow-card',
].join(' ');

// The mark: T-Astrolabe (天仪星轨) — a geometric T spine crossed by a 24° orbital arc
// with a warm amber satellite star, nodding to Tycho Brahe's precision observatory.
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="mark-fill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="color-mix(in oklab, var(--primary) 78%, white)" />
          <stop offset="1" stopColor="color-mix(in oklab, var(--primary) 88%, #0E1420)" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="18" fill="url(#mark-fill)" />
      <g transform="rotate(-24 32 33)">
        <path
          d="M 12 33 A 20 9.5 0 1 1 52 33 A 20 9.5 0 0 1 20 40.8"
          fill="none"
          stroke="rgba(255,255,255,0.44)"
          strokeWidth="2.8"
          strokeLinecap="round"
        />
      </g>
      <path d="M18.5 21H45.5M32 21V46" fill="none" stroke="white" strokeWidth="5.4" strokeLinecap="round" />
      <circle cx="49.5" cy="28.5" r="3.5" fill="#F8D06B" />
    </svg>
  );
}

function Brand() {
  return (
    <p data-slot="brand" className="flex min-h-hit items-center gap-2 px-1.5">
      <Mark className="size-6 flex-none drop-shadow-[0_1px_2px_color-mix(in_oklab,var(--primary)_40%,transparent)]" />
      <span className="text-lg leading-none font-semibold tracking-[-0.02em]">tycho</span>
      {VERSION ? <span className="ml-auto rounded-full border border-border px-1.5 font-mono text-2xs text-faint">{VERSION}</span> : null}
    </p>
  );
}

function PlaceLink({ place: { to, title, icon: Icon }, count, countLabel, subtle, onNavigate }: {
  place: Place;
  count?: number;
  countLabel?: string;
  subtle?: boolean;
  onNavigate: () => void;
}) {
  return (
    <NavLink to={to} end={to === '/'} onClick={onNavigate} className={SIDE_ITEM}>
      <Icon className="size-4 flex-none group-aria-[current=page]/side:text-primary" strokeWidth={1.75} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {count ? (
        <span
          aria-label={countLabel ?? `${count} 件等你`}
          className={cn(
            'rounded-full px-1.5 text-xs leading-[18px] font-semibold tabular-nums',
            subtle ? 'bg-waiting-soft text-waiting-foreground' : 'bg-waiting text-ink-foreground',
          )}
        >
          {count}
        </span>
      ) : null}
    </NavLink>
  );
}

// A project in the side column: its name, and at a glance whether something of it waits
// for the owner (amber, with how many) or is moving (blue); a paused one is muted, with a mark.
function ProjectLink({ project, onNavigate }: { project: Project; onNavigate: () => void }) {
  const paused = project.paused_at != null;
  const state = `${paused ? `${PROJECT_PAUSED_LABEL} · ` : ''}在进行 ${project.moving} · 等你 ${project.waiting}`;
  return (
    <NavLink to={`/projects/${encodeURIComponent(project.id)}`} onClick={onNavigate} title={state} className={SIDE_ITEM}>
      <ProjectMark name={project.name} className="-ml-0.5" />
      <span className={cn('min-w-0 flex-1 truncate', paused && 'text-muted-foreground')}>{project.name}</span>
      {paused ? <Pause aria-label={PROJECT_PAUSED_LABEL} className="size-3.5 flex-none text-muted-foreground" /> : null}
      {project.moving ? <Dot tone="running" className="size-1.5" /> : null}
      {project.waiting ? <span className="rounded-full bg-waiting-soft px-1.5 text-xs leading-[18px] font-semibold text-waiting-foreground tabular-nums">{project.waiting}</span> : null}
      <span className="sr-only">{state}</span>
    </NavLink>
  );
}

function Banner({ notes, title, wecomError }: { notes: readonly BannerNote[]; title: string; wecomError?: boolean }) {
  const client = useQueryClient();
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);
  if (!notes.length) return null;
  return (
    <div role="status" title={title} className="flex flex-none flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-waiting-border bg-waiting-soft px-4 py-1.5 text-center text-sm text-waiting-foreground wrap-anywhere">
      <span>
        {notes.map(({ text, href, label }, index) => (
          <Fragment key={text}>
            {index ? ' · ' : null}
            {text}
            {href ? <HashLink href={href} className="ml-2">{label}</HashLink> : null}
          </Fragment>
        ))}
      </span>
      {wecomError ? (
        <Button
          size="sm"
          disabled={reconnecting}
          onClick={async () => {
            setReconnecting(true);
            setReconnectError(null);
            try {
              await post('/api/wecom/reconnect');
              await Promise.all([
                client.invalidateQueries({ queryKey: stateQuery.queryKey }),
                client.invalidateQueries({ queryKey: [PAGE] }),
              ]);
            } catch (err) {
              setReconnectError(messageOf(err));
            } finally {
              setReconnecting(false);
            }
          }}
        >
          {reconnecting ? '重连中…' : '重新连接'}
        </Button>
      ) : null}
      {reconnectError ? <span role="alert" className="text-xs text-destructive">{reconnectError}</span> : null}
    </div>
  );
}

function RestoreBanner({ restore }: { restore: NonNullable<ServiceState['restore']> }) {
  const client = useQueryClient();
  const live = useLive();
  const held = restore.held_tasks.length;
  return (
    <div role="status" className="flex flex-none flex-wrap items-center justify-center gap-x-3 gap-y-1.5 border-b border-waiting-border bg-waiting-soft px-4 py-1.5 text-center text-sm text-waiting-foreground">
      <Link to="/">{restoreHeadline(fullTime(restore.backup_at))}</Link>
      <Button
        size="sm"
        disabled={held > 0}
        title={held > 0 ? `还有 ${held} 个任务等你确认` : undefined}
        onClick={async () => {
          try {
            await post('/api/restore/confirm');
            await Promise.all([client.invalidateQueries({ queryKey: ['state'] }), client.invalidateQueries({ queryKey: [PAGE] })]);
          } catch (error) {
            live.showError(messageOf(error));
          }
        }}
      >
        确认清点完成
      </Button>
    </div>
  );
}

const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon };

// The scheme is this browser's, not the service's: it is stored here and nowhere else.
function ThemeSwitch() {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  return (
    <Segmented
      label="深浅色"
      value={choice}
      options={THEME_CHOICES.map(({ value, label }) => {
        const Icon = THEME_ICONS[value];
        return { value, title: label, label: <><Icon className="size-3.5" aria-hidden="true" /><span className="sr-only">{label}</span></> };
      })}
      className="flex-none flex-nowrap [&>label]:px-1.5"
      onChange={(next) => {
        saveTheme(next);
        setChoice(next);
      }}
    />
  );
}

export function Shell() {
  const location = useLocation();
  const live = useLive();
  const { connected, lastUpdate, error } = useLiveState();
  const { data: listing } = useQuery(tasksQuery);
  const { data: service, isError: stateFailed } = useQuery(stateQuery);
  const { data: projects } = useQuery(projectsQuery);
  const { data: overview } = useQuery(overviewQuery);
  // Only the ones in sight: an archived project is in its own list on the projects page.
  const shownProjects = activeProjects(projects ?? []);
  const archivedCount = (projects ?? []).filter((project) => project.archived_at != null).length;
  const [menu, setMenu] = useState(false);
  const [palette, setPalette] = useState(false);
  const [creating, setCreating] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const side = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  // When the menu last shut: a page come to by choosing it in the menu has a bar, and a
  // menu button, of its own, and that button is the one the focus goes back to.
  const shutAt = useRef(0);

  // A page come to starts clean: the menu shut, the last page's failure gone.
  useEffect(() => {
    setMenu(false);
    live.showError(null);
  }, [live, location.pathname]);

  // The menu takes the focus when it opens and gives it back to its button when it
  // shuts, however it was shut: what it showed is gone from the page.
  useEffect(() => {
    if (menu) side.current?.querySelector<HTMLElement>('a')?.focus();
    else if (wasOpen.current) {
      shutAt.current = Date.now();
      menuButton.current?.focus();
    }
    wasOpen.current = menu;
  }, [menu]);

  // Keeps the composer above the software keyboard where the browser only shrinks the
  // visual viewport.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const fit = (): void => document.documentElement.style.setProperty('--app-height', `${viewport.height}px`);
    viewport.addEventListener('resize', fit);
    fit();
    return () => viewport.removeEventListener('resize', fit);
  }, []);

  useEffect(() => {
    void syncDirectoryThemePacks();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      setPalette((open) => !open);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // What waits for the owner, as the one number beside 总览: every task that stands on a
  // question or a stop or waits to be accepted, the ones under a work included. A work that
  // has tasks waits only through them. Tasks of archived projects and ready tasks whose
  // automatic independent review is currently running stay out of the attention count.
  const archived = archivedProjectIds(projects ?? []);
  const waiting = [...(listing?.tasks ?? []), ...(listing?.children ?? [])].filter(
    (task) => task.summary?.leaf !== false
      && WAITS.includes(task.state)
      && !isInReview(task)
      && (task.project_id == null || !archived.has(task.project_id)),
  ).length;
  const knowledgeAwaiting = overview?.counts.knowledge_awaiting ?? 0;
  const pendingJoins = overview?.counts.pending_joins ?? 0;
  const notes: BannerNote[] = [
    ...(!connected && lastUpdate ? [{ text: `已断开，上次更新 ${formatTime(lastUpdate)}` }] : []),
    ...(service ? bannerNotes({
      dispatch: { degraded: Boolean(service.dispatch.degraded), recovering: Boolean(service.dispatch.recovering), paused: service.dispatch.paused ?? null },
      router: service.router,
      channels: service.channels,
    }) : []),
  ];
  const menuContext = useMemo(() => ({ open: menu, toggle: () => setMenu((open) => !open), button: menuButton, shutAt }), [menu]);
  const activeThreadId = useMemo(() => new URLSearchParams(location.search).get('thread'), [location.search]);
  const shut = (): void => setMenu(false);

  return (
    <div
      className="flex h-(--app-height,100dvh)"
      onKeyDown={(event) => { if (event.key === 'Escape') setMenu(false); }}
    >
      {/* Below the shell's width the side column is a drawer over the page; the page under it is dimmed. */}
      {menu ? <div aria-hidden="true" className="fixed inset-0 z-30 bg-overlay shell:hidden" onClick={shut} /> : null}
      <aside
        id="side"
        ref={side}
        data-open={menu}
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-[264px] flex-col gap-2.5 border-r border-border bg-muted/95 p-2.5 transition-transform duration-200 ease-out',
          'shell:static shell:z-auto shell:w-[252px] shell:flex-none shell:translate-x-0 shell:bg-muted/85 shell:shadow-none',
          menu ? 'translate-x-0 shadow-dialog' : 'invisible -translate-x-full shell:visible',
        )}
      >
        <Brand />
        <button
          type="button"
          onClick={() => { shut(); setPalette(true); }}
          className="flex min-h-hit items-center gap-2 rounded-md bg-raised px-2 text-sm text-faint shadow-card transition-colors duration-100 hover:text-muted-foreground"
        >
          <Search className="size-4 flex-none" aria-hidden="true" />
          <span className="flex-1 text-left">搜索或跳转</span>
          <kbd className="rounded-xs border border-border px-1 font-sans text-2xs">{MAC ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <div className="-mr-1 flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto pr-1">
          <nav aria-label="视图" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-px">
            {WORK_PLACES.map((place) => <PlaceLink key={place.to} place={place} onNavigate={shut} {...(place.to === '/' ? { count: waiting } : {})} />)}
          </nav>
          <nav aria-label="项目" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-px">
            <div className="flex min-h-7 items-center justify-between pr-0.5 pl-2">
              <Link to="/projects" onClick={shut} className="text-xs font-medium text-faint no-underline hover:text-foreground">项目</Link>
              <Tooltip text="新建项目">
                <Button variant="ghost" size="icon-sm" aria-label="新建项目" className="size-6 min-h-0" onClick={() => { shut(); setCreating(true); }}><Plus className="size-3.5" /></Button>
              </Tooltip>
            </div>
            {shownProjects.map((project) => {
              const projectBase = `/projects/${encodeURIComponent(project.id)}`;
              const isCurrentProject = location.pathname === projectBase || location.pathname.startsWith(`${projectBase}/`);
              const threads = isCurrentProject ? projectSidebarThreads(listing?.tasks, project.id) : [];
              return (
                <Fragment key={project.id}>
                  <ProjectLink project={project} onNavigate={shut} />
                  {threads.length > 0 ? (
                    <div className="ml-4 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-0.5 border-l border-border/70 py-0.5 pl-2">
                      {threads.map((task) => {
                        const active = activeThreadId === task.id;
                        const identity = formatAssignmentSummary(task.assignment, { showLiveLabel: true });
                        const tooltip = identity ? `${task.title} · ${identity}` : task.title;
                        return (
                          <Link
                            key={task.id}
                            to={`${projectBase}?thread=${encodeURIComponent(task.id)}`}
                            onClick={shut}
                            aria-current={active ? 'true' : undefined}
                            title={tooltip}
                            className={cn(
                              'flex min-h-7 min-w-0 max-w-full items-center gap-1.5 overflow-hidden rounded-md px-1.5 text-xs text-muted-foreground no-underline transition-colors duration-100',
                              'hover:bg-hover hover:text-foreground focus-visible:-outline-offset-2',
                              active && 'bg-raised font-medium text-foreground shadow-card',
                            )}
                          >
                            <StatusDot state={task.summary?.dot ?? task.state} className="size-3.5" />
                            <span className="min-w-0 flex-1 truncate">{task.title}</span>
                          </Link>
                        );
                      })}
                    </div>
                  ) : null}
                </Fragment>
              );
            })}
            {archivedCount > 0 && shownProjects.length > 0 ? (
              <Link
                to="/projects#archived"
                onClick={shut}
                className="flex items-center justify-between rounded-md px-2 py-1 text-xs text-faint no-underline transition-colors duration-100 hover:bg-hover hover:text-foreground"
              >
                <span>已归档项目</span>
                <span className="tabular-nums">{archivedCount}</span>
              </Link>
            ) : null}
            {projects && projects.length === 0 ? (
              <button type="button" onClick={() => { shut(); setCreating(true); }} className="rounded-md px-2 py-1.5 text-left text-xs text-faint hover:bg-hover hover:text-foreground">
                还没有项目。建一个，就能和它的负责人说话。
              </button>
            ) : null}
            {projects && projects.length > 0 && shownProjects.length === 0 ? (
              <Link to="/projects" onClick={shut} className="rounded-md px-2 py-1.5 text-left text-xs text-faint no-underline hover:bg-hover hover:text-foreground">
                项目都归档了：到项目列表恢复。
              </Link>
            ) : null}
          </nav>
          <nav aria-label="配置" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-px">
            <p className="flex min-h-7 items-center px-2 text-xs font-medium text-faint">配置</p>
            {SETUP_PLACES.map((place) => (
              <PlaceLink
                key={place.to}
                place={place}
                onNavigate={shut}
                {...(place.to === '/knowledge' && knowledgeAwaiting > 0
                  ? { count: knowledgeAwaiting, countLabel: `${knowledgeAwaiting} 条知识待定`, subtle: true }
                  : {})}
              />
            ))}
          </nav>
        </div>
        <div className="grid min-w-0 gap-2 border-t border-border pt-2.5">
          <AccountQuotaPopover />
          <div className="flex min-w-0 items-center justify-between gap-2 px-2">
            <Health className="min-w-0 flex-1 truncate" />
            <LastHeard at={lastUpdate} className="flex-none leading-[18px] whitespace-nowrap" />
          </div>
          <div className="flex min-w-0 items-center gap-0.5">
            <div className="relative inline-flex flex-none items-center">
              <Admit />
              {pendingJoins > 0 ? (
                <span
                  aria-label={`${pendingJoins} 台机器待放行`}
                  title={`${pendingJoins} 台机器待放行`}
                  className="pointer-events-none absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full bg-waiting px-1 text-2xs leading-4 font-semibold text-ink-foreground tabular-nums"
                >
                  {pendingJoins}
                </span>
              ) : null}
            </div>
            <DeviceLogin />
            <span className="flex-1" />
            <ThemeSkinPicker />
            <ThemeSwitch />
          </div>
        </div>
      </aside>

      <MenuContext value={menuContext}>
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
          <Banner notes={notes} title={lastUpdate ? fullTime(lastUpdate) : ''} wecomError={Boolean(service?.channels?.wecom?.error)} />
          <ConsoleVersionNotice pageVersion={VERSION} serviceVersion={!stateFailed ? service?.version : undefined}
            onRefresh={() => window.location.reload()} />
          {service?.restore ? <RestoreBanner restore={service.restore} /> : null}
          <Outlet />
          {error ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
              <div className="pointer-events-auto flex max-w-[560px] items-start gap-2 rounded-lg border border-failed-border bg-raised py-2 pr-1.5 pl-3.5 text-sm shadow-pop">
                <p role="alert" className="min-w-0 flex-1 py-0.5 text-destructive wrap-anywhere">{error}</p>
                <Button variant="ghost" size="icon-sm" aria-label="知道了" onClick={() => live.showError(null)}><X /></Button>
              </div>
            </div>
          ) : null}
        </main>
      </MenuContext>

      <Palette open={palette} onOpenChange={setPalette} onNewProject={() => setCreating(true)} />
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
