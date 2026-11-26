// A program that does nothing and never ends: a compiler or a self-check that hangs, for the
// tests that cancel a login while it is still being prepared. It records its pid if told where.
import { appendFileSync } from 'node:fs';

if (process.env.FAKE_HANG_RECORD) appendFileSync(process.env.FAKE_HANG_RECORD, `${JSON.stringify({ pid: process.pid, parent: process.ppid, event: 'hang' })}\n`);
setInterval(() => {}, 60_000);
