// A watch process of its own (tests/node-watch.test.ts), whose process table says the
// Worker left something behind that takes two looks to go: the wait between those looks is
// the only thing left to keep this process alive once the Worker has exited. Nothing here
// calls process.exit, so a wait that does not hold the process lets it end before the exit
// code is written — which is what the test is looking for.
import './guard.ts';
import type { HostProcesses } from '../node/hostprocess.ts';
import { runWatch } from '../node/watch.ts';

const [dataDir, runDir, worker] = process.argv.slice(2);
// A pid no process holds: the fake table only ever names it, nothing signals it.
const GHOST = 2 ** 30;
let looks = 0;
const procs: HostProcesses = {
  alive: () => false,
  startOf: async () => undefined,
  descendants: async () => (++looks <= 2 ? [GHOST] : []),
  tagged: async () => [],
  endTree: async () => {},
  endGroup: async () => {},
};
process.exitCode = await runWatch({
  dataDir: dataDir!, runDir: runDir!, round: 1, argv: [process.execPath, worker!], env: {}, credentialVariable: null, procs,
});
