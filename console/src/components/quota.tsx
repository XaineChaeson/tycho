// A login's quota windows as its executor last said them. The usage page shows them whole and
// can ask for them again; the accounts page shows the same figures and points there.
import { remainingPercent, usageLine } from '@shared/labels.ts';
import type { LoginStatus } from '@shared/labels.ts';
import { Note } from '@/components/bits';
import { cn } from '@/lib/utils';

type Window = LoginStatus['usage'][number];

export const remainingOf = (figure: Window): number => remainingPercent(figure.used);

// How much of a quota window remains: aligned with the footer quota popover so every surface
// reads as remaining percentage (green > 20%, amber <= 20%, red <= 10%).
export function QuotaWindow({ figure, className }: { figure: Window; className?: string }) {
  const remaining = remainingOf(figure);
  const noBar = figure.window.startsWith('balance:')
    || figure.window.startsWith('bonus_balance:')
    || figure.window.startsWith('api_balance:')
    || figure.window.startsWith('gateway_unlimited:');
  const tone = remaining <= 10 ? 'bg-failed' : remaining <= 20 ? 'bg-waiting' : 'bg-success';
  return (
    <div className={cn('grid gap-1', className)}>
      <Note className="text-xs tabular-nums">{usageLine(figure)}</Note>
      {noBar ? null : (
        <span aria-hidden="true" className="block h-1.5 overflow-hidden rounded-full bg-muted">
          <span
            className={cn('block h-full rounded-full transition-[width] duration-200', tone)}
            style={{ width: `${remaining}%` }}
          />
        </span>
      )}
    </div>
  );
}
