// What a release is made of: every file of it, by path, with the sha256 of its bytes.
// scripts/pack.ts writes it into each package; the installer compares two of them before
// it takes a version already in place for a reinstall of the same program. A version
// number is a commit count, and two branches packed at the same count share one.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFEST = 'release.json';

type Files = Record<string, string>;

function walk(root: string, path: string, found: Files): void {
  for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
    const name = path === '' ? entry.name : `${path}/${entry.name}`;
    if (entry.isDirectory()) walk(root, name, found);
    else if (name !== MANIFEST) found[name] = createHash('sha256').update(readFileSync(join(root, name))).digest('hex');
  }
}

// Written over the directory as it stands: everything in it is the release.
export function writeManifest(dir: string): void {
  const files: Files = {};
  walk(dir, '', files);
  const sorted = Object.fromEntries(Object.keys(files).sort().map((name) => [name, files[name]!]));
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify({ files: sorted }, null, 2)}\n`);
}

// The files a release says it is made of, or null when it says nothing readable.
export function readManifest(dir: string): Files | null {
  try {
    const { files } = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as { files?: unknown };
    if (typeof files !== 'object' || files === null || Array.isArray(files)) return null;
    return Object.values(files).every((hash) => typeof hash === 'string') ? (files as Files) : null;
  } catch {
    return null;
  }
}

// Whether two directories hold the same release. One without a manifest cannot be told
// to be the same, so it is not.
export function sameRelease(a: string, b: string): boolean {
  const [left, right] = [readManifest(a), readManifest(b)];
  if (left === null || right === null) return false;
  const names = Object.keys(left);
  return names.length === Object.keys(right).length && names.every((name) => left[name] === right[name]);
}
