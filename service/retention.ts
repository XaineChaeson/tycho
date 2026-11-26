// What a finished work leaves on disk, cleared once its retention period has passed
// (docs/design/phase1-design.md "已结束的工作"): the host's registered copies under
// releases/<run>/, and each machine's copies of the Task's code under its task directory
// (one directory per source binding, `tasks/<task>/<binding_key>/`; the old names
// `tasks/<task>/<source id>/` and `tasks/<task>/repo/` are the same kind of copy).
// The ledger keeps every record — Tasks, Runs, registrations, changes — and says when each
// copy was cleared; only the bytes go.
//
// The two kinds are recorded in opposite orders, because the party that owns the bytes is
// not the same:
//
//   - The host's copies are this service's to see. One transaction marks the round
//     (run.releases_dropped_at) and audits it, and only then are the directories removed.
//     The mark is the commit point: a crash in between leaves a marked round whose
//     directories the next sweep removes. The ledger must never say "cleared" for bytes it
//     has not seen go.
//   - A machine's copy is the machine's. The ledger cannot look at it, and the command is
//     repeatable (a directory already gone is a success). So the machine confirms the removal
//     first, and run.code_dropped_at is written afterwards. A crash in between — the machine
//     answered, the ledger did not record it — leaves the mark missing; the next pass asks
//     again, gets success for the directory that is no longer there, and records it then.
//     That is why the command is idempotent.
//
// `code_dropped_at` is audit only: the timeline can say when a round's machine copy was
// confirmed gone. No page shows a machine copy's state — the host cannot verify it, and the
// ledger only knows what a machine said.
//
// One pass marks and sweeps the host's copies, then asks each machine that is here now and
// said it can for its copy of each due Task. The sweep runs every pass, also when nothing new
// came due, so a removal that failed last time is tried again. A machine that is away,
// removed, or too old to be asked is left alone and tried again later; a refusal is logged
// and nothing is recorded, so the next pass asks again. A pass does not start, and does not
// send its next command, while the service is stopping, degraded, or running its recovery
// inventory: the caller says so through `blocked`, and a pass that meets it stops where it is.
// Nothing is pushed and nobody is told: this is housekeeping, not an event.
import type { Ledger } from './ledger.ts';

export interface RetentionOptions {
  ledger: Pick<Ledger, 'dropDueReleases' | 'retentionDue' | 'noteTaskCodeDropped' | 'getMachine'>;
  // What this host knows of the machines: whether a client is here now, and whether it said
  // it can drop a Task's code copy (service/nodes.ts).
  nodes: { connected(machineId: string): boolean; reportedDropTaskCode(machineId: string): boolean };
  // The closed-set command that removes one Task's code copy on a machine.
  channel: { dropTaskCode(machineId: string, taskDir: string): Promise<void> };
  // What the ledger marked is removed by the acceptor's sweep, which also leaves alone what a
  // taking is writing right now. Called on every pass, not only one that marked something.
  sweep: () => void;
  // Whether a pass must not go on now: the service is stopping, degraded, or running its
  // recovery inventory. Read before the pass and before each machine command.
  blocked: () => boolean;
  // Read once at the start of a pass, so both kinds of cleanup judge the same moment.
  now?: () => Date;
  log: (line: string) => void;
}

export interface Retention {
  // One pass over both kinds of copy. Each half has its own guard: a failure in one is logged
  // and the other still runs, and nothing here may take the service down.
  runOnce(): Promise<void>;
}

export function createRetention(options: RetentionOptions): Retention {
  const { ledger, nodes, channel, blocked } = options;
  const now = (): Date => options.now?.() ?? new Date();
  // The pass under way, if one is: the timer and the start-up pass never overlap.
  let current: Promise<void> | undefined;

  // The host's copies: the ledger marks them and writes what it did in one transaction (its
  // commit point), then the sweep removes the directories. A sweep that cannot finish leaves
  // them to the next one; the mark is not undone. The sweep is called on every pass, also
  // when the ledger marked nothing new, because that is exactly what a previous failed
  // removal looks like.
  function dropHostCopies(at: Date): void {
    const marked = ledger.dropDueReleases(at);
    if (marked.length > 0) options.log(`保留期到了：账本记下清理 ${marked.length} 份主机上的登记产物`);
    options.sweep();
  }

  // One code copy per (Task, machine): every due round of a Task on one machine names the same
  // directory. Only a machine that is here now and said it can be told is asked, and only
  // while it is still the machine and node identity the round ran on.
  async function dropMachineCopies(at: Date): Promise<void> {
    const groups = new Map<string, { taskId: string; machineId: string; nodeId: string }>();
    for (const due of ledger.retentionDue(at)) {
      if (due.code_dropped_at !== null || due.machine_id === null || due.node_id === null) continue;
      const machine = ledger.getMachine(due.machine_id);
      if (machine === undefined || machine.nodeId !== due.node_id) continue;
      if (!nodes.connected(due.machine_id) || !nodes.reportedDropTaskCode(due.machine_id)) continue;
      groups.set(`${due.task_id}\u0000${due.machine_id}\u0000${due.node_id}`, { taskId: due.task_id, machineId: due.machine_id, nodeId: due.node_id });
    }
    for (const { taskId, machineId, nodeId } of groups.values()) {
      // A stop or a degraded ledger in the middle of a pass: send nothing more. What was
      // already confirmed and recorded stands.
      if (blocked()) return;
      try {
        await channel.dropTaskCode(machineId, `tasks/${taskId}`);
      } catch (err) {
        // A refusal (a round of it still has processes, the machine cannot say) and a
        // machine that went away are the same here: nothing is recorded, the next pass asks.
        options.log(`清理机器 ${machineId} 上任务 ${taskId} 的代码副本没做成，下次再试：${(err as Error).message}`);
        continue;
      }
      try {
        ledger.noteTaskCodeDropped(taskId, machineId, nodeId);
      } catch (err) {
        // The machine confirmed the bytes are gone; only the mark is missing. The next pass
        // asks again — the command is safe to repeat and a directory already gone is a
        // success — and records it then. Never let this escape: the ledger being closed as
        // part of a stop, or in degraded mode, is not a reason to fail the pass.
        options.log(`机器 ${machineId} 上任务 ${taskId} 的代码副本清掉了，账本没记下：${(err as Error).message}`);
      }
    }
  }

  async function pass(): Promise<void> {
    // Nothing at all while the service is stopping, degraded or recovering: a mark written
    // then could not be trusted, and the next start sweeps anyway.
    if (blocked()) return;
    const at = now();
    try {
      dropHostCopies(at);
    } catch (err) {
      options.log(`按保留期清理主机上的产物这一遍没有做完：${(err as Error).message}`);
    }
    if (blocked()) return;
    try {
      await dropMachineCopies(at);
    } catch (err) {
      options.log(`按保留期清理机器上的代码副本这一遍没有做完：${(err as Error).message}`);
    }
  }

  return {
    // One pass at a time: a pass still asking machines when the next hour comes round is not
    // doubled, and a caller that asks meanwhile gets that same pass's answer.
    runOnce(): Promise<void> {
      current ??= pass().finally(() => { current = undefined; });
      return current;
    },
  };
}
