// `npm run login-link`: `tycho open --print` under the name a checkout knows it by. The
// running service is asked for a link, and what is printed is the address it tells
// others to reach it by.
import { command } from '../cli/main.ts';

process.exitCode = await command(['open', '--print']);
