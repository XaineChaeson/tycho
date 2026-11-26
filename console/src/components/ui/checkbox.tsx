import * as React from 'react';
import { cn } from '@/lib/utils';

const BOX = [
  'peer size-4 flex-none cursor-pointer appearance-none border border-input bg-background shadow-xs transition-colors duration-100',
  'checked:border-primary checked:bg-primary hover:not-disabled:not-checked:border-faint',
  'disabled:cursor-not-allowed disabled:opacity-50',
].join(' ');

// The browser's own checkbox, drawn in ink. The tick is a layer over it, so the control
// stays a real input.
function Checkbox({ className, ...props }: Omit<React.ComponentProps<'input'>, 'type'>) {
  return (
    <span className="relative inline-flex size-4 flex-none items-center justify-center">
      <input type="checkbox" data-slot="checkbox" className={cn(BOX, 'rounded-sm', className)} {...props} />
      <svg viewBox="0 0 12 12" aria-hidden="true" className="pointer-events-none absolute size-3 fill-none stroke-primary-foreground stroke-[1.8] opacity-0 peer-checked:opacity-100" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 6.2 5 8.6l4.5-5" />
      </svg>
    </span>
  );
}

function Radio({ className, ...props }: Omit<React.ComponentProps<'input'>, 'type'>) {
  return (
    <span className="relative inline-flex size-4 flex-none items-center justify-center">
      <input type="radio" data-slot="radio" className={cn(BOX, 'rounded-full', className)} {...props} />
      <span aria-hidden="true" className="pointer-events-none absolute size-1.5 rounded-full bg-primary-foreground opacity-0 peer-checked:opacity-100" />
    </span>
  );
}

// A tick or a radio with its words: the whole line is the target.
function Choice({ className, ...props }: React.ComponentProps<'label'>) {
  return <label className={cn('flex min-h-hit cursor-pointer items-center gap-2 text-sm has-disabled:cursor-not-allowed has-disabled:text-muted-foreground', className)} {...props} />;
}

export { Checkbox, Radio, Choice };
