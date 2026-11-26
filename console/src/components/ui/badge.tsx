import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// A state as a word on a tinted ground. The word carries the meaning; the colour only makes
// it quicker to find, and follows the same five meanings the dots use.
const badgeVariants = cva(
  'inline-flex min-h-5 max-w-full items-center gap-1 rounded-sm border px-1.5 py-px font-mono text-2xs leading-4 font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        running: 'border-running-border bg-running-soft text-running-foreground',
        waiting: 'border-waiting-border bg-waiting-soft text-waiting-foreground',
        failed: 'border-failed-border bg-failed-soft text-failed-foreground',
        success: 'border-success-border bg-success-soft text-success-foreground',
        ended: 'border-border bg-muted text-muted-foreground',
        plain: 'border-border bg-background text-muted-foreground',
      },
    },
    defaultVariants: { tone: 'ended' },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

function Badge({ className, tone, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" data-tone={tone ?? 'ended'} className={cn(badgeVariants({ tone, className }))} {...props} />;
}

export { Badge };
