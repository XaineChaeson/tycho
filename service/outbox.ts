import type { Ctx, Db } from './db.ts';
import { nowIso, writeChange } from './db.ts';
import type { Degraded } from './degraded.ts';
import { InputError } from './errors.ts';
import { ulid } from './ids.ts';

// A transport cannot establish whether its external side effect happened. Ordinary
// retry policy must not turn that uncertainty into another external side effect.
export class DeliveryUncertainError extends Error {}

// How a failed notification is retried: the settings outbox.giveUpAfterMs,
// outbox.retryFirstMs and outbox.retryMaxMs, as they stand at that failure.
interface RetryPolicy {
  giveUpAfterMs: number;
  firstDelayMs: number;
  maxDelayMs: number;
}

export interface OutboxRow {
  id: string;
  created_at: string;
  channel: string;
  kind: string;
  payload_json: string;
  state: 'pending' | 'sent' | 'given_up';
  tries: number;
  next_at: string;
  error: string | null;
  first_failed_at: string | null;
}

// A cap below the first wait is no cap on it: the first wait is the shortest there is.
function delayAfterFailure(tries: number, { firstDelayMs, maxDelayMs }: RetryPolicy): number {
  return Math.min(firstDelayMs * 2 ** (tries - 1), Math.max(firstDelayMs, maxDelayMs));
}

