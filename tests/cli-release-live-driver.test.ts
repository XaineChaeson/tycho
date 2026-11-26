// Guards what a release does when what is left of a Router driver cannot be confirmed gone:
// current stays on the version just installed, the old one is not started, and the command
// says which of the two it could not confirm. The ledger is the reason — a second writer on
// it is the thing the whole design keeps out (docs/design/project-sessions.md §3).
// - a leftover the scan keeps finding: the release sees the process and refuses to hand the
//   ledger back to the old program;
// - a scan that cannot run at all: the same refusal in its own words, since "cannot tell" is
//   not "nothing is left".
// The services are this repository's own, from a real release unpacked into the prefix. It is
// only the release's own look at the process table that is made to fail here; the services
// look with this machine's table.
//
// The service manager is the one thing stood in for (see cli-release-live-fixture.ts).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { openLedger } from '../service/ledger.ts';
import { hostProcesses } from '../service/processes.ts';
import { USER } from './helpers.ts';
import { OLD, NEW, currentOf, installVersion, liveStage, loseConsoleAssets, manager, oldUp, ownUnit } from './cli-release-live-fixture.ts';

// Review of step 1, A: the release itself, end to end, when what is left of a Router driver
// cannot be confirmed gone — a leftover the scan keeps finding, or a scan that cannot run. The
// services clear what they can; this is what the release does when the clearing did not hold:
// current stays on the new version and the old one is not started.
for (const kind of ['stuck', 'scan'] as const) {
  test(kind === 'stuck' ? '负责人驱动者的残留清不掉：不移动 current，不启动旧版，如实说明' : '查不了进程表：不移动 current，不启动旧版，如实说明', async (t) => {
    const live = liveStage(t);
    const { s, prefix } = live;
    assert.equal(await installVersion(live, OLD, { automatic: false }), 0, s.text());
    ownUnit(s, prefix);
    // A context still open: every service scans its marker, and so does the release.
    const marker = '22222222-3333-4444-5555-666666666666';
    const seeded = openLedger(join(s.dataDir, 'ledger.db'));
    const project = seeded.createProject({ name: '试跑' }, USER);
    seeded.openContext({ projectId: project, segmentId: seeded.ensureSegment(project).id, marker, launch: {}, knowledge: [] });
    seeded.close();
    await oldUp(t, prefix, s.dataDir);
    const m = manager(t, live);
    // Only the release's own look is made to fail; the services look with this machine's table.
    s.cli.processes = {
      async find(asked) {
        if (asked !== marker) return hostProcesses.find(asked);
        if (kind === 'scan') throw new Error('进程表读不了');
        return [process.pid];
      },
    };
    t.after(() => { delete s.cli.processes; });
    const upgrading = installVersion(live, NEW, { mutate: loseConsoleAssets });
    assert.notEqual(await m.serve('请服务管理器启动新版'), null, m.said());
    assert.equal(await upgrading, 1, s.text());
    assert.match(s.err.join('\n'), kind === 'stuck' ? /没有回退：负责人驱动者还有进程在跑/ : /没有回退：查不出还有没有负责人进程残留/);
    if (kind === 'stuck') assert.match(s.err.join('\n'), new RegExp(marker));
    assert.equal(currentOf(prefix), NEW, '确认不了就保留现场，不换成旧版程序');
    assert.equal(m.starts(), 1, '旧版没有被启动');
    await m.stopAll();
  });
}
