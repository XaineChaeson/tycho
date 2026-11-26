import * as React from 'react';
import { DropdownMenu as MenuPrimitive, Popover as PopoverPrimitive, Tooltip as TooltipPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

// What floats over the page for a moment: a menu of the less common actions of a place, a
// small panel that opens from a button, and the words a pointer resting on an icon gets.
const FLOAT = 'z-50 rounded-lg bg-raised text-sm text-foreground shadow-pop data-[state=open]:animate-pop-in';

const Menu = MenuPrimitive.Root;
const MenuTrigger = MenuPrimitive.Trigger;

function MenuContent({ className, align = 'end', sideOffset = 6, ...props }: React.ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content data-slot="menu" align={align} sideOffset={sideOffset} className={cn(FLOAT, 'min-w-44 p-1', className)} {...props} />
    </MenuPrimitive.Portal>
  );
}

function MenuItem({ className, danger = false, ...props }: React.ComponentProps<typeof MenuPrimitive.Item> & { danger?: boolean }) {
  return (
    <MenuPrimitive.Item
      className={cn(
        'flex min-h-hit cursor-pointer items-center gap-2 rounded-md px-2 outline-none select-none data-disabled:cursor-default data-disabled:text-faint data-highlighted:bg-hover',
        "[&_svg]:size-4 [&_svg]:flex-none [&_svg]:text-muted-foreground",
        danger && 'text-destructive [&_svg]:text-destructive',
        className,
      )}
      {...props}
    />
  );
}

function MenuLabel({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cn('px-2 pt-1.5 pb-1 text-xs text-faint', className)} {...props} />;
}

function MenuSeparator({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;

function PopoverContent({ className, align = 'start', sideOffset = 6, ...props }: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content data-slot="popover" align={align} sideOffset={sideOffset} className={cn(FLOAT, 'w-72 p-3 wrap-anywhere', className)} {...props} />
    </PopoverPrimitive.Portal>
  );
}

// The name of a control that shows only a picture. The control still carries the name
// itself (aria-label): this is for the eye. Each brings its own provider, so one can stand
// anywhere without the page having to wrap it.
function Tooltip({ text, side = 'top', children }: { text: React.ReactNode; side?: 'top' | 'right' | 'bottom' | 'left'; children: React.ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={350}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content side={side} sideOffset={6} className="z-50 max-w-72 rounded-md bg-ink px-2 py-1 text-xs text-ink-foreground shadow-sm wrap-anywhere data-[state=delayed-open]:animate-fade-in">
            {text}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export { Menu, MenuTrigger, MenuContent, MenuItem, MenuLabel, MenuSeparator, Popover, PopoverTrigger, PopoverContent, Tooltip };
