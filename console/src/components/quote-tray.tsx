import { Quote, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { ComposerQuote } from '@/lib/quotes';

export function QuoteTray({
  quotes,
  disabled = false,
  onRemove,
  onClear,
}: {
  quotes: readonly ComposerQuote[];
  disabled?: boolean;
  onRemove: (id: string) => void;
  onClear?: () => void;
}) {
  const { t } = useI18n();
  if (quotes.length === 0) return null;

  return (
    <div
      role="region"
      aria-label={t('quote.trayLabel', { count: quotes.length })}
      className="flex flex-col gap-1.5 border-b border-border/60 px-3 pt-2 pb-2"
    >
      {quotes.length > 1 && onClear ? (
        <div className="flex items-center justify-between text-2xs text-faint">
          <span>{t('quote.trayLabel', { count: quotes.length })}</span>
          <button
            type="button"
            disabled={disabled}
            onClick={onClear}
            className="cursor-pointer border-0 bg-transparent p-0 text-2xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {t('quote.clearAll')}
          </button>
        </div>
      ) : null}
      {quotes.map((quote) => (
        <div
          key={quote.id}
          data-quote-chip
          className="flex items-start gap-2 rounded-lg border border-border/70 border-l-2 border-l-primary bg-muted/55 py-1.5 pr-1.5 pl-2.5 text-xs"
        >
          <Quote className="mt-0.5 size-3 flex-none text-primary/80" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            {quote.source ? (
              <span className="mr-1.5 font-medium text-muted-foreground">{quote.source}</span>
            ) : null}
            <p className="line-clamp-2 text-foreground/90 wrap-anywhere whitespace-pre-wrap">{quote.excerpt}</p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            aria-label={t('quote.remove')}
            className="size-5 flex-none rounded-md"
            disabled={disabled}
            onClick={() => onRemove(quote.id)}
          >
            <X className="size-3" />
          </Button>
        </div>
      ))}
    </div>
  );
}
