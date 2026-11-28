// Cross-project pinned read-only references & intra-project task artifact contracts.
// Enforces the end-state collaboration invariants:
// 1. Cross-project references freeze exact `(pinned_version, content_sha256, frozen_bytes)`,
//    never recursively expand, and never expose source project chats/repos/other artifacts.
// 2. Intra-project artifact contracts strictly bind two tasks in the SAME project, pin bounded
//    clarifications to `(producer_revision, contract_version)`, and coalesce delivery notices so
//    rapid producer updates never cause wakeup fan-out avalanches.
import { createHash } from 'node:crypto';
import type { Ctx, Db } from './db.ts';
import { nowIso, writeChange } from './db.ts';
import { InputError } from './errors.ts';
import { ulid } from './ids.ts';
import {
  CROSS_PROJECT_REF_KINDS,
  MAX_CONTRACT_CLARIFICATIONS,
  MAX_CONTRACT_CLARIFICATION_CHARS,
  type ContractClarification,
  type CrossProjectRef,
  type CrossProjectRefKind,
  type TaskContract,
  type TaskContractStatus,
} from '../shared/collaboration.ts';

interface RefRow {
  id: string;
  created_at: string;
  source_project_id: string;
  target_project_id: string;
  ref_kind: CrossProjectRefKind;
  source_ref_id: string;
  pinned_version: string;
  title: string;
  summary: string;
  content_sha256: string;
  frozen_bytes: number;
  granted_by: string;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
}

interface ContractRow {
  id: string;
  created_at: string;
  updated_at: string;
  project_id: string;
  producer_task_id: string;
  consumer_task_id: string;
  contract_name: string;
  artifact_path: string;
  registered_version: number;
  status: TaskContractStatus;
  delivered_run_id: string | null;
  delivered_sha256: string | null;
  delivery_summary: string | null;
  clarification_json: string;
  coalesced_revision: number;
  notified_version: number;
}

const contractOf = (row: ContractRow): TaskContract => ({
  id: row.id,
  created_at: row.created_at,
  updated_at: row.updated_at,
  project_id: row.project_id,
  producer_task_id: row.producer_task_id,
  consumer_task_id: row.consumer_task_id,
  contract_name: row.contract_name,
  artifact_path: row.artifact_path,
  registered_version: row.registered_version,
  status: row.status,
  delivered_run_id: row.delivered_run_id,
  delivered_sha256: row.delivered_sha256,
  delivery_summary: row.delivery_summary,
  clarifications: JSON.parse(row.clarification_json) as ContractClarification[],
  coalesced_revision: row.coalesced_revision,
  notified_version: row.notified_version,
});

export interface FrozenRefPayload {
  title: string;
  summary: string;
  pinned_version: string;
  content_sha256: string;
  frozen_bytes: number;
  text: string;
}

export interface CollaborationOptions {
  // Resolves a concrete source item inside `sourceProjectId` into a non-recursive frozen payload.
  resolveRefContent: (sourceProjectId: string, refKind: CrossProjectRefKind, sourceRefId: string, pinnedVersion?: string) => FrozenRefPayload;
  // Optional coalesced internal notification hook when a contract advances to a new unnotified version.
  onContractCoalescedNotice?: (contract: TaskContract, ctx: Ctx) => void;
}

