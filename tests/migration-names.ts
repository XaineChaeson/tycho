import type { Ledger } from '../service/ledger.ts';

// Old migration tests compare labels across eras; resolve them only on the test side.
export function migrationId(ledger: Pick<Ledger, 'listAccounts' | 'listMachineLogins'>, name: string): string {
  const found = [...ledger.listAccounts(), ...ledger.listMachineLogins()].find((login) => login.name === name);
  if (!found) throw new Error('No migrated login named ' + name);
  return found.id;
}
export function migrationNames(ledger: Pick<Ledger, 'listAccounts' | 'listMachineLogins'>, json: string): string[] {
  const names = new Map([...ledger.listAccounts(), ...ledger.listMachineLogins()].map(({ id, name }) => [id, name]));
  return (JSON.parse(json) as string[]).map((id) => names.get(id) ?? 'gone');
}
