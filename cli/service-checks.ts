// The service's own self-check, brought into `tycho doctor`. A running service is asked:
// it knows its settings, its Router and its machines. With none running the ledger is
// read, without creating or migrating anything, and the same check functions the service
// uses are given what can be known that way; what only a running service knows is shown
// as not known. No HTTP handling, ledger reading or check rule is copied here.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ADAPTERS } from '../adapters/all.ts';
import { createAccounts } from '../service/accounts.ts';
import { inspectClaude } from '../service/claude-cli.ts';
import type { DoctorCheck } from '../service/doctor.ts';
import { doctor as serviceDoctorChecks } from '../service/doctor.ts';
import { openLedger } from '../service/ledger.ts';
import { elsewhereText } from '../service/lock.ts';
import { readSecret, wecomSecretFile } from '../service/secrets.ts';
import { serviceSettings } from '../service/service-settings.ts';
import { routerEnv } from '../service/session-host.ts';
import type { Check } from './doctor.ts';
import type { ServiceState } from './service-client.ts';
import { consoleUrl, serviceDoctor } from './service-client.ts';
import { lockFile } from '../service/config.ts';

// Answered by the command itself, for the Node and the data directory it was given.
const OWN = new Set(['node', 'data-dir']);
// What only a running service knows: its Router process, and what it has learned of the machines.
const runtimeOnly = (id: string): boolean => id === 'router' || id.startsWith('login:');

// `console` is where the running service's console is; null when there is none to open.
function shown({ title, level, text, fix }: DoctorCheck, console: string | null): Check {
  if (level === 'ok' || fix === null) return { title, level, detail: text };
  return { title, level, detail: text, fix: console === null ? `启动服务后在控制台里处理：${fix.label}。` : `在控制台里处理（${fix.label}）：${console}/${fix.href}` };
}

export async function serviceChecks(dataDir: string, service: ServiceState, inspect = inspectClaude): Promise<Check[]> {
  if (service.state === 'running') {
    const checks = await serviceDoctor(service);
    return checks.filter(({ id }) => !OWN.has(id)).map((check) => shown(check, consoleUrl(service.port)));
  }
  const file = join(dataDir, 'ledger.db');
  if (!existsSync(file)) {
    return [{ title: '服务的配置', level: 'warn', detail: `还没有初始化：${dataDir} 里没有账本。`, fix: '运行 tycho run，然后在控制台里配置。' }];
  }
  if (service.state === 'held') {
    return [{
      title: '服务的配置',
      level: 'unknown',
      detail: service.elsewhere === undefined
        ? `数据目录正被进程 ${service.pid} 占着（服务在启动，或正在恢复备份），这时不去读账本。等它结束再查。`
        : `数据目录的锁在另一台机器上，本机读不了账本。${elsewhereText(lockFile(dataDir), service.elsewhere)}`,
    }];
  }
  let ledger: ReturnType<typeof openLedger>;
  try {
    ledger = openLedger(file, { readOnly: true });
  } catch (err) {
    return [{
      title: '账本',
      level: 'warn',
      detail: `账本没有读：${(err as Error).message}。自检只读它，不升级也不改它。`,
      fix: '账本比程序旧：运行一次 tycho run，服务启动时会升级它。账本比程序新：运行 tycho update。',
    }];
  }
  try {
    const settings = serviceSettings({ ledger, dataDir, log: () => {} });
    // The account the Router is bound to, read the way the service reads it, so the login
    // checked here is the one it would start with. Which executors take a token and which
    // can be the Router is their own declaration, not a name written here.
    const executors = ADAPTERS;
    const accounts = createAccounts({
      ledger,
      executors,
      credentialExecutors: Object.entries(executors).filter(([, each]) => each.credential).map(([id]) => id),
      routingExecutors: Object.entries(executors).filter(([, each]) => each.canRoute).map(([id]) => id),
      dataDir,
      log: () => {},
    });
    const account = settings.get('router.account');
    const bound = account === '' ? undefined : accounts.get(account);
    const credential = account === '' ? undefined : accounts.credentialOf(account);
    // The two account-and-project facts the ledger can answer without the service: logins
    // expected to run out, and projects with no usable login left. Read here rather than
    // invented, so the offline check says what the running service would.
    const checks = serviceDoctorChecks({
      dataDir,
      settings,
      claude: await inspect(settings.get('router.cli'), routerEnv(undefined, credential?.value ?? '')),
      logins: [...ledger.listAccounts(), ...ledger.listMachineLogins()],
      routerLogin: { account, token: credential !== undefined },
      expiringLogins: ledger.expiringAccounts(new Date()),
      projectsWithoutLogins: ledger.projectsWithoutLogins(),
      wecomSecretSet: readSecret(wecomSecretFile(dataDir)) !== '',
    });
    return checks
      .filter(({ id }) => !OWN.has(id))
      .map((check) => (runtimeOnly(check.id) ? { title: check.title, level: 'unknown', detail: '服务没在跑，不知道。' } : shown(check, null)));
  } finally {
    ledger.close();
  }
}
