// Only the current installation's own service definitions are observed. This is
// diagnostic information, never authority to dispatch work or run another command.
import { localeMap, t } from './i18n.ts';
export interface ServiceObservation {
  role: 'host' | 'node';
  manager: 'systemd' | 'launchd' | 'windows-task' | 'startup' | 'unsupported';
  entry: string | null;
  installed: boolean | null;
  enabled: boolean | null;
  running: boolean | null;
  main_pid: number | null;
  problem?: { kind: 'permission_error' | 'unavailable' | 'unknown'; message: string };
}
export interface ServiceManagerReport {
  observed_at: string;
  services: ServiceObservation[];
}

export const observationProblem = (error: unknown): ServiceObservation['problem'] => {
  const text = error instanceof Error ? error.message : String(error);
  if (/permission|access.*denied|not permitted|拒绝|权限/i.test(text)) { // i18n-ignore
    return { kind: 'permission_error', message: t('sh.serviceManager.problem.permission') };
  }
  if (/bus|connect|not found|not available|ENOENT|timeout|timed out|ETIMEDOUT/i.test(text)) {
    return { kind: 'unavailable', message: t('sh.serviceManager.problem.unavailable') };
  }
  return { kind: 'unknown', message: t('sh.serviceManager.problem.unknown') };
};

// An optional, untrusted diagnostic must never fail a node's heartbeat. Discard
// unknown fields here; consumers receive only this normal form.
export function serviceManagerReport(value: unknown): ServiceManagerReport | undefined {
  if (value === undefined) return undefined;
  const invalid = (): ServiceManagerReport => ({ observed_at: new Date().toISOString(), services: [
    { role: 'node', manager: 'unsupported', entry: null, installed: null, enabled: null, running: null, main_pid: null,
      problem: { kind: 'unknown', message: t('sh.serviceManager.problem.unparseable') } },
  ] });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const raw = value as Record<string, unknown>;
  if (typeof raw.observed_at !== 'string' || raw.observed_at.length > 40 || !Number.isFinite(Date.parse(raw.observed_at))
    || !Array.isArray(raw.services) || raw.services.length > 2) return invalid();
  const seen = new Set<string>();
  const services: ServiceObservation[] = [];
  for (const each of raw.services) {
    if (!each || typeof each !== 'object' || Array.isArray(each)) return invalid();
    const item = each as Record<string, unknown>;
    if ((item.role !== 'host' && item.role !== 'node') || seen.has(item.role)
      || typeof item.manager !== 'string' || !['systemd', 'launchd', 'windows-task', 'startup', 'unsupported'].includes(item.manager)
      || !(item.entry === null || typeof item.entry === 'string' && /^[\w.-]{1,160}$/.test(item.entry))
      || !['installed', 'enabled', 'running'].every(key => item[key] === null || typeof item[key] === 'boolean')
      || !(item.main_pid === null || Number.isSafeInteger(item.main_pid) && (item.main_pid as number) > 0)) return invalid();
    seen.add(item.role);
    const result: ServiceObservation = { role: item.role, manager: item.manager as ServiceObservation['manager'],
      entry: item.entry as string | null, installed: item.installed as boolean | null,
      enabled: item.enabled as boolean | null, running: item.running as boolean | null, main_pid: item.main_pid as number | null };
    if (item.problem !== undefined) {
      const problem = item.problem as Record<string, unknown> | null;
      if (!problem || typeof problem.kind !== 'string' || !['permission_error', 'unavailable', 'unknown'].includes(problem.kind)) return invalid();
      // The classification is useful; arbitrary subprocess output is not a public message.
      result.problem = observationProblem(problem.kind === 'permission_error' ? 'permission denied'
        : problem.kind === 'unavailable' ? 'not available' : 'unknown');
    }
    services.push(result);
  }
  return { observed_at: raw.observed_at, services };
}

const SERVICE_MANAGER_LABELS: Readonly<Record<ServiceObservation['manager'], string>> = localeMap({
  systemd: 'sh.serviceManager.manager.systemd',
  launchd: 'sh.serviceManager.manager.launchd',
  'windows-task': 'sh.serviceManager.manager.windows-task',
  startup: 'sh.serviceManager.manager.startup',
  unsupported: 'sh.serviceManager.manager.unsupported',
});

export function serviceObservationText(service: ServiceObservation): string {
  const role = service.role === 'node' ? t('sh.serviceManager.role.node') : t('sh.serviceManager.role.host');
  const manager = SERVICE_MANAGER_LABELS[service.manager];
  const installed = service.installed === null
    ? t('sh.serviceManager.installed.unknown')
    : service.installed ? t('sh.serviceManager.installed.yes') : t('sh.serviceManager.installed.no');
  const running = service.running === null
    ? t('sh.serviceManager.running.unknown')
    : service.running ? t('sh.serviceManager.running.yes') : t('sh.serviceManager.running.no');
  const enabled = service.enabled === null
    ? ''
    : service.enabled ? t('sh.serviceManager.enabled.yes') : t('sh.serviceManager.enabled.no');
  const pid = service.main_pid === null ? '' : t('sh.serviceManager.pid', { pid: service.main_pid });
  const problem = service.problem ? t('sh.serviceManager.problemSuffix', { message: service.problem.message }) : '';
  return t('sh.serviceManager.summary', { role, manager, installed, running, enabled, pid, problem });
}
