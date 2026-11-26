import * as React from 'react';
import { cn } from '@/lib/utils';

// One look for everything typed into: a fine edge that darkens under the pointer and takes
// the ring when it has the keyboard.
export const FIELD = [
  'w-full min-w-0 rounded-md border border-input bg-background text-sm text-foreground shadow-xs',
  'transition-[border-color,box-shadow] duration-100 placeholder:text-faint',
  'hover:not-disabled:not-focus:border-faint',
  'focus:border-ring focus:outline-[3px] focus:outline-offset-0 focus:outline-ring/20',
  'read-only:bg-muted read-only:text-muted-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground',
  'aria-invalid:border-failed',
].join(' ');

function Input({ className, type = 'text', ...props }: React.ComponentProps<'input'>) {
  return <input type={type} data-slot="input" className={cn(FIELD, 'min-h-hit px-2.5 py-1', className)} {...props} />;
}

// Grows with what is typed (field-sizing), from `rows` up to whatever the caller caps it at.
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn(FIELD, 'block field-sizing-content min-h-hit resize-none px-2.5 py-1.5 leading-[20px]', className)} {...props} />;
}

export { Input, Textarea };
