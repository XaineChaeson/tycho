// `npm run stop`: `tycho stop` under the name a checkout knows it by. Windows has no
// signal another process can send for a clean stop: what looks like one kills the
// service outright, which counts as a crash.
import { command } from '../cli/main.ts';

process.exitCode = await command(['stop']);
