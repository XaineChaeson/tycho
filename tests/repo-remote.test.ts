// Guards which address of the owner's remote a machine is handed (shared/remote.ts
// machineRemote, the one rule the host and the machine's watch both apply): a token or
// password in an https address leaving the host, in its user part or its query; an ssh login
// name being dropped (the machine's key is registered under it); a local path, a file://
// address or a transport written with a single colon being sent to a machine where it means
// nothing; and an address git or ssh would read as an option, or as a transport helper,
// being passed on at all.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { machineRemote } from '../shared/remote.ts';

test('https：用户名、密码、查询串都去掉，其余原样', () => {
  assert.equal(machineRemote('https://owner:ghp_secret@github.com/owner/project.git'), 'https://github.com/owner/project.git');
  assert.equal(machineRemote('https://ghp_secret@github.com/owner/project.git'), 'https://github.com/owner/project.git');
  assert.equal(machineRemote('https://gitlab.example.test/group/project.git?private_token=x#t'), 'https://gitlab.example.test/group/project.git');
  assert.equal(machineRemote('https://gitlab.example.test:8443/group/project.git'), 'https://gitlab.example.test:8443/group/project.git');
  assert.equal(machineRemote('git://ghp_secret@github.com/owner/project.git'), 'git://github.com/owner/project.git', 'git:// 没有认证，用户名只可能是令牌');
});

test('ssh：登录名留着，密码去掉；scp 写法原样，ssh 配置里的别名也算', () => {
  assert.equal(machineRemote('ssh://git@github.com/owner/project.git'), 'ssh://git@github.com/owner/project.git');
  assert.equal(machineRemote('ssh://git:pw@example.test:2222/owner/project.git'), 'ssh://git@example.test:2222/owner/project.git');
  assert.equal(machineRemote('git@github.com:owner/project.git'), 'git@github.com:owner/project.git');
  assert.equal(machineRemote('github-work:owner/project.git'), 'github-work:owner/project.git');
});

test('给出去的地址再过一遍还是它自己：机器按同一条规则核对', () => {
  for (const url of [
    'https://owner:t@github.com/o/p.git', 'http://example.test:8080/o/p.git?x=1', 'git://t@github.com/o/p.git',
    'ssh://git:pw@example.test:2222/o/p.git', 'ssh://example.test/o/p.git', 'git@github.com:o/p.git', 'github-work:o/p.git',
  ]) {
    const handed = machineRemote(url)!;
    assert.equal(machineRemote(handed), handed, url);
  }
});

test('机器上用不了的地址不给', () => {
  for (const url of [
    '/srv/git/project.git', 'C:\\repos\\project.git', 'C:/repos/project.git', '..\\project', '../project',
    'file:///srv/git/project.git', 'file:/srv/git/project.git', 'file:repo.git', 'https:example.test/x', 'ssh:example.test/x',
    '', 'https://exa mple.test/x', 'ftp://example.test/x.git',
  ]) {
    assert.equal(machineRemote(url), null, url);
  }
});

test('git 或 ssh 会当成参数、当成传输助手的地址不给', () => {
  for (const url of [
    '-uhack', 'ssh://-oProxyCommand=id/host/repo.git', 'ssh://-oProxyCommand=id@host/repo.git',
    'git@-oProxyCommand=id:repo', '-oProxyCommand=id@host:repo', 'ext::sh -c touch', 'ext::sh', 'fd::17',
  ]) {
    assert.equal(machineRemote(url), null, url);
  }
});
