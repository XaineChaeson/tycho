import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, FileText, ListTodo, Sparkles, Terminal, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useState, type KeyboardEvent, type MutableRefObject } from 'react';
import { t as translate } from '@shared/i18n.ts';
import { quotaUsedUp, usageLine } from '@shared/labels.ts';
import { formatFileSize } from '@/components/project-files';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { accountsQuery, knowledgeQuery, projectFilesQuery, tasksQuery } from '@/lib/queries';
import type { Account, AccountsAndMachines } from '@/lib/types';
import { cn } from '@/lib/utils';

export const LARGE_PASTE_THRESHOLD = 16 * 1024;

export function createPastedLogFile(text: string): File {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return new File([text], `pasted-log-${stamp}.txt`, { type: 'text/plain' });
}

export interface PastedSnippet {
  id: string;
  text: string;
  bytes: number;
  lines: number;
  preview: string;
}

export function createPastedSnippet(text: string): PastedSnippet {
  const bytes = new Blob([text]).size;
  const lineList = text.split(/\r?\n/);
  const preview = lineList.slice(0, 3).join('\n').slice(0, 180);
  return {
    id: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    text,
    bytes,
    lines: lineList.length,
    preview,
  };
}

export function formatTextWithSnippets(text: string, snippets: readonly PastedSnippet[]): string {
  const trimmed = text.trim();
  if (snippets.length === 0) return text;
  const blocks = snippets.map((snippet, index) => {
    const label = snippets.length > 1
      ? translate('proj.composer.pastedLabelIndexed', { index: index + 1 })
      : translate('proj.composer.pastedLabelSingle');
    const header = translate('proj.composer.pastedBlockHeader', {
      label,
      lines: snippet.lines,
      size: formatFileSize(snippet.bytes),
    });
    return `${header}\n\`\`\`\n${snippet.text}\n\`\`\``;
  });
  return trimmed ? `${trimmed}\n\n${blocks.join('\n\n')}` : blocks.join('\n\n');
}

export function PastedSnippetChips({
  snippets,
  disabled = false,
  onRemove,
}: {
  snippets: readonly PastedSnippet[];
  disabled?: boolean;
  onRemove: (id: string) => void;
}) {
  const { t } = useI18n();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  if (snippets.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 border-b border-border/60 px-3 pt-2 pb-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {snippets.map((snippet, index) => {
          const open = expandedId === snippet.id;
          return (
            <div
              key={snippet.id}
              className="inline-flex max-w-full items-center gap-1 rounded-lg border border-border bg-muted/60 py-0.5 pr-1 pl-2 text-xs"
            >
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setExpandedId(open ? null : snippet.id)}
                className="inline-flex items-center gap-1 text-left text-foreground hover:text-primary"
              >
                {open ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
                <FileText className="size-3.5 text-muted-foreground" aria-hidden="true" />
                <span className="font-medium">
                  {snippets.length > 1
                    ? t('proj.composer.snippetTitleIndexed', { index: index + 1 })
                    : t('proj.composer.snippetTitle')}
                </span>
                <span className="text-2xs text-muted-foreground tabular-nums">
                  {t('proj.composer.snippetMeta', { lines: snippet.lines, size: formatFileSize(snippet.bytes) })}
                </span>
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('proj.composer.removeSnippetAria', { index: index + 1 })}
                className="size-5 rounded-md"
                disabled={disabled}
                onClick={() => onRemove(snippet.id)}
              >
                <X className="size-3" />
              </Button>
            </div>
          );
        })}
      </div>
      {expandedId ? (() => {
        const snippet = snippets.find((item) => item.id === expandedId);
        if (!snippet) return null;
        return (
          <pre className="max-h-36 overflow-auto rounded-md border border-border bg-code p-2 font-mono text-2xs leading-4 whitespace-pre-wrap text-muted-foreground">
            {snippet.text.slice(0, 2000)}
            {snippet.text.length > 2000 ? `\n${t('proj.composer.snippetTruncated')}` : ''}
          </pre>
        );
      })() : null}
    </div>
  );
}

export type ComposerTriggerKind = '$' | '@' | '/';

export interface DetectedTrigger {
  kind: ComposerTriggerKind;
  query: string;
  start: number;
  end: number;
}

export function detectComposerTrigger(text: string, caret: number): DetectedTrigger | null {
  const clamped = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, clamped);
  let start = clamped;
  while (start > 0 && !/\s/.test(before[start - 1]!)) {
    start -= 1;
  }
  const token = before.slice(start, clamped);
  if (token.length === 0) return null;
  const first = token[0];
  if (first !== '$' && first !== '@' && first !== '/') return null;
  return {
    kind: first,
    query: token.slice(1),
    start,
    end: clamped,
  };
}

export function replaceTriggerText(
  text: string,
  trigger: DetectedTrigger,
  insertion: string,
): { text: string; caret: number } {
  const head = text.slice(0, trigger.start);
  const tail = text.slice(trigger.end);
  const nextText = `${head}${insertion}${tail}`;
  return { text: nextText, caret: head.length + insertion.length };
}

