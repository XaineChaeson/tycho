// Ctrl K: one box that goes to any page, any project, any active work, and any active knowledge or skill.
import { useQuery } from '@tanstack/react-query';
import { BookOpen, FolderPlus, Gauge } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { LOADING_LABELS } from '@shared/knowledge.ts';
import { taskLine, WORK_GROUPS, workGroup } from '@shared/labels.ts';
import { StatusDot } from '@/components/bits';
import { PLACES } from '@/components/nav';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { useI18n } from '@/lib/i18n';
import { activeProjects } from '@/lib/projects';
import { knowledgeQuery, projectsQuery, tasksQuery } from '@/lib/queries';
import type { Task } from '@/lib/types';

const MAX_QUICK_JUMP = 6;

const isInReview = (task: Task): boolean =>
  task.state === 'ready' && (
    task.review_gate?.kind === 'in_review'
    || Boolean(task.active_review)
    || task.summary?.dot === 'running'
  );

// Priority order when the palette opens:
// 待你处理 (0) > 待验收 (1) > 进行中 (2) > 近期可续接 (3) > 其他 (4).
export function paletteTaskRank(task: Task): number {
  const group = workGroup(task);
  if (group === WORK_GROUPS.waiting) return 0;
  if (group === WORK_GROUPS.ready && !isInReview(task)) return 1;
  if (group === WORK_GROUPS.moving || isInReview(task)) return 2;
  if (task.state === 'done' && task.resumable !== false) return 3;
  return 4;
}

function taskRecencyMs(task: Task): number {
  const raw = task.updated_at ?? task.finished_at ?? task.created_at;
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? 0 : ms;
}

function comparePaletteTasks(a: Task, b: Task): number {
  const rankDiff = paletteTaskRank(a) - paletteTaskRank(b);
  if (rankDiff !== 0) return rankDiff;
  const timeDiff = taskRecencyMs(b) - taskRecencyMs(a);
  if (timeDiff !== 0) return timeDiff;
  return a.id.localeCompare(b.id);
}

function applyFrozenOrder<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  frozenIds: readonly string[] | null,
): T[] {
  if (!frozenIds || frozenIds.length === 0) return [...items];
  const byId = new Map(items.map((item) => [idOf(item), item]));
  const result: T[] = [];
  const seen = new Set<string>();
  for (const id of frozenIds) {
    const found = byId.get(id);
    if (found) {
      result.push(found);
      seen.add(id);
    }
  }
  for (const item of items) {
    const id = idOf(item);
    if (!seen.has(id)) result.push(item);
  }
  return result;
}

function altDigitIndex(event: KeyboardEvent): number | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key >= '1' && event.key <= '6') return Number(event.key);
  if (event.code.startsWith('Digit') && event.code.length === 6) {
    const num = Number(event.code.slice(5));
    if (num >= 1 && num <= 6) return num;
  }
  return null;
}

