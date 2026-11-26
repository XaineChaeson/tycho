// Guards against a self-check that passes a private key ssh would refuse, or calls one ssh
// would accept a problem: the accounts ssh trusts on Windows being read off their names,
// which are translated on a localized system, instead of off their SIDs; an entry whose
// account the system could not name being dropped instead of shown as the SID it is; the
// group and other bits of a POSIX mode being read as one; a key that is not there, or is
// not a file, being answered for as if it were one; and the check leaving anything behind.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { WindowsAcl } from '../service/ssh-key.ts';
import { keyAccess, modeAccess, othersAllowed } from '../service/ssh-key.ts';
import { fixture } from './helpers.ts';

// What `icacls <file>` printed, and what `icacls <file> /save <tmp>` wrote, for a key only
// its owner, the administrators and SYSTEM can read: the shape of a key file in a profile,
// recorded from Windows 11. The account and its SID stand in for the ones that were there;
// the padding icacls aligns the entries with is kept as it printed it and means nothing.
const MINE = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const TIGHT: WindowsAcl = {
  named: [
    'C:\\Users\\owner\\.ssh\\door-key BUILTIN\\Administrators:(F)',
    '                                      NT AUTHORITY\\SYSTEM:(F)',
    '                                      EXAMPLE\\owner:(M)',
  ].join('\r\n'),
  sddl: `D:P(A;;FA;;;BA)(A;;FA;;;SY)(A;;0x1301bf;;;${MINE})`,
  mine: MINE,
  user: 'owner',
};

// The same, for a key another account can read as well — one whose account this system
// could not name, which is the state a machine that cannot reach its domain reports. Two
// entries are not in this list on purpose: the mandatory label is not part of the access
// list ssh reads, and a denied entry grants nothing.
const OPEN: WindowsAcl = {
  named: [
    'D:\\work\\door-key (I)(W,D,DC)',
    '                EXAMPLE\\owner:(I)(F)',
    '                OTHERPC\\somebody:(I)(M)',
    '                (I)(M)',
    '                BUILTIN\\Administrators:(I)(F)',
    '                NT AUTHORITY\\SYSTEM:(I)(F)',
    '                NT AUTHORITY\\Authenticated Users:(I)(M)',
    '                BUILTIN\\Users:(I)(RX)',
    '                Mandatory Label\\Low Mandatory Level:(I)(NW)',
  ].join('\r\n'),
  sddl: 'D:AI(A;ID;0x110156;;;S-1-4-632491151-689405914)(A;ID;FA;;;S-1-5-21-1111111111-2222222222-3333333333-1001)'
    + '(A;ID;0x1301bf;;;S-1-5-21-2222222222-3333333333-4444444444-1002)'
    + '(A;ID;0x1301bf;;;S-1-5-21-2857266861-2505391361-3763063477-4076939562)(A;ID;FA;;;BA)(A;ID;FA;;;SY)'
    + '(A;ID;0x1301bf;;;AU)(A;ID;0x1200a9;;;BU)(D;ID;0x10000000;;;S-1-5-21-2857266861-2505391361-3763063477-4076939562)'
    + 'S:AI(ML;ID;NW;;;LW)',
  mine: MINE,
  user: 'owner',
};

test('the accounts ssh trusts are read off SIDs, and the rest are named as the system named them', () => {
  assert.deepEqual(othersAllowed('C:\\Users\\owner\\.ssh\\door-key', TIGHT), [], '只有自己、管理员组和 SYSTEM：ssh 会接受');
  assert.deepEqual(othersAllowed('D:\\work\\door-key', OPEN), [
    // An account the system could not name is still an account: it is shown as its SID.
    'S-1-4-632491151-689405914',
    'OTHERPC\\somebody',
    'S-1-5-21-2857266861-2505391361-3763063477-4076939562',
    'NT AUTHORITY\\Authenticated Users',
    'BUILTIN\\Users',
  ]);
  // The denied entry in that list grants nothing, and the mandatory label is not read.
  assert.ok(!othersAllowed('D:\\work\\door-key', OPEN).includes('Mandatory Label\\Low Mandatory Level'));
});

test('the user it runs as is told apart by SID, and by name only when the system would not say which SID is theirs', () => {
  assert.deepEqual(othersAllowed('C:\\Users\\owner\\.ssh\\door-key', { ...TIGHT, mine: '' }), []);
  assert.deepEqual(othersAllowed('C:\\Users\\owner\\.ssh\\door-key', { ...TIGHT, mine: '', user: 'someone' }), ['EXAMPLE\\owner'], '名字对不上就是别人');
  // A SID the system named is what decides, whatever the name beside it reads like.
  assert.deepEqual(othersAllowed('C:\\Users\\owner\\.ssh\\door-key', { ...TIGHT, mine: 'S-1-5-21-9' }), ['EXAMPLE\\owner']);
});

test('a POSIX mode is read as ssh reads it: any group or other bit at all', () => {
  assert.equal(modeAccess(0o600, '/home/owner/key').kind, 'ok');
  assert.equal(modeAccess(0o700, '/home/owner/key').kind, 'ok');
  assert.deepEqual(modeAccess(0o640, '/home/owner/key'), {
    kind: 'open', others: ['同一个用户组里的账号'], tighten: 'chmod 600 "/home/owner/key"',
  });
  assert.deepEqual(modeAccess(0o644, '/home/owner/key'), {
    kind: 'open', others: ['同一个用户组里的账号', '这台电脑上的其他账号'], tighten: 'chmod 600 "/home/owner/key"',
  });
});

test('a key that is not there, not a file, or on a real machine is answered for and left alone', (t) => {
  const f = fixture(t);
  assert.deepEqual(keyAccess(join(f.dir, 'gone-key'), f.dir), { kind: 'missing' });
  const dir = join(f.dir, 'a-directory');
  mkdirSync(dir);
  assert.deepEqual(keyAccess(dir, f.dir), { kind: 'unknown', reason: `${dir} 不是一个文件` });
  // A file that is there: the reading is this machine's, and it writes nothing beside the
  // key and leaves nothing behind.
  const key = join(f.dir, 'door-key');
  writeFileSync(key, 'KEY');
  const verdict = keyAccess(key, f.dir);
  assert.ok(['ok', 'open', 'unknown'].includes(verdict.kind), JSON.stringify(verdict));
  assert.equal(readFileSync(key, 'utf8'), 'KEY', '文件一个字节没动');
  assert.deepEqual(readdirSync(f.dir).filter((name) => name.startsWith('acl-')), [], '读访问列表的临时文件不留下来');
});
