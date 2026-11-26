import * as React from 'react';
import { cn } from '@/lib/utils';

// What a page shows while it is first read: the shape of what is coming, so nothing under
// it moves when it arrives. Never a line of "正在读取…".
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('animate-shimmer rounded-md bg-[linear-gradient(90deg,var(--muted)_25%,var(--hover)_50%,var(--muted)_75%)] bg-[length:200%_100%]', className)}
      {...props}
    />
  );
}

// A head and a few rows, as most pages' first answer looks.
function SkeletonPage({ rows = 4 }: { rows?: number }) {
  return (
    <div data-slot="skeleton-page" className="grid gap-3">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="mb-2 h-4 w-full max-w-[420px]" />
      {Array.from({ length: rows }, (_, index) => <Skeleton key={index} className="h-14 w-full" />)}
    </div>
  );
}

export { Skeleton, SkeletonPage };
