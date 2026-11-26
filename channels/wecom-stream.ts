// One reply to one inbound WeCom message, growing in one bubble.
//
// A frame replaces the bubble's content and its answer carries nothing but the req_id,
// so a req_id only ever has one frame in flight and only the newest snapshot is kept.
// Everything here is best effort on top of the Outbox: finish() says whether the final
// text got through, and on 'fallback' the caller pushes it the ordinary way.
export const STREAM_TIMING = {
  bodyMs: 1000,
  statusMs: 2000,
  timerMs: 5000,
  ackMs: 15_000,
  retryMs: 500,
  rotateMs: 5 * 60_000,
  // The gateway's own words are ">6 minutes"; its documentation's 10 minutes does not hold.
  expireMs: 6 * 60_000,
  silentMs: 30_000,
  // Something has to end a stream whose turn never comes, or it rotates for ever.
  abandonMs: 60 * 60_000,
};

export type StreamTiming = typeof STREAM_TIMING;

const ROTATE_BYTES = 18_000;
const MAX_TOOL_LINES = 8;
const FINISH_RETRIES = 3;
const STREAM_EXPIRED = new Set([846608, 846604]);
const VERSION_CONFLICT = 6000;
const ZERO_WIDTH_SPACE = '​';
const CONTINUED = '接上一条继续';
const ROTATED_EMPTY = '仍在处理，接下一条';
const ALREADY_SHOWN = '以上是全部内容';
const ABANDONED = '等得太久，这里不再刷新，结果出来后会单独发给你';
const NOTHING = '处理完了，没有内容';

export interface StreamClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const timers: Omit<StreamClock, 'now'> = {
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface StreamFrame {
  reqId: string;
  streamId: string;
  finish: boolean;
  content: string;
}

interface ReplyStreamOptions {
  reqId: string;
  // Rejects when the frame is refused; an `errcode` on the error is WeCom's own.
  send(frame: StreamFrame): Promise<void>;
  // Asked once per new stream.id: opening one counts as a message, a refresh does not.
  mayOpen(): boolean;
  newId(): string;
  // Optional transform applied to full text BEFORE bubble splitting (e.g. group URL redaction
  // so a private URL straddling a bubble boundary can never split past redaction).
  redact?: (text: string) => string;
  now?: () => number;
  clock?: StreamClock;
  timing?: Partial<StreamTiming>;
}

interface ToolEvent {
  name: string;
  phase: 'start' | 'end';
  isError: boolean;
}

interface ToolLine {
  name: string;
  outcome: '' | '完成' | '失败';
}

export interface Display {
  note?: string | undefined;
  queue?: string | undefined;
  tools?: string[];
  elapsed?: string | undefined;
  body?: string;
}

interface Shown {
  content: string;
  body: string;
  status: string;
}

interface Flight {
  seq: number;
  timer: unknown;
  done: Promise<number | undefined>;
  settle(code: number | undefined): void;
}

export function compose({ note, queue, tools = [], elapsed, body = '' }: Display): string {
  const lines = [note, queue, ...tools.slice(-MAX_TOOL_LINES), elapsed].filter((line) => line !== undefined);
  // A <think> in the model's words would open a block that nothing closes.
  const text = body.trim() ? body.replace(/<(\/?think)>/g, `<${ZERO_WIDTH_SPACE}$1>`) : '';
  if (lines.length === 0) return text || '<think></think>';
  return `<think>${lines.join('\n')}</think>${text && `\n\n${text}`}`;
}

export function elapsedText(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `已运行 ${minutes} 分 ${seconds % 60} 秒` : `已运行 ${seconds} 秒`;
}

const fitBytes = (text: string, bytes: number): string =>
  Buffer.from(text).subarray(0, bytes).toString().replace(/�+$/, '');

// At the last paragraph break that fits, else the last line break, else wherever the
// bytes run out. `rest` is what the next bubble has to show.
export function splitBody(text: string, maxBytes: number): { head: string; rest: string } {
  const fitting = fitBytes(text, maxBytes);
  const paragraph = fitting.lastIndexOf('\n\n');
  const cut = paragraph > 0 ? paragraph : fitting.lastIndexOf('\n');
  if (cut <= 0) return { head: fitting, rest: text.slice(fitting.length) };
  return { head: text.slice(0, cut), rest: text.slice(cut).replace(/^\n+/, '') };
}

const delivered = (code: number | undefined): boolean => code === 0 || code === VERSION_CONFLICT;

export class ReplyStream {
  readonly reqId: string;
  #send: ReplyStreamOptions['send'];
  #mayOpen: ReplyStreamOptions['mayOpen'];
  #newId: ReplyStreamOptions['newId'];
  #redact: ((text: string) => string) | undefined;
  #clock: StreamClock;
  #timing: StreamTiming;

