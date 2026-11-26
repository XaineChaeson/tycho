// The inbound sources' keys and requests (docs/design/triggers.md §2.2). Each source is one
// caller with one entrance; the translator its kind names is the pure function that checks the
// signature and reads the request into events, and the ledger judges those in one transaction.
// A key's secret is a file under <data>/secrets/triggers named by the key's id, and leaves this
// machine once: in the answer to the owner who issued it. The ledger holds which keys verify
// until when; a restart never extends one.
import { randomBytes } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from './db.ts';
import { InputError } from './errors.ts';
import { ulid } from './ids.ts';
import { putSecret, readSecret } from './secrets.ts';
import type { InboundResult, InboundSourceView, InboundVerdict } from './triggers.ts';
import { inboundResultPath, TYCHO_V1_HEADERS, type InboundKind, type InboundReceiptResult } from '../shared/triggers.ts';
import { translateGithub } from './inbound/github.ts';
import { translateStandardWebhooks } from './inbound/standard-webhooks.ts';
import { receiptKey, translateTychoV1 } from './inbound/tycho-v1.ts';
import type { InboundHeaders, InboundProject, Translator } from './inbound/types.ts';

const KEY_ID = /^[0-9A-Z]{26}$/;
const SECRET_BYTES = 32;

// One line per kind: a new translator is its file and an entry here.
const TRANSLATORS: Record<InboundKind, Translator> = {
  'tycho-v1': translateTychoV1,
  'standard-webhooks': translateStandardWebhooks,
  github: translateGithub,
};

// The folder keeps the name it had before inbound sources: keys issued then are still the
// sources' keys after the upgrade, and no file is moved.
export const inboundSecretDir = (dataDir: string): string => join(dataDir, 'secrets', 'triggers');

// What of the ledger this needs: the keys and projects a request is judged by, the one transaction
// its verdict goes into, and issuing a key.
interface Sources {
  getInboundSource?(sourceId: string): { kind: InboundKind } | undefined;
  issueInboundKey(sourceId: string, keyId: string, ctx: Ctx, now?: Date): InboundSourceView;
  inboundTarget(sourceId: string, now?: Date): { id: string; kind: InboundKind; projects: InboundProject[]; keyIds: string[] } | undefined;
  liveInboundKeyIds(now?: Date): string[];
  readInboundReceipt(sourceId: string, keyId: string, receiptId: string, now: Date): InboundReceiptResult | undefined;
  receiveInbound(request: { sourceId: string; keyId: string | null; verdict: InboundVerdict; body: Uint8Array }, now?: Date): InboundResult | undefined;
}

// A request as it arrived, its body's bytes untouched.
export interface InboundArrival {
  header: InboundHeaders;
  body: Uint8Array;
}

export function createInbounds({ ledger, dataDir, skewMs, log = (line: string) => console.error(line) }: {
  ledger: Sources;
  dataDir: string;
  skewMs: () => number;
  log?: (line: string) => void;
}) {
  const dir = inboundSecretDir(dataDir);
  const file = (keyId: string): string => {
    if (!KEY_ID.test(keyId)) throw new InputError(`不是密钥编号：${keyId}`);
    return join(dir, keyId);
  };

  function keysOf(ids: string[]) {
    return ids.flatMap((id) => {
      const secret = readSecret(file(id));
      return secret === '' ? [] : [{ id, secret }];
    });
  }

  // The files of keys that verify nowhere any more, and of keys whose issue never committed.
  // Everything here is synchronous, so no key is between its file and its ledger row meanwhile.
  function tidy(now: Date = new Date()): void {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const live = new Set(ledger.liveInboundKeyIds(now));
    for (const name of names) if (!live.has(name)) rmSync(join(dir, name), { force: true });
  }

  return {
    // A new key for a source, in force at once; the one it replaces verifies through its
    // transition (§2.2). The secret is in the answer and nowhere else that leaves this machine.
    // Its file is written first: a crash before the ledger commits leaves a file nothing names,
    // which tidy() removes.
    issue(sourceId: string, ctx: Ctx, now: Date = new Date()): { key_id: string; secret: string; source: InboundSourceView } {
      const keyId = ulid();
      const kind = ledger.getInboundSource?.(sourceId)?.kind;
      const secret = kind === 'standard-webhooks'
        ? `whsec_${randomBytes(SECRET_BYTES).toString('base64')}`
        : randomBytes(SECRET_BYTES).toString('hex');
      putSecret(file(keyId), secret);
      let source: InboundSourceView;
      try {
        source = ledger.issueInboundKey(sourceId, keyId, ctx, now);
      } catch (err) {
        rmSync(file(keyId), { force: true });
        throw err;
      }
      try {
        tidy(now);
      } catch (err) {
        log(`清理作废的入站密钥文件失败：${String(err)}`);
      }
      return { key_id: keyId, secret, source };
    },

    // One request (§2.2). The signature is the request's whole authentication: the translator of
    // the source's kind matches it against the keys the ledger says verify now, and nothing else
    // the request shows is looked at. Undefined when nothing from outside reaches the source.
    receive(sourceId: string, arrival: InboundArrival, now: Date = new Date()): InboundResult | undefined {
      const target = ledger.inboundTarget(sourceId, now);
      if (target === undefined) return undefined;
      const keys = keysOf(target.keyIds);
      const translation = TRANSLATORS[target.kind]({ header: arrival.header, body: arrival.body, now, skewMs: skewMs() }, keys, target.projects);
      const verdict: InboundVerdict = translation.status === 'signed'
        ? { status: 'events', eventIdSigned: translation.eventIdSigned, events: translation.events }
        : translation.status === 'ping' ? { status: 'ping' } : translation;
      return ledger.receiveInbound({
        sourceId,
        keyId: translation.status === 'refused' ? null : translation.keyId,
        verdict,
        body: arrival.body,
      }, now);
    },

    readReceipt(sourceId: string, receiptId: string, header: InboundHeaders, now: Date = new Date()): InboundReceiptResult | undefined {
      const target = ledger.inboundTarget(sourceId, now);
      if (target?.kind !== 'tycho-v1') return undefined;
      const key = receiptKey(
        keysOf(target.keyIds), inboundResultPath(sourceId, receiptId),
        header(TYCHO_V1_HEADERS.time), header(TYCHO_V1_HEADERS.signature), now, skewMs(),
      );
      return key === undefined ? undefined : ledger.readInboundReceipt(sourceId, key, receiptId, now);
    },

    tidy,
  };
}

export type Inbounds = ReturnType<typeof createInbounds>;
