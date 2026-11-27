import { MessageCircleQuestion, Quote } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { trimQuoteExcerpt } from '@/lib/quotes';

export interface SelectedExcerpt {
  source: string;
  excerpt: string;
  pane: 'chat' | 'thread';
}

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

  const readSelection = useCallback(() => {
    const root = rootRef.current;
    if (!root || typeof window === 'undefined') {
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
    const box = anchorBox ?? focusBox;
    if (!box || !root.contains(box)) {
      setFloating(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      setFloating(null);
      return;
    }
    const pane: 'chat' | 'thread' = box.closest('[data-pane="thread"]') ? 'thread' : 'chat';
    const source = box.dataset.quoteSource || (pane === 'thread' ? t('task.report') : t('project.routerSpeaker'));
    const top = Math.max(12, rect.top - 40);
    const left = Math.min(Math.max(96, rect.left + rect.width / 2), window.innerWidth - 110);
    setFloating({
      top,
      left,
      selection: { source, excerpt: trimQuoteExcerpt(raw), pane },
    });
  }, [rootRef, t]);

  useEffect(() => {
    const onPointerUp = () => {
      window.setTimeout(readSelection, 0);
    };
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.toString().trim().length < 2) {
        setFloating(null);
      }
    };
    const onMouseDown = (event: MouseEvent) => {
      if (popoverRef.current?.contains(event.target as Node)) return;
      setFloating(null);
    };
    const onScroll = () => setFloating(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFloating(null);
    };
    document.addEventListener('mouseup', onPointerUp);
    document.addEventListener('keyup', onPointerUp);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mouseup', onPointerUp);
      document.removeEventListener('keyup', onPointerUp);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('mousedown', onMouseDown);
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
