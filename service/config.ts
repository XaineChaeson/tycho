// What the service needs before it has a ledger to ask: where its data lives. Everything
// else is a setting or an object in the ledger, changed in the console.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { homePathOf } from './home-paths.ts';
import { LOOPBACK, WILDCARD } from './settings.ts';

// The same rule on every system, and the one place it is written: TYCHO_DATA is the one
// thing set outside the console. Always absolute, a relative TYCHO_DATA resolved where the
// caller stands: a service manager starts the service somewhere else, where the same
// words would name another directory.
export const dataDirOf = (env: NodeJS.ProcessEnv, home: string): string => resolve(homePathOf(env, home, 'TYCHO_DATA'));

export const dataDirFromEnv = (): string => dataDirOf(process.env, homedir());

// Makes the directory if it is not there.
export function prepareDataDir(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

// Written by the service at each start, read by `tycho open`.
export const loginTokenFile = (dataDir: string): string => join(dataDir, 'login-token');

// Written by the service at each start: where it listens, the token this machine's own
// commands show it, and which program it is. Read by the `tycho` command.
export const serviceFile = (dataDir: string): string => join(dataDir, 'service.json');

// The data directory's lock: the service and a restore take it, and the commands read who holds it.
export const lockFile = (dataDir: string): string => join(dataDir, 'lock');

// Who a running service is. A pid and a port say only that something runs and something
// listens; this is what the service itself answers, to a request carrying its token.
export interface Instance {
  pid: number;
  version: string;
  // The directory holding service/, cli/ and package.json that it runs from.
  program_dir: string;
  started_at: string;
}

// For this machine's own requests: /api/login-links answers the loopback only.
export const localUrl = (port: number, path: string): string => `http://${LOOPBACK}:${port}${path}`;

// A login link has to be opened where the cookie will be used.
export function loginUrl(http: { host: string; publicUrl: string }, port: number, path: string): string {
  if (http.publicUrl) return `${http.publicUrl}${path}`;
  return http.host === WILDCARD ? localUrl(port, path) : `http://${http.host}:${port}${path}`;
}
