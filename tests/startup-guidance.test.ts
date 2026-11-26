// Guards against the CLI startup path generating a login credential in service logs, and
// against the hint it prints naming a command the owner does not have: an installed copy
// is told `tycho open`, a checkout `npm run login-link`.
import './guard.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('startup prints retrieval instructions without creating or logging a login link', () => {
  const source = readFileSync(new URL('../service/main.ts', import.meta.url), 'utf8');
  const main = source.slice(source.indexOf('async function main()'));
  assert.doesNotMatch(main, /createLink\(|\/login\//);
  assert.match(main, /LOGIN_HINT/);
  assert.match(main, /已配置企微时私聊机器人发/);
  const hint = /const LOGIN_HINT = (.*);/.exec(source)?.[1] ?? '';
  assert.match(hint, /运行 tycho open 打开控制台/);
  assert.match(hint, /运行 npm run login-link 获取登录链接/);
  assert.doesNotMatch(hint, /createLink\(|\/login\//);
});
