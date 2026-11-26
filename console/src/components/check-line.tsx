// What a connection test said, beside the login it was about: on the accounts page, the
// machines an account can reach; on the machines page, the one machine a check was about.
import { Dot } from '@/components/bits';
import { checkFine, checkLine } from '@/lib/accounts';
import type { MachineCheck } from '@/lib/types';
import { cn } from '@/lib/utils';

export function CheckLine({ answer }: { answer: MachineCheck }) {
  const fine = checkFine(answer);
  return (
    <span className={cn('text-sm wrap-anywhere', fine ? 'text-muted-foreground' : 'text-destructive')}>
      <Dot tone={fine ? 'success' : 'failed'} className="mr-1.5 align-middle" />
      {checkLine(answer)}
    </span>
  );
}
