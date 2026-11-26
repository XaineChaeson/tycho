// CPU load for reproducing timing flakes (docs/test-stability.md): node scripts/load.ts <threads> <seconds>
// One process; its busy worker threads end with it. Capped at 8 threads and 300 seconds:
// the machine is shared, and an uncapped run once held all of it for hours.
import { Worker } from 'node:worker_threads';

const threads = Math.min(Number(process.argv[2] ?? 8), 8);
const seconds = Math.min(Number(process.argv[3] ?? 300), 300);
for (let i = 0; i < threads; i++) new Worker('for(;;){}', { eval: true });
console.log(`load pid=${process.pid} threads=${threads} seconds=${seconds} (capped at 8 threads, 300 s)`);
setTimeout(() => process.exit(0), seconds * 1000);
