// Writes a .tar.gz by hand, for the archives no honest tar will produce: a member that
// climbs out with "..", an absolute or drive-letter name, a symbolic link, a hard link.
import { gzipSync } from 'node:zlib';

export interface Member {
  name: string;
  type?: 'file' | 'dir' | 'symlink' | 'hardlink';
  content?: string;
  // What a link points at.
  link?: string;
}

const TYPE_FLAG = { file: '0', hardlink: '1', symlink: '2', dir: '5' } as const;

function header({ name, type = 'file', content = '', link = '' }: Member): Buffer {
  const block = Buffer.alloc(512);
  const octal = (value: number, width: number): string => value.toString(8).padStart(width - 1, '0');
  // Silently cut short, a name would point somewhere the test never meant.
  for (const field of [name, link]) {
    if (Buffer.byteLength(field) > 100) throw new Error(`名字超过 tar 头的 100 字节：${field}`);
  }
  block.write(name, 0, 100, 'utf8');
  block.write(octal(type === 'dir' ? 0o755 : 0o644, 8), 100, 'ascii');
  block.write(octal(0, 8), 108, 'ascii');
  block.write(octal(0, 8), 116, 'ascii');
  block.write(octal(type === 'file' ? Buffer.byteLength(content) : 0, 12), 124, 'ascii');
  block.write(octal(0, 12), 136, 'ascii');
  // The checksum is taken with its own field read as spaces.
  block.fill(' ', 148, 156);
  block.write(TYPE_FLAG[type], 156, 'ascii');
  block.write(link, 157, 100, 'utf8');
  block.write('ustar\0', 257, 'binary');
  block.write('00', 263, 'ascii');
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

export function tarGz(members: Member[]): Buffer {
  const blocks: Buffer[] = [];
  for (const member of members) {
    blocks.push(header(member));
    if ((member.type ?? 'file') !== 'file') continue;
    const body = Buffer.from(member.content ?? '', 'utf8');
    blocks.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  // Two empty blocks end an archive.
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

// A release in outline: enough for an installer to take it for one if it were unpacked.
const RELEASE: Member[] = [
  { name: 'package.json', content: '{"name":"tycho","version":"66.0.0","engines":{"node":">=24"}}' },
  { name: 'cli/', type: 'dir' },
  { name: 'cli/main.ts', content: '' },
];

export type Hostile = 'dotdot' | 'absolute' | 'drive' | 'symlink' | 'hardlink';

// The five ways an archive reaches past the directory it is unpacked into, each added to
// what would otherwise pass for a release. `outside` is an absolute directory, with forward
// slashes, holding sentinel.txt: where a tar that obeyed would write.
export function hostileArchives(outside: string): Record<Hostile, Buffer> {
  // Without its drive, an absolute name on the current drive.
  const rooted = outside.replace(/^[A-Za-z]:/, '');
  const members: Record<Hostile, Member[]> = {
    dotdot: [{ name: '../dotdot.txt', content: 'out' }],
    absolute: [{ name: `${rooted}/absolute.txt`, content: 'out' }],
    // Where there are no drives this is only an odd name, refused all the same.
    drive: [{ name: /^[A-Za-z]:/.test(outside) ? `${outside}/drive.txt` : 'C:/drive.txt', content: 'out' }],
    symlink: [{ name: 'link', type: 'symlink', link: outside }, { name: 'link/symlink.txt', content: 'out' }],
    hardlink: [{ name: 'hard', type: 'hardlink', link: `${outside}/sentinel.txt` }, { name: 'hard', content: 'out' }],
  };
  return Object.fromEntries(Object.entries(members).map(([kind, extra]) => [kind, tarGz([...RELEASE, ...extra])])) as Record<Hostile, Buffer>;
}

export const plainArchive = (): Buffer => tarGz(RELEASE);