export function createOutbox(db: Db, degraded: Degraded, hooks: { beforeMarkSent?: () => void } = {}) {
  function load(id: string): OutboxRow {
    const row = db.get<OutboxRow>('SELECT * FROM outbox WHERE id = ?', id);
    if (!row) throw new InputError(`出站消息不存在：${id}`);
    return row;
  }

  function loadPending(id: string): OutboxRow {
    const row = load(id);
    if (row.state !== 'pending') throw new InputError(`出站消息 ${id} 状态为 ${row.state}，不是待发送`);
    return row;
  }

  return {
    // A payload with an external_id names what it notifies about, once per channel,
    // whatever state the first copy has reached by now.
    enqueue(channel: string, kind: string, payload: unknown): OutboxRow {
      return degraded.write(() => {
        const key = (payload as { external_id?: unknown } | null)?.external_id;
        if (typeof key === 'string') {
          const known = db.get<OutboxRow>(
            `SELECT * FROM outbox WHERE channel = ? AND json_extract(payload_json, '$.external_id') = ?`,
            channel,
            key,
          );
          if (known) return known;
        }
        const id = ulid();
        const at = nowIso();
        db.run(
          `INSERT INTO outbox (id, created_at, channel, kind, payload_json, state, next_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
          id,
          at,
          channel,
          kind,
          JSON.stringify(payload),
          at,
        );
        return load(id);
      });
    },

    // Taking an item licenses a send, and a send that cannot be recorded would
    // be repeated, so this read is refused in degraded mode too.
    takeDue(now: Date = new Date()): OutboxRow[] {
      degraded.assertHealthy();
      return db.all<OutboxRow>(
        `SELECT * FROM outbox WHERE state = 'pending' AND next_at <= ? ORDER BY next_at, rowid`,
        now.toISOString(),
      );
    },

    counts(): { pending: number; given_up: number } {
      const rows = db.all<{ state: string; n: number }>(
        `SELECT state, count(*) AS n FROM outbox WHERE state != 'sent' GROUP BY state`,
      );
      const of = (state: string): number => rows.find((row) => row.state === state)?.n ?? 0;
      return { pending: of('pending'), given_up: of('given_up') };
    },

    // Called inside the transaction that seals a restored backup.
    giveUpPending(reason: string): number {
      return degraded.write(() => {
        const { n } = db.get<{ n: number }>(`SELECT count(*) AS n FROM outbox WHERE state = 'pending'`)!;
        db.run(`UPDATE outbox SET state = 'given_up', error = ? WHERE state = 'pending'`, reason);
        return n;
      });
    },

    isPending(id: string): boolean {
      const row = db.get<{ state: OutboxRow['state'] }>('SELECT state FROM outbox WHERE id = ?', id);
      return row?.state === 'pending';
    },

    listGivenUp(): OutboxRow[] {
      return db.all<OutboxRow>(`SELECT * FROM outbox WHERE state = 'given_up' ORDER BY rowid DESC`);
    },

    markSent(id: string, note?: string): void {
      degraded.write(() => {
        loadPending(id);
        hooks.beforeMarkSent?.();
        db.run(`UPDATE outbox SET state = 'sent', error = ?, first_failed_at = NULL WHERE id = ?`, note ?? null, id);
      });
    },

    markFailed(id: string, error: string, retry: RetryPolicy, now: Date = new Date()): void {
      degraded.write(() => {
        const row = loadPending(id);
        const tries = row.tries + 1;
        const firstFailedAt = row.first_failed_at ?? now.toISOString();
        if (now.getTime() - new Date(firstFailedAt).getTime() >= retry.giveUpAfterMs) {
          db.run(`UPDATE outbox SET state = 'given_up', tries = ?, error = ? WHERE id = ?`, tries, error, id);
          return;
        }
        const nextAt = new Date(now.getTime() + delayAfterFailure(tries, retry)).toISOString();
        db.run(
          `UPDATE outbox SET tries = ?, next_at = ?, error = ?, first_failed_at = ? WHERE id = ?`,
          tries,
          nextAt,
          error,
          firstFailedAt,
          id,
        );
      });
    },

    markUncertain(id: string, reason: string): void {
      degraded.write(() => {
        const row = loadPending(id);
        db.run(`UPDATE outbox SET state = 'given_up', tries = ?, error = ?, first_failed_at = COALESCE(first_failed_at, ?) WHERE id = ?`, row.tries + 1, reason, nowIso(), id);
      });
    },

    confirmReceived(id: string, ctx: Ctx): void {
      degraded.write(() => {
        const row = load(id);
        if (row.state === 'sent') return;
        if (row.state !== 'given_up') throw new InputError('只能确认已停止自动重试的通知，请先核对原聊天');
        db.run(`UPDATE outbox SET state = 'sent', error = '主人已确认收到' WHERE id = ?`, id);
        writeChange(db, 'outbox.confirm_received', ctx, {}, { outbox_id: id, kind: row.kind });
      });
    },

    confirmAllReceived(ctx: Ctx): number {
      return degraded.write(() => {
        const rows = db.all<{ id: string; kind: string }>(`SELECT id, kind FROM outbox WHERE state = 'given_up'`);
        if (rows.length === 0) return 0;
        db.run(`UPDATE outbox SET state = 'sent', error = '主人已确认收到' WHERE state = 'given_up'`);
        writeChange(db, 'outbox.confirm_all_received', ctx, {}, { count: rows.length });
        return rows.length;
      });
    },

    retry(id: string, ctx: Ctx): void {
      degraded.write(() => {
        const row = load(id);
        if (row.state === 'sent') throw new InputError(`出站消息 ${id} 已发送，不能重试`);
        if (row.state === 'given_up' && typeof row.error === 'string' && /未确认|结果未知/.test(row.error)) {
          throw new InputError('该通知送达结果未确认，不能走普通重试；请先在原聊天核对，再选择“已确认收到”或“强制补发”');
        }
        db.run(
          `UPDATE outbox SET state = 'pending', tries = 0, next_at = ?, error = NULL, first_failed_at = NULL WHERE id = ?`,
          nowIso(),
          id,
        );
        writeChange(db, 'outbox.retry', ctx, {}, { outbox_id: id, kind: row.kind });
      });
    },

    // Explicit owner-initiated resend for a given-up item (such as an uncertain Weixin send):
    // advances `force_resend_seq` inside payload_json so the channel issues a fresh idempotency key.
    forceResend(id: string, ctx: Ctx): number {
      return degraded.write(() => {
        const row = load(id);
        if (row.state !== 'given_up') throw new InputError('只能强制重发已停止自动重试的通知');
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.payload_json);
        } catch {
          throw new InputError(`出站消息 ${id} 的载荷不是合法 JSON，无法强制重发`);
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new InputError(`出站消息 ${id} 的载荷不是对象，无法强制重发`);
        }
        const payload = parsed as Record<string, unknown>;
        const prev = typeof payload.force_resend_seq === 'number' && Number.isInteger(payload.force_resend_seq) && payload.force_resend_seq >= 0
          ? payload.force_resend_seq
          : 0;
        const nextSeq = prev + 1;
        const nextPayload = JSON.stringify({ ...payload, force_resend_seq: nextSeq });
        db.run(
          `UPDATE outbox SET payload_json = ?, state = 'pending', tries = 0, next_at = ?, error = NULL, first_failed_at = NULL WHERE id = ?`,
          nextPayload,
          nowIso(),
          id,
        );
        writeChange(db, 'outbox.force_resend', ctx, {}, { outbox_id: id, kind: row.kind, force_resend_seq: nextSeq });
        return nextSeq;
      });
    },
  };
}
