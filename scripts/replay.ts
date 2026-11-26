import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isEntry } from '../service/entry.ts';
import { baselineCases, compareReadyNotice, exportReadyNoticeDraft, parseReadyNoticeCase } from './replay-ready-notice.ts';

const USAGE = `离线回放待验收报告规则

node scripts/replay.ts run [--split tune|release | --case <已定稿案例.json>] [--baseline <旧版工作目录>] [--candidate <新版工作目录>]
node scripts/replay.ts export --ledger <账本备份> --run <轮次编号> --split tune|release --out <草稿.json>

run 默认跑发布验证集。两边都只在临时账本执行，企微发送由本地记录替代，不接入真实账号或模型。
export 只读所选账本，保留结构事实。回放前需确认缺失前提和预期结果，再写成定稿案例。`;

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help') {
    console.log(USAGE);
    return;
  }
  if (command === 'export') {
    const { values } = parseArgs({ args: rest, options: { ledger: { type: 'string' }, run: { type: 'string' },
      split: { type: 'string' }, out: { type: 'string' } } });
    if (!values.ledger || !values.run || !values.out || (values.split !== 'tune' && values.split !== 'release')) throw new Error(USAGE);
    const draft = exportReadyNoticeDraft(values.ledger, values.run, values.split);
    writeFileSync(values.out, JSON.stringify(draft, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`已导出待审阅草稿 ${draft.case_id}`);
    return;
  }
  if (command !== 'run') throw new Error(USAGE);
  const { values } = parseArgs({ args: rest, options: {
    case: { type: 'string' }, split: { type: 'string' }, baseline: { type: 'string' }, candidate: { type: 'string' },
  } });
  if ((values.split !== undefined && values.split !== 'tune' && values.split !== 'release')
    || (values.case !== undefined && values.split !== undefined)) throw new Error(USAGE);
  const inputs = values.case === undefined ? baselineCases.filter((item) => item.split === (values.split ?? 'release'))
    : [parseReadyNoticeCase(JSON.parse(readFileSync(values.case, 'utf8')))];
  const results = [];
  for (const input of inputs) results.push(await compareReadyNotice(input, { baseline: values.baseline, candidate: values.candidate }));
  const failures = results.filter((item) => item.failures.length > 0);
  console.log(JSON.stringify({ family: 'ready-notice', passed: results.length - failures.length, failed: failures.length, results }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

if (isEntry(import.meta.filename)) {
  await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
