// What the console keeps in step with the service while it is open: the conversation,
// from a snapshot plus what the stream pushes, and the word that everything else has to
// be read again (`changed`, sent after every change the ledger commits: whatever is on
// screen is read again, the rest is marked stale). The stream is best effort: after a
// break the page reads the snapshot again and says when it last heard anything; it keeps
// no cursor.
import type { QueryClient } from '@tanstack/react-query';
import { t as translate } from '@shared/i18n.ts';
import { api, messageOf, post } from './api.ts';
import { hasTurn, processing, summaryLine } from './conversation.ts';
import { composeWithQuotes, MAX_COMPOSER_QUOTES, trimQuoteExcerpt, type ComposerQuote, type QuoteSourceKey } from './quotes.ts';
import type { Message, ProjectFileSummary, TurnChanges } from './types.ts';

const SNAPSHOT_SIZE = 50;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
// Changes come in bursts (a Run settles in several commits): one read again for all of them.
const GATHER_MS = 100;
const MAX_ATTACHMENTS = 8;
const MAX_KEPT_CONVERSATIONS = 16;
const MAX_BACKLOG_EVENTS = 250;
const MAX_LIVE_MESSAGES = 200;
const NO_CHANGES: TurnChanges = { changes: [], tasks: [] };
const TASK_DRAFTS_STORAGE_KEY = 'tycho.taskDrafts';

function loadTaskDrafts(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    if (typeof sessionStorage === 'undefined') return map;
    const raw = sessionStorage.getItem(TASK_DRAFTS_STORAGE_KEY);
    if (!raw) return map;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string' && value.length > 0) map.set(key, value);
      }
    }
  } catch {
    // Ignore storage access or JSON parse errors; in-memory map still works.
  }
  return map;
}

function syncTaskDrafts(map: ReadonlyMap<string, string>): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    if (map.size === 0) sessionStorage.removeItem(TASK_DRAFTS_STORAGE_KEY);
    else sessionStorage.setItem(TASK_DRAFTS_STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // Ignore storage quota or restricted-context errors.
  }
}

const focusKey = (focus: Focus): string => `${focus.project}/${focus.segment ?? ''}`;

// The conversation in view (docs/design/project-sessions.md §1): a project's segment, or the
// project's queue before it has one. What is typed is that project's draft.
interface Focus {
  project: string;
  segment: string | null;
}

export interface LiveState {
  focus: Focus | null;
  // Whether the conversation in view has been read since the console opened. Until it has,
  // the page shows the shape of what is coming. Each conversation keeps what was last read of
  // it: one shown again starts from that, and is read again behind it.
  loaded: boolean;
  messages: ReadonlyMap<string, Message>;
  changes: ReadonlyMap<string, TurnChanges>;
  connected: boolean;
  lastUpdate: number | null;
  // What the owner sent and the ledger has not shown back yet.
  sending: string | null;
  sendingAttachments: readonly ProjectFileSummary[];
  // What the owner has typed to the Router and not sent. Kept here and not by the page:
  // a walk to another page and back does not lose it.
  draft: string;
  attachments: readonly ProjectFileSummary[];
  quotes: readonly ComposerQuote[];
  // Why the draft is a text that was sent and came back.
  refused: string | null;
  // "Since you last opened": read once, before the first snapshot moves that moment.
  summary: string;
  error: string | null;
  // Increments when any per-task draft or quote changes so task composers re-sync cleanly.
  taskDraftVersion: number;
}

