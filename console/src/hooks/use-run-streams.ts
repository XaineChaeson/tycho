// The site of a Task's Runs as the task page shows it: for each Run a snapshot of its
// events plus what the stream pushes after it, under one set of numbers. A stream is
// opened only for Runs that have not ended, and closed once they have; a hole in the
// numbers is filled by reading again, and a read that fails is retried and said. The record
// of a Run that is over and whose output was read whole never changes again: it is kept in the
// console's cache, so the page opened again draws it at once, in its first draw.
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from '@shared/i18n.ts';
import { api } from '@/lib/api';
import { createRunEvents, createTimelineReader } from '@/lib/timeline';
import type { NormalizedEvent, Run, RunEvents, RunSnapshot } from '@/lib/types';

interface Pushed {
  run_id: string;
  index: number;
  event: NormalizedEvent;
}

interface Site {
  logs: Map<string, ReturnType<typeof createRunEvents<NormalizedEvent>>>;
  snapshots: Map<string, RunSnapshot>;
  history: Map<string, string | null>;
}

const emptySite = (): Site => ({ logs: new Map(), snapshots: new Map(), history: new Map() });

interface RunRecord {
  events: RunEvents;
  snapshot: RunSnapshot;
}

const recordKey = (id: string) => ['run-record', id];

const readRecord = async (id: string): Promise<RunRecord> => {
  const [events, snapshot] = await Promise.all([
    api<RunEvents>(`/api/runs/${encodeURIComponent(id)}/events`),
    api<{ snapshot: RunSnapshot }>(`/api/runs/${encodeURIComponent(id)}/snapshot`),
  ]);
  return { events, snapshot: snapshot.snapshot };
};

// Over, and its output read to the end: nothing will be added to its record. A round judged
// gone (lost, or a stop settled after its machine was presumed or removed) may have more.
const lasting = (run: Run | undefined): boolean => run?.state === 'ended' && run.exit_kind !== 'lost' && run.error?.lost == null;
// Kept while the console is open for a while, not for ever: a long run's record is large.
const KEEP_MS = 30 * 60_000;

// A lasting Run's record is read once; one whose history could not be loaded is not kept.
async function recordOf(client: QueryClient, run: Run | undefined, id: string): Promise<RunRecord> {
  if (!lasting(run)) return readRecord(id);
  const record = await client.fetchQuery({ queryKey: recordKey(id), queryFn: () => readRecord(id), staleTime: Infinity, gcTime: KEEP_MS, meta: { lasting: true } });
  if (record.events.loaded === false || record.events.reason) client.removeQueries({ queryKey: recordKey(id), exact: true });
  return record;
}
const NO_EVENTS: NormalizedEvent[] = [];

export interface RunStreams {
  events(runId: string): NormalizedEvent[];
  snapshot(runId: string | undefined): RunSnapshot | undefined;
  // Why a finished Run's record could not be loaded, when it could not.
  history(runId: string): string | null;
  // What is wrong with reading the site right now, if anything.
  status: string | null;
}

