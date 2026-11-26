import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Processes, RouterLaunch, SessionHost, SessionHostOptions, TurnObserver } from '../service/session-host.ts';
import type { RouterKnowledge } from '../service/knowledge-brief.ts';
import type { LedgerOptions } from '../service/ledger.ts';
import { hostProcesses } from '../service/processes.ts';
import { createSessionHost, RouterUnavailable } from '../service/session-host.ts';
import { routerMaterial } from '../service/router-material.ts';
import { claudeTier, fixture, ROUTER_TUNED, tuned, USER } from './helpers.ts';

// A context of the fixture's project, as an earlier run of the service left it.
// The login the test Host runs as when bound to no account: this computer's own, as h1's.
export const hostLogin = (f: ReturnType<typeof fixture>): string => f.ledger.getMachineLogin('h1', 'claude')!.id;

export function openContext(f: ReturnType<typeof fixture>, marker: string, login: { loginId?: string } = {}) {
  const segment = f.ledger.ensureSegment(f.projectId);
  return f.ledger.openContext({ projectId: f.projectId, segmentId: segment.id, marker, launch: {}, knowledge: [], loginId: hostLogin(f), ...login });
}

export const TOKEN = 'oauth-token-of-the-router-account';

export const FAKE = join(import.meta.dirname, 'fake-claude.mjs');
// A CLI that is alive with its stdin closed. Node cannot play it on Windows, and a shell
// script cannot be started there, so each platform has its own.
export const NO_STDIN =
  process.platform === 'win32'
    ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(import.meta.dirname, 'fake-claude-no-stdin.ps1')]
    : ['sh', join(import.meta.dirname, 'fake-claude-no-stdin.sh')];
export const POSIX_ONLY = process.platform === 'win32' ? 'Windows 没有进程组，这条测的是 POSIX 的行为' : false;
export const TOOLS = ['list_tasks', 'get_project'];
export const MCP_TOOLS = TOOLS.map((name) => `mcp__tycho__${name}`);
export const options = { timeout: 60_000 };

export async function until<T>(read: () => T | undefined | false, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await sleep(20);
  }
}

export interface LogEntry {
  argv?: string[];
  cwd?: string;
  pid?: number;
  nested?: string[];
  config_dir?: string | null;
  marker_env?: string | null;
  git_optional_locks?: string | null;
  user?: string;
  control?: string;
  child?: number;
}

export const childPids = (entries: LogEntry[]): number[] => entries.flatMap(({ child }) => (child === undefined ? [] : [child]));

// What the ledger says of the barriers, for a test to raise and lower.
export type Barriers = { degraded: boolean; recovering: boolean };

export function setup(
  t: TestContext,
  env: Record<string, string> = {},
  { claude, tier, account, accountName, credentialRef, token, barriers, ledgerOptions, ...overrides }: Partial<SessionHostOptions> & Partial<RouterLaunch> & { barriers?: Barriers; ledgerOptions?: LedgerOptions } = {},
) {
  // Hooks run in the order they are added, and the fixture removes the directory the
  // CLI is running in, so the stop has to come first.
  let stop = async (): Promise<void> => {};
  const previous = { ...process.env };
  t.after(async () => {
    try {
      await stop();
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
      Object.assign(process.env, previous);
    }
  });
  const f = fixture(t, ledgerOptions);
  const logFile = join(f.dir, 'fake.log');
  Object.assign(process.env, {
    FAKE_CLAUDE_LOG: logFile,
    FAKE_CLAUDE_TOOLS: JSON.stringify(MCP_TOOLS),
    ...env,
    // These are what the host has to strip before a nested Claude will start.
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'outer',
  });
  const events: { event: string; data: any }[] = [];
  const logLines: string[] = [];
  const make = (extra: Partial<SessionHostOptions> = {}) =>
    createSessionHost({ ...ROUTER_TUNED,
      ledger: barriers ? { ...f.ledger, dispatchConditions: () => ({ ...f.ledger.dispatchConditions(), ...barriers }) } : f.ledger,
      dataDir: f.dir,
      launchWith: async () => ({
        claude: claude ?? [process.execPath, FAKE],
        tier: tier ?? claudeTier('tier.json'),
        ...(account ? { account } : {}),
        ...(accountName ? { accountName } : {}),
        ...(credentialRef ? { credentialRef } : {}),
        ...(token ? { token } : {}),
      }),
      toolNames: TOOLS,
      hostLogin: () => hostLogin(f),
      material: (projectId) => routerMaterial(f.ledger, projectId, 64 * 1024),
      publish: (event, data) => events.push({ event, data }),
      log: (line) => logLines.push(line),
      pollMs: 20,
      turnTimeoutMs: tuned('router.turnTimeoutMs'),
      ...overrides,
      ...extra,
    });
  const host = make();
  stop = host.stop;
  const send = (text: string, externalId: string = randomUUID()) =>
    f.ledger.receiveMessage({ channel: 'console', externalId, actor: 'user', text, projectId: f.projectId }).id;
  const state = (id: string) => f.ledger.getMessage(id).state;
  const settled = (id: string) =>
    until(() => (state(id) === 'processed' || state(id) === 'unverified') && state(id), `消息 ${id} 收尾`);
  const log = (): LogEntry[] =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as LogEntry)
      : [];
  const users = () => log().flatMap((entry) => (entry.user === undefined ? [] : [entry.user]));
  const starts = () => log().filter((entry) => entry.argv);
  const outbound = () => f.peek<{ id: string; text: string; final: number }>(`SELECT * FROM message WHERE direction = 'out'`);
  return { f, host, make, send, state, settled, log, users, starts, outbound, events, logLines };
}

export function admitted(host: SessionHost): string | undefined {
  const admission = host.admitTool(host.toolTokens()[0]);
  if ('refused' in admission) return undefined;
  admission.done();
  return admission.messageId;
}

// A session that exists, the way the last run of the service left it.
export function existingSession(f: ReturnType<typeof fixture>): string {
  const ref = randomUUID();
  const session = openContext(f, ref);
  f.ledger.setContextRef(session.id, ref);
  return ref;
}

// `claude` is read at every launch: the test swaps it to bring up a working process.
export function closedStdin(t: TestContext, env: Record<string, string> = {}, overrides: Partial<SessionHostOptions> = {}) {
  const claude = [...NO_STDIN];
  const context = setup(t, env, { claude, ...overrides });
  const closed = join(context.f.dir, 'stdin-closed');
  process.env.FAKE_CLAUDE_CLOSED = closed;
  return { ...context, claude, closedYet: () => until(() => existsSync(closed), 'stdin 已关闭') };
}


export const steady = (): Barriers => ({ degraded: false, recovering: false });