// The part of EventSource the console uses.
interface Source {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

// One round of connection: a stream from the moment it is opened until it breaks or the
// console stops, and the events it pushed while its snapshot was being read. They wait:
// the snapshot may already be older than they are.
interface Round {
  source: Source;
  reading: boolean;
  backlog: { key?: string; run: () => void }[];
  backlogOverflow: boolean;
}

interface PendingSend {
  project: string;
  segment: string | null;
  text: string;
  attachments: readonly ProjectFileSummary[];
  attachmentIds: readonly string[];
  row: string | null;
  awaiting: string | null;
}

interface LiveOptions {
  client: QueryClient;
  open?: (url: string) => Source;
  schedule?: (fn: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
  now?: () => number;
  // Waits out a burst of changes before reading again.
  gather?: (fn: () => void) => unknown;
}

export function createLive({
  client,
  open = (url) => new EventSource(url) as unknown as Source,
  schedule = (fn, delay) => setTimeout(fn, delay),
  cancel = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  now = Date.now,
  gather = (fn) => setTimeout(fn, GATHER_MS),
}: LiveOptions) {
  let state: LiveState = { focus: null, loaded: false, messages: new Map(), changes: new Map(), connected: false, lastUpdate: null, sending: null, sendingAttachments: [], draft: '', attachments: [], quotes: [], refused: null, summary: '', error: null, taskDraftVersion: 0 };
  const listeners = new Set<() => void>();
  // The round under way, if the console is connected or connecting. A read that comes
  // back to find another round, or none, belongs to a connection that is over: all of
  // it is dropped.
  let round: Round | undefined;
  // Pending optimistic sends scoped per project so Project A's send never appears in or
  // locks Project B's composer.
  const pendingSends = new Map<string, PendingSend>();
  let backoff = BACKOFF_START_MS;
  let timer: unknown;
  // Goes up on every start and stop: what an earlier run still has under way is dropped.
  let run = 0;
  // What was typed to each project's Router and not sent, while another one is in view.
  const drafts = new Map<string, string>();
  const draftAttachments = new Map<string, ProjectFileSummary[]>();
  const draftQuotes = new Map<string, ComposerQuote[]>();
  let nextQuoteSeq = 0;
  // What was typed & quoted into each task's follow-up/interjection composer, with revision
  // tracking so a late send ack never clears newer unsent edits.
  const taskDrafts = loadTaskDrafts();
  const taskQuotes = new Map<string, ComposerQuote[]>();
  const taskDraftRevisions = new Map<string, number>();
  // And why a text of a project's came back, while another one is in view.
  const refusals = new Map<string, string>();
  // What was last shown of each conversation read since the console opened (bounded LRU).
  const kept = new Map<string, Pick<LiveState, 'messages' | 'changes'>>();
  let gathering = false;

  const rememberConversation = (key: string, entry: Pick<LiveState, 'messages' | 'changes'>): void => {
    kept.delete(key);
    kept.set(key, entry);
    if (kept.size > MAX_KEPT_CONVERSATIONS) {
      const oldest = kept.keys().next().value;
      if (oldest !== undefined) kept.delete(oldest);
    }
  };

  const pendingForFocus = (focus: Focus | null): PendingSend | undefined => {
    if (!focus) return undefined;
    const pending = pendingSends.get(focus.project);
    if (!pending) return undefined;
    // Match exact segment, or a project queue that just created its first segment.
    if (pending.segment === null || focus.segment === null || pending.segment === focus.segment) {
      return pending;
    }
    return undefined;
  };

  const bumpTaskDraftRevision = (taskId: string): number => {
    const next = (taskDraftRevisions.get(taskId) ?? 0) + 1;
    taskDraftRevisions.set(taskId, next);
    set({ taskDraftVersion: state.taskDraftVersion + 1 });
    return next;
  };

  // What a snapshot reads: the segment in view, the project's queue before its first segment,
  // or the newest messages when no conversation is in view.
  const snapshotUrl = (focus: Focus | null): string =>
    focus?.segment ? `/api/messages?segment=${encodeURIComponent(focus.segment)}&limit=${SNAPSHOT_SIZE}`
      : focus ? `/api/messages?project=${encodeURIComponent(focus.project)}&limit=${SNAPSHOT_SIZE}`
        : `/api/messages?limit=${SNAPSHOT_SIZE}`;

  function set(patch: Partial<LiveState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  const showError = (text: string | null): void => { if (text !== state.error) set({ error: text }); };
  const refresh = (...keys: string[]): void => { for (const key of keys) void client.invalidateQueries({ queryKey: [key] }); };
  // The one way anything the console has read is read again after a change: what is on
  // screen now, the rest when it is next shown. A read under way is begun again, so the
  // answer is never older than the change.
  function invalidate(): void {
    if (gathering) return;
    gathering = true;
    gather(() => {
      gathering = false;
      // What never changes once read (a Run that is over, read whole) is not read again.
      void client.invalidateQueries({ predicate: (query) => query.meta?.lasting !== true });
    });
  }

  async function refreshChanges(id: string): Promise<void> {
    const mine = round;
    const targetFocus = state.focus ? focusKey(state.focus) : null;
    const turn = await api<TurnChanges>(`/api/messages/${id}/changes`);
    if (mine === round && (state.focus ? focusKey(state.focus) : null) === targetFocus) {
      set({ changes: new Map(state.changes).set(id, turn) });
    }
  }

  // False when the round ended while its snapshot was read: nothing of it was kept. Once the
  // stream is (re)connected, everything else is read again too; a conversation brought into
  // view reads only its own messages.
  async function snapshot(mine: Round, connecting: boolean): Promise<boolean> {
    mine.reading = true;
    const url = snapshotUrl(state.focus);
    try {
      const { messages, changes: committed = {} } = await api<{ messages: Message[]; changes?: Record<string, TurnChanges> }>(url);
      if (mine !== round) return false;
      // Another conversation came into view meanwhile: this read is not about it.
      if (snapshotUrl(state.focus) !== url) {
        mine.reading = false;
        return await snapshot(mine, connecting);
      }
      // With no conversation in view the read is only what tells the service the owner has seen
      // the picture ("since you last opened"); its rows are nobody's to show.
      if (state.focus === null) set({ lastUpdate: now() });
      else {
        const turns = messages.filter(hasTurn);
        set({
          messages: new Map(messages.map((row) => [row.id, row])),
          changes: new Map(turns.map(({ id }) => [id, committed[id] ?? NO_CHANGES])),
          loaded: true,
          lastUpdate: now(),
        });
      }
      // Also the first time: what changed between the page's own read and this stream
      // being opened was pushed to nobody.
      if (connecting) invalidate();
      return true;
    } catch (err) {
      if (mine !== round) return false;
      // If the user already switched to another conversation while this read failed, never
      // leave the new conversation stranded on a skeleton — read the new conversation instead.
      if (snapshotUrl(state.focus) !== url) {
        mine.reading = false;
        return await snapshot(mine, connecting);
      }
      throw err;
    } finally {
      // Only what is this round's own: a later round has its own backlog and its own read.
      mine.reading = false;
      const waiting = mine.backlog;
      const overflowed = mine.backlogOverflow;
      mine.backlog = [];
      mine.backlogOverflow = false;
      if (mine === round) {
        if (overflowed) {
          void snapshot(mine, false).catch((err: unknown) => showError(messageOf(err)));
        } else {
          for (const item of waiting) item.run();
        }
      }
    }
  }

  function settleSending(project: string, id: string): void {
    const pending = pendingSends.get(project);
    if (!pending || pending.awaiting !== id) return;
    pendingSends.delete(project);
    if (state.focus?.project === project) {
      set({ sending: null, sendingAttachments: [] });
    }
  }

  function sameAttachmentIds(row: Message, expected: readonly string[]): boolean {
    if (row.attachments === undefined) return expected.length === 0;
    if (row.attachments.length !== expected.length) return false;
    if (expected.length === 0) return true;
    const actualIds = new Set(row.attachments.map((att) => att.id));
    return actualIds.size === expected.length && expected.every((id) => actualIds.has(id));
  }

  const withBoundedMessage = (map: ReadonlyMap<string, Message>, row: Message): Map<string, Message> => {
    const next = new Map(map);
    next.set(row.id, row);
    if (next.size > MAX_LIVE_MESSAGES) {
      const activeProject = state.focus?.project ?? null;
      // Prefer evicting messages belonging to non-focused projects first so unrelated traffic
      // never grows unboundedly or pushes the active conversation out of memory.
      for (const [id, msg] of next) {
        if (next.size <= MAX_LIVE_MESSAGES) break;
        if (activeProject !== null && msg.project_id != null && msg.project_id !== activeProject) {
          next.delete(id);
        }
      }
      for (const id of next.keys()) {
        if (next.size <= MAX_LIVE_MESSAGES) break;
        next.delete(id);
      }
    }
    return next;
  };

  function onMessage(row: Message): void {
    // Settle any project's matching pending send even if another project is currently focused.
    for (const [projectId, pending] of pendingSends) {
      if (
        pending.row === null
        && row.direction === 'in'
        && row.channel === 'console'
        && (row.project_id === undefined || row.project_id === projectId)
        && row.text === pending.text
        && sameAttachmentIds(row, pending.attachmentIds)
      ) {
        pending.row = row.id;
        pending.awaiting = row.id;
      }
      if (pending.awaiting === row.id) {
        settleSending(projectId, row.id);
      }
    }

    const existing = state.messages.get(row.id);
    // An unhydrated status update (`processing`/`processed`) must never wipe attachments
    // already attached to the known row.
    const merged = row.attachments === undefined && existing?.attachments?.length
      ? { ...row, attachments: existing.attachments }
      : row;
    set({ messages: withBoundedMessage(state.messages, merged) });
    if (hasTurn(merged)) refreshChanges(merged.id).catch(() => undefined);
  }

  // A draft says which request it answers, in which project and segment: several projects'
  // Routers write at once, so nothing is guessed from whichever message is being handled.
  function onDelta({ message_id: id, text, reply_to: replyTo, project_id: project, segment_id: segment }: {
    message_id: string; text: string; reply_to?: string; project_id?: string | null; segment_id?: string | null;
  }): void {
    const known = state.messages.get(id);
    if (known?.final === 1) return;
    // The first draft of a reply arrives before any row for it has been pushed.
    const row: Message = known ? { ...known, text }
      : { id, direction: 'out', external_id: replyTo ? `reply:${replyTo}` : `out:${id}`, text, final: 0, state: null, project_id: project ?? null, segment_id: segment ?? null };
    set({ messages: withBoundedMessage(state.messages, row) });
  }

  function onTask({ id, state: taskState }: { id: string; state: string }): void {
    // The capsules say the new state at once; the rest is read again on the `changed` the
    // same commit sends.
    const changes = new Map<string, TurnChanges>();
    for (const [messageId, turn] of state.changes) {
      changes.set(messageId, { ...turn, tasks: turn.tasks.map((task) => (task.id === id ? { ...task, state: taskState } : task)) });
    }
    set({ changes });
    const turn = processing(state.messages.values());
    if (turn) refreshChanges(turn.id).catch(() => undefined);
  }

  function enqueueBacklog(mine: Round, entry: { key?: string; run: () => void }): void {
    if (entry.key) {
      const idx = mine.backlog.findIndex((item) => item.key === entry.key);
      if (idx !== -1) {
        mine.backlog[idx] = entry;
        return;
      }
    }
    if (mine.backlog.length >= MAX_BACKLOG_EVENTS) {
      mine.backlogOverflow = true;
      return;
    }
    mine.backlog.push(entry);
  }

  function connect(token: number): void {
    if (token !== run) return;
    const mine: Round = { source: open('/api/stream'), reading: false, backlog: [], backlogOverflow: false };
    round = mine;
    const on = <T>(type: string, handler: (data: T) => void, coalesceKey?: (data: T) => string | undefined): void => mine.source.addEventListener(type, (event) => {
      const data = JSON.parse(event.data) as T;
      set({ lastUpdate: now() });
      if (mine.reading) {
        const key = coalesceKey?.(data);
        enqueueBacklog(mine, { ...(key ? { key } : {}), run: () => handler(data) });
      } else {
        handler(data);
      }
    });
    on<{ message_id: string; text: string; reply_to?: string; project_id?: string | null; segment_id?: string | null }>(
      'delta',
      onDelta,
      (d) => `delta:${d.message_id}`,
    );
    on('message', onMessage);
    on('task', onTask);
    on('changed', invalidate, () => 'changed');
    mine.source.onopen = () => {
      snapshot(mine, true).then(
        (keptSnapshot) => {
          if (!keptSnapshot) return;
          backoff = BACKOFF_START_MS;
          set({ connected: true });
        },
        (err: unknown) => {
          if (mine !== round) return;
          showError(messageOf(err));
          // The reason may be one the banner explains, and state answers when little else does.
          refresh('state');
          retry(mine);
        },
      );
    };
    mine.source.onerror = () => retry(mine);
  }

  // From 1 second to 30, doubling: the service may be restarting, or the network gone.
  // The broken stream is closed before anything else: a browser would connect it again
  // by itself, and there would be two.
  function retry(failed: Round): void {
    if (failed !== round) return;
    const token = run;
    failed.source.close();
    round = undefined;
    // Sent messages already accepted by POST never get their SSE event now; reconnect snapshot shows them.
    for (const [projectId, pending] of [...pendingSends]) {
      if (pending.awaiting) settleSending(projectId, pending.awaiting);
    }
    set({ connected: false });
    timer = schedule(() => {
      timer = undefined;
      // EventSource hides the status; this is how an expired login is noticed.
      api('/api/state').catch(() => undefined);
      connect(token);
    }, backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: (): LiveState => state,
    showError,

    start(): void {
      const token = ++run;
      // Before the first snapshot: reading one is what moves "last opened" forward.
      api<{ delivered: number; running: number; waiting: number }>('/api/summary')
        .then((counts) => { if (token === run) set({ summary: summaryLine(counts) }); }, (err: unknown) => { if (token === run) showError(messageOf(err)); })
        .finally(() => connect(token));
    },

    stop(): void {
      run += 1;
      if (timer !== undefined) cancel(timer);
      timer = undefined;
      round?.source.close();
      round = undefined;
      backoff = BACKOFF_START_MS;
    },

    // What is typed to the Router. Typing over a text that came back lets its reason go.
    type(text: string): void {
      if (state.focus) {
        drafts.set(state.focus.project, text);
        refusals.delete(state.focus.project);
      }
      set({ draft: text, refused: null });
    },

    addAttachment(file: ProjectFileSummary): void {
      const projectId = file.project_id || state.focus?.project;
      if (!projectId) {
        if (state.attachments.some((existing) => existing.id === file.id)) return;
        if (state.attachments.length >= MAX_ATTACHMENTS) return;
        set({ attachments: [...state.attachments, file], refused: null });
        return;
      }
      const isFocused = state.focus?.project === projectId;
      const current = isFocused ? state.attachments : (draftAttachments.get(projectId) ?? []);
      if (current.some((existing) => existing.id === file.id)) return;
      if (current.length >= MAX_ATTACHMENTS) return;
      const next = [...current, file];
      draftAttachments.set(projectId, next);
      refusals.delete(projectId);
      if (isFocused) {
        set({ attachments: next, refused: null });
      }
    },

    removeAttachment(fileId: string): void {
      const next = state.attachments.filter((existing) => existing.id !== fileId);
      if (next.length === state.attachments.length) return;
      if (state.focus) {
        if (next.length > 0) draftAttachments.set(state.focus.project, next);
        else draftAttachments.delete(state.focus.project);
        refusals.delete(state.focus.project);
      }
      set({ attachments: next, refused: null });
    },

    addQuote(input: { source: string; sourceKey?: QuoteSourceKey; excerpt: string }, targetProject?: string): boolean {
      const excerpt = trimQuoteExcerpt(input.excerpt);
      if (!excerpt) return false;
      const quote: ComposerQuote = {
        id: `q-${++nextQuoteSeq}`,
        source: input.source.trim(),
        ...(input.sourceKey ? { sourceKey: input.sourceKey } : {}),
        excerpt,
        reply: '',
      };
      const projectId = targetProject ?? state.focus?.project;
      if (!projectId) {
        if (state.quotes.length >= MAX_COMPOSER_QUOTES) return false;
        set({ quotes: [...state.quotes, quote], refused: null });
        return true;
      }
      const isFocused = state.focus?.project === projectId;
      const current = isFocused ? state.quotes : (draftQuotes.get(projectId) ?? []);
      if (current.length >= MAX_COMPOSER_QUOTES) return false;
      const next = [...current, quote];
      draftQuotes.set(projectId, next);
      refusals.delete(projectId);
      if (isFocused) set({ quotes: next, refused: null });
      return true;
    },

    updateQuoteReply(quoteId: string, reply: string): void {
      let changed = false;
      const next = state.quotes.map((existing) => {
        if (existing.id !== quoteId) return existing;
        changed = true;
        return { ...existing, reply };
      });
      if (!changed) return;
      if (state.focus) {
        draftQuotes.set(state.focus.project, next);
        refusals.delete(state.focus.project);
      }
      set({ quotes: next, refused: null });
    },

    removeQuote(quoteId: string): void {
      const next = state.quotes.filter((existing) => existing.id !== quoteId);
      if (next.length === state.quotes.length) return;
      if (state.focus) {
        if (next.length > 0) draftQuotes.set(state.focus.project, next);
        else draftQuotes.delete(state.focus.project);
        refusals.delete(state.focus.project);
      }
      set({ quotes: next, refused: null });
    },

    clearQuotes(): void {
      if (state.quotes.length === 0) return;
      if (state.focus) draftQuotes.delete(state.focus.project);
      set({ quotes: [] });
    },

    // Begins a text for a project's Router, which may not be the one in view yet.
    typeFor(project: string | null, text: string): void {
      if (project === null || state.focus?.project === project) {
        set({ draft: text, refused: null });
        if (state.focus) drafts.set(state.focus.project, text);
        return;
      }
      drafts.set(project, text);
      refusals.delete(project);
    },

    getTaskDraft(taskId: string): string {
      return taskDrafts.get(taskId) ?? '';
    },

    getTaskDraftRevision(taskId: string): number {
      return taskDraftRevisions.get(taskId) ?? 0;
    },

    setTaskDraft(taskId: string, text: string): number {
      if (!taskId) return 0;
      if (text === '') taskDrafts.delete(taskId);
      else taskDrafts.set(taskId, text);
      syncTaskDrafts(taskDrafts);
      return bumpTaskDraftRevision(taskId);
    },

    getTaskQuotes(taskId: string): readonly ComposerQuote[] {
      return taskQuotes.get(taskId) ?? [];
    },

    addTaskQuote(taskId: string, input: { source: string; sourceKey?: QuoteSourceKey; excerpt: string }): boolean {
      if (!taskId) return false;
      const excerpt = trimQuoteExcerpt(input.excerpt);
      if (!excerpt) return false;
      const current = taskQuotes.get(taskId) ?? [];
      if (current.length >= MAX_COMPOSER_QUOTES) return false;
      const quote: ComposerQuote = {
        id: `tq-${++nextQuoteSeq}`,
        source: input.source.trim(),
        ...(input.sourceKey ? { sourceKey: input.sourceKey } : {}),
        excerpt,
        reply: '',
      };
      taskQuotes.set(taskId, [...current, quote]);
      bumpTaskDraftRevision(taskId);
      return true;
    },

    updateTaskQuoteReply(taskId: string, quoteId: string, reply: string): void {
      const current = taskQuotes.get(taskId);
      if (!current) return;
      let changed = false;
      const next = current.map((existing) => {
        if (existing.id !== quoteId) return existing;
        changed = true;
        return { ...existing, reply };
      });
      if (!changed) return;
      taskQuotes.set(taskId, next);
      bumpTaskDraftRevision(taskId);
    },

    removeTaskQuote(taskId: string, quoteId: string): void {
      const current = taskQuotes.get(taskId);
      if (!current) return;
      const next = current.filter((existing) => existing.id !== quoteId);
      if (next.length === current.length) return;
      if (next.length > 0) taskQuotes.set(taskId, next);
      else taskQuotes.delete(taskId);
      bumpTaskDraftRevision(taskId);
    },

    clearTaskQuotes(taskId: string): void {
      if (!taskId || !taskQuotes.has(taskId)) return;
      taskQuotes.delete(taskId);
      bumpTaskDraftRevision(taskId);
    },

    clearTaskDraft(taskId: string, expectedRevision?: number): boolean {
      if (!taskId) return false;
      const currentRev = taskDraftRevisions.get(taskId) ?? 0;
      if (expectedRevision !== undefined && currentRev !== expectedRevision) {
        return false;
      }
      const hadAnything = taskDrafts.has(taskId) || taskQuotes.has(taskId);
      taskDrafts.delete(taskId);
      taskQuotes.delete(taskId);
      syncTaskDrafts(taskDrafts);
      if (hadAnything) bumpTaskDraftRevision(taskId);
      return true;
    },

    // Brings a conversation into view: its own messages are read again, and the box holds what
    // was typed to that project's Router before. Null: none is in view.
    focusOn(focus: Focus | null): void {
      const same = (focus?.project ?? null) === (state.focus?.project ?? null) && (focus?.segment ?? null) === (state.focus?.segment ?? null);
      if (same) return;
      if (state.focus) {
        drafts.set(state.focus.project, state.draft);
        if (state.attachments.length > 0) draftAttachments.set(state.focus.project, [...state.attachments]);
        else draftAttachments.delete(state.focus.project);
        if (state.quotes.length > 0) draftQuotes.set(state.focus.project, [...state.quotes]);
        else draftQuotes.delete(state.focus.project);
        if (state.refused === null) refusals.delete(state.focus.project);
        else refusals.set(state.focus.project, state.refused);
      }
      const draft = focus ? drafts.get(focus.project) ?? '' : '';
      const attachments = focus ? draftAttachments.get(focus.project) ?? [] : [];
      const quotes = focus ? draftQuotes.get(focus.project) ?? [] : [];
      const refused = focus ? refusals.get(focus.project) ?? null : null;
      if (state.focus && state.loaded) rememberConversation(focusKey(state.focus), { messages: state.messages, changes: state.changes });
      // A project's queue that has just been given its first segment is the same conversation.
      const grown = focus !== null && state.loaded && state.focus?.project === focus.project && state.focus.segment === null;
      const back = focus === null ? undefined : grown ? { messages: state.messages, changes: state.changes } : kept.get(focusKey(focus));
      const pending = pendingForFocus(focus);
      set({
        focus,
        draft,
        attachments,
        quotes,
        refused,
        sending: pending?.text ?? null,
        sendingAttachments: pending?.attachments ?? [],
        loaded: back !== undefined,
        messages: back?.messages ?? new Map(),
        changes: back?.changes ?? new Map(),
      });
      const mine = round;
      if (focus && mine && !mine.reading) snapshot(mine, false).catch((err: unknown) => showError(messageOf(err)));
    },

    // Sends the draft. False when the service did not take it: the text is the draft
    // again, with the reason.
    async send(): Promise<boolean> {
      const rawDraft = state.draft;
      const quotes = state.quotes;
      const text = composeWithQuotes(rawDraft, quotes, translate);
      const attachments = state.attachments;
      const project = state.focus?.project;
      const segment = state.focus?.segment ?? null;
      if (project === undefined) {
        if (text.trim() === '' && attachments.length === 0) return false;
        set({ refused: translate('core.live.requireProjectPage') });
        return false;
      }
      if ((text.trim() === '' && attachments.length === 0) || pendingSends.has(project)) return false;
      drafts.delete(project);
      draftAttachments.delete(project);
      draftQuotes.delete(project);
      const attachmentIds = attachments.map((file) => file.id);
      const pending: PendingSend = { project, segment, text, attachments, attachmentIds, row: null, awaiting: null };
      pendingSends.set(project, pending);
      set({ sending: text, sendingAttachments: attachments, draft: '', attachments: [], quotes: [], refused: null, error: null });
      try {
        const body = attachmentIds.length > 0
          ? { text, project_id: project, attachment_ids: attachmentIds }
          : { text, project_id: project };
        const { id } = await post<{ id: string }>('/api/messages', body);
        // Its row may be here already and the pending text gone with it. Otherwise the
        // event is awaited; with no stream it will never come.
        if (pending.row === null) {
          pending.awaiting = id;
          const alreadyPresent = state.focus?.project === project && state.messages.has(id);
          if (alreadyPresent || !state.connected) settleSending(project, id);
        }
        return true;
      } catch (err) {
        if (pendingSends.get(project) === pending) {
          pendingSends.delete(project);
        }
        // Ahead of anything begun meanwhile from another page: neither text nor attachments are lost.
        // Back in that project's box, ahead of anything typed there since.
        const isFocused = state.focus?.project === project;
        const back = [rawDraft, isFocused ? state.draft : drafts.get(project) ?? ''].filter(Boolean).join('\n');
        const currentAttachments = isFocused ? state.attachments : draftAttachments.get(project) ?? [];
        const currentQuotes = isFocused ? state.quotes : draftQuotes.get(project) ?? [];
        const mergedQuotes = [...quotes, ...currentQuotes].slice(0, MAX_COMPOSER_QUOTES);
        const mergedAttachments: ProjectFileSummary[] = [];
        for (const item of [...attachments, ...currentAttachments]) {
          if (!mergedAttachments.some((existing) => existing.id === item.id) && mergedAttachments.length < MAX_ATTACHMENTS) {
            mergedAttachments.push(item);
          }
        }
        if (isFocused) {
          if (mergedAttachments.length > 0) draftAttachments.set(project, mergedAttachments);
          if (mergedQuotes.length > 0) draftQuotes.set(project, mergedQuotes);
          set({ sending: null, sendingAttachments: [], draft: back, attachments: mergedAttachments, quotes: mergedQuotes, refused: messageOf(err) });
        } else {
          drafts.set(project, back);
          if (mergedAttachments.length > 0) draftAttachments.set(project, mergedAttachments);
          if (mergedQuotes.length > 0) draftQuotes.set(project, mergedQuotes);
          refusals.set(project, messageOf(err));
        }
        return false;
      }
    },
  };
}

export type Live = ReturnType<typeof createLive>;