export function useRunStreams(runs: readonly Run[] | undefined, selected: string | null): RunStreams {
  const client = useQueryClient();
  // One Run when one is picked, else all of them: the site is read again only when this changes.
  const key = selected ?? (runs ?? []).map((run) => run.id).join(',');
  const latest = useRef(runs);
  latest.current = runs;
  const site = useRef<Site>(emptySite());
  // The stream that is open, with the Runs it was opened for and how it is given up.
  const stream = useRef<{ ids: string[]; end: () => void } | null>(null);
  const [, redraw] = useState(0);
  const [status, setStatus] = useState<string | null>(null);

  // Before the page is painted: what the cache already holds is in the first draw.
  useLayoutEffect(() => {
    if (!key) return undefined;
    const all = latest.current ?? [];
    const ids = selected ? [selected] : all.map((run) => run.id);
    const current = emptySite();
    site.current = current;
    let open = true;
    const draw = (): void => { if (open) redraw((n) => n + 1); };
    const say = (text: string | null): void => { if (open) { setStatus(text); draw(); } };
    say(null);

    const logStatus = new Map<string, string>();
    const readerStatus = new Map<string, string>();
    let streamError = '';
    function publishStatus(): void {
      const next = streamError
        || [...readerStatus.values()].find(Boolean)
        || [...logStatus.values()].find(Boolean)
        || null;
      say(next);
    }

    function logOf(id: string) {
      let log = current.logs.get(id);
      if (!log) {
        log = createRunEvents<NormalizedEvent>({
          load: () => api<RunEvents>(`/api/runs/${encodeURIComponent(id)}/events`),
          onChange: draw,
          onStatus(message) {
            logStatus.set(id, message);
            publishStatus();
          },
        });
        current.logs.set(id, log);
      }
      return log;
    }

    function take({ id, events, snapshot }: RunRecord & { id: string }): void {
      logOf(id).reset(events);
      current.snapshots.set(id, snapshot);
      current.history.set(
        id,
        events.loaded === false
          ? t('core.runStreams.historyNotLoaded', { reason: events.reason ?? t('core.runStreams.unknownReason') })
          : events.reason ?? null,
      );
    }
    for (const id of ids) {
      const kept = client.getQueryData<RunRecord>(recordKey(id));
      if (kept && lasting(all.find((run) => run.id === id))) take({ id, ...kept });
    }

    // Isolate hydration per run so one failing old round never blocks or discards events
    // for a healthy live round.
    const readers = new Map<string, ReturnType<typeof createTimelineReader<RunRecord & { id: string }, Pushed>>>();
    for (const id of ids) {
      const reader = createTimelineReader<RunRecord & { id: string }, Pushed>({
        load: async () => ({ id, ...(await recordOf(client, (latest.current ?? all).find((run) => run.id === id), id)) }),
        onLoad(result) {
          if (!open) return;
          take(result);
          draw();
        },
        onEvent(payload) {
          if (!open) return;
          logOf(payload.run_id).push(payload);
          draw();
        },
        onStatus(message) {
          readerStatus.set(id, message);
          publishStatus();
        },
      });
      readers.set(id, reader);
    }

    // A Run that has ended has nothing more to push: its record is read once.
    const liveIds = ids.filter((id) => all.find((run) => run.id === id)?.state !== 'ended');
    const liveIdSet = new Set(liveIds);
    const source = liveIds.length ? new EventSource(`/api/stream?runs=${encodeURIComponent(liveIds.join(','))}`) : null;
    // Start REST hydration immediately for every run without waiting for EventSource onopen.
    for (const reader of readers.values()) void reader.read();

    if (source) {
      let openedOnce = false;
      source.addEventListener('run_event', (message) => {
        const payload = JSON.parse((message as MessageEvent<string>).data) as Pushed;
        if (open && liveIdSet.has(payload.run_id)) readers.get(payload.run_id)?.push(payload);
      });
      // On reconnect (or if initial read failed), re-read live runs to cover any gap.
      source.onopen = () => {
        streamError = '';
        publishStatus();
        if (openedOnce) {
          for (const id of liveIds) void readers.get(id)?.read();
        } else {
          openedOnce = true;
          for (const id of liveIds) {
            const reader = readers.get(id);
            if (reader?.isRetrying()) void reader.read();
          }
        }
      };
      source.onerror = () => {
        streamError = t('core.runStreams.disconnected');
        publishStatus();
      };
    }
    const mine = source ? {
      ids: liveIds,
      // What the Runs last pushed may have been on its way still: queue a trailing read on
      // every live run's reader, even if an earlier snapshot read is currently in flight.
      end: () => {
        source.close();
        streamError = '';
        publishStatus();
        for (const id of liveIds) void readers.get(id)?.read();
      },
    } : null;
    stream.current = mine;

    return () => {
      open = false;
      if (stream.current === mine) stream.current = null;
      for (const log of current.logs.values()) log.close();
      for (const reader of readers.values()) reader.close();
      source?.close();
    };
    // `selected` is in the key, and `runs` is read as it was when the key changed.
  }, [key]);

  // A Run that has ended pushes nothing more. Once none of the stream's Runs is still
  // going, the stream has no use and is closed; the site stays as it stands.
  const going = (runs ?? []).filter((run) => run.state !== 'ended').map((run) => run.id).join(',');
  useEffect(() => {
    const open = stream.current;
    if (!open || open.ids.some((id) => going.split(',').includes(id))) return;
    stream.current = null;
    open.end();
  }, [going]);

  return {
    events: (runId) => site.current.logs.get(runId)?.events() ?? NO_EVENTS,
    snapshot: (runId) => (runId === undefined ? undefined : site.current.snapshots.get(runId)),
    history: (runId) => site.current.history.get(runId) ?? null,
    status,
  };
}
