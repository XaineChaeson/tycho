export interface GatewayFrame {
  cmd: string;
  headers: { req_id: string };
  body?: any;
}

export interface StreamRecord {
  reqId: string;
  id: string;
  finish: boolean;
  content: string;
}

export type StreamPlan = 'silent' | { errcode: number; errmsg: string } | { delayMs: number } | undefined;

export interface Gateway {
  url: string;
  frames: GatewayFrame[];
  connections: number;
  readonly open: number;
  answer: (frame: GatewayFrame) => { errcode: number; errmsg: string } | undefined;
  onStream: (frame: StreamRecord, index: number) => StreamPlan;
  sent(cmd: string): GatewayFrame[];
  streams(): StreamRecord[];
  inject(frame: unknown): void;
  message(body: unknown, reqId?: string): string;
  event(from: string, event: unknown, reqId?: string): string;
  press(from: string, key: string): string;
  cut(): void;
  until<T>(read: () => T | undefined | false, what: string, ms?: number): Promise<T>;
  close(): Promise<void>;
}

export function startGateway(): Promise<Gateway>;
