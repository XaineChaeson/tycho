// The poll loop never waits for the service manager. A fixed CLI child owns the
// synchronous OS queries, with one in flight and a bounded result; no host request
// can supply its executable, arguments, environment or service name.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { observationProblem, serviceManagerReport, type ServiceManagerReport } from '../shared/service-manager.ts';

export function createServiceObserver(appRoot: string, options: {
  read?: () => Promise<unknown>;
  now?: () => number;
} = {}) {
  const now = options.now ?? Date.now;
  let held: ServiceManagerReport | undefined;
  let checking: Promise<void> | undefined;
  let next = 0;
  let closed = false;
  let child: ReturnType<typeof execFile> | undefined;
  const read = options.read ?? (() => new Promise<unknown>((resolve, reject) => {
    child = execFile(process.execPath, [join(appRoot, 'cli', 'main.ts'), 'node', 'service', 'status', '--json'], {
      timeout: 10_000, maxBuffer: 32 * 1024, windowsHide: true, encoding: 'utf8',
    }, (error, stdout) => {
      child = undefined;
      if (error) reject(error);
      else { try { resolve(JSON.parse(stdout)); } catch (problem) { reject(problem); } }
    });
  }));
  return {
    report(): ServiceManagerReport | undefined {
      if (!closed && !checking && now() >= next) {
        next = now() + 60_000;
        checking = Promise.resolve().then(read).then(value => { held = serviceManagerReport(value); })
          .catch(error => { held = { observed_at: new Date(now()).toISOString(), services: [
            { role: 'node', manager: 'unsupported', entry: null, installed: null, enabled: null, running: null, main_pid: null, problem: observationProblem(error) },
          ] }; }).finally(() => { checking = undefined; });
      }
      return held;
    },
    close() { closed = true; child?.kill(); },
  };
}
