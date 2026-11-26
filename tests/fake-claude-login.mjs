// A stand-in for `claude setup-token` as the prototype recorded it under a pseudoconsole
// (docs/design/native-login.md, 落地记录): the authorization address as an OSC 8 hyperlink and
// as text, blanks drawn as "cursor forward", the paste prompt echoing what is typed (masked
// but for the last six characters, in clear on the wire), "OAuth error ... Press Enter to
// retry." after a wrong code without exiting, and a new address on retry. On the right code it
// prints a token, wrapped if told to. It records, outside the data directory, its pid and
// whether it was asked to open a browser and what came of it. It never contacts anyone.
//
// Told how to behave by its environment:
//   FAKE_LOGIN_RECORD   file to append one JSON line per event to
//   FAKE_LOGIN_GOOD     the code that succeeds
//   FAKE_LOGIN_TOKEN    the token printed on success
//   FAKE_LOGIN_WRAP     wrap the token every this many characters
//   FAKE_LOGIN_SCREEN   'standard' (default) | 'unknown': a success screen with no token on it
//                       | 'inline': the token with words after it on its line
//                       | 'tail': the token last on the screen, one wrapped piece at a time with
//                         FAKE_LOGIN_PAUSE_MS between them, nothing after it, and no exit
//                       | 'hang': after the code, a spinner line and then nothing at all
//   FAKE_LOGIN_ERROR    'rejected' (default) | 'network' | 'sample': an error followed by an
//                       example of what a token looks like, on a line of its own
//   FAKE_LOGIN_PRELUDE  '1': a token-shaped example line on the screen before the address
//   FAKE_LOGIN_PROMPT   '0': never show the paste prompt
//   FAKE_LOGIN_EXIT     '1': exit once the token is printed (default: wait for Enter)
//   FAKE_LOGIN_SILENT   '1': print nothing at all, and wait
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const env = process.env;
const record = (event) => {
  if (env.FAKE_LOGIN_RECORD) appendFileSync(env.FAKE_LOGIN_RECORD, `${JSON.stringify({ pid: process.pid, ...event })}\n`);
};
const out = (text) => process.stdout.write(text);
const ESC = '\x1b';
// Words with "cursor forward" between them, as ConPTY sends a line it draws.
const words = (line) => line.split(' ').join(`${ESC}[1C`);

record({ event: 'start', tty: Boolean(process.stdin.isTTY) });
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
// The CLI ignores Ctrl-C at this prompt; so does this.
process.on('SIGINT', () => {});

// What the real CLI does first: tries to open a browser. BROWSER is what it would run.
function openBrowser(url) {
  if (env.BROWSER === undefined) {
    record({ event: 'browser', browser: 'default' });
    return;
  }
  try {
    const child = spawn(env.BROWSER, [url], { stdio: 'ignore' });
    child.on('error', (err) => record({ event: 'browser', browser: env.BROWSER, opened: false, error: err.code }));
    child.on('spawn', () => record({ event: 'browser', browser: env.BROWSER, opened: true }));
  } catch (err) {
    record({ event: 'browser', browser: env.BROWSER, opened: false, error: String(err.code ?? err) });
  }
}

let state = 'code';
let code = '';
const PROMPT = env.FAKE_LOGIN_PROMPT === '0' ? '' : 'Paste code here if prompted > ';
// What a token looks like, as a screen might show for an example. Never a real one.
const SAMPLE = 'sk-ant-oat01-EXAMPLEexampleEXAMPLEexampleEXAMPLE_example-EXAMPLE';

function offer() {
  const url = `https://claude.com/cai/oauth/authorize?code=true&client_id=fake-client&state=${randomBytes(16).toString('hex')}`;
  record({ event: 'url', host: url.split('?')[0] });
  out(`${words("Browser didn't open? Use the url below to sign in (c to copy)")}\r\n`);
  out(`${ESC}]8;;${url}\x07${url}${ESC}]8;;\x07\r\n\r\n`);
  out(words(PROMPT));
  openBrowser(url);
  state = 'code';
  code = '';
}

