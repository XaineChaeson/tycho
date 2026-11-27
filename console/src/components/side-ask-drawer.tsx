import { ArrowUp, CornerUpLeft, Loader2, MessageCircleQuestion, Quote, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Tooltip } from '@/components/ui/menu';
import { messageOf, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { trimQuoteExcerpt } from '@/lib/quotes';
import { cn } from '@/lib/utils';

export interface SideAskQuote {
  source?: string;
  excerpt: string;
}

interface SideAskEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  executor?: string;
  durationMs?: number;
}

interface SideAskResponse {
  answer: string;
  executor: string;
  duration_ms: number;
}

export function SideAskDrawer({
  projectId,
  open,
  initialQuote,
  onClose,
  onPromoteToMain,
}: {
  projectId: string;
  open: boolean;
  initialQuote: SideAskQuote | null;
  onClose: () => void;
  onPromoteToMain: (payload: { source: string; excerpt: string }) => void;
}) {
  const { locale, t } = useI18n();
  const [quote, setQuote] = useState<SideAskQuote | null>(initialQuote);
  const [entries, setEntries] = useState<SideAskEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promotedId, setPromotedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (initialQuote) setQuote(initialQuote);
  }, [initialQuote]);

  useEffect(() => {
    if (open) {
      window.setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open, initialQuote]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, busy]);

  if (!open) return null;

  async function submit(): Promise<void> {
    const question = draft.trim();
    if (!question || busy) return;
    const history = entries.map(({ role, text }) => ({ role, text }));
    const userEntry: SideAskEntry = { id: `u-${Date.now()}`, role: 'user', text: question };
    setEntries((prev) => [...prev, userEntry]);
    setDraft('');
    setBusy(true);
    setError(null);
    try {
      const res = await post<SideAskResponse>(`/api/projects/${encodeURIComponent(projectId)}/side-ask`, {
        question,
        ...(quote ? { quote } : {}),
        ...(history.length > 0 ? { history } : {}),
        locale,
      });
      setEntries((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          text: res.answer,
          executor: res.executor,
          durationMs: res.duration_ms,
        },
      ]);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void submit();
  }

  function promote(entry: SideAskEntry): void {
    onPromoteToMain({
      source: t('sideAsk.title'),
      excerpt: trimQuoteExcerpt(entry.text, 600),
    });
    setPromotedId(entry.id);
    window.setTimeout(() => setPromotedId((cur) => (cur === entry.id ? null : cur)), 2000);
  }

  return (
    <aside
      role="dialog"
      aria-label={t('sideAsk.title')}
      className="fixed right-4 bottom-4 z-40 flex h-[min(560px,calc(100vh-96px))] w-[min(430px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-border bg-raised shadow-dialog"
    >
      <header className="flex flex-none items-center justify-between gap-2 border-b border-border bg-muted/50 px-3.5 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <MessageCircleQuestion className="size-4 flex-none text-primary" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-foreground">{t('sideAsk.title')}</h2>
          </div>
          <p className="truncate text-2xs text-muted-foreground">{t('sideAsk.subtitle')}</p>
        </div>
        <div className="flex flex-none items-center gap-0.5">
          {entries.length > 0 ? (
            <Tooltip text={t('sideAsk.clear')}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('sideAsk.clear')}
                onClick={() => {
                  setEntries([]);
                  setError(null);
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </Tooltip>
          ) : null}
          <Button variant="ghost" size="icon-sm" aria-label={t('common.close')} onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </header>

      {quote ? (
        <div className="flex flex-none items-start gap-2 border-b border-border/70 bg-muted/30 px-3.5 py-2 text-xs">
          <Quote className="mt-0.5 size-3 flex-none text-primary/80" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            {quote.source ? <span className="mr-1.5 font-medium text-muted-foreground">{quote.source}</span> : null}
            <p className="line-clamp-3 text-foreground/90 wrap-anywhere whitespace-pre-wrap">{quote.excerpt}</p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('quote.remove')}
            className="size-5 flex-none"
            onClick={() => setQuote(null)}
          >
            <X className="size-3" />
          </Button>
        </div>
      ) : null}

      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 py-3 text-sm">
        {entries.length === 0 ? (
          <p className="my-auto px-2 text-center text-xs text-muted-foreground">{t('sideAsk.empty')}</p>
        ) : (
          entries.map((entry) => (
            entry.role === 'user' ? (
              <div key={entry.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-bubble px-3 py-1.5 text-sm wrap-anywhere whitespace-pre-wrap">
                  {entry.text}
                </div>
              </div>
            ) : (
              <div key={entry.id} className="flex flex-col gap-1.5 rounded-xl border border-border/70 bg-background/80 p-3">
                <Markdown text={entry.text} projectId={projectId} />
                <div className="flex items-center justify-between gap-2 border-t border-border/50 pt-1.5 text-2xs text-faint">
                  <span className="font-mono">
                    {entry.executor ?? 'router'}
                    {entry.durationMs ? ` · ${(entry.durationMs / 1000).toFixed(1)}s` : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => promote(entry)}
                    className={cn(
                      'inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-2xs font-medium transition-colors',
                      promotedId === entry.id ? 'text-success-foreground' : 'text-primary hover:underline',
                    )}
                  >
                    <CornerUpLeft className="size-3" aria-hidden="true" />
                    {promotedId === entry.id ? t('sideAsk.promoted') : t('sideAsk.promote')}
                  </button>
                </div>
              </div>
            )
          ))
        )}
        {busy ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden="true" />
            <span>{t('sideAsk.thinking')}</span>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-lg border border-failed-border bg-failed-soft px-2.5 py-1.5 text-xs text-destructive wrap-anywhere">
            {error}
          </p>
        ) : null}
      </div>

      <form
        className="flex flex-none items-end gap-1.5 border-t border-border bg-background px-2.5 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Textarea
          ref={inputRef}
          rows={1}
          value={draft}
          readOnly={busy}
          placeholder={t('sideAsk.placeholder')}
          aria-label={t('sideAsk.title')}
          className="max-h-28 min-h-8 flex-1 overflow-y-auto border-0 bg-transparent px-1.5 py-1.5 text-sm shadow-none focus:outline-0"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button
          variant="primary"
          size="icon-sm"
          type="submit"
          aria-label={t('common.send')}
          disabled={busy || draft.trim() === ''}
          className="size-8 flex-none rounded-lg"
        >
          <ArrowUp className="size-4" />
        </Button>
      </form>
    </aside>
  );
}
