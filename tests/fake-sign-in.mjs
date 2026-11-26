// A stand-in for an executor's own sign-in command (node/sign-in.ts), for tests only. It prints
// the recorded Codex device-code screen (tests/fixtures/codex/0.162.0/login-device), then:
//   TYCHO_FAKE_SIGNIN_EXIT    exit with this code once TYCHO_FAKE_SIGNIN_GO exists (at once
//                             when that is unset); unset: stay up until ended
//   TYCHO_FAKE_SIGNIN_QUIET   print nothing at all (a screen that never shows a code)
//   TYCHO_FAKE_SIGNIN_FLOOD   print this many KiB of filler after the screen
//   TYCHO_FAKE_SIGNIN_PIDS    write "<own pid> <child pid>" here, after starting a child that
//                             stays up (what ending the tree has to reach)
//   TYCHO_FAKE_SIGNIN_MARK    write its arguments here (which command line it was run with)
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
if (env.TYCHO_FAKE_SIGNIN_MARK) writeFileSync(env.TYCHO_FAKE_SIGNIN_MARK, JSON.stringify(process.argv.slice(2)));
if (env.TYCHO_FAKE_SIGNIN_PIDS) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  writeFileSync(env.TYCHO_FAKE_SIGNIN_PIDS, `${process.pid} ${child.pid}`);
}
if (env.TYCHO_FAKE_SIGNIN_PASTE === '1') {
  process.stdout.write([
    'Open this link in a browser to log in with Google:',
    '',
    '  https://accounts.google.com/o/oauth2/auth?client_id=test&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=s1',
    '',
    'Then paste the authorization code, or the full URL of the page you land on, and press Enter: ',
  ].join('\n'));
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    const nl = buf.indexOf('\n');
    if (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      if (env.TYCHO_FAKE_SIGNIN_STDIN_OUT) writeFileSync(env.TYCHO_FAKE_SIGNIN_STDIN_OUT, line);
      process.exit(env.TYCHO_FAKE_SIGNIN_EXPECT && line !== env.TYCHO_FAKE_SIGNIN_EXPECT ? 1 : 0);
    }
  });
  setInterval(() => {}, 1000);
} else {
  if (!env.TYCHO_FAKE_SIGNIN_QUIET) {
    process.stdout.write(readFileSync(join(import.meta.dirname, 'fixtures', 'codex', '0.162.0', 'login-device', 'stdout.txt')));
  }
  if (env.TYCHO_FAKE_SIGNIN_FLOOD) {
    const line = `${'x'.repeat(1023)}\n`;
    for (let i = 0; i < Number(env.TYCHO_FAKE_SIGNIN_FLOOD); i += 1) process.stdout.write(line);
  }
  const code = env.TYCHO_FAKE_SIGNIN_EXIT;
  const go = env.TYCHO_FAKE_SIGNIN_GO;
  setInterval(() => {
    if (code !== undefined && (go === undefined || existsSync(go))) process.exit(Number(code));
  }, 50);
}
