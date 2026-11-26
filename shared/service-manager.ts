// Only the current installation's own service definitions are observed. This is
// diagnostic information, never authority to dispatch work or run another command.
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
  if (/permission|access.*denied|not permitted|拒绝|权限/i.test(text)) {
    return { kind: 'permission_error', message: '当前用户无权读取系统服务状态' };
  }
  if (/bus|connect|not found|not available|ENOENT|timeout|timed out|ETIMEDOUT/i.test(text)) {
    return { kind: 'unavailable', message: '系统服务管理器不可达、未提供或查询超时' };
  }
  return { kind: 'unknown', message: '未能核实系统服务状态' };
};

// An optional, untrusted diagnostic must never fail a node's heartbeat. Discard
// unknown fields here; consumers receive only this normal form.
export function serviceManagerReport(value: unknown): ServiceManagerReport | undefined {
  if (value === undefined) return undefined;
  const invalid = (): ServiceManagerReport => ({ observed_at: new Date().toISOString(), services: [
    { role: 'node', manager: 'unsupported', entry: null, installed: null, enabled: null, running: null, main_pid: null,
      problem: { kind: 'unknown', message: '机器报告的系统服务状态无法解析' } },
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

export function serviceObservationText(service: ServiceObservation): string {
  const role = service.role === 'node' ? '节点客户端' : '主服务';
  const manager = { systemd: 'systemd', launchd: 'launchd', 'windows-task': '计划任务', startup: '启动文件夹', unsupported: '系统服务' }[service.manager];
  const installed = service.installed === null ? '安装状态未知' : service.installed ? '已安装' : '未安装';
  const running = service.running === null ? '运行状态未知' : service.running ? '运行中' : '未运行';
  const enabled = service.enabled === null ? '' : service.enabled ? '，已启用自启' : '，未启用自启';
  return `${role} · ${manager}：${installed}，${running}${enabled}${service.main_pid === null ? '' : `，PID ${service.main_pid}`}${service.problem ? `；${service.problem.message}` : ''}`;
}
