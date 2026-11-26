// A stand-in for the process helper (tests/process-helper.test.ts): it answers nothing, and
// writes down the command line and the environment it was given, so a test can see where the
// marker travelled. It stays alive long enough to be looked at.
import { writeFileSync } from 'node:fs';

const [report] = process.argv.slice(2);
writeFileSync(report, JSON.stringify({ argv: process.argv.slice(1), marker: process.env.TYCHO_PROCINFO_MARKER ?? null }));
setTimeout(() => {}, 1500);
