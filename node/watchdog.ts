// State-aware round watchdog: reclaims hung processes after a formal `turn.end` event
// and aborts silent model/init stalls without false-killing running tools or active
// descendant subprocesses.
import { ADAPTERS } from '../adapters/all.ts';
import type { NormalizedEvent } from '../adapters/types.ts';

export const DEFAULT_POST_TURN_GRACE_MS = 20_000;

// Cap buffered bytes for a single unterminated stdout line so giant lines never grow
// unbounded in memory while still counting as progress.
const MAX_STDOUT_LINE_LENGTH = 1024 * 1024;

export type WatchdogPhase = 'waiting_model' | 'tool_running' | 'turn_ended';
export type WatchdogTriggerReason = 'turn_completed_hang' | 'model_idle';

export type WatchdogSnapshot = {
  phase: WatchdogPhase;
  activeTools: number;
  turnEnded: boolean;
  silentMs: number;
};

export interface RoundWatchdogOptions {
  executor?: string;
  parse?: (line: string) => NormalizedEvent[];
  modelIdleTimeoutMs?: number;
  postTurnGraceMs?: number;
  hasDescendantProcesses?: () => Promise<boolean>;
  onTrigger: (reason: WatchdogTriggerReason, detail: string) => void;
  onNote?: (message: string) => void;
  now?: () => number;
}

export interface RoundWatchdog {
  feedStdout(bytes: Uint8Array | string): void;
  feedStderr(bytes: Uint8Array | string): void;
  tick(): Promise<void>;
  snapshot(): WatchdogSnapshot;
  isTurnEnded(): boolean;
  dispose(): void;
}

function hasBytes(bytes: Uint8Array | string): boolean {
  return typeof bytes === 'string' ? bytes.length > 0 : bytes.byteLength > 0;
}

function resolveParser(options: RoundWatchdogOptions): ((line: string) => NormalizedEvent[]) | undefined {
  if (options.parse) return options.parse;
  if (options.executor && Object.hasOwn(ADAPTERS, options.executor)) {
    const adapter = ADAPTERS[options.executor]!;
    return (line: string) => adapter.parse(line);
  }
  return undefined;
}

export function createRoundWatchdog(options: RoundWatchdogOptions): RoundWatchdog {
  const now = options.now ?? Date.now;
  const parser = resolveParser(options);
  const modelIdleTimeoutMs = options.modelIdleTimeoutMs;
  const postTurnGraceMs = options.postTurnGraceMs ?? DEFAULT_POST_TURN_GRACE_MS;

  const activeTools = new Set<string>();
  const decoder = new TextDecoder('utf-8');

  let turnEnded = false;
  let lastProgressAt = now();
  let stdoutBuffer = '';
  let droppingOversizedLine = false;
  let triggered = false;
  let disposed = false;
  let checkingIdle = false;
  let descendantNotedAt: number | undefined;
  let postTurnTimer: ReturnType<typeof setTimeout> | undefined;

  const clearPostTurnTimer = (): void => {
    if (postTurnTimer !== undefined) {
      clearTimeout(postTurnTimer);
      postTurnTimer = undefined;
    }
  };

  const schedulePostTurn = (): void => {
    clearPostTurnTimer();
    if (disposed || triggered || postTurnGraceMs <= 0) return;
    postTurnTimer = setTimeout(() => {
      postTurnTimer = undefined;
      if (disposed || triggered || !turnEnded) return;
      triggered = true;
      options.onTrigger(
        'turn_completed_hang',
        '执行器已产出正式完成事件，但进程超过宽限期仍未退出，已自动回收并保留结果',
      );
    }, postTurnGraceMs);
    postTurnTimer.unref?.();
  };

  const processLine = (line: string): void => {
    if (!parser) return;
    let events: NormalizedEvent[];
    try {
      events = parser(line);
    } catch {
      return;
    }
    if (!Array.isArray(events)) return;
    for (const event of events) {
      if (event.kind === 'tool.start') {
        if (turnEnded) {
          clearPostTurnTimer();
          turnEnded = false;
        }
        activeTools.add(event.id);
      } else if (event.kind === 'tool.end') {
        activeTools.delete(event.id);
      } else if (event.kind === 'turn.end') {
        activeTools.clear();
        turnEnded = true;
        schedulePostTurn();
      }
    }
  };

  const feedStdout = (bytes: Uint8Array | string): void => {
    if (disposed || !hasBytes(bytes)) return;
    lastProgressAt = now();
    if (!parser) return;

    const text = typeof bytes === 'string' ? bytes : decoder.decode(bytes, { stream: true });
    let cursor = 0;
    while (cursor < text.length) {
      const nl = text.indexOf('\n', cursor);
      if (nl === -1) {
        if (!droppingOversizedLine) {
          const tail = text.slice(cursor);
          if (stdoutBuffer.length + tail.length > MAX_STDOUT_LINE_LENGTH) {
            stdoutBuffer = '';
            droppingOversizedLine = true;
          } else {
            stdoutBuffer += tail;
          }
        }
        break;
      }

      const segment = text.slice(cursor, nl);
      cursor = nl + 1;
      if (droppingOversizedLine) {
        droppingOversizedLine = false;
        stdoutBuffer = '';
        continue;
      }
      if (stdoutBuffer.length + segment.length > MAX_STDOUT_LINE_LENGTH) {
        stdoutBuffer = '';
        continue;
      }
      const line = (stdoutBuffer + segment).trim();
      stdoutBuffer = '';
      if (line.length > 0) processLine(line);
    }
  };

  const feedStderr = (bytes: Uint8Array | string): void => {
    if (disposed) return;
    if (hasBytes(bytes)) lastProgressAt = now();
  };

  const tick = async (): Promise<void> => {
    if (disposed || triggered || turnEnded || checkingIdle) return;
    if (!modelIdleTimeoutMs || modelIdleTimeoutMs <= 0) return;
    if (activeTools.size > 0) return;
    if (now() - lastProgressAt < modelIdleTimeoutMs) return;

    checkingIdle = true;
    try {
      let busy = false;
      if (options.hasDescendantProcesses) {
        try {
          busy = await options.hasDescendantProcesses();
        } catch {
          // Fail-safe: if the process table is unreadable, assume busy and never false-kill.
          busy = true;
        }
      }
      if (
        disposed ||
        triggered ||
        turnEnded ||
        activeTools.size > 0 ||
        now() - lastProgressAt < modelIdleTimeoutMs
      ) {
        return;
      }
      if (busy) {
        if (descendantNotedAt !== lastProgressAt) {
          descendantNotedAt = lastProgressAt;
          options.onNote?.('检测到活跃子进程仍在运行，跳过静默中止');
        }
        return;
      }
      triggered = true;
      options.onTrigger(
        'model_idle',
        `等待模型或初始化超过 ${Math.round(modelIdleTimeoutMs / 60000)} 分钟无进展且无运行中工具，已自动中止`,
      );
    } finally {
      checkingIdle = false;
    }
  };

  const snapshot = (): WatchdogSnapshot => {
    const phase: WatchdogPhase = turnEnded
      ? 'turn_ended'
      : activeTools.size > 0
        ? 'tool_running'
        : 'waiting_model';
    return {
      phase,
      activeTools: activeTools.size,
      turnEnded,
      silentMs: Math.max(0, now() - lastProgressAt),
    };
  };

  const isTurnEnded = (): boolean => turnEnded;

  const dispose = (): void => {
    disposed = true;
    clearPostTurnTimer();
  };

  return {
    feedStdout,
    feedStderr,
    tick,
    snapshot,
    isTurnEnded,
    dispose,
  };
}
