import type { AccountsAndMachines } from './types.ts';
import type { LoginChoice } from './settings.ts';

// Only configured logins have an identity that can be selected or saved.
export const loginChoices = (page: Pick<AccountsAndMachines, 'accounts' | 'machines'> | undefined): LoginChoice[] => [
  ...(page?.accounts.map(({ id, name }) => ({ id, name })) ?? []),
  ...(page?.machines.flatMap((machine) => (machine.logins ?? []).flatMap((login) =>
    login.configured && login.id !== null ? [{ id: login.id, name: login.name, machine: machine.id, executor: login.executor, accountLabel: login.account_label, routeLabel: login.route_label }] : [])) ?? []),
];
