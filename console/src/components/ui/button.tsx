import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { cn } from '@/lib/utils';

// Four looks carry the whole console. `primary` is cobalt: the one main action of a place, and
// never more than one in sight. `secondary` is everything else that is a button. `ghost` is
// an action inside a row or a bar. `danger` is what cannot be taken back; it stays quiet
// until it is the thing being confirmed (`danger-solid`).
const buttonVariants = cva(
  [
    'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap no-underline select-none',
    'transition-[background-color,border-color,color,opacity,transform] duration-100 active:not-disabled:scale-[0.98]',
    'disabled:cursor-default disabled:opacity-50',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        primary: 'btn-primary',
        secondary: 'btn-secondary aria-pressed:bg-brand-soft aria-pressed:text-brand-foreground data-[state=open]:bg-muted',
        ghost: 'border-transparent bg-transparent text-muted-foreground hover:not-disabled:bg-hover hover:not-disabled:text-foreground aria-pressed:bg-hover aria-pressed:text-foreground data-[state=open]:bg-hover data-[state=open]:text-foreground',
        danger: 'border-transparent bg-transparent text-destructive hover:not-disabled:bg-failed-soft',
        'danger-solid': 'btn-danger-solid hover:not-disabled:opacity-90',
      },
      size: {
        md: 'min-h-hit px-3 text-sm',
        sm: 'min-h-hit-sm px-2 text-xs',
        lg: 'min-h-10 px-4 text-base',
        icon: 'size-hit p-0',
        'icon-sm': 'size-hit-sm p-0',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export type ButtonProps = React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean };

function Button({ className, variant = 'secondary', size = 'md', asChild = false, type = 'button', ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      className={cn(buttonVariants({ variant, size, className }))}
      {...(asChild ? {} : { type })}
      {...props}
    />
  );
}

export { Button, buttonVariants };
