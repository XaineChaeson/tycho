import { clip } from '../runner/display.ts';
import { HIDDEN_TEXT } from '../runner/redact.ts';

const MAX_BYTES = 4096;
const SECRET_FIELD = /^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|password|secret|credentials?|operation_key|(?:.*[-_])?(?:api[-_]?key|token))$/i;
const INLINE_SECRET = /((?:authorization\s*:\s*)?(?:bearer|basic)\s+|(?:\b[\w-]*(?:api[-_]?key|password|secret|token)\b["']?\s*[:=]\s*["']?))([^\s"'\\,;}\]]+)/gi;
const AUTH_HEADER = /(\b(?:proxy[-_])?authorization\b\s*:\s*)([^\r\n]+)/gi;
const JOIN_MATERIAL = /\b[0-9a-f]{64}\b/gi;
const URL_CREDENTIAL = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi;
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g;

export function redactDiagnosticText(text: string, hide: (text: string) => string): string {
  return hide(text)
    .replace(INLINE_SECRET, (_match, prefix: string) => prefix + HIDDEN_TEXT)
    .replace(AUTH_HEADER, (_match, prefix: string, value: string) => {
      const scheme = /^(?:bearer|basic)\b\s+/i.exec(value)?.[0] ?? '';
      return prefix + scheme + HIDDEN_TEXT;
    })
    .replace(URL_CREDENTIAL, (_match, scheme: string) => scheme + HIDDEN_TEXT + '@')
    .replace(GITHUB_TOKEN, HIDDEN_TEXT);
}

// Machine join materials are minted as 32 random bytes and handed directly to
// Workers. The host may forget their values on restart, so mask their spelling.
export function redactWorkerDiagnosticText(text: string, hide: (text: string) => string): string {
  return redactDiagnosticText(text, hide).replace(JOIN_MATERIAL, HIDDEN_TEXT);
}

export function routerTurnText(text: string, hide: (text: string) => string): string {
  return clip(redactDiagnosticText(text, hide), 128 * 1024).text;
}

export function routerCallText(value: unknown, hide: (text: string) => string = (text) => text): string {
  const text = JSON.stringify(value, (key, field: unknown) => {
    if (SECRET_FIELD.test(key)) return HIDDEN_TEXT;
    return typeof field === 'string' ? redactDiagnosticText(field, hide) : field;
  }, 2);
  return clip(text, MAX_BYTES).text;
}
