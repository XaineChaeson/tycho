// What a release archive holds, looked at before it is unpacked. Not left to tar: what it
// refuses differs from one tar and one version to the next, and by the time it refuses
// something an earlier member may already be on disk. install/install.sh and
// install/install.ps1 make the same check in their own languages, before any of this
// code exists on the machine.
import type { System } from './system.ts';
import { said, tool } from './system.ts';

const lines = (text: string): string[] => text.split(/\r?\n/).filter((line) => line !== '');

// A member that would be written somewhere other than under the directory unpacked
// into: an absolute name, a drive letter, a ".." on the way, or a backslash, which
// Windows reads as a separator (and both tars print for any character they escape).
const escapes = (name: string): boolean =>
  name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\\') || name.split('/').includes('..');

// Null when every member is a plain file or a directory and lands inside the directory
// the archive is unpacked into; otherwise what is wrong, in words for the owner.
// `archive` is named relative to `cwd`: the tar that ships with Windows takes its
// arguments in the system code page, and GNU tar reads a colon as a remote host.
export function archiveProblem(system: Pick<System, 'exec' | 'platform' | 'env'>, archive: string, cwd: string): string | null {
  const tar = tool(system, 'tar');
  const names = system.exec(tar, ['-tzf', archive], { cwd });
  if (names.code !== 0) return `读不出包里有什么（它不是 .tar.gz，或者已经损坏）：${said(names)}`;
  const members = lines(names.stdout);
  const outside = members.find(escapes);
  if (outside !== undefined) return `包里有会落到解包目录之外的成员：${outside}`;

  // The first character of each line is the member's type, in GNU tar and bsdtar
  // alike: - a plain file, d a directory, l a symbolic link, h a hard link.
  const kinds = system.exec(tar, ['-tzvf', archive], { cwd });
  if (kinds.code !== 0) return `读不出包里有什么（它不是 .tar.gz，或者已经损坏）：${said(kinds)}`;
  const listed = lines(kinds.stdout);
  const odd = listed.findIndex((line) => !/^[-d]/.test(line));
  if (odd === -1) return null;
  // By its place in the first listing when the two agree: the rest of this line is
  // dates in the console's code page.
  const shown = listed.length === members.length ? members[odd]! : listed[odd]!;
  return `包里有不是普通文件或目录的成员（符号链接、硬链接或特殊文件）：${shown}`;
}
