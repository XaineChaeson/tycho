// One fixed, read-only view of this installation; it never opens a ledger or node identity.
import { autostartFor, type Role } from './autostart.ts';
import { installedSpec } from './install.ts';
import { prefixOf } from './paths.ts';
import { readRecord, slotOf } from './record.ts';
import type { System } from './system.ts';
import type { ServiceManagerReport } from '../shared/service-manager.ts';

export function observeServices(system: System, appRoot: string, requested: Role): ServiceManagerReport {
  const started = Date.now();
  const bounded: System = { ...system, exec(file, args, options = {}) {
    const remaining = 8_000 - (Date.now() - started);
    if (remaining <= 0) return { code: 124, stdout: '', stderr: 'service observation timeout' };
    return system.exec(file, args, { ...options, timeoutMs: Math.min(remaining, 1_500), maxBufferBytes: 32 * 1024 });
  } };
  const prefix = prefixOf(appRoot);
  const record = prefix === null ? null : readRecord(prefix);
  const roles: Role[] = (['host', 'node'] as const).filter(role => role === requested || slotOf(record, role) !== undefined);
  return { observed_at: new Date().toISOString(), services: roles.map(role => autostartFor(bounded, role).observe(installedSpec(bounded, appRoot, role))) };
}
