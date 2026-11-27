// The conversation as the rows to draw, from what the ledger holds: the owner's
// messages, the Router's replies under the message they answer, internal events and triggers'
// messages as one gray line, what an unfinished request had committed, the Tasks a turn created, and
// question cards where they were asked. Days are told apart by a line between them.
import { t } from '@shared/i18n.ts';
import { eventHeadline } from '@shared/labels.ts';
import { fromOwner } from '@shared/triggers.ts';
import type { Approval, Change, Message, ProjectFileSummary, TaskCapsule, TurnChanges } from './types.ts';

export type Item =
  | { key: string; kind: 'date'; text: string }
  | { key: string; kind: 'mine'; text: string; attachments?: readonly ProjectFileSummary[]; messageId?: string; at?: string }
  | { key: string; kind: 'note'; text: string; messageId?: string; at?: string }
  | { key: string; kind: 'reply'; id: string; text: string; attachments?: readonly ProjectFileSummary[]; incomplete: boolean; at?: string }
  // `changes` null: what it committed has not been read, so nothing can be said about it.
  | { key: string; kind: 'unverified'; changes: Change[] | null; at?: string }
  | { key: string; kind: 'capsules'; tasks: TaskCapsule[] }
  | { key: string; kind: 'card'; card: Approval; at?: string }
  | { key: string; kind: 'empty' };

const REPLY = 'reply:';
const isVisibleInbound = (row: Message): boolean => row.direction === 'in' && row.state !== 'ignored';
const at = (value: string | undefined): { at?: string } => (value ? { at: value } : {});
const attachmentsOf = (list: readonly ProjectFileSummary[] | undefined): { attachments?: readonly ProjectFileSummary[] } =>
  list && list.length > 0 ? { attachments: list } : {};

// A day, of the reader's own clock: the line between two days of a conversation.
export function dayKey(value: string | number): string {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function dateLabel(value: string | number, now: Date = new Date()): string {
  const date = new Date(value);
  if (sameDay(date, now)) return t('proj.conv.today');
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return t('proj.conv.yesterday');
  return t('proj.conv.dateYmd', {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  });
}

// A message the Router has taken up: only these have a turn whose changes can be read.
export const hasTurn = (row: Message): boolean => row.direction === 'in' && row.state !== 'received' && row.state !== 'ignored';

export const processing = (messages: Iterable<Message>): Message | undefined => [...messages].find((row) => row.state === 'processing');

function replyItem(row: Message, inbound?: Message): Item {
  // A reply still being written belongs to a turn under way; anything else that never
  // got its last word was cut off.
  return { key: `out:${row.id}`, kind: 'reply', id: row.id, text: row.text, ...attachmentsOf(row.attachments), incomplete: row.final === 0 && inbound?.state !== 'processing', ...at(row.created_at) };
}

// A line whenever the conversation advances to a new day: a conversation read months later
// must not look like one long afternoon. A paired reply stays under the message it answers so
// answering a 23:59 message at 00:00 neither splits the Q&A block nor sends a later 23:59
// event back to "昨天"; date dividers are strictly monotonic.
function withDays(items: Item[], paired: ReadonlySet<string>): Item[] {
  const out: Item[] = [];
  let day: string | null = null;
  for (const item of items) {
    const when = paired.has(item.key) ? undefined : 'at' in item ? item.at : undefined;
    if (when) {
      const key = dayKey(when);
      if (day === null || key > day) {
        out.push({ key: `date:${item.key}`, kind: 'date', text: dateLabel(when) });
        day = key;
      }
    }
    out.push(item);
  }
  return out;
}

export function conversationItems({ messages, changes, approvals, sending, sendingAttachments }: {
  messages: Iterable<Message>;
  changes: ReadonlyMap<string, TurnChanges>;
  approvals: readonly Approval[];
  sending: string | null;
  sendingAttachments?: readonly ProjectFileSummary[];
}): Item[] {
  const rows = [...messages].sort((a, b) => (a.id < b.id ? -1 : 1));
  const replies = new Map<string, Message>();
  for (const row of rows) {
    if (row.direction === 'out' && row.external_id.startsWith(REPLY)) replies.set(row.external_id.slice(REPLY.length), row);
  }
  const inboundIds = new Set(rows.filter(isVisibleInbound).map(({ id }) => id));
  const oldest = rows[0]?.id ?? '';
  const entries: ({ id: string; row: Message } | { id: string; card: Approval })[] = [
    ...rows.map((row) => ({ id: row.id, row })),
    // A question still open matters however old it is.
    ...approvals.filter((card) => card.state === 'open' || card.id >= oldest).map((card) => ({ id: card.id, card })),
  ].sort((a, b) => (a.id < b.id ? -1 : 1));

  const paired = new Set<string>();
  const items = entries.flatMap((entry): Item[] => {
    if ('card' in entry) return [{ key: `card:${entry.card.id}`, kind: 'card', card: entry.card, ...at(entry.card.created_at) }];
    const { row } = entry;
    if (row.direction === 'out') {
      // Drawn under the message it answers.
      if (row.external_id.startsWith(REPLY) && inboundIds.has(row.external_id.slice(REPLY.length))) return [];
      return [replyItem(row)];
    }
    if (!isVisibleInbound(row)) return [];
    const trajectory = row.project_id && ['processing', 'processed', 'unverified'].includes(row.state ?? '') ? { messageId: row.id } : {};
    const drawn: Item[] = [!fromOwner(row.channel ?? '')
      ? { key: `in:${row.id}`, kind: 'note', text: eventHeadline(row.text), ...trajectory, ...at(row.created_at) }
      : { key: `in:${row.id}`, kind: 'mine', text: row.text, ...attachmentsOf(row.attachments), ...trajectory, ...at(row.created_at) }];
    const reply = replies.get(row.id);
    if (reply) {
      const rendered = replyItem(reply, row);
      paired.add(rendered.key);
      drawn.push(rendered);
    }
    const turn = changes.get(row.id);
    if (row.state === 'unverified') drawn.push({ key: `unverified:${row.id}`, kind: 'unverified', changes: turn ? turn.changes : null, ...at(row.created_at) });
    if (turn?.tasks.length) drawn.push({ key: `tasks:${row.id}`, kind: 'capsules', tasks: turn.tasks });
    return drawn;
  });
  if (sending !== null) items.push({ key: 'sending', kind: 'mine', text: sending, ...attachmentsOf(sendingAttachments) });
  if (items.length === 0) items.push({ key: 'empty', kind: 'empty' });
  return withDays(items, paired);
}

export function summaryLine({ delivered, running, waiting }: { delivered: number; running: number; waiting: number }): string {
  const parts: string[] = [];
  if (delivered) parts.push(t('proj.conv.summaryDelivered', { count: delivered }));
  if (running) parts.push(t('proj.conv.summaryRunning', { count: running }));
  if (waiting) parts.push(t('proj.conv.summaryWaiting', { count: waiting }));
  return parts.length ? t('proj.conv.summarySinceOpen', { details: parts.join(t('proj.conv.summarySep')) }) : '';
}
