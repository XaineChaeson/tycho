import * as React from 'react';
import { X } from 'lucide-react';
import { AlertDialog as AlertPrimitive, Dialog as DialogPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';
import { Button } from './button';

// A window in the middle of the page, over a dimmed page: a few steps the owner is walked
// through, or a short form. Escape or a click beside it closes it, and closed it hands the
// focus back to whatever opened it. A form that is edited beside the page it belongs to is a
// drawer (`Sheet`); a yes-or-no about something that cannot be taken back is `Confirm`.
const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

const OVERLAY = 'fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in';
const WINDOW = [
  'fixed top-1/2 left-1/2 z-50 flex max-h-[min(88dvh,760px)] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col',
  'rounded-2xl bg-raised text-sm shadow-dialog wrap-anywhere data-[state=open]:animate-rise-in',
].join(' ');

function CloseButton() {
  return (
    <DialogPrimitive.Close asChild>
      <Button variant="ghost" size="icon-sm" aria-label="关闭" className="-mr-1.5 flex-none"><X /></Button>
    </DialogPrimitive.Close>
  );
}

// Never wider than the screen less its margins, never taller than most of it: what does
// not fit scrolls inside, under a head that stays.
function DialogContent({ title, description, footer, className, children, ...props }: Omit<React.ComponentProps<typeof DialogPrimitive.Content>, 'title'> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={OVERLAY} />
      <DialogPrimitive.Content data-slot="dialog" className={cn(WINDOW, 'max-w-[480px]', className)} {...(description ? {} : { 'aria-describedby': undefined })} {...props}>
        <header className="flex flex-none items-start justify-between gap-4 px-5 pt-4 pb-1">
          <div className="min-w-0">
            <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
            {description ? <DialogPrimitive.Description className="mt-1 text-muted-foreground">{description}</DialogPrimitive.Description> : null}
          </div>
          <CloseButton />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-5">{children}</div>
        {footer ? <footer className="flex flex-none flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer> : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

// The row of buttons that ends a step inside a dialog's body.
function DialogActions({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('mt-1 flex flex-wrap justify-end gap-2', className)} {...props} />;
}

// A drawer from the right edge: the page it belongs to stays in sight behind it. Where a
// thing is edited: an account, a login, a role, a trigger.
const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;

function SheetContent({ title, description, footer, side = 'right', className, bodyClassName, children, ...props }: Omit<React.ComponentProps<typeof DialogPrimitive.Content>, 'title'> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  // Stays at the foot while the body scrolls: the buttons that save or drop what was typed.
  footer?: React.ReactNode;
  side?: 'right' | 'left';
  bodyClassName?: string;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={OVERLAY} />
      <DialogPrimitive.Content
        data-slot="sheet"
        className={cn(
          'fixed inset-y-0 z-50 flex h-full w-[min(540px,100%)] flex-col bg-raised text-sm shadow-dialog wrap-anywhere',
          side === 'right' ? 'right-0 data-[state=open]:animate-slide-in-right' : 'left-0 data-[state=open]:animate-slide-in-left',
          className,
        )}
        {...(description ? {} : { 'aria-describedby': undefined })}
        {...props}
      >
        <header className="flex flex-none items-start justify-between gap-4 border-b border-border px-5 py-3.5">
          <div className="min-w-0">
            <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
            {description ? <DialogPrimitive.Description className="mt-0.5 text-muted-foreground">{description}</DialogPrimitive.Description> : null}
          </div>
          <CloseButton />
        </header>
        <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-4', bodyClassName)}>{children}</div>
        {footer ? <footer className="flex flex-none flex-wrap items-center gap-2 border-t border-border px-5 py-3">{footer}</footer> : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

// A yes-or-no before something that cannot be taken back. It does not close on a click
// beside it; the refusal of what was confirmed is said inside it, where the next try is.
function Confirm({ open, title, description, confirm, cancel = '取消', danger = true, busy = false, confirmDisabled = false, error, onConfirm, onCancel, children }: {
  open: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirm: React.ReactNode;
  cancel?: React.ReactNode;
  danger?: boolean;
  busy?: boolean;
  // A step the owner must first meet a condition for, such as typing the name again.
  confirmDisabled?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  return (
    <AlertPrimitive.Root open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
      <AlertPrimitive.Portal>
        <AlertPrimitive.Overlay className={OVERLAY} />
        <AlertPrimitive.Content data-slot="confirm" className={cn(WINDOW, 'max-w-[420px] gap-4 p-5')} {...(description ? {} : { 'aria-describedby': undefined })}>
          <div>
            <AlertPrimitive.Title className="text-base font-semibold">{title}</AlertPrimitive.Title>
            {description ? <AlertPrimitive.Description className="mt-1.5 text-muted-foreground">{description}</AlertPrimitive.Description> : null}
          </div>
          {children}
          {error ? <p role="alert" className="text-destructive">{error}</p> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <AlertPrimitive.Cancel asChild><Button disabled={busy}>{cancel}</Button></AlertPrimitive.Cancel>
            {/* Not Radix's Action: that closes at once, and this one stays until it is answered. */}
            <Button variant={danger ? 'danger-solid' : 'primary'} disabled={busy || confirmDisabled} onClick={onConfirm}>{confirm}</Button>
          </div>
        </AlertPrimitive.Content>
      </AlertPrimitive.Portal>
    </AlertPrimitive.Root>
  );
}

export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogActions, Sheet, SheetTrigger, SheetClose, SheetContent, Confirm };
