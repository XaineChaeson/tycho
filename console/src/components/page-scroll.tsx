import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

const NEAR_BOTTOM_PX = 80;

// The part of a page that scrolls. Two things are kept apart: where the page stands
// when it is first come to, and what happens as it grows. `opens` is the first: at its
// head, or at its latest line as a conversation does. `follow` is the second: new
// content pulls the view down with it only while the reader is at the bottom, so
// someone reading further up keeps their place. A page that opens at its head follows
// from the moment the reader has gone down to its end, not before.
export function PageScroll({ follow = false, opens = 'head', className, children }: {
  follow?: boolean | undefined;
  opens?: 'head' | 'latest' | undefined;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Where the reader was before this draw.
  const atBottom = useRef(opens === 'latest');

  useLayoutEffect(() => {
    const node = ref.current;
    if (follow && node && atBottom.current) node.scrollTop = node.scrollHeight;
  });

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
      {children}
    </div>
  );
}
