// What `claude setup-token` shows, read from the raw bytes of its pseudoconsole
// (docs/design/native-login.md; the prototype's findings are in its 落地记录). Everything here
// is pure and works on text held in memory: the raw screen holds the authorization code the
// owner pasted and, on success, the token, so none of it is ever written anywhere. What may be
// written is `shapeOf`'s output, which keeps no letter and no digit of the original.

// The terminal's control sequences out, the screen's layout kept: ConPTY sends only the cells
// that changed and moves the cursor between them, so a space between two words is often a
// "cursor forward" and a new line a "cursor position". Those become the spaces and line
// breaks they stand for; every other sequence goes.
export function stripScreen(raw: string): string {
  return raw
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[(\d*)C/g, (_all, n: string) => ' '.repeat(Number(n) || 1))
    .replace(/\x1b\[[\d;]*[HfBEd]/g, '\n')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r\n?/g, '\n');
}

const AUTHORIZE = /https:\/\/[^\s"'\x07\x1b]+\/oauth\/authorize\?[^\s"'\x07\x1b]+/g;
// An OSC 8 hyperlink's target: what the CLI means, before any wrapping or redraw of the text.
const OSC8 = /\x1b\]8;[^;\x07\x1b]*;(https:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/g;

// The authorization address the screen offers, the latest one: the hyperlink's target first,
// the text second. Undefined while there is none.
export function authorizeUrl(raw: string): string | undefined {
  const linked = [...raw.matchAll(OSC8)].map((found) => found[1]!).filter((url) => /\/oauth\/authorize\?/.test(url));
  if (linked.length > 0) return linked.at(-1);
  return stripScreen(raw).match(AUTHORIZE)?.at(-1);
}

// An address as a log line may hold it: up to the query, which carries the login's state.
export const urlForLog = (url: string): string => url.split('?')[0]!;

export const pastePrompt = (raw: string): boolean => /Paste code here/i.test(stripScreen(raw));

// What the screen says after a code was submitted. `token` only when it is there whole.
export type Outcome =
  | { kind: 'token'; token: string }
  | { kind: 'rejected' }
  | { kind: 'unreachable' }
  // A token is on the screen but cannot be read off it whole.
  | { kind: 'unreadable' }
  | { kind: 'pending' };

// A token's characters, and the prefix the CLI's long-lived tokens carry. The prefix is from
// the vendor's tokens as they are used elsewhere, not from a success screen anyone here has
// seen: a screen that does not match is "认不出这一版的登录结果", with its shape kept so the
// reading can be fixed.
const TOKEN_START = /sk-ant-[A-Za-z0-9_-]+/;
const TOKEN_LINE = /^[A-Za-z0-9_-]+$/;

// What is known about whether more of the screen is coming: the CLI has exited, or nothing has
// come for the settle wait (a setting) since the last chunk.
export interface ScreenEnd {
  exited?: boolean;
  quiet?: boolean;
}

// The token, wherever the terminal wrapped it: it stands alone on its line, and a line that is
// nothing but token characters right after it is the rest of it. It counts only once it is
// known to have ended, and that is known three ways only: a line after it that cannot be a
// piece of it (a blank line, or one with a character no token has); the CLI has exited; or
// nothing has come for the settle wait — the screen that prints the token last and then waits.
// Output arrives in chunks, and one can stop right after a wrap: until one of the three,
// `undefined`. Quiet confirms only a line whose end has already arrived; an unfinished line
// still needs more output or the CLI's exit. A
// token with other text beside it on its line is not one this can tell the end of: `null`, and
// the login is "not read", never a guess at which part is the token.
export function tokenOf(screen: string, end: ScreenEnd = {}): string | null | undefined {
  const lines = screen.split('\n');
  // The last line is still being drawn, unless nothing more is coming.
  const last = lines.length - 1;
  const settled = end.exited === true || (end.quiet === true && screen.endsWith('\n'));
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!;
    const found = TOKEN_START.exec(line);
    if (!found) continue;
    if (line.slice(0, found.index).trim() !== '' || line.slice(found.index + found[0].length).trim() !== '') return null;
    if (at === last && !settled) return undefined;
    let token = found[0];
    for (let next = at + 1; next <= last; next++) {
      const piece = lines[next]!.trim();
      const notPiece = !TOKEN_LINE.test(piece);
      // A blank line, or one with what no token has, ends it: once it has ended, or, while it
      // is still being drawn, if it already holds more than a piece could.
      if (next < last ? notPiece : piece !== '' && notPiece) return token;
      if (next === last) {
        if (!settled) return undefined;
        return token + piece;
      }
      token += piece;
    }
    return settled ? token : undefined;
  }
  return undefined;
}

// The CLI's own failure lines. Once one is on the screen, nothing else on it is the login's
// result: a token-shaped line there is an example or a leftover, never the token.
const FAILED = /OAuth error|Press Enter to retry/i;
const UNREACHABLE = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|socket hang up|timed? ?out|status code 5\d\d/i;

// What the screen after the code says, read from the stripped text after the moment the code
// went in (what the screen showed before it is never read for a token). A failure the CLI
// states comes first; a token only on a screen with no failure on it.
export function outcomeOf(after: string, end: ScreenEnd = {}): Outcome {
  const screen = stripScreen(after);
  if (FAILED.test(screen)) return UNREACHABLE.test(screen) ? { kind: 'unreachable' } : { kind: 'rejected' };
  const token = tokenOf(screen, end);
  if (token === null) return { kind: 'unreadable' };
  if (token !== undefined) return { kind: 'token', token };
  return { kind: 'pending' };
}

// The screen with every letter one placeholder letter and every digit one placeholder digit:
// punctuation, blanks and the lines stay. It shows how the screen is laid out, and nothing of
// what it says — not the code, not a token, not an address's query.
export function shapeOf(screen: string): string {
  return screen
    .replace(/\p{L}/gu, 'a')
    .replace(/\p{N}/gu, '0')
    // Long runs of blanks say nothing a few would not.
    .replace(/[ \t]{8,}/g, (blank) => ` ‹${blank.length}› `)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

