// Every login a round can run as, in one store (docs/design/accounts-machines-decoupled.md):
// the accounts tycho keeps, and each machine's own login of an executor. The dispatcher, the
// Runner, the tools and the pages ask this one store by login id; what an account is and what
// a machine's login is are decided where each is kept — service/accounts.ts and the ledger.
import type { Executors } from '../adapters/types.ts';
import type { Account, Login, LoginStore } from '../runner/snapshot.ts';
import type { Accounts } from './accounts.ts';
import { checkLoginSettings, type LoginSettingsInput } from './accounts.ts';
import { InputError } from './errors.ts';
import type { Ctx, Ledger, MachineLoginRecord } from './ledger.ts';

interface LoginsOptions {
  ledger: Pick<Ledger, 'getMachineLoginById' | 'listMachineLogins' | 'getMachineLogin' | 'putMachineLogin' | 'deleteMachineLogin' | 'getMachine'>;
  accounts: Pick<Accounts, 'get' | 'list'>;
  executors: Executors;
}

export function createLogins({ ledger, accounts, executors }: LoginsOptions) {
  const strip = ({ created_at: _made, updated_at: _changed, ...login }: MachineLoginRecord): Login => login;
  return {
    get(id: string): Login | undefined {
      const account = accounts.get(id);
      if (account) return account;
      const login = ledger.getMachineLoginById(id);
      return login && strip(login);
    },
    list(): Login[] {
      return [...accounts.list(), ...ledger.listMachineLogins().map(strip)];
    },
    accounts: (): Account[] => accounts.list(),
    machineLogins: (): MachineLoginRecord[] => ledger.listMachineLogins(),

    // The settings of a machine's own login of one executor, checked the way an account's are.
    // The machine is one the ledger holds; whether it is signed in there is its own report.
    putMachineLogin(machine: string, executor: string, input: LoginSettingsInput, ctx: Ctx): { login: MachineLoginRecord; created: boolean } {
      if (!ledger.getMachine(machine)) throw new InputError('机器不存在：' + machine);
      if (!Object.hasOwn(executors, executor)) throw new InputError(`没有执行器 ${executor} 的适配器，可选：${Object.keys(executors).join('、')}`);
      const settings = checkLoginSettings(executor, input, executors);
      const { created } = ledger.putMachineLogin({ executor, machine, ...settings }, ctx);
      return { login: ledger.getMachineLogin(machine, executor)!, created };
    },
    // The projects it was removed from come back, with what each has left (native-login.md §2).
    removeMachineLogin(machine: string, executor: string, ctx: Ctx): { projects: { id: string; name: string; remaining: number }[] } {
      return ledger.deleteMachineLogin(machine, executor, ctx);
    },
  } satisfies LoginStore & Record<string, unknown>;
}

export type Logins = ReturnType<typeof createLogins>;
