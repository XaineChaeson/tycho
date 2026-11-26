// Stands in for the ssh that keeps the gateway connection. It connects to nothing: it
// says on stderr what OpenSSH says (the lines are the ones in OpenSSH's ssh.c and
// sshconnect.c; `-v` puts `debug1:` lines among them) and stays or ends as told.
//
// FAKE_SSH_LOG   file that receives one JSON line per start: { pid, argv }
// FAKE_SSH_PLAN  file holding a JSON array with what each start does, the last entry for
//                every start after it. Without the file every start is `up`.
//   up       the forward is accepted, and the process stays until it is ended
//   refused  nothing answers at the gateway: exit 255
//   taken    the port on the gateway is in use, which ExitOnForwardFailure ends: exit 255
//   silent   stays, and never says the forward is up
//   drop     up, and a moment later the connection is lost: exit 255
//   mute     ends with exit 255 and not a word
//   fork     backgrounds the forward unless foreground ownership is explicitly fixed
//   proxy    leaves a ProxyCommand child in the same process tree
//   stubborn ignores SIGTERM
//   huge-line / huge-unfinished emit megabytes with / without a final newline
import { appendFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const log = process.env.FAKE_SSH_LOG;

function lines(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

const started = log ? lines(log).length : 0;
let intent;
try { intent = readFileSync(process.env.FAKE_SSH_RECORD ?? '', 'utf8'); } catch {}
if (log) appendFileSync(log, `${JSON.stringify({ pid: process.pid, argv, intent })}\n`);

let plan = ['up'];
try {
  plan = JSON.parse(readFileSync(process.env.FAKE_SSH_PLAN ?? '', 'utf8'));
} catch {
  // No plan: every start connects.
}
const step = plan[Math.min(started, plan.length - 1)];

const forward = argv[argv.indexOf('-R') + 1] ?? '';
const [, listenPort, , connectPort] = forward.split(':');
const say = (line) => process.stderr.write(`${line}\n`);
const stay = () => setInterval(() => {}, 1000);
const up = () => {
  say('debug1: Authentication succeeded (publickey).');
  say('Authenticated to door.example ([203.0.113.7]:22) using "publickey".');
  say(`debug1: remote forward success for: listen 127.0.0.1:${listenPort}, connect 127.0.0.1:${connectPort}`);
};

function proxy() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  if (log) appendFileSync(join(dirname(log), 'children.log'), String(child.pid) + '\n');
  child.unref();
}

say('OpenSSH_fake, for tests');
say('debug1: Connecting to the gateway');
switch (step) {
  case 'fork':
    up();
    if (['ForkAfterAuthentication=no', 'ControlMaster=no', 'ControlPath=none', 'ControlPersist=no'].every((arg) => argv.includes(arg))) stay();
    else { proxy(); process.exit(0); }
    break;
  case 'proxy':
    proxy();
    up();
    stay();
    break;
  case 'stubborn':
    process.on('SIGTERM', () => {});
    up();
    stay();
    break;
  case 'huge-line':
  case 'huge-unfinished':
    process.stderr.write('故障' + '字'.repeat(1024 * 1024) + (step === 'huge-line' ? '\n' : ''), () => process.exit(255));
    break;
  case 'refused':
    say('ssh: connect to host door.example port 22: Connection refused');
    process.exit(255);
    break;
  case 'taken':
    say(`debug1: remote forward failure for: listen 127.0.0.1:${listenPort}, connect 127.0.0.1:${connectPort}`);
    say(`Error: remote port forwarding failed for listen port ${listenPort}`);
    process.exit(255);
    break;
  case 'silent':
    stay();
    break;
  case 'mute':
    process.exit(255);
    break;
  case 'drop':
    up();
    setTimeout(() => {
      say('Connection to door.example closed by remote host.');
      say('Transferred: sent 3212, received 2936 bytes, in 4.3 seconds');
      say('Bytes per second: sent 742.9, received 679.1');
      process.exit(255);
    }, 150);
    break;
  default:
    up();
    stay();
}
