import * as React from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FIELD } from './input';

// The browser's own select. Where the browser lets a page draw it (`appearance:
// base-select`, index.css) its list is the console's; elsewhere it is the system's, which
// is the right control on a phone. Either way a keyboard, a screen reader and a form see a
// real select, and nothing is loaded for it.
function Select({ className, wrapperClassName, ...props }: React.ComponentProps<'select'> & { wrapperClassName?: string }) {
  return (
    <span data-slot="select-wrapper" className={cn('relative inline-flex min-w-0', wrapperClassName)}>
      <select
        data-slot="select"
        className={cn(FIELD, 'min-h-hit cursor-pointer appearance-none items-center truncate py-1 pr-8 pl-2.5 disabled:cursor-not-allowed', className)}
        {...props}
      />
      <ChevronsUpDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-faint" aria-hidden="true" />
    </span>
  );
}

function Option(props: React.ComponentProps<'option'>) {
  return <option data-slot="select-option" {...props} />;
}

export { Select, Option };
