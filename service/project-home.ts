import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { InputError } from './errors.ts';
import { ulid } from './ids.ts';
import { prepareOwnerOnlyDirectory } from './secrets.ts';

const VERSION = 1;
export const PROJECT_HOME_KEY_PREFIX = 'project-home:';
const MIN_TRANSFER_GENERATION = 2;
const PROJECT_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SERVICE_ID = /^tycho:[a-f0-9]{64}$/;
const PUBLIC_KEY = /^[a-zA-Z0-9_-]{59}$/;
const SIGNATURE = /^[a-zA-Z0-9_-]{86}$/;

export interface ProjectHomeIdentity {
  id: string;
  public_key: string;
}
export interface ProjectOwnership {
  service_id: string;
  generation: number;
}
export interface ProjectHomeStatus {
  phase: 'owned' | 'frozen' | 'incoming' | 'unknown';
  service_id: string;
  generation: number | null;
  target_service: string | null;
}

interface OutgoingTransfer {
  project_id: string;
  target: string;
  bundle_sha256: string;
}
interface IncomingTransfer {
  project_id: string;
  source: ProjectHomeIdentity;
  generation: number;
  bundle_sha256: string;
}
export interface ProjectHandoff {
  version: typeof VERSION;
  project_id: string;
  source_service: string;
  target_service: string;
  generation: number;
  bundle_sha256: string;
  transfer_id: string;
  signature: string;
}
type HandoffFields = Omit<ProjectHandoff, 'signature'>;

type AuthorityRow = {
  phase: 'owned' | 'frozen' | 'incoming';
  generation: number;
  peer: string | null;
  peer_key: string | null;
  bundle: string | null;
  transfer: string | null;
};
type KeyRow = { public_key: string; private_key: string };

export const authorityPath = (dataDir: string): string => join(dataDir, 'project-home', 'authority.db');
export const projectHomeEnabled = (dataDir: string): boolean => existsSync(join(dataDir, 'project-home'));
const serviceId = (spki: Buffer): string => 'tycho:' + createHash('sha256').update(spki).digest('hex');

function validateProject(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !PROJECT_ID.test(id)) throw new InputError('项目编号无效');
}

function validateGeneration(generation: unknown): asserts generation is number {
  if (!Number.isSafeInteger(generation) || (generation as number) < MIN_TRANSFER_GENERATION) throw new InputError('移交代次无效');
}

function validateBundle(hash: unknown): asserts hash is string {
  if (typeof hash !== 'string' || !SHA256.test(hash)) throw new InputError('移交数据摘要无效');
}

function publicKeyOf(identity: ProjectHomeIdentity) {
  if (!identity || typeof identity.public_key !== 'string' || !PUBLIC_KEY.test(identity.public_key)) throw new InputError('服务公钥无效');
  const buffer = Buffer.from(identity.public_key, 'base64url');
  if (buffer.toString('base64url') !== identity.public_key || serviceId(buffer) !== identity.id) throw new InputError('服务编号与公钥不符');
  const key = createPublicKey({ format: 'der', type: 'spki', key: buffer });
  if (key.asymmetricKeyType !== 'ed25519') throw new InputError('服务签名算法无效');
  return key;
}

function signed(fields: HandoffFields): Buffer {
  const { version, project_id, source_service, target_service, generation, bundle_sha256, transfer_id } = fields;
  return Buffer.from(JSON.stringify([version, project_id, source_service, target_service, generation, bundle_sha256, transfer_id]), 'utf8');
}

function handoffOf(raw: unknown): ProjectHandoff {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new InputError('项目移交凭证无效');
  const { version, project_id, source_service, target_service, generation, bundle_sha256, transfer_id, signature } = raw as Record<string, unknown>;
  if (version !== VERSION) throw new InputError('项目移交凭证版本不支持');
  validateProject(project_id);
  validateGeneration(generation);
  validateBundle(bundle_sha256);
  if (typeof source_service !== 'string' || !SERVICE_ID.test(source_service) || typeof target_service !== 'string' || !SERVICE_ID.test(target_service)) {
    throw new InputError('项目移交凭证中的服务编号无效');
  }
  if (typeof transfer_id !== 'string' || !PROJECT_ID.test(transfer_id) || typeof signature !== 'string' || !SIGNATURE.test(signature)) {
    throw new InputError('项目移交凭证的编号或签名无效');
  }
  return { version, project_id, source_service, target_service, generation, bundle_sha256, transfer_id, signature };
}