function accountQuotaStatus(account: Account): string {
  const status = account.status;
  if (!status) return translate('proj.composer.quotaAvailable');
  if (status.rejected) return translate('proj.composer.quotaRelogin');
  if (status.rest) return translate('proj.composer.quotaResting');
  if (status.usage.length > 0) {
    const summary = status.usage.map((item) => usageLine(item)).join(' / ');
    return quotaUsedUp(status.usage) ? translate('proj.composer.quotaExhausted', { summary }) : summary;
  }
  return status.active_runs > 0
    ? translate('proj.composer.quotaRunning', { count: status.active_runs })
    : translate('proj.composer.quotaAvailable');
}

export function formatAccountUsageSummary(data: AccountsAndMachines | undefined): string {
  if (!data || data.accounts.length === 0) {
    return translate('proj.composer.usageEmpty');
  }
  const parts = data.accounts.map((account) => {
    const state = accountQuotaStatus(account);
    const queued = account.queued_tasks > 0 ? translate('proj.composer.usageQueuedPart', { count: account.queued_tasks }) : '';
    return translate('proj.composer.usageAccountPart', {
      name: account.name,
      executor: account.executor,
      state,
      queued,
    });
  });
  return translate('proj.composer.usageHeader', { summary: parts.join(translate('proj.composer.usageSep')) });
}

export interface ComposerTriggerItem {
  id: string;
  kind: 'skill' | 'file' | 'task' | 'command';
  label: string;
  detail?: string;
  insertText: string;
  action?: 'usage';
}

