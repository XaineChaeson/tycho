// Machines join by themselves (docs/design/nodes.md §1.1): their name, hostname and identity
// come from their own client. What the owner writes about one is its note; removing one is
// revoking it.
import type { MachineStore } from '../runner/snapshot.ts';
import type { Ctx, Ledger, MachineRecord } from './ledger.ts';
import { DegradedError, InputError } from './errors.ts';

const NOTE_CHARS = 200;

export function createMachines({ ledger }: { ledger: Pick<Ledger, 'getMachine' | 'listMachines' | 'setMachineNote' | 'deleteMachine' | 'dispatchConditions'> }) {
  // The console and the Router's tools both write through here, so the owner's rule that
  // what the service is set up with stands until an inventory is done is kept here once,
  // rather than beside each caller. Reads stay open: an inventory reads, it does not write.
  function steady(): void {
    if (ledger.dispatchConditions().recovering) throw new DegradedError('服务正在恢复清点，现在不能改机器');
  }
  return {
    get: (id: string): MachineRecord | undefined => ledger.getMachine(id),
    list: (): MachineRecord[] => ledger.listMachines(),
    setNote(id: string, note: unknown, ctx: Ctx): MachineRecord {
      if (note !== null && typeof note !== 'string') throw new InputError('备注应为文字');
      if (typeof note === 'string' && note.trim().length > NOTE_CHARS) throw new InputError(`备注最多 ${NOTE_CHARS} 个字`);
      steady();
      ledger.setMachineNote(id, note, ctx);
      return ledger.getMachine(id)!;
    },
    remove(id: string, ctx: Ctx, options: { confirmed?: boolean } = {}): void {
      steady();
      ledger.deleteMachine(id, ctx, options);
    },
  } satisfies MachineStore & Record<string, unknown>;
}
export type Machines = ReturnType<typeof createMachines>;
