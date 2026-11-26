// The Console accepts a frozen rule case, not code or machine credentials. The only
// live data access is the existing read-only, redacted draft projection.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appVersion } from '../cli/paths.ts';
import { InputError } from './errors.ts';
import { nameIsSafe } from './releases.ts';
import { baselineCases, compareReadyNotice, exportReadyNoticeDraft, parseReadyNoticeCase } from './replay-ready-notice.ts';

const root = dirname(import.meta.dirname);
// These are the shipped runtime trees: source identity works in installed packages,
// with no Git checkout or test fixtures. Include transitive consumers, not just the rule.
const runtimeTrees = ['adapters', 'channels', 'cli', 'node', 'runner', 'service', 'shared'];

function sourceBasis() {
  const source_files = ['package.json'];
  function visit(relative: string): void {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) source_files.push(child);
    }
  }
  for (const tree of runtimeTrees) visit(tree);
  source_files.sort();
  const hash = createHash('sha256');
  for (const file of source_files) hash.update(file).update('\0').update(createHash('sha256').update(readFileSync(join(root, file))).digest());
  return { version: appVersion(root), source_digest: hash.digest('hex'), source_files,
    baseline: { setting: 'router.directReadyNotice', value: false },
    candidate: { setting: 'router.directReadyNotice', value: true },
  };
}

export function createReplayConsole({ dataDir }: { dataDir: string }) {
  let running = false;
  return {
    cases() {
      return { family: 'ready-notice' as const, cases: structuredClone(baselineCases) };
    },
    draft(runId: unknown, split: unknown) {
      if (typeof runId !== 'string' || !nameIsSafe(runId) || (split !== 'tune' && split !== 'release')) throw new InputError('请选择本服务的轮次编号和 tune 或 release 案例集');
      try { return exportReadyNoticeDraft(join(dataDir, 'ledger.db'), runId, split); }
      catch (error) { throw new InputError((error as Error).message); }
    },
    async run(value: unknown) {
      if (running) throw new InputError('已有一项隔离规则评测正在运行，请等待结束');
      running = true;
      try {
        let input;
        try { input = structuredClone(parseReadyNoticeCase(value)); }
        catch (error) { throw new InputError((error as Error).message); }
        const basis = sourceBasis();
        // Both variants use this process's own service code. Only the rule flag differs;
        // compareReadyNotice creates scratch ledgers and captures notification delivery.
        const result = await compareReadyNotice(input);
        if (sourceBasis().source_digest !== basis.source_digest) throw new InputError('评测期间程序代码发生变化，本次结果不可信，请在代码稳定后重新运行');
        return { family: 'ready-notice' as const, mode: 'isolated-rule-simulation' as const, basis, input, result,
          execution: { business: 'isolated-ledger', worker: 'fixed-receipt', router: 'no-model', notification: 'local-capture' },
          external_effects: result.external_effects,
        };
      } finally { running = false; }
    },
  };
}

export type ReplayConsole = ReturnType<typeof createReplayConsole>;