function succeed() {
  const token = env.FAKE_LOGIN_TOKEN ?? '';
  const wrap = Number(env.FAKE_LOGIN_WRAP ?? 0);
  const pieces = wrap > 0 ? token.match(new RegExp(`.{1,${wrap}}`, 'g')) : [token];
  out(`\r\n\r\n${ESC}[32m✓${ESC}[39m ${words('Long-lived authentication token created successfully!')}\r\n\r\n`);
  if (env.FAKE_LOGIN_SCREEN === 'tail') {
    out(`${words('Your OAuth token (valid for 1 year):')}\r\n\r\n`);
    const pause = Number(env.FAKE_LOGIN_PAUSE_MS ?? 1000);
    pieces.forEach((piece, index) => setTimeout(() => {
      // With its cursor visible ConPTY also reports the move after the completed line.
      // A hidden cursor can leave its trailing line end unobservable to the reader.
      out(`${piece}\r\n${ESC}[?25h`);
      record({ event: 'piece', index, last: index === pieces.length - 1 });
    }, index * pause));
    state = 'done';
    return;
  }
  if (env.FAKE_LOGIN_SCREEN === 'unknown') {
    out(`${words('Your new credential is ready. Find it in your account settings.')}\r\n`);
  } else {
    out(`${words('Your OAuth token (valid for 1 year):')}\r\n\r\n`);
    out(env.FAKE_LOGIN_SCREEN === 'inline' ? `${token} ${words('(keep it safe)')}\r\n` : `${pieces.join('\r\n')}\r\n`);
  }
  out(`\r\n${words("Store this token securely. You won't be able to see it again.")}\r\n`);
  state = 'done';
  record({ event: 'success' });
  if (env.FAKE_LOGIN_EXIT === '1') setTimeout(() => process.exit(0), 200);
}

function fail() {
  const why = env.FAKE_LOGIN_ERROR === 'network' ? 'getaddrinfo ENOTFOUND platform.claude.com' : 'Request failed with status code 400';
  out(`\r\n${words(`OAuth error: ${why}`)}\r\n`);
  if (env.FAKE_LOGIN_ERROR === 'sample') out(`\r\n${words('A token looks like this:')}\r\n\r\n${SAMPLE}\r\n\r\n`);
  out(`${words('Press Enter to retry.')}\r\n`);
  state = 'error';
  record({ event: 'error' });
}

process.stdin.on('data', (chunk) => {
  for (const char of chunk.toString('utf8')) {
    if (state === 'code') {
      if (char === '\r' || char === '\n') {
        record({ event: 'submitted', length: code.length });
        state = 'exchanging';
        setTimeout(() => {
          if (env.FAKE_LOGIN_SCREEN === 'hang') {
            out(`\r\n${words('· Exchanging the code…')}\r\n`);
            state = 'done';
            record({ event: 'hang' });
          } else if (code === env.FAKE_LOGIN_GOOD) succeed();
          else fail();
        }, 300);
        continue;
      }
      code += char;
      // Masked on the screen, but the last characters go out in clear, as the CLI's do.
      const shown = '*'.repeat(Math.max(0, code.length - 6)) + code.slice(-6);
      out(`\r${words(PROMPT)}${shown}`);
    } else if (state === 'error' && char === '\r') {
      out(`\r\n${words('Retrying…')}\r\n`);
      offer();
    }
  }
});

if (env.FAKE_LOGIN_SILENT !== '1') {
  out(`${ESC}[?25l${ESC}[2J${ESC}[H${words('Welcome to Claude Code v9.9.9')}\r\n`);
  out(`${words('This will guide you through long-lived (1-year) auth token setup for your Claude account.')}\r\n`);
  out(`${words('· Opening browser to sign in…')}\r\n`);
  if (env.FAKE_LOGIN_PRELUDE === '1') out(`${words('Tokens look like this:')}\r\n\r\n${SAMPLE}\r\n\r\n`);
  setTimeout(offer, 150);
}