function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  // Transactions hold only the synchronous authority check or transfer step.
  db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
  return db;
}

function connect(db: DatabaseSync, keys: KeyRow) {
  const publicKey = Buffer.from(keys.public_key, 'base64url');
  const identity = Object.freeze({ id: serviceId(publicKey), public_key: keys.public_key });
  const privateKey = createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.from(keys.private_key, 'base64url') });
  if (!createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).equals(publicKey)) {
    throw new Error('项目归属数据库中的服务签名密钥不匹配');
  }

  function transact<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (typeof (result as { then?: unknown } | undefined)?.then === 'function') {
        throw new Error('项目写操作必须在同步事务内结束');
      }
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  let installing: { projectId: string; ownership: ProjectOwnership } | undefined;

  function installProject<T>(projectId: string, ownership: ProjectOwnership, install: () => T): T {
    installing = { projectId, ownership };
    try {
      return install();
    } finally {
      installing = undefined;
    }
  }

  function rowOf(projectId: string): AuthorityRow | undefined {
    return db.prepare('SELECT phase, generation, peer, peer_key, bundle, transfer FROM authority WHERE project = ?').get(projectId) as AuthorityRow | undefined;
  }

  function readOwnership(projectId: string): ProjectOwnership | undefined {
    validateProject(projectId);
    const row = rowOf(projectId);
    return row?.phase === 'owned' ? { service_id: identity.id, generation: row.generation } : undefined;
  }

  function assertWritable(projectId: string, installed: ProjectOwnership | undefined): void {
    validateProject(projectId);
    const row = rowOf(projectId);
    if (row?.phase === 'frozen') throw new InputError(`项目已冻结，正在移交给服务 ${row.peer}`);
    if (row?.phase === 'incoming') throw new InputError('项目已准备，当前服务尚未接管');
    if (!row || installed?.service_id !== identity.id || installed.generation !== row.generation) {
      throw new InputError('项目账本的写入归属未核实');
    }
  }

  return {
    identity,
    close() { if (db.isOpen) db.close(); },
    readOwnership,
    describe(projectId: string, installed?: ProjectOwnership): ProjectHomeStatus {
      validateProject(projectId);
      const row = rowOf(projectId);
      const phase = row?.phase === 'owned' && (installed?.service_id !== identity.id || installed.generation !== row.generation)
        ? 'unknown' : row?.phase ?? 'unknown';
      return {
        phase, service_id: identity.id, generation: phase === 'unknown' ? null : row!.generation,
        target_service: row?.phase === 'frozen' ? row.peer : null,
      };
    },
    assertWritable,
    isGuarded: () => db.isTransaction,
    guardLedgerTransaction<T>(fn: () => T): T {
      // An installation already holds this lock. It may synchronize only the ledger
      // on this same connection, and still uses the ledger's own commit.
      return db.isTransaction ? fn() : transact(fn);
    },
    assertLedgerWrite(projectId: string, installed: ProjectOwnership | undefined): void {
      if (!installing) {
        assertWritable(projectId, installed);
      } else if (installing.projectId !== projectId) {
        throw new InputError('项目移交不能写入目标端的其他项目');
      }
    },
    assertInstall(projectId: string, ownership: ProjectOwnership): void {
      if (projectId !== installing?.projectId || ownership.service_id !== installing.ownership.service_id || ownership.generation !== installing.ownership.generation) {
        throw new InputError('项目归属只能在已核实的安装中登记');
      }
    },

    // Only for a freshly minted ID. Existing data, in particular a restored ledger with missing
    // authority evidence, must never enter through here.
    registerNew(projectId: string, install?: (ownership: ProjectOwnership) => void): ProjectOwnership {
      validateProject(projectId);
      return transact(() => {
        if (rowOf(projectId)) throw new InputError('项目归属记录已经存在');
        db.prepare("INSERT INTO authority (project, phase, generation) VALUES (?, 'owned', 1)").run(projectId);
        const ownership = Object.freeze({ service_id: identity.id, generation: 1 });
        if (install) installProject(projectId, ownership, () => install(ownership));
        return ownership;
      });
    },

    withWrite<T>(projectId: string, installed: ProjectOwnership | undefined, fn: () => T): T {
      return transact(() => {
        assertWritable(projectId, installed);
        return fn();
      });
    },

    // The caller pins the source public key through an already authenticated channel and verifies
    // the staged project's format and bytes. Neither an address nor the receipt itself enrols a key.
    stageIncoming({ project_id, source, generation, bundle_sha256 }: IncomingTransfer, replace = false): void {
      validateProject(project_id);
      validateGeneration(generation);
      validateBundle(bundle_sha256);
      publicKeyOf(source);
      if (source.id === identity.id) throw new InputError('项目的来源和目标服务相同');
      transact(() => {
        const row = rowOf(project_id);
        if (row?.phase === 'incoming' && row.generation === generation && row.peer === source.id && row.peer_key === source.public_key) {
          if (row.bundle === bundle_sha256) return;
          if (!replace) throw new InputError('同一源服务已有待接管的移交包。源端拒绝冻结旧包时，可用 stage --replace 重新准备');
          db.prepare('UPDATE authority SET bundle = ? WHERE project = ?').run(bundle_sha256, project_id);
          return;
        }
        if (row && (row.phase !== 'frozen' || generation <= row.generation + 1)) {
          throw new InputError('项目已有归属或待接管记录，不能覆盖');
        }
        db.prepare(`INSERT INTO authority (project, phase, generation, peer, peer_key, bundle, transfer)
          VALUES (?, 'incoming', ?, ?, ?, ?, NULL) ON CONFLICT(project) DO UPDATE SET
          phase = excluded.phase, generation = excluded.generation, peer = excluded.peer,
          peer_key = excluded.peer_key, bundle = excluded.bundle, transfer = NULL`)
          .run(project_id, generation, source.id, source.public_key, bundle_sha256);
      });
    },

    // The owner has already stopped admission and drained Workers, Router and external sends.
    // The callback checks that barrier and hashes the exact staged scope under the same write
    // exclusion. A mismatch or uncertain effect aborts before this service gives up write access.
    freezeForTransfer({ project_id, target, bundle_sha256 }: OutgoingTransfer, installed: ProjectOwnership | undefined, confirmQuiescentSnapshot: () => string): ProjectHandoff {
      validateProject(project_id);
      validateBundle(bundle_sha256);
      if (typeof target !== 'string' || !SERVICE_ID.test(target) || target === identity.id) throw new InputError('项目移交目标服务无效');
      const row = transact(() => {
        const current = rowOf(project_id);
        if (current?.phase === 'frozen' && current.peer === target && current.bundle === bundle_sha256) return current;
        assertWritable(project_id, installed);
        const generation = current!.generation;
        validateGeneration(generation + 1);
        if (confirmQuiescentSnapshot() !== bundle_sha256) throw new InputError('清点后的项目数据与目标准备的数据不一致');
        const transfer = ulid();
        db.prepare("UPDATE authority SET phase = 'frozen', peer = ?, peer_key = NULL, bundle = ?, transfer = ? WHERE project = ?")
          .run(target, bundle_sha256, transfer, project_id);
        return { generation, transfer };
      });
      // A crash before this point releases no receipt. After this point a retry returns the
      // same signed claim from the persisted freeze, and the old service stays frozen.
      const fields: HandoffFields = {
        version: VERSION, project_id, source_service: identity.id, target_service: target,
        generation: row.generation + 1, bundle_sha256, transfer_id: row.transfer!,
      };
      return { ...fields, signature: sign(null, signed(fields), privateKey).toString('base64url') };
    },

    // The install callback must be synchronous, idempotent by transfer_id, and persist both
    // the verified bundle and its local ledger generation before reporting the installed digest.
    // The authority switches after that succeeds. A partial install still has no write right.
    acceptIncoming(receipt: unknown, install: (ownership: ProjectOwnership, handoff: Readonly<ProjectHandoff>) => string): ProjectOwnership {
      const handoff = Object.freeze(handoffOf(receipt));
      if (handoff.target_service !== identity.id) throw new InputError('项目移交凭证发给了另一个目标服务');
      return transact(() => {
        const row = rowOf(handoff.project_id);
        if (!row || !row.peer || !row.peer_key || (row.phase !== 'incoming' && row.phase !== 'owned')) {
          throw new InputError('目标服务尚未准备接管该项目');
        }
        if (row.generation !== handoff.generation || row.peer !== handoff.source_service || row.bundle !== handoff.bundle_sha256) {
          throw new InputError('项目移交代次、来源或数据摘要未核实');
        }
        const sender = publicKeyOf({ id: row.peer, public_key: row.peer_key });
        const signature = Buffer.from(handoff.signature, 'base64url');
        if (signature.toString('base64url') !== handoff.signature || !verify(null, signed(handoff), sender, signature)) {
          throw new InputError('项目移交凭证签名不匹配');
        }
        const ownership = Object.freeze({ service_id: identity.id, generation: handoff.generation });
        if (row.phase === 'owned') {
          if (row.transfer !== handoff.transfer_id) throw new InputError('项目已由另一份移交凭证接管');
          return ownership;
        }
        if (installProject(handoff.project_id, ownership, () => install(ownership, handoff)) !== handoff.bundle_sha256) throw new InputError('已安装的项目数据摘要未核实');
        db.prepare("UPDATE authority SET phase = 'owned', transfer = ? WHERE project = ?").run(handoff.transfer_id, handoff.project_id);
        return ownership;
      });
    },
  };
}

