import { MessageCircleQuestion, Quote } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { trimQuoteExcerpt, type QuoteSourceKey } from '@/lib/quotes';

export interface SelectedExcerpt {
  source: string;
  sourceKey?: QuoteSourceKey | undefined;
  excerpt: string;
  pane: 'chat' | 'thread';
}

const VALID_SOURCE_KEYS = new Set<QuoteSourceKey>(['router', 'owner', 'report', 'worker', 'followup', 'sideAsk']);

interface FloatingPos {
  top: number;
  left: number;
  selection: SelectedExcerpt;
}

function closestQuotable(node: Node | null): HTMLElement | null {
  const el = node?.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node?.parentElement ?? null;
  if (!el) return null;
  if (el.closest('input, textarea, select, [contenteditable="true"], [data-quote-popover]')) return null;
  return el.closest<HTMLElement>('[data-quotable]');
}

// Listens to text selection inside `[data-quotable]` regions and floats a compact desktop-native
// action pill (`引用` + `临时追问`) right above the selection.
export function SelectionQuotePopover({
  rootRef,
  onQuote,
  onSideAsk,
}: {
  rootRef: React.RefObject<HTMLElement | null>;
  onQuote: (selection: SelectedExcerpt) => void;
  onSideAsk?: (selection: SelectedExcerpt) => void;
}) {
  const { t } = useI18n();
  const [floating, setFloating] = useState<FloatingPos | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const dismissedRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);

  const readSelection = useCallback(() => {
    const root = rootRef.current;
    if (!root || typeof window === 'undefined' || dismissedRef.current) {
      setFloating(null);
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setFloating(null);
      return;
    }
    const raw = sel.toString().trim();
    if (raw.length < 2) {
      setFloating(null);
      return;
    }
    const anchorBox = closestQuotable(sel.anchorNode);
    const focusBox = closestQuotable(sel.focusNode);
    // Both range endpoints must belong to the same quotable region so cross-speaker
    // selections are never misattributed to a single speaker.
    if (!anchorBox || !focusBox || anchorBox !== focusBox || !root.contains(anchorBox)) {
      setFloating(null);
      return;
    }
    const box = anchorBox;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      setFloating(null);
      return;
    }
    const pane: 'chat' | 'thread' = box.closest('[data-pane="thread"]') ? 'thread' : 'chat';
    const rawKey = box.dataset.quoteSourceKey as QuoteSourceKey | undefined;
    const sourceKey: QuoteSourceKey | undefined = rawKey && VALID_SOURCE_KEYS.has(rawKey)
      ? rawKey
      : (pane === 'thread' ? 'report' : 'router');
    const source = box.dataset.quoteSource || (pane === 'thread' ? t('task.report') : t('project.routerSpeaker'));
    // Flip below the selection when there is not enough room above it so the toolbar never
    // covers the highlighted text.
    const top = rect.top >= 52
      ? rect.top - 40
      : Math.min(Math.max(12, window.innerHeight - 48), rect.bottom + 8);
    const left = Math.min(Math.max(96, rect.left + rect.width / 2), window.innerWidth - 110);
    setFloating({
      top,
      left,
      selection: { source, sourceKey, excerpt: trimQuoteExcerpt(raw), pane },
    });
  }, [rootRef, t]);

  useEffect(() => {
    const scheduleRead = () => {
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(readSelection, 0);
    };
    const onPointerUp = () => {
      scheduleRead();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return;
      scheduleRead();
    };
    const onSelectionChange = () => {
      dismissedRef.current = false;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.toString().trim().length < 2) {
        setFloating(null);
      }
    };
    const onPointerDown = (event: Event) => {
      if (popoverRef.current?.contains(event.target as Node)) return;
      setFloating(null);
    };
    const onScroll = () => setFloating(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        dismissedRef.current = true;
        window.clearTimeout(timerRef.current);
        setFloating(null);
      }
    };
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('mouseup', onPointerUp);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timerRef.current);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('mouseup', onPointerUp);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [readSelection]);

  if (!floating) return null;

  const clearSel = () => {
    window.getSelection()?.removeAllRanges();
    setFloating(null);
  };

  return (
    <div
      ref={popoverRef}
      data-quote-popover
      role="toolbar"
      aria-label={t('quote.action')}
      style={{ top: `${floating.top}px`, left: `${floating.left}px` }}
      className="fixed z-50 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-border bg-raised p-1 shadow-pop"
    >
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          onQuote(floating.selection);
          clearSel();
        }}
        className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-xs font-medium text-foreground transition-colors hover:bg-hover"
      >
        <Quote className="size-3.5 text-primary" aria-hidden="true" />
        {t('quote.action')}
      </button>
      {onSideAsk ? (
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onSideAsk(floating.selection);
            clearSel();
          }}
          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-xs font-medium text-foreground transition-colors hover:bg-hover"
        >
          <MessageCircleQuestion className="size-3.5 text-brand-foreground" aria-hidden="true" />
          {t('sideAsk.action')}
        </button>
      ) : null}
    </div>
  );
}
