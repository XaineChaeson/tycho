// A secret a round was handed must not travel on from the round's output
// (docs/design/native-login.md, ruling G). An executor that reads its key from the environment
// hands it to everything it starts, and a model can print what it finds there; from the
// Runner on, output goes into the ledger, the console and pushes to a phone. So the Runner
// replaces every known secret in what it reads, before a line is parsed or a result taken.
// One entry for every executor: this knows no executor and no shape of secret.
//
// What it is not: a guard on the machine. The raw log there still holds what was printed —
// the machine is the boundary, as for the key itself. It knows the secret a login holds now and
// the one each round was handed while this service runs; one replaced before a restart, of a
// round read back after it, is one it can no longer recognise. Only a login tycho keeps has a
// secret here: a machine's own login gives it nothing to hide.

export const HIDDEN_TEXT = '[已隐去的密钥]';

// Below this a "secret" is a word that turns up in ordinary text, and hiding it would mangle
// the output without protecting anything a token store would accept.
const MIN_SECRET_CHARS = 8;

// The same secret as a JSON string carries it: every line of an executor's output is JSON,
// where a quote, a backslash or a non-ASCII character is written escaped.
const forms = (secret: string): string[] => [...new Set([secret, JSON.stringify(secret).slice(1, -1)])];

export function hider(secrets: readonly (string | undefined)[], marker: string = HIDDEN_TEXT): (text: string) => string {
  const known = [...new Set(secrets.filter((secret): secret is string => typeof secret === 'string' && secret.length >= MIN_SECRET_CHARS).flatMap(forms))]
    // The longest first: a secret that contains another is hidden whole.
    .sort((a, b) => b.length - a.length);
  if (known.length === 0) return (text) => text;
  return (text) => known.reduce((held, secret) => (held.includes(secret) ? held.split(secret).join(marker) : held), text);
}
