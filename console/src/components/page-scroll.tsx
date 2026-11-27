import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

const NEAR_BOTTOM_PX = 80;

// The part of a page that scrolls. Two things are kept apart: where the page stands
// when it is first come to, and what happens as it grows. `opens` is the first: at its
// head, or at its latest line as a conversation does. `follow` is the second: new
// content pulls the view down with it only while the reader is at the bottom, so
// someone reading further up keeps their place. `resetKey` resets the scroll anchor
// cleanly when switching conversation segments inside the same mounted scroll container.
export function PageScroll({ follow = false, opens = 'head', resetKey, className, children }: {
  follow?: boolean | undefined;
  opens?: 'head' | 'latest' | undefined;
  resetKey?: string | undefined;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Where the reader was before this draw.
  const atBottom = useRef(opens === 'latest');
  const prevResetKey = useRef(resetKey);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (prevResetKey.current !== resetKey) {
      prevResetKey.current = resetKey;
      atBottom.current = opens === 'latest';
      node.scrollTop = opens === 'latest' ? node.scrollHeight : 0;
      return;
    }
    if (follow && atBottom.current) node.scrollTop = node.scrollHeight;
  });

  // Follow late asynchronous content growth (images, Mermaid diagrams, resized iframes)
  // while the reader is pinned to the bottom, without pulling them away once scrolled up.
  useEffect(() => {
    if (!follow || typeof ResizeObserver === 'undefined') return;
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      const node = ref.current;
      if (node && atBottom.current) {
        node.scrollTop = node.scrollHeight;
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [follow, resetKey]);

  return (
    <div
      ref={ref}
      data-scroll=""
      className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', className)}
      onScroll={(event) => {
        const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
        atBottom.current = scrollHeight - scrollTop - clientHeight < NEAR_BOTTOM_PX;
      }}
    >
      <div ref={contentRef} className="min-w-0">
        {children}
      </div>
    </div>
  );
}
