import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { GroupMessage } from './callback.ts';
import { RemoteError, type Clients } from './clients.ts';

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const MAX_SUBMIT_CLOCK = 45 * 60 * SECOND;
const MAX_REPLY_CLOCK = 55 * 60 * SECOND;
const MAX_RESULT_CLOCK = 24 * HOUR;
const MAX_UNSENT_REPLY_CLOCK = 7 * 24 * HOUR;
const POLL_MS = 5 * SECOND;
const GROUP_GAP_MS = 250;
const MAX_ON_TICK = 10;

type Phase = 'submit' | 'result' | 'reply' | 'delivered' | 'no_reply' | 'failed' | 'uncertain';

interface Job {
  event_id: string;
  message_id: string;
  chat_id: string;
  project_id: string;
  body: string | null;
  reply: string | null;
  uuid: string;
  state: Phase;
  receipt: string | null;
  accepted_at: number;
  first_submit_at: number | null;
  first_reply_at: number | null;
  next_at: number;
  attempts: number;
  detail: string | null;
  return_message: string | null;
}

export function openFeishuQueue(path: string, deps: { clients: Clients; binding?: string; now?: () => number; log?: (line: string) => void; start?: boolean }) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS delivery (
      event_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, chat_id TEXT NOT NULL, project_id TEXT NOT NULL,
      body TEXT, reply TEXT, uuid TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT, accepted_at INTEGER NOT NULL,
      first_submit_at INTEGER, first_reply_at INTEGER, next_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      detail TEXT, return_message TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS delivery_due ON delivery(next_at, accepted_at) WHERE state IN ('submit', 'result', 'reply');
  `);
  if (deps.binding !== undefined) {
    db.exec('CREATE TABLE IF NOT EXISTS bridge_identity (slot INTEGER PRIMARY KEY CHECK(slot = 1), binding TEXT NOT NULL) STRICT;');
    db.prepare('INSERT INTO bridge_identity VALUES (1, ?) ON CONFLICT(slot) DO NOTHING').run(deps.binding);
    if (db.prepare('SELECT binding FROM bridge_identity WHERE slot = 1').get()?.binding !== deps.binding) {
      db.close();
      throw new Error('这份飞书队列属于其他应用、租户或 Tycho 来源；请以原配置处理或使用独立数据目录');
    }
  }
  const clock = deps.now ?? Date.now;
  const log = deps.log ?? ((line) => console.error(line));
  const { clients } = deps;
  const terminal = db.prepare("UPDATE delivery SET state = ?, body = NULL, reply = NULL, detail = ?, return_message = ? WHERE event_id = ?");
  let active: Promise<void> | undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  // A row that could not be updated must not monopolize the oldest slot.
  // This in-memory delay only affects scheduling. Remote retries still use
  // the durable first-attempt time, event ID, payload and reply UUID.
  const deferred = new Map<string, number>();

  function record(message: GroupMessage): void {
    const { eventId, messageId, chatId, projectId, threadId, text, quickReply } = message;
    // The receipt never decides the target chat or message. These come from the
    // signed callback. A duplicate retains its original route and wording.
    const body = quickReply === null ? JSON.stringify({ channel: 'feishu', message_id: messageId, thread_id: threadId, text }) : null;
    const at = clock();
    db.prepare(`INSERT INTO delivery (event_id, message_id, chat_id, project_id, body, reply, uuid, state, accepted_at, next_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`)
      .run(eventId, messageId, chatId, projectId, body, quickReply, randomUUID(), quickReply === null ? 'submit' : 'reply', at, at);
  }

  function finish(job: Job, state: Phase, detail: string, response: string | null = null): void {
    terminal.run(state, detail, response, job.event_id);
    if (state === 'failed' || state === 'uncertain') log(`${job.event_id} ${state} ${detail}`);
  }

  function retry(job: Job, detail: string, wait: number): void {
    db.prepare('UPDATE delivery SET attempts = attempts + 1, detail = ?, next_at = ? WHERE event_id = ?')
      .run(detail, clock() + wait, job.event_id);
  }

  async function advance(job: Job): Promise<void> {
    const at = clock();
    try {
      if (job.state === 'submit') {
        if (job.first_submit_at !== null && at - job.first_submit_at >= MAX_SUBMIT_CLOCK) {
          finish(job, 'uncertain', 'tycho-submit-window-ended');
          return;
        }
        if (job.first_submit_at === null && at - job.accepted_at >= MAX_RESULT_CLOCK) {
          finish(job, 'failed', 'tycho-unsent-event-expired');
          return;
        }
        db.prepare('UPDATE delivery SET first_submit_at = COALESCE(first_submit_at, ?) WHERE event_id = ?').run(at, job.event_id);
        const receipt = await clients.submit(job.project_id, job.event_id, job.body!);
        db.prepare("UPDATE delivery SET state = 'result', body = NULL, receipt = ?, attempts = 0, next_at = ?, detail = NULL WHERE event_id = ?")
          .run(receipt, clock(), job.event_id);
      } else if (job.state === 'result') {
        if (job.first_submit_at !== null && at - job.first_submit_at >= MAX_RESULT_CLOCK) {
          finish(job, 'failed', 'tycho-result-window-ended');
          return;
        }
        const result = await clients.result(job.project_id, job.receipt!);
        if (result.reply !== undefined) {
          db.prepare("UPDATE delivery SET state = 'reply', reply = ?, attempts = 0, next_at = ?, detail = NULL WHERE event_id = ?")
            .run(result.reply, clock(), job.event_id);
        } else if (result.state !== 'received' && result.state !== 'processing') {
          finish(job, 'no_reply', 'tycho-no-authorized-reply');
        } else {
          retry(job, 'tycho-awaiting-reply', POLL_MS);
        }
      } else if (job.state === 'reply') {
        if (job.first_reply_at === null && at - job.accepted_at >= MAX_UNSENT_REPLY_CLOCK) {
          finish(job, 'failed', 'feishu-unsent-reply-expired');
          return;
        }
        if (job.first_reply_at !== null && at - job.first_reply_at >= MAX_REPLY_CLOCK) {
          finish(job, 'uncertain', 'feishu-reply-window-ended');
          return;
        }
        // Set this first: a process can die after delivery but before reading the response.
        db.prepare('UPDATE delivery SET first_reply_at = COALESCE(first_reply_at, ?) WHERE event_id = ?').run(at, job.event_id);
        const response = await clients.reply(job.message_id, job.reply!, job.uuid);
        finish(job, 'delivered', 'feishu-replied', response);
      }
    } catch (error) {
      if (!(error instanceof RemoteError)) throw error;
      if (error.retryable) {
        retry(job, error.code, Math.min(60 * SECOND, SECOND * 2 ** Math.min(job.attempts, 6)));
      } else {
        // An earlier ambiguous attempt may already have sent or submitted.
        const priorAttempt = job.state === 'reply' ? job.first_reply_at : job.state === 'submit' ? job.first_submit_at : null;
        finish(job, priorAttempt === null ? 'failed' : 'uncertain', error.code);
      }
    }
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    active ??= (async () => {
      const at = clock();
      for (const [id, until] of deferred) if (until <= at) deferred.delete(id);
      // Look one extra row ahead for every temporary exclusion. Other due rows
      // remain eligible even when the first batch encounters a storage failure.
      const jobs = db.prepare(`SELECT * FROM delivery WHERE state IN ('submit', 'result', 'reply') AND next_at <= ?
        ORDER BY next_at, accepted_at LIMIT ?`).all(at, MAX_ON_TICK + deferred.size) as unknown as Job[];
      for (const job of jobs.filter(({ event_id }) => !deferred.has(event_id)).slice(0, MAX_ON_TICK)) {
        if (stopped) return;
        try {
          await advance(job);
        } catch {
          const wait = 60 * SECOND;
          log(`${job.event_id} ${job.state} feishu-queue-operation-failed`);
          try {
            retry(job, 'feishu-queue-operation-failed', wait);
          } catch {
            deferred.set(job.event_id, clock() + wait);
          }
        }
        if (job.state === 'reply' && deps.start !== false) await new Promise((resolve) => setTimeout(resolve, GROUP_GAP_MS));
      }
    })().finally(() => { active = undefined; });
    return active;
  }

  if (deps.start !== false) {
    timer = setInterval(() => { void tick().catch(() => log('飞书桥接队列读取或写入失败')); }, SECOND);
    timer.unref();
  }
  return {
    record, tick,
    status() {
      return db.prepare(`SELECT event_id, project_id, state, receipt, return_message, detail, attempts FROM delivery ORDER BY accepted_at, rowid`).all();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      try { await active; } finally { db.close(); }
    },
  };
}
