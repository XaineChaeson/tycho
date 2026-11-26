// Guards how a Claude login's screen is read (service/login-screen.ts) against: blanks drawn as
// "cursor forward" running words together; an address read from the redrawn text instead of the
// hyperlink; a wrapped token cut short or glued to the sentence after it; a token taken before
// it is known to have ended (a chunk that stops right after a wrap), or taken from a screen that
// also says the login failed; a token with other text on its line guessed at instead of
// refused; an error screen taken for a pending one; and a "shape" that still holds a letter or
// digit of what the screen said.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizeUrl, outcomeOf, pastePrompt, shapeOf, stripScreen, tokenOf, urlForLog } from '../service/login-screen.ts';

const ESC = '\x1b';
const words = (line: string): string => line.split(' ').join(`${ESC}[1C`);
const URL_A = 'https://claude.com/cai/oauth/authorize?code=true&client_id=c1&state=s1';
const URL_B = 'https://claude.com/cai/oauth/authorize?code=true&client_id=c1&state=s2';
const TOKEN = `sk-ant-oat01-${'Ab3_x-'.repeat(15)}Zz9`;

test('去掉控制序列时保住空格和换行', () => {
  assert.equal(stripScreen(`${ESC}[2J${ESC}[H${words('Welcome to Claude Code')}\r\n${ESC}[3;1Hnext`), '\nWelcome to Claude Code\n\nnext');
});

test('网址先取超链接的目标；只有文字时取文字里的；有好几个取最新的', () => {
  const linked = `${ESC}]8;;${URL_A}\x07visible text${ESC}]8;;\x07`;
  assert.equal(authorizeUrl(linked), URL_A);
  assert.equal(authorizeUrl(`${words('use the url below')}\r\n${URL_A}\r\n`), URL_A);
  assert.equal(authorizeUrl(`${ESC}]8;;${URL_A}\x07${URL_A}${ESC}]8;;\x07 ... ${ESC}]8;;${URL_B}\x07${URL_B}${ESC}]8;;\x07`), URL_B);
  assert.equal(authorizeUrl('nothing yet'), undefined);
  assert.equal(urlForLog(URL_A), 'https://claude.com/cai/oauth/authorize');
  assert.ok(pastePrompt(words('Paste code here if prompted >')));
});

test('令牌：独占一行、折行接上；只有确认结束了才算', () => {
  // Ended by a blank line, or by a line that cannot be a piece of it.
  assert.equal(tokenOf(`Your token:\n\n${TOKEN}\n\nStore it.`), TOKEN);
  const wrapped = TOKEN.match(/.{1,40}/g)!.join('\n');
  assert.equal(tokenOf(`Your token:\n${wrapped}\n\nStore this token securely.`), TOKEN);
  assert.equal(tokenOf(`${TOKEN}\nStore this token securely.`), TOKEN);
  // Even before that next line has ended: a blank in it already says it is not a piece.
  assert.equal(tokenOf(`${TOKEN}\nStore th`), TOKEN);
  // A line ended, and nothing after it yet: a wrapped token may go on in the next chunk.
  assert.equal(tokenOf(`${TOKEN.slice(0, 40)}\n`), undefined);
  assert.equal(tokenOf('sk-ant-oat01-AbCd12\n'), undefined);
  assert.equal(tokenOf(`${TOKEN.slice(0, 40)}\n${TOKEN.slice(40, 80)}\n`), undefined);
  assert.equal(tokenOf(`${TOKEN.slice(0, 40)}\n${TOKEN.slice(40, 80)}`), undefined);
  // Quiet for the settle wait after its line ended: what is there is the whole of it.
  assert.equal(tokenOf(`${TOKEN.slice(0, 40)}\n${TOKEN.slice(40)}\n`, { quiet: true }), TOKEN);
  // Quiet cannot complete an unfinished line. Only exit confirms there are no more bytes.
  assert.equal(tokenOf(`Your token:\n${TOKEN}`), undefined);
  assert.equal(tokenOf(`Your token:\n${TOKEN.slice(0, 40)}\n${TOKEN.slice(40)}`, { quiet: true }), undefined);
  assert.equal(tokenOf(`Your token:\n${TOKEN}`, { quiet: true }), undefined);
  // The CLI has exited: nothing more is coming.
  assert.equal(tokenOf(`Your token:\n${TOKEN}`, { exited: true }), TOKEN);
  // Words beside it on its line: which part is the token cannot be told.
  assert.equal(tokenOf(`token: ${TOKEN}\n`), null);
  assert.equal(tokenOf(`${TOKEN} (keep it safe)\n`), null);
  assert.equal(tokenOf('no token here\n'), undefined);
});

