// One side of the compile race in tests/process-helper.test.ts: make the process helper for
// a cache directory of the caller's, ask a real pid when it began, and print the answer and
// whether the helper was used at all. Two of these started at the same instant are what says a
// draft is never used half-written; the flag is what says both really used one, because a
// child that quietly fell back to the PowerShell queries would answer just as correctly.
import { createProcInfo } from '../service/procinfo.ts';

const [cacheDir, pid] = process.argv.slice(2);
let degraded: string | null = null;
const info = createProcInfo({
  cacheDir: cacheDir!,
  log: (line) => {
    degraded = line;
    process.stderr.write(`${line}\n`);
  },
});
const answer = (await info.startsLater([Number(pid)])).get(Number(pid));
console.log(JSON.stringify({ answer: answer ?? null, degraded }));
