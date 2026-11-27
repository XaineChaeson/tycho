// Paired Quote-Reply tray rendered inside Project and Task composers, plus QuotedMessageBody
// for visually rendering paired quote-and-reply blocks inside sent owner bubbles.
import { Quote, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useI18n } from '@/lib/i18n';
import {
  parseQuotedSegments,
  resolveQuoteSource,
  type ComposerQuote,
} from '@/lib/quotes';
import { cn } from '@/lib/utils';

export function QuoteTray({
  quotes,
  disabled = false,
  submitDisabled = false,
  onRemove,
  onClear,
  onUpdateReply,
  onSubmit,
}: {
  quotes: readonly ComposerQuote[];
  disabled?: boolean;
  submitDisabled?: boolean;
  onRemove: (id: string) => void;
  onClear?: () => void;
  onUpdateReply?: (id: string, reply: string) => void;
  onSubmit?: () => void;
}) {
  const { t } = useI18n();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const replyRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  const prevCount = useRef(quotes.length);

  // Auto-focus the newly added quote's reply input when stacking 2+ quotes so the user
  // can immediately type the paired reply right below the quoted excerpt.
  useEffect(() => {
    if (quotes.length > prevCount.current && quotes.length >= 2) {
      const latest = quotes.at(-1);
      if (latest) {
        replyRefs.current.get(latest.id)?.focus();
      }
    }
    prevCount.current = quotes.length;
  }, [quotes]);

  if (quotes.length === 0) return null;

  const isMulti = quotes.length > 1;

  function toggleExpand(id: string): void {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleReplyKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (disabled || submitDisabled) return;
    onSubmit?.();
  }

  return (
    <div
      role="region"
      aria-label={t('quote.trayLabel', { count: quotes.length })}
      className="flex flex-col gap-2 border-b border-border/70 px-3 pt-2.5 pb-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-2xs text-faint">
        <span className="flex items-center gap-1.5">
          <span className="font-medium text-muted-foreground">{t('quote.trayLabel', { count: quotes.length })}</span>
          {isMulti ? <span className="hidden sm:inline">· {t('quote.pairHint')}</span> : null}
        </span>
        {isMulti && onClear ? (
          <button
            type="button"
            disabled={disabled}
            onClick={onClear}
            className="cursor-pointer border-0 bg-transparent p-0 text-2xs text-faint hover:text-foreground disabled:opacity-50"
          >
            {t('quote.clearAll')}
          </button>
        ) : null}
      </div>

      <div className="flex max-h-64 flex-col gap-2 overflow-y-auto overscroll-contain pr-0.5">
        {quotes.map((quote, index) => {
          const sourceLabel = resolveQuoteSource(quote, t);
          const expanded = expandedIds.has(quote.id);
          const longExcerpt = quote.excerpt.length > 140 || quote.excerpt.includes('\n');
          return (
            <div
              key={quote.id}
              data-quote-card={quote.id}
              className="flex-none overflow-hidden rounded-lg border border-border/80 bg-muted/35"
            >
              <div className="flex items-start gap-2 border-l-2 border-primary/70 bg-muted/55 px-2.5 py-1.5 text-xs">
                <Quote className="mt-0.5 size-3 flex-none text-primary/75" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {isMulti ? (
                      <span className="inline-flex size-4 flex-none items-center justify-center rounded-full bg-primary/15 font-mono text-2xs font-semibold text-primary tabular-nums">
                        {index + 1}
                      </span>
                    ) : null}
                    {sourceLabel ? (
                      <span className="font-medium text-muted-foreground">{sourceLabel}</span>
                    ) : null}
                    {longExcerpt ? (
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => toggleExpand(quote.id)}
                        className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-2xs text-primary hover:underline"
                      >
                        {expanded ? t('quote.collapse') : t('quote.expand')}
                      </button>
                    ) : null}
                  </div>
                  <p
                    className={cn(
                      'mt-0.5 text-foreground/85 wrap-anywhere whitespace-pre-wrap',
                      !expanded && 'line-clamp-2',
                    )}
                  >
                    {quote.excerpt}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={t('quote.remove')}
                  title={t('quote.remove')}
                  onClick={() => onRemove(quote.id)}
                  className="inline-flex size-5 flex-none cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent text-faint hover:bg-hover hover:text-foreground disabled:opacity-50"
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </div>
              {onUpdateReply ? (
                <div className="border-t border-border/60 bg-background/90 px-2.5 py-1">
                  <textarea
                    ref={(el) => {
                      if (el) replyRefs.current.set(quote.id, el);
                      else replyRefs.current.delete(quote.id);
                    }}
                    rows={1}
                    value={quote.reply ?? ''}
                    disabled={disabled}
                    aria-label={t('quote.replyLabel', { index: index + 1 })}
                    placeholder={isMulti ? t('quote.replyPlaceholder') : t('quote.replyPlaceholderSingle')}
                    onChange={(event) => onUpdateReply(quote.id, event.target.value)}
                    onKeyDown={handleReplyKeyDown}
                    className="block max-h-24 w-full resize-none border-0 bg-transparent py-0.5 text-xs leading-relaxed text-foreground placeholder:text-faint focus:outline-0 disabled:opacity-60"
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SentQuoteBlock({ source, excerpt }: { source: string | null; excerpt: string }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const longExcerpt = excerpt.length > 220 || excerpt.split('\n').length > 4;
  return (
    <blockquote
      data-sent-quote=""
      className="m-0 rounded-md border-l-2 border-primary/70 bg-background/65 px-2.5 py-1.5 text-xs text-muted-foreground"
    >
      <div className="mb-0.5 flex items-center gap-1">
        {source ? (
          <>
            <Quote className="size-3 flex-none text-primary/70" aria-hidden="true" />
            <span className="font-medium text-foreground/80">{source}</span>
          </>
        ) : (
          <span className="sr-only">{t('quote.blockLabel')}</span>
        )}
        {longExcerpt ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-2xs text-primary hover:underline"
          >
            {expanded ? t('quote.collapse') : t('quote.expand')}
          </button>
        ) : null}
      </div>
      <p className={cn('m-0 wrap-anywhere whitespace-pre-wrap', !expanded && longExcerpt && 'line-clamp-4')}>{excerpt}</p>
    </blockquote>
  );
}

// Visually renders sent owner messages & short follow-ups that contain quote blocks so each
// quote card stays visually bound right above the reply addressing it.
export function QuotedMessageBody({ text, className }: { text: string; className?: string }) {
  const segments = useMemo(() => parseQuotedSegments(text), [text]);
  const hasQuotes = segments.some((seg) => seg.kind === 'quote');

  if (!hasQuotes) {
    return <span className={className}>{text}</span>;
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {segments.map((segment, index) => (
        segment.kind === 'quote' ? (
          <SentQuoteBlock key={`q-${index}`} source={segment.source} excerpt={segment.excerpt} />
        ) : (
          <p key={`t-${index}`} className="m-0 wrap-anywhere whitespace-pre-wrap text-foreground">
            {segment.text}
          </p>
        )
      ))}
    </div>
  );
}
