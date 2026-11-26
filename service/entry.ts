// Whether a module is the script Node was started with. Not import.meta.main: before
// Node 24.3 that is false for a .ts entry, and a script that asks it does nothing and
// exits 0 — `npm run restore` would look done.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { nodeIsEnough, requiredNode } from '../cli/paths.ts';

export function startedAs(file: string): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync.native(process.argv[1]) === realpathSync.native(file);
  } catch {
    return false;
  }
}

// The same, for an entry with nothing useful to do on a Node older than package.json
// asks for: it says so and exits 1.
export function isEntry(file: string): boolean {
  if (!startedAs(file)) return false;
  const required = requiredNode(join(import.meta.dirname, '..'));
  if (nodeIsEnough(process.versions.node, required)) return true;
  console.error(`这个程序需要 Node ${required} 或更新的，现在是 ${process.versions.node}（${process.execPath}）。`);
  process.exit(1);
}
