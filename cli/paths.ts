import { homePathOf } from '../service/home-paths.ts';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { versionText } from '../shared/version.ts';

// Where the installer puts the program when it is not told otherwise.
export const defaultPrefix = (env: NodeJS.ProcessEnv, home: string): string => homePathOf(env, home, 'TYCHO_PREFIX');

export interface Layout {
  prefix: string;
  versions: string;
  // A text file naming the version in use. Not a symlink: Windows asks for a privilege.
  current: string;
  bin: string;
  // Present only when the installer had to bring its own Node.
  node: string;
  // What the installer put here and changed outside: the list an uninstall undoes.
  record: string;
  // The record exactly as it was before an upgrade rewrote it, kept while the new version
  // proves itself: a rollback puts it back with the program, so the version it goes back
  // to reads a record of its own shape. Gone once the upgrade has settled either way.
  recordBefore: string;
  // Held by the one install, upgrade or uninstall at work in this prefix.
  lock: string;
}

export const layoutOf = (prefix: string): Layout => ({
  prefix,
  versions: join(prefix, 'versions'),
  current: join(prefix, 'current'),
  bin: join(prefix, 'bin'),
  node: join(prefix, 'node'),
  record: join(prefix, 'install.json'),
  recordBefore: join(prefix, 'install.json.before-upgrade'),
  lock: join(prefix, 'install.lock'),
});

// A version becomes a directory name and is read back by two shell launchers.
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
export const isVersion = (value: unknown): value is string => typeof value === 'string' && VERSION.test(value);

const NAME = 'tycho';

interface Package {
  name?: unknown;
  version?: unknown;
  engines?: { node?: unknown };
}

const packageOf = (appRoot: string): Package => JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as Package;

export function appVersion(appRoot: string): string {
  const { version } = packageOf(appRoot);
  if (!isVersion(version)) throw new Error(`${join(appRoot, 'package.json')} 里的版本号不能用：${String(version)}`);
  return version;
}

// The version of the release unpacked in this directory, or null when it is not one of
// this program's: what tells a version directory the installer made from a directory
// that merely has a version for a name.
export function releaseVersion(dir: string): string | null {
  try {
    const { name, version } = packageOf(dir);
    return name === NAME && isVersion(version) ? version : null;
  } catch {
    return null;
  }
}

// The oldest Node this release runs on. package.json's `engines` is the one place it is
// written: the install scripts read it from the unpacked release, and so does this.
export function requiredNode(appRoot: string): string {
  const range = packageOf(appRoot).engines?.node;
  const found = typeof range === 'string' ? /^>=\s*(\d+(?:\.\d+){0,2})$/.exec(range.trim()) : null;
  if (!found) throw new Error(`${join(appRoot, 'package.json')} 的 engines.node 应为 >=主.次.修订：${String(range)}`);
  return found[1]!;
}

const numbers = (version: string): number[] => {
  const [major = 0, minor = 0, patch = 0] = version.replace(/^v/, '').split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  return [major, minor, patch];
};

// Whether a Node of this version is at least the required one.
export function nodeIsEnough(version: string, required: string): boolean {
  const [have, need] = [numbers(version), numbers(required)];
  for (let at = 0; at < 3; at += 1) if (have[at] !== need[at]) return have[at]! > need[at]!;
  return true;
}

// An installed copy sits at <prefix>/versions/<version>. Anything else is a source
// checkout, which has no prefix to upgrade or remove.
export function prefixOf(appRoot: string): string | null {
  const versions = dirname(appRoot);
  return basename(versions) === 'versions' ? dirname(versions) : null;
}

// Whether the program in this directory is an installed release: loaded from
// <prefix>/versions/<its own version>, where only the installer puts one.
const installedAs = (appRoot: string, version: string): boolean => prefixOf(appRoot) !== null && basename(appRoot) === version;

// The version of the program in this directory as the owner reads it.
export const shownVersion = (appRoot: string, version: string = appVersion(appRoot)): string => versionText(version, installedAs(appRoot, version));

export function readCurrent(prefix: string): string | null {
  try {
    const version = readFileSync(layoutOf(prefix).current, 'utf8').trim();
    return isVersion(version) ? version : null;
  } catch {
    return null;
  }
}