export function createCollaboration(db: Db, write: <T>(fn: () => T) => T, options: CollaborationOptions) {
  function requireProject(id: string, label = '项目'): void {
    if (!db.get('SELECT 1 FROM project WHERE id = ?', id)) {
      throw new InputError(`${label}不存在：${id}`);
    }
  }

  function requireTask(id: string, label = '任务'): { id: string; project_id: string | null; revision: number; title: string; state: string } {
    const row = db.get<{ id: string; project_id: string | null; revision: number; title: string; state: string }>(
      'SELECT id, project_id, revision, title, state FROM task WHERE id = ?',
      id,
    );
    if (!row) throw new InputError(`${label}不存在：${id}`);
    return row;
  }

  return {
    // ---- Cross-Project Pinned Read-Only References ----

    grantCrossProjectRef(fields: {
      source_project_id: unknown;
      target_project_id: unknown;
      ref_kind: unknown;
      source_ref_id: unknown;
      pinned_version?: unknown;
      title?: unknown;
      summary?: unknown;
    }, ctx: Ctx): CrossProjectRef {
      const sourceProjectId = typeof fields.source_project_id === 'string' ? fields.source_project_id.trim() : '';
      const targetProjectId = typeof fields.target_project_id === 'string' ? fields.target_project_id.trim() : '';
      if (!sourceProjectId || !targetProjectId) throw new InputError('需要同时指定源项目和目标项目编号');
      if (sourceProjectId === targetProjectId) throw new InputError('跨项目引用的源项目和目标项目不能相同');
      requireProject(sourceProjectId, '源项目');
      requireProject(targetProjectId, '目标项目');

      const refKind = fields.ref_kind as CrossProjectRefKind;
      if (!(CROSS_PROJECT_REF_KINDS as readonly unknown[]).includes(refKind)) {
        throw new InputError(`引用类型只能是 ${CROSS_PROJECT_REF_KINDS.join('、')}`);
      }
      const sourceRefId = typeof fields.source_ref_id === 'string' ? fields.source_ref_id.trim() : '';
      if (!sourceRefId) throw new InputError('需要填写被引用对象编号（source_ref_id）');
      const requestedVersion = typeof fields.pinned_version === 'string' && fields.pinned_version.trim() !== ''
        ? fields.pinned_version.trim()
        : undefined;

      const resolved = options.resolveRefContent(sourceProjectId, refKind, sourceRefId, requestedVersion);
      const title = typeof fields.title === 'string' && fields.title.trim() !== '' ? fields.title.trim().slice(0, 200) : resolved.title;
      const summary = typeof fields.summary === 'string' && fields.summary.trim() !== '' ? fields.summary.trim().slice(0, 600) : resolved.summary;

      const id = ulid();
      const at = nowIso();
      write(() => {
        db.run(
          `INSERT INTO cross_project_ref (
             id, created_at, source_project_id, target_project_id, ref_kind, source_ref_id,
             pinned_version, title, summary, content_sha256, frozen_bytes, granted_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, at, sourceProjectId, targetProjectId, refKind, sourceRefId,
          resolved.pinned_version, title, summary, resolved.content_sha256, resolved.frozen_bytes, ctx.actor,
        );
        writeChange(db, 'collab.ref_grant', ctx, {}, {
          ref_id: id,
          source_project_id: sourceProjectId,
          target_project_id: targetProjectId,
          ref_kind: refKind,
          source_ref_id: sourceRefId,
          pinned_version: resolved.pinned_version,
          content_sha256: resolved.content_sha256,
        });
      });

      return db.get<RefRow>('SELECT * FROM cross_project_ref WHERE id = ?', id)!;
    },

    revokeCrossProjectRef(refId: string, reason: string | undefined, ctx: Ctx): CrossProjectRef {
      return write(() => {
        const row = db.get<RefRow>('SELECT * FROM cross_project_ref WHERE id = ?', refId);
        if (!row) throw new InputError(`跨项目引用不存在：${refId}`);
        if (row.revoked_at !== null) return row;
        const at = nowIso();
        const trimmedReason = reason?.trim() || '已撤权（阻断后续派发，不回收历史快照副本）';
        db.run(
          'UPDATE cross_project_ref SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ?',
          at, ctx.actor, trimmedReason, row.id,
        );
        writeChange(db, 'collab.ref_revoke', ctx, {}, { ref_id: row.id, reason: trimmedReason });
        return db.get<RefRow>('SELECT * FROM cross_project_ref WHERE id = ?', row.id)!;
      });
    },

    listCrossProjectRefs(filter: { projectId?: string; direction?: 'incoming' | 'outgoing' | 'all'; includeRevoked?: boolean } = {}): CrossProjectRef[] {
      const clauses: string[] = [];
      const params: string[] = [];
      if (filter.projectId) {
        if (filter.direction === 'incoming') {
          clauses.push('target_project_id = ?');
          params.push(filter.projectId);
        } else if (filter.direction === 'outgoing') {
          clauses.push('source_project_id = ?');
          params.push(filter.projectId);
        } else {
          clauses.push('(source_project_id = ? OR target_project_id = ?)');
          params.push(filter.projectId, filter.projectId);
        }
      }
      if (!filter.includeRevoked) {
        clauses.push('revoked_at IS NULL');
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
      return db.all<RefRow>(`SELECT * FROM cross_project_ref${where} ORDER BY created_at DESC`, ...params);
    },

    // Non-recursive read of a granted cross-project reference by target project.
    readCrossProjectRef(targetProjectId: string, refId: string): { ref: CrossProjectRef; text: string; integrity_ok: boolean } {
      const row = db.get<RefRow>('SELECT * FROM cross_project_ref WHERE id = ?', refId);
      if (!row || row.target_project_id !== targetProjectId) {
        throw new InputError(`当前项目没有这条跨项目只读引用：${refId}`);
      }
      if (row.revoked_at !== null) {
        throw new InputError(`跨项目引用 ${refId} 已被撤权（${row.revoke_reason ?? '已撤权'}），无法继续读取`);
      }
      const resolved = options.resolveRefContent(row.source_project_id, row.ref_kind, row.source_ref_id, row.pinned_version);
      return {
        ref: row,
        text: resolved.text,
        integrity_ok: resolved.content_sha256 === row.content_sha256,
      };
    },

    // ---- Intra-Project Task Artifact Contracts ----

    createTaskContract(fields: {
      project_id: string;
      producer_task_id: unknown;
      consumer_task_id: unknown;
      contract_name: unknown;
      artifact_path?: unknown;
    }, ctx: Ctx): TaskContract {
      requireProject(fields.project_id);
      const producerId = typeof fields.producer_task_id === 'string' ? fields.producer_task_id.trim() : '';
      const consumerId = typeof fields.consumer_task_id === 'string' ? fields.consumer_task_id.trim() : '';
      const contractName = typeof fields.contract_name === 'string' ? fields.contract_name.trim() : '';
      const artifactPath = typeof fields.artifact_path === 'string' ? fields.artifact_path.trim().slice(0, 300) : '';
      if (!producerId || !consumerId) throw new InputError('需要填写生产方任务和消费方任务编号');
      if (producerId === consumerId) throw new InputError('交付契约的生产方和消费方不能是同一个任务');
      if (!contractName || contractName.length > 160) throw new InputError('契约名称不能为空且最多 160 字');

      const producer = requireTask(producerId, '生产方任务');
      const consumer = requireTask(consumerId, '消费方任务');
      if (producer.project_id !== fields.project_id || consumer.project_id !== fields.project_id) {
        throw new InputError('任务交付契约仅允许同一项目内的任务之间建立；跨项目请使用固定版本只读引用');
      }

      const id = ulid();
      const at = nowIso();
      write(() => {
        if (db.get('SELECT 1 FROM task_contract WHERE project_id = ? AND producer_task_id = ? AND consumer_task_id = ? AND contract_name = ?',
          fields.project_id, producerId, consumerId, contractName)) {
          throw new InputError(`已存在同名的任务交付契约：${contractName}`);
        }
        db.run(
          `INSERT INTO task_contract (
             id, created_at, updated_at, project_id, producer_task_id, consumer_task_id,
             contract_name, artifact_path, registered_version, status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending')`,
          id, at, at, fields.project_id, producerId, consumerId, contractName, artifactPath,
        );
        writeChange(db, 'collab.contract_create', ctx, { taskId: producerId }, {
          contract_id: id, project_id: fields.project_id, producer_task_id: producerId,
          consumer_task_id: consumerId, contract_name: contractName, artifact_path: artifactPath,
        });
      });

      return contractOf(db.get<ContractRow>('SELECT * FROM task_contract WHERE id = ?', id)!);
    },

    listTaskContracts(filter: { projectId?: string; taskId?: string; status?: TaskContractStatus } = {}): TaskContract[] {
      const clauses: string[] = [];
      const params: string[] = [];
      if (filter.projectId) { clauses.push('project_id = ?'); params.push(filter.projectId); }
      if (filter.taskId) { clauses.push('(producer_task_id = ? OR consumer_task_id = ?)'); params.push(filter.taskId, filter.taskId); }
      if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
      return db.all<ContractRow>(`SELECT * FROM task_contract${where} ORDER BY updated_at DESC`, ...params).map(contractOf);
    },

    // Producer delivers a new registered version of a contract artifact.
    // Coalesces notification state so rapid multi-version deliveries never trigger fan-out wakeups.
    deliverTaskContract(contractId: string, fields: {
      artifact_path?: unknown;
      delivery_summary?: unknown;
      content_digest?: unknown;
      run_id?: string | null;
      expected_project_id?: string;
    }, ctx: Ctx): { contract: TaskContract; coalesced: boolean } {
      let shouldNotify = false;
      const updated = write(() => {
        const row = db.get<ContractRow>('SELECT * FROM task_contract WHERE id = ?', contractId);
        if (!row) throw new InputError(`交付契约不存在：${contractId}`);
        if (fields.expected_project_id && row.project_id !== fields.expected_project_id) {
          throw new InputError(`交付契约 ${contractId} 不属于当前项目`);
        }
        const nextVersion = row.registered_version + 1;
        const artifactPath = typeof fields.artifact_path === 'string' && fields.artifact_path.trim() !== ''
          ? fields.artifact_path.trim().slice(0, 300)
          : row.artifact_path;
        const summary = typeof fields.delivery_summary === 'string' ? fields.delivery_summary.trim().slice(0, 1200) : '';
        const sha = typeof fields.content_digest === 'string' && fields.content_digest.trim() !== ''
          ? fields.content_digest.trim().slice(0, 128)
          : createHash('sha256').update(`${contractId}:${nextVersion}:${artifactPath}:${summary}`, 'utf8').digest('hex');
        const at = nowIso();
        // Coalescing rule: if there is already an unacknowledged newer version (`registered_version > notified_version`),
        // merge into the pending re-evaluation instead of firing another wakeup.
        const alreadyPendingNotice = row.registered_version > row.notified_version;
        shouldNotify = !alreadyPendingNotice;
        const nextNotified = shouldNotify ? nextVersion : row.notified_version;
        db.run(
          `UPDATE task_contract SET
             updated_at = ?, artifact_path = ?, registered_version = ?, status = 'delivered',
             delivered_run_id = ?, delivered_sha256 = ?, delivery_summary = ?,
             coalesced_revision = coalesced_revision + 1, notified_version = ?
           WHERE id = ?`,
          at, artifactPath, nextVersion, fields.run_id ?? null, sha, summary || null, nextNotified, row.id,
        );
        writeChange(db, 'collab.contract_deliver', ctx, {
          taskId: row.producer_task_id,
          ...(fields.run_id ? { runId: fields.run_id } : {}),
        }, {
          contract_id: row.id, version: nextVersion, artifact_path: artifactPath,
          sha256: sha, coalesced: alreadyPendingNotice,
        });
        return contractOf(db.get<ContractRow>('SELECT * FROM task_contract WHERE id = ?', row.id)!);
      });

      if (shouldNotify) {
        options.onContractCoalescedNotice?.(updated, ctx);
      }
      return { contract: updated, coalesced: !shouldNotify };
    },

    // Consumer marks a contract blocked with a bounded structured clarification question
    // pinned to `(producer_revision, contract_version)`.
    blockTaskContract(contractId: string, fields: {
      question: unknown;
      expected_project_id?: string;
    }, ctx: Ctx): TaskContract {
      const question = typeof fields.question === 'string' ? fields.question.trim() : '';
      if (!question) throw new InputError('阻塞澄清问题不能为空');
      if (question.length > MAX_CONTRACT_CLARIFICATION_CHARS) {
        throw new InputError(`澄清问题最多 ${MAX_CONTRACT_CLARIFICATION_CHARS} 字`);
      }
      return write(() => {
        const row = db.get<ContractRow>('SELECT * FROM task_contract WHERE id = ?', contractId);
        if (!row) throw new InputError(`交付契约不存在：${contractId}`);
        if (fields.expected_project_id && row.project_id !== fields.expected_project_id) {
          throw new InputError(`交付契约 ${contractId} 不属于当前项目`);
        }
        const producer = requireTask(row.producer_task_id, '生产方任务');
        const list = JSON.parse(row.clarification_json) as ContractClarification[];
        if (list.length >= MAX_CONTRACT_CLARIFICATIONS) {
          throw new InputError(`单个契约最多保留 ${MAX_CONTRACT_CLARIFICATIONS} 条澄清记录，请由总控收敛后再继续`);
        }
        const at = nowIso();
        list.push({
          id: ulid(),
          at,
          by: ctx.actor,
          producer_revision: producer.revision,
          contract_version: row.registered_version,
          question,
        });
        db.run(
          `UPDATE task_contract SET updated_at = ?, status = 'blocked', clarification_json = ? WHERE id = ?`,
          at, JSON.stringify(list), row.id,
        );
        writeChange(db, 'collab.contract_block', ctx, { taskId: row.consumer_task_id }, {
          contract_id: row.id, contract_version: row.registered_version, producer_revision: producer.revision,
        });
        return contractOf(db.get<ContractRow>('SELECT * FROM task_contract WHERE id = ?', row.id)!);
      });
    },

    // Producer or Router answers the latest open clarification question and transitions contract to `clarified`.
    clarifyTaskContract(contractId: string, fields: {
      clarification_id?: unknown;
      answer: unknown;
      expected_project_id?: string;
    }, ctx: Ctx): TaskContract {
      const answer = typeof fields.answer === 'string' ? fields.answer.trim() : '';
      if (!answer) throw new InputError('澄清回复不能为空');
      if (answer.length > MAX_CONTRACT_CLARIFICATION_CHARS) {
        throw new InputError(`澄清回复最多 ${MAX_CONTRACT_CLARIFICATION_CHARS} 字`);
      }
      return write(() => {
        const row = db.get<ContractRow>('SELECT * FROM task_contract WHERE id = ?', contractId);
        if (!row) throw new InputError(`交付契约不存在：${contractId}`);
        if (fields.expected_project_id && row.project_id !== fields.expected_project_id) {
          throw new InputError(`交付契约 ${contractId} 不属于当前项目`);
        }
        const list = JSON.parse(row.clarification_json) as ContractClarification[];
        const targetId = typeof fields.clarification_id === 'string' && fields.clarification_id.trim() !== ''
          ? fields.clarification_id.trim()
          : undefined;
        const target = targetId
          ? list.find((c) => c.id === targetId)
          : [...list].reverse().find((c) => c.answer === undefined);
        if (!target) throw new InputError('没有待回复的阻塞澄清项');
        const at = nowIso();
        target.answer = answer;
        target.answered_at = at;
        target.answered_by = ctx.actor;
        const hasOpen = list.some((c) => c.answer === undefined);
        db.run(
          `UPDATE task_contract SET updated_at = ?, status = ?, clarification_json = ? WHERE id = ?`,
          at, hasOpen ? 'blocked' : 'clarified', JSON.stringify(list), row.id,
        );
        writeChange(db, 'collab.contract_clarify', ctx, { taskId: row.producer_task_id }, {
          contract_id: row.id, clarification_id: target.id,
        });
        return contractOf(db.get<ContractRow>('SELECT * FROM task_contract WHERE id = ?', row.id)!);
      });
    },

    deleteTaskContract(contractId: string, expectedProjectId: string | undefined, ctx: Ctx): void {
      write(() => {
        const row = db.get<ContractRow>('SELECT * FROM task_contract WHERE id = ?', contractId);
        if (!row) throw new InputError(`交付契约不存在：${contractId}`);
        if (expectedProjectId && row.project_id !== expectedProjectId) {
          throw new InputError(`交付契约 ${contractId} 不属于当前项目`);
        }
        db.run('DELETE FROM task_contract WHERE id = ?', row.id);
        writeChange(db, 'collab.contract_delete', ctx, { taskId: row.producer_task_id }, { contract_id: row.id });
      });
    },
  };
}

export type CollaborationService = ReturnType<typeof createCollaboration>;
