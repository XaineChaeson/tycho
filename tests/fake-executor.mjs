// A Worker as this machine runs one, for the tests about the node channel: the executor's
// own ndjson, a receipt at the end, and whatever the test asked for before that.
//
//   TYCHO_FAKE_SLEEP_MS   stay up this long before answering (a round to stop or restart)
//   TYCHO_FAKE_WAIT_FILE  wait for this file to appear (a round that runs until told)
//   TYCHO_FAKE_EXIT       the exit code (0 when unset)
//   TYCHO_FAKE_TOUCH      write this file once the round is under way
//   TYCHO_FAKE_LEAK       start this process and leave it running (a round with residue)
//   TYCHO_FAKE_ENV_FILE   write this Worker's whole environment there (what reached its hands)
//   TYCHO_FAKE_RECEIPT    JSON fields added to the receipt (what a skill reports, e.g. destroyed_machines)
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';

const sleepMs = Number(process.env.TYCHO_FAKE_SLEEP_MS ?? '0');
const waitFile = process.env.TYCHO_FAKE_WAIT_FILE;
const exitCode = Number(process.env.TYCHO_FAKE_EXIT ?? '0');
const touch = process.env.TYCHO_FAKE_TOUCH;
const leak = process.env.TYCHO_FAKE_LEAK;
const envFile = process.env.TYCHO_FAKE_ENV_FILE;
const receiptExtra = JSON.parse(process.env.TYCHO_FAKE_RECEIPT ?? '{}');

const line = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

line({ type: 'system', subtype: 'init', session_id: 'node-session' });
if (touch) writeFileSync(touch, `${process.pid}\n`);
if (envFile) writeFileSync(envFile, JSON.stringify(process.env));
if (leak) {
  // In the Worker's own group, not one of its own: what a stop reaches is the group.
  const child = spawn(process.execPath, [join(import.meta.dirname, 'fake-leak.mjs'), leak], { stdio: 'ignore', windowsHide: true });
  child.unref();
}
line({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '在做' } },
});
if (sleepMs > 0) await sleep(sleepMs);
if (waitFile) {
  const deadline = Date.now() + 90_000;
  while (!existsSync(waitFile) && Date.now() < deadline) await sleep(50);
}
line({
  type: 'result',
  is_error: exitCode !== 0,
  session_id: 'node-session',
  result: `做完了\n\`\`\`receipt\n${JSON.stringify({ status: exitCode === 0 ? 'done' : 'failed', summary: '节点上这一轮跑完了', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }], ...receiptExtra })}\n\`\`\``,
  usage: { input_tokens: 1, output_tokens: 2 },
});
process.exit(exitCode);