export interface ComposerTriggerController {
  open: boolean;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

export interface ComposerTriggerMenuProps {
  projectId?: string | null;
  value: string;
  caret: number;
  disabled?: boolean;
  controllerRef?: MutableRefObject<ComposerTriggerController>;
  onApply: (nextValue: string, nextCaret: number) => void;
  onUsageAction?: (summary: string) => void;
  className?: string;
}

const TRIGGER_HEADER_KEYS: Record<ComposerTriggerKind, string> = {
  '$': 'proj.composer.triggerSkills',
  '@': 'proj.composer.triggerFilesTasks',
  '/': 'proj.composer.triggerCommands',
};

export function ComposerTriggerMenu({
  projectId = null,
  value,
  caret,
  disabled = false,
  controllerRef,
  onApply,
  onUsageAction,
  className,
}: ComposerTriggerMenuProps) {
  const { t } = useI18n();
  const detected = useMemo(
    () => (disabled ? null : detectComposerTrigger(value, caret)),
    [disabled, value, caret],
  );
  const [dismissKey, setDismissKey] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const currentKey = detected ? `${detected.start}:${detected.kind}` : null;
  const isDismissed = currentKey !== null && currentKey === dismissKey;
  const activeTrigger = isDismissed ? null : detected;
  const activeKind = activeTrigger?.kind ?? null;

  useEffect(() => {
    if (currentKey === null) setDismissKey(null);
    setActiveIndex(0);
  }, [currentKey, detected?.query]);

  // Only fetch datasets on demand when their trigger is active; never retry on 404/error.
  const knowledge = useQuery({
    ...knowledgeQuery,
    enabled: activeKind === '$',
    retry: false,
  });
  const projectFiles = useQuery({
    ...projectFilesQuery(projectId ?? '__none__'),
    enabled: activeKind === '@' && Boolean(projectId),
    retry: false,
  });
  const tasks = useQuery({
    ...tasksQuery,
    enabled: activeKind === '@',
    retry: false,
  });
  const accounts = useQuery({
    ...accountsQuery,
    enabled: activeKind === '/',
    retry: false,
  });

  const items = useMemo<ComposerTriggerItem[]>(() => {
    if (!activeTrigger) return [];
    const q = activeTrigger.query.trim().toLowerCase();

    if (activeTrigger.kind === '$') {
      const results: ComposerTriggerItem[] = [];
      const seen = new Set<string>();
      for (const entry of knowledge.data?.entries ?? []) {
        if (entry.state !== 'active' || entry.kind !== 'skill') continue;
        if (projectId && entry.project_ids !== null && !entry.project_ids.includes(projectId)) continue;
        const hay = `${entry.title} ${entry.when_to_use} ${entry.id}`.toLowerCase();
        if (q && !hay.includes(q)) continue;
        seen.add(entry.title);
        results.push({
          id: `skill:${entry.id}`,
          kind: 'skill',
          label: entry.title,
          detail: entry.when_to_use || t('proj.composer.detailProjectSkill'),
          insertText: `$${entry.title} `,
        });
      }
      for (const dirSkill of knowledge.data?.directory_skills ?? []) {
        const label = dirSkill.name || dirSkill.slug;
        if (seen.has(label)) continue;
        const hay = `${label} ${dirSkill.slug} ${dirSkill.description}`.toLowerCase();
        if (q && !hay.includes(q)) continue;
        results.push({
          id: `dirskill:${dirSkill.id}`,
          kind: 'skill',
          label,
          detail: dirSkill.description || t('proj.composer.detailDirSkill'),
          insertText: `$${label} `,
        });
      }
      return results.slice(0, 8);
    }

    if (activeTrigger.kind === '@') {
      const results: ComposerTriggerItem[] = [];
      for (const file of projectFiles.data?.files ?? []) {
        if (q && !file.name.toLowerCase().includes(q)) continue;
        results.push({
          id: `file:${file.id}`,
          kind: 'file',
          label: file.name,
          detail: formatFileSize(file.size),
          insertText: `@${file.name} `,
        });
      }
      const allTasks = [...(tasks.data?.tasks ?? []), ...(tasks.data?.children ?? [])];
      for (const task of allTasks) {
        if (projectId && task.project_id !== projectId) continue;
        const hay = `${task.title} ${task.id}`.toLowerCase();
        if (q && !hay.includes(q)) continue;
        results.push({
          id: `task:${task.id}`,
          kind: 'task',
          label: task.title,
          detail: task.id,
          insertText: `@${task.title} `,
        });
      }
      return results.slice(0, 10);
    }

    // '/' quick actions
    const usageSummary = formatAccountUsageSummary(accounts.data);
    const commands: ComposerTriggerItem[] = [
      {
        id: 'cmd:usage',
        kind: 'command',
        label: '/usage',
        detail: accounts.data
          ? t('proj.composer.cmdUsageDetailCount', { count: accounts.data.accounts.length })
          : t('proj.composer.cmdUsageDetailDefault'),
        insertText: `${usageSummary} `,
        action: 'usage',
      },
      {
        id: 'cmd:status',
        kind: 'command',
        label: '/status',
        detail: t('proj.composer.cmdStatusDetail'),
        insertText: t('proj.composer.cmdStatusInsert'),
      },
    ];
    return commands.filter((cmd) => !q || cmd.label.slice(1).toLowerCase().includes(q) || (cmd.detail ?? '').toLowerCase().includes(q));
  }, [activeTrigger, knowledge.data, projectFiles.data, tasks.data, accounts.data, projectId, t]);

  const safeIndex = items.length > 0 ? activeIndex % items.length : 0;
  const isOpen = activeTrigger !== null && items.length > 0;

  function applyItem(item: ComposerTriggerItem): void {
    if (!activeTrigger) return;
    if (item.action === 'usage' && onUsageAction) {
      const summary = formatAccountUsageSummary(accounts.data);
      const replaced = replaceTriggerText(value, activeTrigger, '');
      onApply(replaced.text, replaced.caret);
      onUsageAction(summary);
      return;
    }
    const replaced = replaceTriggerText(value, activeTrigger, item.insertText);
    onApply(replaced.text, replaced.caret);
  }

  // Publish keyboard controller at commit time (not during render) and preserve modified
  // editing shortcuts like Shift+Enter and Shift+Tab.
  useLayoutEffect(() => {
    if (!controllerRef) return;
    controllerRef.current = {
      open: isOpen,
      handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
        if (!isOpen || event.nativeEvent.isComposing || event.keyCode === 229) return false;
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActiveIndex((prev) => (prev + 1) % items.length);
          return true;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActiveIndex((prev) => (prev - 1 + items.length) % items.length);
          return true;
        }
        if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const picked = items[safeIndex];
          if (!picked) return false;
          event.preventDefault();
          applyItem(picked);
          return true;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          if (currentKey) setDismissKey(currentKey);
          return true;
        }
        return false;
      },
    };
  });

  if (!isOpen || !activeTrigger) return null;

  return (
    <div
      role="listbox"
      aria-label={t(TRIGGER_HEADER_KEYS[activeTrigger.kind])}
      className={cn(
        'absolute right-0 bottom-full left-0 z-30 mb-1.5 overflow-hidden rounded-xl border border-border-strong bg-raised shadow-dialog',
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-border/70 bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground">
        <span>{t(TRIGGER_HEADER_KEYS[activeTrigger.kind])}</span>
        <span>{t('proj.composer.triggerNavHint')}</span>
      </div>
      <div className="max-h-56 overflow-y-auto py-1">
        {items.map((item, index) => {
          const selected = index === safeIndex;
          const Icon = item.kind === 'skill' ? Sparkles
            : item.kind === 'file' ? FileText
              : item.kind === 'task' ? ListTodo
                : Terminal;
          return (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={selected}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => applyItem(item)}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                selected ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground',
              )}
            >
              <Icon className="size-3.5 flex-none text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 truncate font-medium text-foreground">{item.label}</span>
              {item.detail ? (
                <span className="ml-auto max-w-[55%] truncate text-2xs text-faint">{item.detail}</span>
              ) : null}
              <Badge tone="plain" className="flex-none text-2xs">
                {item.kind === 'skill'
                  ? t('proj.composer.kindSkill')
                  : item.kind === 'file'
                    ? t('proj.composer.kindFile')
                    : item.kind === 'task'
                      ? t('proj.composer.kindTask')
                      : t('proj.composer.kindCommand')}
              </Badge>
            </button>
          );
        })}
      </div>
    </div>
  );
}
