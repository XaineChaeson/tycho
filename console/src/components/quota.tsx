// A login's quota windows as its executor last said them. The usage page shows them whole and
// can ask for them again; the accounts page shows the same figures and points there.
import { usageLine } from '@shared/labels.ts';
import type { LoginStatus } from '@shared/labels.ts';
import { Note } from '@/components/bits';
import { cn } from '@/lib/utils';

type Window = LoginStatus['usage'][number];

export const spentOf = (figure: Window): number => Math.min(100, Math.max(0, Math.round(figure.used * 100)));

// How much of a quota window is spent: the words carry the figure, the bar under them only
// makes a window that is running out quicker to find.
export function QuotaWindow({ figure, className }: { figure: Window; className?: string }) {
  const spent = spentOf(figure);
  const noBar = figure.window.startsWith('balance:')
    || figure.window.startsWith('bonus_balance:')
    || figure.window.startsWith('api_balance:')
    || figure.window.startsWith('gateway_unlimited:');
  return (
    <div className={cn('grid gap-1', className)}>
      <Note className="text-xs">{usageLine(figure)}</Note>
      {noBar ? null : (
        <span aria-hidden="true" className="block h-1 overflow-hidden rounded-full bg-muted">
          <span
            className={cn('block h-full rounded-full', spent >= 90 ? 'bg-failed' : spent >= 70 ? 'bg-waiting' : 'bg-muted-foreground')}
            style={{ width: `${spent}%` }}
          />
        </span>
      )}
    </div>
  );
}
