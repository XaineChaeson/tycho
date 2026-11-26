import type { Reading } from './types.ts';

export interface ResultLimits {
  recordBytes: number;
  stateBytes: number;
  stderrBytes: number;
}

export interface ResultReader {
  feedStdout(bytes: Uint8Array): void;
  feedStderr(bytes: Uint8Array): void;
  finish(exitCode: number | null): Reading;
}

export class ResultLimitError extends Error {
  readonly dimension: keyof ResultLimits;
  readonly limit: number;
  readonly attempted: number;

  constructor(dimension: keyof ResultLimits, limit: number, attempted: number) {
    super(`Incremental result incomplete: ${dimension} limit ${limit}, observed ${attempted}`);
    this.name = 'ResultLimitError';
    this.dimension = dimension;
    this.limit = limit;
    this.attempted = attempted;
  }
}

// Both raw streams use owned blocks: one-byte input chunks never become one object each.
// Payload limits do not measure V8 object overhead or promise an RSS limit.
const BLOCK_BYTES = 16 * 1024;
class ResultBytes {
  private blocks: Buffer[] = [];
  private used = 0;
  size = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  append(input: Uint8Array): void {
    let at = 0;
    while (at < input.byteLength) {
      let last = this.blocks.at(-1);
      if (!last || this.used === last.length) {
        last = Buffer.allocUnsafe(Math.min(BLOCK_BYTES, this.capacity - this.size));
        this.blocks.push(last);
        this.used = 0;
      }
      const take = Math.min(input.byteLength - at, last.length - this.used);
      last.set(input.subarray(at, at + take), this.used);
      at += take;
      this.used += take;
      this.size += take;
    }
  }

  text(): string {
    const bytes = Buffer.allocUnsafe(this.size);
    let at = 0;
    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i]!;
      const take = i === this.blocks.length - 1 ? this.used : block.length;
      block.copy(bytes, at, 0, take);
      at += take;
    }
    return bytes.toString('utf8');
  }

  clear(): void {
    this.blocks = [];
    this.used = 0;
    this.size = 0;
  }
}

interface ResultState {
  // True when this record changed retained result state; ignored records need no recount.
  line(text: string): boolean;
  state(): unknown;
  finish(exitCode: number | null, stderr: string): Reading;
}

export function createResultReader(reducer: ResultState, given?: ResultLimits): ResultReader;
export function createResultReader(reducer: ResultState | undefined, given?: ResultLimits): ResultReader {
  const limits = given === undefined ? undefined : { ...given };
  if (limits) {
    for (const name of ['recordBytes', 'stateBytes', 'stderrBytes'] as const) {
      if (!Number.isSafeInteger(limits[name]) || limits[name] < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }
  const record = new ResultBytes(limits?.recordBytes ?? Infinity);
  const stderr = new ResultBytes(limits?.stderrBytes ?? Infinity);
  let ended = false;
  let failed = false;
  let failure: unknown;

  function release(): void {
    record.clear();
    stderr.clear();
    reducer = undefined;
  }

  function fail(error: unknown): never {
    failed = true;
    failure = error;
    release();
    throw error;
  }

  function guard(): void {
    if (failed) throw failure;
    if (ended) throw new Error('Result reader already finished');
  }

  function bound(dimension: keyof ResultLimits, size: number): void {
    if (limits && size > limits[dimension]) throw new ResultLimitError(dimension, limits[dimension], size);
  }

  function measure(value: unknown): void {
    if (limits) bound('stateBytes', Buffer.byteLength(JSON.stringify(value)));
  }

  function part(bytes: Uint8Array, complete: boolean): void {
    bound('recordBytes', record.size + bytes.byteLength);
    if (!complete) {
      record.append(bytes);
      return;
    }
    let text: string;
    if (record.size === 0) text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
    else {
      record.append(bytes);
      text = record.text();
      record.clear();
    }
    if (reducer!.line(text)) measure(reducer!.state());
  }

  return {
    feedStdout(input) {
      guard();
      try {
        const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
        let start = 0;
        for (;;) {
          const end = bytes.indexOf(10, start);
          if (end < 0) break;
          part(bytes.subarray(start, end), true);
          start = end + 1;
        }
        part(bytes.subarray(start), false);
      } catch (error) { fail(error); }
    },
    feedStderr(input) {
      guard();
      try {
        bound('stderrBytes', stderr.size + input.byteLength);
        stderr.append(input);
      } catch (error) { fail(error); }
    },
    finish(exitCode) {
      guard();
      try {
        if (record.size) part(Buffer.alloc(0), true);
        const reading = reducer!.finish(exitCode, stderr.text());
        measure(reading);
        ended = true;
        release();
        return reading;
      } catch (error) { return fail(error); }
    },
  };
}

export function batchResult(reader: ResultReader, stdout: string, exitCode: number | null, stderr: string): Reading {
  reader.feedStdout(Buffer.from(stdout));
  reader.feedStderr(Buffer.from(stderr));
  return reader.finish(exitCode);
}
