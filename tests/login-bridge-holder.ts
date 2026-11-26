// A process that holds the login helper the way the service does, for tests/ptybridge.test.ts
// to kill: it starts the helper on the fake CLI (silent, so it just waits), prints one JSON line
// with its own pid, the helper's and the CLI's, and then waits to be killed.
import { prepareBridge, startBridge, childPidOf, windowsCommandLine } from '../service/ptybridge.ts';

const [dataDir, fake] = process.argv.slice(2) as [string, string];
const { bridge, problems } = await prepareBridge({ dataDir });
if (!bridge) {
  console.log(JSON.stringify({ problems }));
  process.exit(1);
}
const child = startBridge(bridge, {
  deadline: Number.MAX_SAFE_INTEGER,
  commandLine: windowsCommandLine([process.execPath, fake]),
  env: { ...process.env, FAKE_LOGIN_SILENT: '1' },
});
let errors = '';
child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
  errors += chunk;
  const cli = childPidOf(errors);
  const helperStart = /ptybridge: started (\d+)\r?\n/.exec(errors)?.[1];
  const cliStart = /ptybridge: child pid \d+ started (\d+)\r?\n/.exec(errors)?.[1];
  if (cli !== undefined && helperStart && cliStart && !errors.includes('\u0000printed')) {
    errors += '\u0000printed';
    console.log(JSON.stringify({ holder: process.pid, helper: child.pid, cli, helperStart, cliStart }));
  }
});
child.stdout!.resume();
setInterval(() => {}, 60_000);