  #startedAt: number;
  #streamId = '';
  #openedAt = 0;
  #body = '';
  #bodyAt: number;
  #queue: string | undefined;
  #tools: ToolLine[] = [];
  // What earlier bubbles closed with, so that the current one leaves it out.
  #closed = '';
  #continued = false;

  // Decides what still needs sending; a failed frame is not in it, so it goes out again.
  #acked: Shown | undefined;
  // A duplicate final is dropped by WeCom even when its first copy looked lost.
  #attempted: string | undefined;
  #frameAt = -Infinity;
  #seq = 0;
  #flight: Flight | undefined;
  #timer: unknown;
  #wake: (() => void) | undefined;
  #offline = false;
  #state: 'open' | 'closing' | 'over' = 'open';
  #endedAt: number | undefined;
  #result: Promise<'delivered' | 'fallback'> | undefined;

  constructor(options: ReplyStreamOptions) {
    this.reqId = options.reqId;
    this.#send = options.send;
    this.#mayOpen = options.mayOpen;
    this.#newId = options.newId;
    this.#redact = options.redact;
    this.#clock = options.clock ?? { now: options.now ?? Date.now, ...timers };
    this.#timing = { ...STREAM_TIMING, ...options.timing };
    this.#startedAt = this.#clock.now();
    this.#bodyAt = this.#startedAt;
    if (!this.#mayOpen()) {
      this.#end();
      return;
    }
    this.#openStream();
    this.#pump();
  }

  // When it stopped taking updates, for the table holding it to forget it later.
  get endedAt(): number | undefined {
    return this.#endedAt;
  }

  update(change: { body?: string; queue?: string | null }): void {
    if (change.queue !== undefined) this.#queue = change.queue ?? undefined;
    if (change.body !== undefined) {
      const nextBody = this.#redact ? this.#redact(change.body) : change.body;
      if (nextBody !== this.#body) {
        this.#body = nextBody;
        this.#bodyAt = this.#clock.now();
      }
    }
    this.#pump();
  }

  tool({ name, phase, isError }: ToolEvent): void {
    if (phase === 'start') {
      this.#tools.push({ name, outcome: '' });
      this.#tools = this.#tools.slice(-MAX_TOOL_LINES);
    } else {
      const line = this.#tools.findLast((each) => each.name === name && each.outcome === '');
      if (line) line.outcome = isError ? '失败' : '完成';
    }
    this.#pump();
  }