export type ProjectHome = ReturnType<typeof connect>;

// Called once during the explicit creation of a fresh service. A failed creation leaves
// evidence that needs inspection, rather than silently generating another private key.
export function createProjectHome(dataDir: string): ProjectHome {
  const file = authorityPath(dataDir);
  prepareOwnerOnlyDirectory(join(dataDir, 'project-home'));
  let handle: number;
  try {
    handle = openSync(file, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new InputError('项目归属数据库已经存在');
    throw error;
  }
  closeSync(handle);
  const db = openDatabase(file);
  try {
    const pair = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { format: 'der', type: 'pkcs8' },
      publicKeyEncoding: { format: 'der', type: 'spki' },
    });
    const keys = { public_key: pair.publicKey.toString('base64url'), private_key: pair.privateKey.toString('base64url') };
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE service_identity (slot INTEGER PRIMARY KEY CHECK(slot = 1), public_key TEXT NOT NULL, private_key TEXT NOT NULL) STRICT;
      CREATE TABLE authority (
        project TEXT PRIMARY KEY,
        phase TEXT NOT NULL CHECK(phase IN ('owned', 'frozen', 'incoming')),
        generation INTEGER NOT NULL CHECK(generation > 0),
        peer TEXT,
        peer_key TEXT,
        bundle TEXT,
        transfer TEXT
      ) STRICT;
      PRAGMA user_version = 1;
    `);
    db.prepare('INSERT INTO service_identity (slot, public_key, private_key) VALUES (1, ?, ?)').run(keys.public_key, keys.private_key);
    db.exec('COMMIT');
    return connect(db, keys);
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openProjectHome(dataDir: string): ProjectHome {
  const file = authorityPath(dataDir);
  if (!existsSync(file)) throw new InputError('未找到项目归属数据库，服务无法核对写权。请找回当前服务的归属库，或使用项目当前的归属服务');
  const db = openDatabase(file);
  try {
    if (db.prepare('PRAGMA user_version').get()?.user_version !== VERSION) throw new InputError('项目归属数据库版本不支持');
    const keys = db.prepare('SELECT public_key, private_key FROM service_identity WHERE slot = 1').get() as KeyRow | undefined;
    if (!keys) throw new Error('未找到服务身份，项目保持只读');
    return connect(db, keys);
  } catch (error) {
    db.close();
    throw error;
  }
}