test('令牌逐块到达：每个折行之后停住时都不算，结束才算整段', () => {
  const pieces = TOKEN.match(/.{1,37}/g)!;
  let screen = 'Your OAuth token (valid for 1 year):\n\n';
  for (const piece of pieces) {
    screen += `${piece}\n`;
    assert.deepEqual(outcomeOf(screen), { kind: 'pending' }, `停在第 ${screen.length} 个字符处时不该算`);
  }
  assert.deepEqual(outcomeOf(screen, { quiet: true }), { kind: 'token', token: TOKEN });
  assert.deepEqual(outcomeOf(`${screen}\n`), { kind: 'token', token: TOKEN });
  // As ConPTY sends it: each line's end only comes with the next piece.
  const head = 'Your OAuth token (valid for 1 year):\n\n';
  for (let shown = 1; shown <= pieces.length; shown++) {
    assert.deepEqual(outcomeOf(head + pieces.slice(0, shown).join('\n')), { kind: 'pending' });
  }
  assert.deepEqual(outcomeOf(head + pieces.join('\n'), { quiet: true }), { kind: 'pending' });
  assert.deepEqual(outcomeOf(head + pieces.join('\n'), { exited: true }), { kind: 'token', token: TOKEN });
});

test('交码之后的画面：认出的失败信号压过一切候选文字', () => {
  assert.deepEqual(outcomeOf(`\r\n${TOKEN}\r\n\r\n`), { kind: 'token', token: TOKEN });
  assert.deepEqual(outcomeOf(`\r\n${words('OAuth error: Request failed with status code 400')}\r\n${words('Press Enter to retry.')}\r\n`), { kind: 'rejected' });
  assert.deepEqual(outcomeOf(`${words('OAuth error: Invalid code. Please make sure the full code was copied')}\r\n`), { kind: 'rejected' });
  assert.deepEqual(outcomeOf(`${words('OAuth error: getaddrinfo ENOTFOUND platform.claude.com')}\r\n${words('Press Enter to retry.')}\r\n`), { kind: 'unreachable' });
  // The review's input: an error, then an example of what a token looks like on its own line.
  assert.deepEqual(outcomeOf(`${words('OAuth error: Request failed with status code 400')}\r\n\r\n${TOKEN}\r\n\r\n`), { kind: 'rejected' });
  assert.deepEqual(outcomeOf(`${TOKEN}\r\n\r\n${words('Press Enter to retry.')}\r\n`, { exited: true }), { kind: 'rejected' });
  assert.deepEqual(outcomeOf(`token: ${TOKEN}\r\n`), { kind: 'unreadable' });
  assert.deepEqual(outcomeOf('****************abc123'), { kind: 'pending' });
});

test('形状：字母数字一个不留，标点、空白、行结构留下', () => {
  const screen = `Your OAuth token (valid for 1 year):\n\n${TOKEN}\n\n${URL_A}\n授权码 ab12#cd34`;
  const shape = shapeOf(screen);
  assert.doesNotMatch(shape, /[b-zA-Z1-9]/, '只能剩占位的 a 和 0');
  assert.ok(!shape.includes(TOKEN) && !shape.includes('state=s1') && !shape.includes('ab12'));
  assert.equal(shape.split('\n').length, screen.split('\n').length);
  assert.match(shape, /^aaaa aaaaa aaaaa \(aaaaa aaa 0 aaaa\):$/m);
  assert.match(shape, /^aa-aaa-aaa00-/m);
});
