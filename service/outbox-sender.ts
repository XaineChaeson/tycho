import type { Ledger } from './ledger.ts';
import { DeliveryUncertainError, type OutboxRow } from './outbox.ts';

const INTERVAL_MS = 2000;

export interface OutboxSenderOptions {
  outbox: Ledger['outbox'];
  // Returning a note records a skipped delivery without retrying it.
  channels: Record<string, (row: OutboxRow) => Promise<void | string>>;
  // Runs ahead of each round, also when the round itself cannot run.
  beforeRound?: () => void;
  // Nothing goes out until the inventory after a failure has finished.
  recovering?: () => boolean;
  // The retry settings, read at each failure.
  giveUpAfterMs: () => number;
  retryFirstMs: () => number;
  retryMaxMs: () => number;
  intervalMs?: number;
  log?: (line: string) => void;
}

export function createOutboxSender(options: OutboxSenderOptions) {
  const { outbox, beforeRound } = options;
  const log = options.log ?? ((line: string) => console.error(line));
  // The Console reads the ledger, so being recorded is being delivered.
  const channels: OutboxSenderOptions['channels'] = { console: async () => {}, ...options.channels };
  let timer: NodeJS.Timeout | undefined;
  let round: Promise<void> | undefined;
  let lastError: string | undefined;

  async function deliver(row: OutboxRow, send: (row: OutboxRow) => Promise<void | string>): Promise<void> {
    let failure: string | undefined;
    let uncertain = false;
    let note: void | string = undefined;
    try {
      note = await send(row);
    } catch (err) {
      failure = (err as Error).message;
      uncertain = err instanceof DeliveryUncertainError;
    }
    if (failure === undefined) outbox.markSent(row.id, typeof note === 'string' ? note : undefined);
    else if (uncertain) outbox.markUncertain(row.id, failure);
    else outbox.markFailed(row.id, failure, { giveUpAfterMs: options.giveUpAfterMs(), firstDelayMs: options.retryFirstMs(), maxDelayMs: options.retryMaxMs() });
  }

  // A write that fails ends the round: the next send could not be recorded either.
  async function runRound(): Promise<void> {
    try {
      beforeRound?.();
      for (const row of outbox.takeDue()) {
        const send = channels[row.channel];
        // Re-check row state immediately before sending: an earlier send in this batch may have
        // taken long enough for project deletion or owner confirmation to remove/settle this row.
        if (send && timer && !options.recovering?.() && outbox.isPending(row.id)) await deliver(row, send);
      }
      lastError = undefined;
    } catch (err) {
      const message = String(err);
      if (message !== lastError) log(`Outbox 发送暂停：${message}`);
      lastError = message;
    }
  }

  function tick(): void {
    round ??= runRound().finally(() => {
      round = undefined;
    });
  }

  return {
    start(): void {
      timer = setInterval(tick, options.intervalMs ?? INTERVAL_MS);
      timer.unref();
      tick();
    },

    async stop(): Promise<void> {
      clearInterval(timer);
      timer = undefined;
      await round;
    },
  };
}

export type OutboxSender = ReturnType<typeof createOutboxSender>;
