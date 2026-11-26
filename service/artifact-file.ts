import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import type { ReleaseFile } from './releases.ts';
import { sameBytes } from './releases.ts';

// Read a file only while its size and digest still match the registration.
export function readBoundArtifact(path: string, file: ReleaseFile): Buffer | null {
  let fd: number | undefined;
  try {
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== file.bytes) return null;
    const body = Buffer.alloc(file.bytes);
    let offset = 0;
    while (offset < body.length) {
      const taken = readSync(fd, body, offset, body.length - offset, offset);
      if (taken === 0) return null;
      offset += taken;
    }
    return sameBytes(body, file) ? body : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