export function Palette({ open, onOpenChange, onNewProject }: { open: boolean; onOpenChange: (open: boolean) => void; onNewProject: () => void }) {
  const { t, bi } = useI18n();
  const navigate = useNavigate();
  const { data: projects } = useQuery(projectsQuery);
  const shown = activeProjects(projects ?? []);
  const { data: listing } = useQuery(tasksQuery);
  const { data: knowledge } = useQuery({ ...knowledgeQuery, enabled: open, retry: false });
  const [search, setSearch] = useState('');
  const [frozenTaskIds, setFrozenTaskIds] = useState<string[] | null>(null);
  const [frozenChildIds, setFrozenChildIds] = useState<string[] | null>(null);

  const rankedTasks = useMemo(
    () => [...(listing?.tasks ?? [])].sort(comparePaletteTasks),
    [listing?.tasks],
  );

  const rankedChildren = useMemo(() => {
    const tasks = listing?.tasks ?? [];
    const children = listing?.children ?? [];
    if (children.length === 0) return [];
    const topById = new Map(tasks.map((task) => [task.id, task]));
    return children
      .filter((child) => !topById.has(child.id))
      .sort(comparePaletteTasks)
      .map((child) => ({
        task: child,
        parentTitle: child.parent_id ? (topById.get(child.parent_id)?.title ?? '') : '',
      }));
  }, [listing]);

  // Freeze ranked order on open so SSE updates never jump rows under the user's cursor.
  useEffect(() => {
    if (!open) {
      setFrozenTaskIds(null);
      setFrozenChildIds(null);
      setSearch('');
      return;
    }
    if (frozenTaskIds === null && rankedTasks.length > 0) {
      setFrozenTaskIds(rankedTasks.map((task) => task.id));
    }
    if (frozenChildIds === null && rankedChildren.length > 0) {
      setFrozenChildIds(rankedChildren.map((entry) => entry.task.id));
    }
  }, [open, frozenTaskIds, frozenChildIds, rankedTasks, rankedChildren]);

  const orderedTasks = useMemo(
    () => applyFrozenOrder(rankedTasks, (task) => task.id, frozenTaskIds),
    [rankedTasks, frozenTaskIds],
  );

  const orderedChildren = useMemo(
    () => applyFrozenOrder(rankedChildren, (entry) => entry.task.id, frozenChildIds),
    [rankedChildren, frozenChildIds],
  );

  const quickJumpTasks = useMemo(
    () => orderedTasks.filter((task) => task.state !== 'abandoned').slice(0, MAX_QUICK_JUMP),
    [orderedTasks],
  );

  const quickIndexById = useMemo(() => {
    const map = new Map<string, number>();
    if (search.trim() !== '') return map;
    quickJumpTasks.forEach((task, idx) => { map.set(task.id, idx + 1); });
    return map;
  }, [quickJumpTasks, search]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (search.trim() !== '') return;
      const digit = altDigitIndex(event);
      if (digit === null) return;
      const target = quickJumpTasks[digit - 1];
      if (!target) return;
      event.preventDefault();
      onOpenChange(false);
      void navigate(`/work/${encodeURIComponent(target.id)}`);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, search, quickJumpTasks, onOpenChange, navigate]);

  const knowledgeItems = useMemo(() => {
    if (!knowledge) return [];
    const fromLedger = knowledge.entries
      .filter((entry) => entry.state === 'active')
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        hint: entry.when_to_use,
        meta: `${entry.kind === 'skill' ? '技能' : LOADING_LABELS[entry.loading]} · ${entry.id}`,
        search: `知识 技能 ${entry.title} ${entry.when_to_use} ${entry.id}`,
      }));
    const fromDir = (knowledge.directory_skills ?? [])
      .filter((skill) => skill.binding.enabled && skill.managed_ledger_id === null)
      .map((skill) => ({
        id: skill.id,
        title: skill.name,
        hint: skill.description,
        meta: `${LOADING_LABELS[skill.binding.loading]} · ${skill.slug}`,
        search: `知识 技能 ${skill.name} ${skill.description} ${skill.slug} ${skill.id}`,
      }));
    return [...fromLedger, ...fromDir];
  }, [knowledge]);

  const go = (to: string) => () => { onOpenChange(false); void navigate(to); };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed top-[14vh] left-1/2 z-50 w-[calc(100%-2rem)] max-w-[560px] -translate-x-1/2 overflow-hidden rounded-xl bg-raised shadow-dialog data-[state=open]:animate-fade-in"
        >
          <DialogPrimitive.Title className="sr-only">{t('nav.searchOrJump')}</DialogPrimitive.Title>
          <Command label={t('nav.searchOrJump')}>
            <CommandInput
              aria-label={t('nav.searchOrJump')}
              value={search}
              onValueChange={setSearch}
              placeholder={bi('去哪儿：页面、项目、工作、知识与技能…', 'Jump to a page, project, work, or skill…')}
              wrapperClassName="min-h-12 border-b border-border px-4"
            />
            <CommandList className="p-1">
              <CommandEmpty>{bi('没有匹配的页面、项目、工作或知识。', 'No matching pages, projects, work, or knowledge.')}</CommandEmpty>
              {orderedTasks.length ? (
                <CommandGroup heading={t('nav.work')}>
                  {orderedTasks.map((task) => {
                    const quickIndex = quickIndexById.get(task.id);
                    return (
                      <CommandItem key={task.id} value={`工作 work ${task.title} ${task.id}`} onSelect={go(`/work/${encodeURIComponent(task.id)}`)}>
                        <StatusDot state={task.summary?.dot ?? task.state} />
                        <span className="min-w-0 flex-1 truncate">{task.title}</span>
                        <span className="max-w-[38%] flex-none truncate text-xs text-faint">{taskLine(task)}</span>
                        {quickIndex !== undefined ? (
                          <kbd
                            aria-hidden="true"
                            title={bi(`Alt+${quickIndex} 快速跳转`, `Alt+${quickIndex} quick jump`)}
                            className="inline-flex min-w-4 flex-none items-center justify-center rounded-xs border border-border bg-muted/70 px-1 font-mono text-2xs leading-4 text-faint tabular-nums"
                          >
                            {quickIndex}
                          </kbd>
                        ) : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ) : null}
              {orderedChildren.length ? (
                <CommandGroup heading={bi('子任务与审阅', 'Subtasks & Reviews')}>
                  {orderedChildren.map(({ task, parentTitle }) => (
                    <CommandItem key={task.id} value={`子任务 审阅 任务 subtask review ${task.title} ${parentTitle} ${task.id}`} onSelect={go(`/task/${encodeURIComponent(task.id)}`)}>
                      <StatusDot state={task.summary?.dot ?? task.state} />
                      <span className="min-w-0 flex-1 truncate">{task.title}</span>
                      <span className="max-w-[40%] flex-none truncate text-xs text-faint">
                        {parentTitle ? `${parentTitle} · ${taskLine(task)}` : taskLine(task)}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
              {shown.length ? (
                <CommandGroup heading={t('nav.projects')}>
                  {shown.map((project) => (
                    <CommandItem key={project.id} value={`项目 project ${project.name} ${project.id}`} onSelect={go(`/projects/${encodeURIComponent(project.id)}`)}>
                      <span className="min-w-0 flex-1 truncate">{project.name}</span>
                      <span className="text-xs text-faint">{t('nav.projectState', { paused: '', moving: project.moving, waiting: project.waiting })}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
              <CommandGroup heading={bi('页面', 'Pages')}>
                {PLACES.map(({ to, title, titleKey, icon: Icon }) => {
                  const label = t(titleKey);
                  return (
                    <CommandItem key={to} value={`页面 page ${title} ${label}`} onSelect={go(to)}><Icon aria-hidden="true" />{label}</CommandItem>
                  );
                })}
              </CommandGroup>
              {knowledgeItems.length ? (
                <CommandGroup heading={bi('知识与技能', 'Knowledge & Skills')}>
                  {knowledgeItems.map((item) => (
                    <CommandItem
                      key={item.id}
                      value={item.search}
                      onSelect={go(`/knowledge?view=entries&select=${encodeURIComponent(item.id)}`)}
                    >
                      <BookOpen aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{item.title}</span>
                      <span className="max-w-[42%] flex-none truncate text-xs text-faint">{item.meta}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
              <CommandGroup heading={bi('动作', 'Actions')}>
                <CommandItem value="动作 查看账号与额度 账号 额度 accounts quota" onSelect={go('/accounts')}>
                  <Gauge aria-hidden="true" />
                  {bi('查看账号与额度', 'View accounts & quota')}
                </CommandItem>
                <CommandItem value="动作 新建项目 new project" onSelect={() => { onOpenChange(false); onNewProject(); }}>
                  <FolderPlus aria-hidden="true" />
                  {t('nav.newProject')}
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
