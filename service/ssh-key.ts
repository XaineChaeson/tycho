// Whether a private key file is one ssh will accept. ssh refuses a key others can read:
// on Windows it walks the file's access list, elsewhere it looks at the mode bits. This
// only reports — nothing here changes a file, and the command that would is the caller's
// to show. Asked by the self-check, never on a path an execution takes.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

type KeyAccess =
  | { kind: 'ok' }
  | { kind: 'missing' }
  // Who else can read it, and the command that would leave nobody but the user the
  // service runs as.
  | { kind: 'open'; others: string[]; tighten: string }
  | { kind: 'unknown'; reason: string };

// What ssh's own check accepts on Windows beside the user it runs as: the built-in
// administrators, Local System, and TrustedInstaller. Its two-letter SDDL names are used
// because what those accounts are called depends on the language of the system.
const TRUSTED = new Set([
  'BA',
  'SY',
  'S-1-5-18',
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464',
]);

const run = (file: string, args: string[]): string => execFileSync(file, args, { encoding: 'utf8', windowsHide: true });

// The user the service runs as, as an account name and as a SID. Neither is invented: a
// system that will not say which SID is theirs leaves the answer to the name.
const accountName = (): string => {
  const { USERDOMAIN: domain, USERNAME: name } = process.env;
  return domain && name ? `${domain}\\${name}` : name ?? '';
};

function mySid(): string {
  try {
    // `whoami` prints one CSV row: the name, then the SID.
    const [, sid] = /^"[^"]*","([^"]*)"/.exec(run('whoami', ['/user', '/fo', 'csv', '/nh']).trim()) ?? [];
    return sid ?? '';
  } catch {
    return '';
  }
}

// One reading of a Windows file's access. Kept apart from running `icacls` so that the rule
// below is read, and tested, against what real systems print.
export interface WindowsAcl {
  // What `icacls <file>` printed.
  named: string;
  // What `icacls <file> /save <somewhere>` wrote, BOM and all.
  sddl: string;
  // The SID of the user the service runs as; empty when the system would not say.
  mine: string;
  // The name that user goes by.
  user: string;
}

// `icacls` prints one line per access entry: the account, then what it may do, in
// parentheses. An account it cannot name is left out, and only the rights are printed.
const ENTRY = /^(?:(.*?):)?((?:\([^)]*\))+)$/;

function entries(text: string, file: string): string[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const matched = ENTRY.exec(line.replace(file, '').trim());
    return matched ? [(matched[1] ?? '').trim()] : [];
  });
}

// The access list as SDDL, one entry per access-control entry, in the order the names above
// are in. `D:` opens the list ssh reads; `S:` would open the one it does not.
function accessList(sddl: string): { allow: boolean; sid: string }[] {
  const from = sddl.indexOf('D:');
  if (from < 0) return [];
  const to = sddl.indexOf('S:', from);
  return [...sddl.slice(from + 2, to < 0 ? undefined : to).matchAll(/\(([^)]*)\)/g)]
    .map(([, fields]) => fields.split(';'))
    .filter((fields) => fields.length >= 6)
    .map((fields) => ({ allow: fields[0]!.startsWith('A'), sid: fields.at(-1)! }));
}

// Who the access list lets read the file, the user it runs as aside. A SID that could not
// be named is shown as the SID: an account this machine cannot look up is still an account.
export function othersAllowed(file: string, { named, sddl, mine, user }: WindowsAcl): string[] {
  const names = entries(named, file);
  const me = user.toLowerCase();
  const isMine = (sid: string, name: string): boolean =>
    mine !== '' ? sid === mine : me !== '' && name.toLowerCase().split('\\').at(-1) === me;
  const others = accessList(sddl).flatMap(({ allow, sid }, index) => {
    const name = names[index] ?? '';
    return allow && !TRUSTED.has(sid) && !isMine(sid, name) ? [name || sid] : [];
  });
  return [...new Set(others)];
}

function windowsAccess(file: string, scratch: string): KeyAccess {
  const dump = join(scratch, `acl-${randomUUID()}.txt`);
  const tighten = `icacls "${file}" /inheritance:r /grant:r "${accountName() || '%USERNAME%'}:R"`;
  try {
    const named = run('icacls', [file]);
    run('icacls', [file, '/save', dump]);
    const sddl = readFileSync(dump, 'utf16le');
    // An access list that lets nobody in is not one ssh can read the key with either.
    if (accessList(sddl).length === 0) return { kind: 'open', others: ['所有账号（文件的访问列表是空的）'], tighten };
    const others = othersAllowed(file, { named, sddl, mine: mySid(), user: process.env.USERNAME ?? '' });
    return others.length === 0 ? { kind: 'ok' } : { kind: 'open', others, tighten };
  } catch (err) {
    return { kind: 'unknown', reason: (err as Error).message };
  } finally {
    rmSync(dump, { force: true });
  }
}

// What a POSIX mode grants, as ssh reads it: any bit at all for the group or for others.
export function modeAccess(mode: number, file: string): KeyAccess {
  const others = [
    ...(mode & 0o070 ? ['同一个用户组里的账号'] : []),
    ...(mode & 0o007 ? ['这台电脑上的其他账号'] : []),
  ];
  return others.length === 0 ? { kind: 'ok' } : { kind: 'open', others, tighten: `chmod 600 "${file}"` };
}

// `scratch` is where the read-only dump of the access list is written and removed again;
// never beside the key itself.
export function keyAccess(file: string, scratch: string): KeyAccess {
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat) return { kind: 'missing' };
  if (!stat.isFile()) return { kind: 'unknown', reason: `${file} 不是一个文件` };
  return process.platform === 'win32' ? windowsAccess(file, scratch) : modeAccess(stat.mode & 0o777, file);
}