  // Asked again it gives the first answer: the Outbox repeats a row whose send was
  // fine but could not be recorded, and that must not mean a second final.
  finish(text: string): Promise<'delivered' | 'fallback'> {
    const safeText = this.#redact ? this.#redact(text) : text;
    this.#result ??= this.#deliver(safeText.trim() ? safeText : NOTHING).then((outcome) => {
      this.#end();
      return outcome;
    });
    return this.#result;
  }

  pause(): void {
    this.#offline = true;
    this.#disarm();
    this.#flight?.settle(undefined);
  }

  // The frame in flight at the break may or may not have arrived; the new connection
  // starts from the newest snapshot either way.
  resume(): void {
    this.#offline = false;
    this.#acked = undefined;
    this.#frameAt = -Infinity;
    this.#pump();
  }

  close(): void {
    this.#end();
    this.#flight?.settle(undefined);
    this.#wake?.();
  }

  #end(): void {
    this.#disarm();
    this.#state = 'over';
    this.#endedAt ??= this.#clock.now();
  }

  #openStream(): void {
    this.#streamId = this.#newId();
    this.#openedAt = this.#clock.now();
    this.#acked = undefined;
    this.#attempted = undefined;
    this.#frameAt = -Infinity;
  }

  #disarm(): void {
    this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #arm(ms: number): void {
    this.#timer = this.#clock.setTimeout(() => this.#pump(), ms);
  }

  #toolLines(): string[] {
    return this.#tools.map(({ name, outcome }) => `调用 ${name}…${outcome}`);
  }

  #note(): string | undefined {
    return this.#continued ? CONTINUED : undefined;
  }

  // What the current bubble has to show of a text. A final text need not extend the
  // drafts: those are every block of the turn, the result is only its last one.
  #unclosed(text: string): string {
    return text.startsWith(this.#closed) ? text.slice(this.#closed.length) : text;
  }

  #latest(at: number): Shown {
    const silent = at - this.#bodyAt >= this.#timing.silentMs;
    const body = this.#unclosed(this.#body);
    const display: Display = {
      note: this.#note(),
      queue: this.#queue,
      tools: this.#toolLines(),
      elapsed: silent ? elapsedText(at - this.#startedAt) : undefined,
      body,
    };
    return { content: compose(display), body, status: [this.#queue, ...this.#toolLines()].join('\n') };
  }

  #interval(next: Shown): number {
    const last = this.#acked;
    if (!last || last.body !== next.body) return this.#timing.bodyMs;
    return last.status === next.status ? this.#timing.timerMs : this.#timing.statusMs;
  }

  // Runs at every event that could make a frame due, and sets the wake-up for the next.
  #pump(): void {
    this.#disarm();
    if (this.#state !== 'open' || this.#offline || this.#flight) return;
    const at = this.#clock.now();
    if (at - this.#openedAt >= this.#timing.expireMs) {
      this.#end();
      return;
    }
    if (at - this.#startedAt >= this.#timing.abandonMs) {
      this.#end();
      void this.#transmit(compose({ tools: this.#toolLines(), body: ABANDONED }), true);
      return;
    }
    const next = this.#latest(at);
    const rotating =
      at - this.#openedAt >= this.#timing.rotateMs || Buffer.byteLength(next.content) > ROTATE_BYTES;
    if (!rotating && next.content === this.#acked?.content) {
      const quietAt = this.#bodyAt + this.#timing.silentMs;
      this.#arm(quietAt > at ? quietAt - at : this.#timing.timerMs);
      return;
    }
    const wait = this.#frameAt + (rotating ? this.#timing.bodyMs : this.#interval(next)) - at;
    if (wait > 0) this.#arm(wait);
    else if (rotating) this.#rotate();
    else void this.#transmit(next.content, false).then((code) => this.#afterFrame(next, code));
  }

  #afterFrame(frame: Shown, code: number | undefined): void {
    if (code !== undefined && STREAM_EXPIRED.has(code)) {
      this.#end();
      return;
    }
    if (delivered(code)) this.#acked = frame;
    this.#pump();
  }

  #closingFrame(body: string): { content: string; rest: string; consumed: number } {
    const shell = compose({ note: this.#note(), tools: this.#toolLines(), body: ZERO_WIDTH_SPACE });
    const { head, rest } = splitBody(body, ROTATE_BYTES - Buffer.byteLength(shell));
    const content = compose({
      note: this.#note(),
      tools: this.#toolLines(),
      body: head.trim() ? head : ROTATED_EMPTY,
    });
    return { content, rest, consumed: body.length - rest.length };
  }

  #continueOnNewStream(): void {
    this.#openStream();
    this.#continued = true;
  }

  // A closing frame that fails leaves everything on this stream, to be tried again at
  // the next wake-up: moving on would strand text in a bubble that may never have got it.
  #rotate(): void {
    const body = this.#unclosed(this.#body);
    const { content, consumed } = this.#closingFrame(body);
    void this.#transmit(content, true).then((code) => {
      if (code !== undefined && STREAM_EXPIRED.has(code)) {
        this.#end();
      } else if (!delivered(code)) {
        this.#pump();
      } else if (this.#mayOpen()) {
        this.#closed += body.slice(0, consumed);
        this.#continueOnNewStream();
        this.#pump();
      } else {
        this.#end();
      }
    });
  }

  #transmit(content: string, finish: boolean): Promise<number | undefined> {
    this.#seq += 1;
    const seq = this.#seq;
    const { promise, resolve } = Promise.withResolvers<number | undefined>();
    // The sequence number keeps a late answer or timeout away from the frame after it.
    const settle = (code: number | undefined): void => {
      if (this.#flight?.seq !== seq) return;
      this.#clock.clearTimeout(this.#flight.timer);
      this.#flight = undefined;
      resolve(code);
    };
    const timer = this.#clock.setTimeout(() => settle(undefined), this.#timing.ackMs);
    this.#flight = { seq, timer, done: promise, settle };
    this.#frameAt = this.#clock.now();
    this.#attempted = content;
    new Promise<void>((sent) => {
      sent(this.#send({ reqId: this.reqId, streamId: this.#streamId, finish, content }));
    }).then(
      () => settle(0),
      (err: { errcode?: number }) => settle(err?.errcode),
    );
    return promise;
  }

  #pauseFor(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = this.#clock.setTimeout(resolve, ms);
    this.#wake = () => {
      this.#clock.clearTimeout(timer);
      resolve();
    };
    return promise;
  }

  async #deliver(text: string): Promise<'delivered' | 'fallback'> {
    if (this.#state !== 'open') return 'fallback';
    this.#state = 'closing';
    this.#disarm();
    await this.#flight?.done;
    let body = this.#unclosed(text);
    for (;;) {
      // A second look: the frame just waited for may have ended the stream.
      if (this.#over()) return 'fallback';
      if (this.#clock.now() - this.#openedAt >= this.#timing.expireMs) return 'fallback';
      const whole = this.#finalFrame(body);
      if (Buffer.byteLength(whole) <= ROTATE_BYTES) return this.#lastFrame(whole);
      const { content, rest, consumed } = this.#closingFrame(body);
      const part = await this.#lastFrame(content);
      if (part !== 'delivered' || !rest.trim()) return part;
      if (!this.#mayOpen()) return 'fallback';
      this.#continueOnNewStream();
      body = body.slice(consumed);
    }
  }

  // A method: the compiler would otherwise carry its narrowing across the awaits.
  #over(): boolean {
    return this.#state === 'over';
  }

  #finalFrame(body: string): string {
    const shown = body.trim() ? body : ALREADY_SHOWN;
    return compose({ note: this.#note(), tools: this.#toolLines(), body: shown });
  }

  async #lastFrame(content: string): Promise<'delivered' | 'fallback'> {
    const frame = content === this.#attempted ? `${content}${ZERO_WIDTH_SPACE}` : content;
    for (let attempt = 0; ; attempt += 1) {
      const code = await this.#transmit(frame, true);
      if (delivered(code)) return 'delivered';
      if ((code !== undefined && STREAM_EXPIRED.has(code)) || attempt === FINISH_RETRIES) return 'fallback';
      if (this.#over()) return 'fallback';
      await this.#pauseFor(this.#timing.retryMs);
      if (this.#over()) return 'fallback';
    }
  }
}
