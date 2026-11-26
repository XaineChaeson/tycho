import type { MinVersion } from './types.ts';

// The first `x.y.z`, with its pre-release part, in a CLI's version line: `0.2.2-rc.1`,
// `codex-cli 0.163.0`, `2.1.312 (Claude Code)`.
const VERSION = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

export function versionOf(line: string): string | undefined {
  return VERSION.exec(line)?.[0];
}

// Semantic-version order: the numbers, then a pre-release below its release, its parts
// compared as numbers where both are numbers.
export function compareVersions(a: string, b: string): number {
  const [, ...left] = VERSION.exec(a) ?? [];
  const [, ...right] = VERSION.exec(b) ?? [];
  for (let at = 0; at < 3; at += 1) {
    const diff = Number(left[at] ?? 0) - Number(right[at] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  const [preA, preB] = [left[3], right[3]];
  if (preA === undefined || preB === undefined) return preA === preB ? 0 : preA === undefined ? 1 : -1;
  const partsA = preA.split('.');
  const partsB = preB.split('.');
  for (let at = 0; at < Math.max(partsA.length, partsB.length); at += 1) {
    const [x, y] = [partsA[at], partsB[at]];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    const diff = numeric ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0;
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

// Why the version a machine's command printed cannot run this program's commands, or nothing
// when it can — or when no version can be read out of the line: that decides nothing, and the
// read-only probe still asks the command itself.
export function tooOld(min: MinVersion, line: string): string | undefined {
  const version = versionOf(line);
  if (version === undefined || compareVersions(version, min.version) >= 0) return undefined;
  return `这一版用不了：${min.lacks}，升到 ${min.version} 以上`;
}
