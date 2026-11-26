// Whether a machine can take a round of one executor, by what that machine last reported of
// itself. Only a missing installation blocks dispatch; minVersion, credentialCheck, and
// checks_code probes are advisory and never block task dispatch.
import type { CredentialCheck, ExecutorDeclarations, MinVersion } from '../adapters/types.ts';
import { readOnlyMissingText } from '../shared/roles.ts';
import type { NodeExecutorStatus, ReportedStatus } from '../shared/node-protocol.ts';

export type Reported = (machineId: string, executor: string) => ReportedStatus | null;

// Only an uninstalled executor blocks dispatch. minVersion / status.unusable are advisory only.
export function unusableHere(status: NodeExecutorStatus | null, _min?: MinVersion): string | undefined {
  if (status === null) return undefined;
  if (!status.installed) return '没装';
  return undefined;
}

// Read-only dispatch only checks that the executor is installed (never blocks on checks_code
// or legacy read_only probe fields).
export function readOnlyHere(status: NodeExecutorStatus | null, min?: MinVersion): { ok: true } | { ok: false; why: string; settled: boolean } {
  const unusable = unusableHere(status, min);
  if (unusable !== undefined) return { ok: false, why: unusable, settled: true };
  return { ok: true };
}

type CredentialDeclarations = Pick<ExecutorDeclarations, 'minVersion' | 'credentialCheck'>;

export function asksAboutToken(
  declarations: CredentialDeclarations | undefined,
): declarations is CredentialDeclarations & { credentialCheck: CredentialCheck } {
  return declarations?.credentialCheck !== undefined;
}

// Credential adoption probe is advisory only: never blocks task dispatch when the executor is installed.
export function accountHere(
  status: NodeExecutorStatus | null,
  declarations: CredentialDeclarations | undefined,
): { ok: true; advisory?: string } | { ok: false; why: string; settled: boolean } {
  const unusable = unusableHere(status, declarations?.minVersion);
  if (unusable !== undefined) return { ok: false, why: unusable, settled: true };
  if (asksAboutToken(declarations) && status?.credential && !status.credential.adopted) {
    return { ok: true, advisory: `账号的令牌在这台机器上可能不会被采用：${status.credential.error ?? '没说原因'}` };
  }
  return { ok: true };
}

export const ownLoginHere = (status: NodeExecutorStatus | null): boolean =>
  status !== null && unusableHere(status) === undefined && status.logged_in !== false;

export interface RoundNeed {
  readOnly: boolean;
  account?: boolean;
}

export const fitsHere = (
  status: NodeExecutorStatus | null,
  need: RoundNeed,
  declarations?: CredentialDeclarations,
): boolean =>
  unusableHere(status, declarations?.minVersion) === undefined
  && (!need.readOnly || readOnlyHere(status, declarations?.minVersion).ok)
  && (!need.account || accountHere(status, declarations).ok);

export function readOnlyRefusal(
  login: { name: string; executor: string },
  executors: Readonly<Record<string, Pick<ExecutorDeclarations, 'readOnly'>>>,
): string | undefined {
  return executors[login.executor] !== undefined ? undefined : readOnlyMissingText(login.name, login.executor);
}
