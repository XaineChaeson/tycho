import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';

// A box that is typed into and a list under it that the arrow keys walk: the palette that
// goes anywhere (components/palette.tsx) and the search over the settings.
function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return <CommandPrimitive data-slot="command" className={cn('flex w-full flex-col text-foreground', className)} {...props} />;
}

function CommandInput({ className, wrapperClassName, ...props }: React.ComponentProps<typeof CommandPrimitive.Input> & { wrapperClassName?: string }) {
  return (
    <div data-slot="command-input" className={cn('flex min-h-hit items-center gap-2 px-3', wrapperClassName)}>
      <Search className="size-4 shrink-0 text-faint" aria-hidden="true" />
      <CommandPrimitive.Input className={cn('h-full min-h-hit w-full min-w-0 bg-transparent text-sm outline-hidden placeholder:text-faint', className)} {...props} />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return <CommandPrimitive.List data-slot="command-list" className={cn('max-h-[min(420px,60dvh)] scroll-py-1 overflow-x-hidden overflow-y-auto', className)} {...props} />;
}

function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty data-slot="command-empty" className="px-3 py-6 text-center text-sm text-muted-foreground" {...props} />;
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn('p-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-faint', className)}
      {...props}
    />
  );
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        'flex min-h-hit cursor-pointer items-center gap-2.5 rounded-md px-2 py-1 text-sm select-none data-[selected=true]:bg-hover',
        '[&_svg]:size-4 [&_svg]:flex-none [&_svg]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList };
