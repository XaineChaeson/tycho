// The host's own release, as a machine's client fetches it (docs/design/nodes.md §1.4): the
// version this host runs, and a package for it packed out of this host's version directory.
// The client asks for it on the two frozen routes (shared/node-protocol.ts), which take no
// protocol version, and installs it with the same `tycho update --from` the owner would run.
//
// The package is the version directory as the installer unpacked it, so its layout is the one
// `update --from` already accepts: cli/main.ts and package.json at the archive's root. It is
// packed once per version, into <data dir>/node-release/<version>.tar.gz, and the bytes and
// digest answered from that file.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { appVersion, layoutOf, prefixOf } from '../cli/paths.ts';
import type { System } from '../cli/system.ts';
import { tool } from '../cli/system.ts';
import type { NodeReleaseAnswer } from '../shared/node-protocol.ts';

export interface ReleasePackage {
  version: string;
  sha256: string;
  bytes: number;
  file: string;
}

export interface NodeReleases {
  // What the client is told: this version, the package (null with why), and how long to wait.
  answer(): Promise<NodeReleaseAnswer>;
  // The bytes, for the route beside that one. Null with why when there is nothing to give.
  package(): Promise<ReleasePackage | { why: string }>;
}

export interface NodeReleaseOptions {
  // The version directory this host itself runs from (the program directory, nodes.md §10).
  appRoot: string;
  dataDir: string;
  system: Pick<System, 'platform' | 'env' | 'exec'>;
  // The setting node.releaseCheckMs, read at each answer so a change reaches the next ask.
  checkEveryMs: () => number;
  log?: (line: string) => void;
}

const cacheName = (version: string): string => `${version}.tar.gz`;
const sha256Of = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

export function createNodeReleases(options: NodeReleaseOptions): NodeReleases {
  const { system } = options;
  const log = options.log ?? ((line: string) => console.error(line));
  const version = appVersion(options.appRoot);
  const prefix = prefixOf(options.appRoot);
  const cacheDir = join(options.dataDir, 'node-release');
  const cacheFile = join(cacheDir, cacheName(version));
  // A host that is not an installed copy has nothing to hand out: there is no version
  // directory to pack, only a source checkout (nodes.md §1.4).
  let why: string | null = prefix === null ? '主机从源码目录运行，没有可下发的发布包' : null;
  let built: ReleasePackage | null = null;
  let building: Promise<ReleasePackage | null> | null = null;

  function existing(): ReleasePackage | null {
    try {
      const stat = statSync(cacheFile);
      if (!stat.isFile() || stat.size === 0) return null;
      return { version, file: cacheFile, bytes: stat.size, sha256: sha256Of(cacheFile) };
    } catch {
      return null;
    }
  }

  // Packed beside the version directory and moved in, for the same reason `update` unpacks
  // there: the Windows tar reads its arguments in the system code page, and only names that
  // are this version's own survive every one of them.
  function pack(): ReleasePackage | null {
    if (prefix === null) return null;
    why = null;
    const layout = layoutOf(prefix);
    const temp = join(layout.versions, `.release-${process.pid}-${Date.now().toString(36)}.tar.gz`);
    try {
      mkdirSync(cacheDir, { recursive: true });
      // Nothing of tar's output is needed on the way through: what matters is the file it
      // leaves, and the reason it gave when it could not make one is its exit code. Asking
      // for no pipes also keeps this working where a machine refuses them.
      const packed = system.exec(tool(system, 'tar'), ['-czf', basename(temp), '-C', version, '.'], { cwd: layout.versions, stdio: 'ignore' });
      if (packed.code !== 0) {
        why = `打发布包失败：tar 退出码 ${packed.code}${packed.stderr.trim() === '' ? '' : `：${packed.stderr.trim()}`}`;
        return null;
      }
      if (!existsSync(temp)) {
        why = '打发布包失败：tar 没有写出包';
        return null;
      }
      // The cache holds this version only: a package for the version before it is no use to
      // any client that is being told this one (nodes.md §1.4).
      rmSync(cacheFile, { force: true });
      try {
        renameSync(temp, cacheFile);
      } catch {
        // Another volume, or a file held for a moment: copy it and drop the temporary name.
        copyFileSync(temp, cacheFile);
        rmSync(temp, { force: true });
      }
      const other = readdirSync(cacheDir).filter((name) => name !== cacheName(version) && !name.startsWith('.'));
      for (const name of other) rmSync(join(cacheDir, name), { force: true, recursive: true });
      const bytes = statSync(cacheFile).size;
      if (bytes === 0) {
        why = '打发布包失败：包是空的';
        return null;
      }
      return { version, file: cacheFile, bytes, sha256: sha256Of(cacheFile) };
    } catch (err) {
      why = `打发布包失败：${(err as Error).message}`;
      return null;
    } finally {
      rmSync(temp, { force: true });
    }
  }

  async function ensure(): Promise<ReleasePackage | null> {
    if (built !== null) return built;
    if (prefix === null) return null;
    const held = existing();
    if (held !== null) {
      built = held;
      return held;
    }
    building ??= Promise.resolve()
      .then(() => {
        const made = pack();
        if (made !== null) built = made;
        else if (why !== null) log(`没有可下发给机器的发布包：${why}`);
        return made;
      })
      .finally(() => {
        building = null;
      });
    return building;
  }

  return {
    async answer(): Promise<NodeReleaseAnswer> {
      const pkg = await ensure();
      return {
        version,
        package: pkg === null ? null : { sha256: pkg.sha256, bytes: pkg.bytes },
        why: pkg === null ? (why ?? '这台主机没有可下发的发布包') : null,
        check_every_ms: options.checkEveryMs(),
      };
    },

    async package(): Promise<ReleasePackage | { why: string }> {
      const pkg = await ensure();
      return pkg ?? { why: why ?? '这台主机没有可下发的发布包' };
    },
  };
}
