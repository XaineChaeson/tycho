import * as React from 'react';
import { Switch as SwitchPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

// The switch semantics a keyboard and a screen reader already know, through Radix. On is
// ink, like everything else that has been chosen.
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-border-strong transition-colors duration-150',
        // A finger gets the full hit height without the track growing.
        'after:absolute after:-inset-x-1 after:top-1/2 after:h-hit after:-translate-y-1/2',
        'data-[state=checked]:bg-primary disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 translate-x-px rounded-full bg-[white] shadow-sm transition-transform duration-150 data-[state=checked]:translate-x-[17px] data-[state=checked]:bg-primary-foreground"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
