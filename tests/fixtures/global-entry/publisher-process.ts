import '../../guard.ts';
import { applyEntry, entryTargets } from '../../../node/global-entry.ts';
const root = process.argv[2]!;
process.on('message', async (request: { id: number; content: any; op?: string; dataDir?: string }) => {
  if (request.op === 'publisher') {
    const { globalEntryPublisher } = await import('../../../service/global-entry-publisher.ts');
    process.send!({ id: request.id, result: globalEntryPublisher(request.dataDir!) }); return;
  }
  if (request.op === 'hold') {
    const { withEntryMutex } = await import('../../../node/global-entry-mutex.ts');
    const result = withEntryMutex(root, () => {
      process.send!({ id: request.id, held: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    });
    process.send!({ id: request.id, result });
    return;
  }
  const result = applyEntry(request.content, entryTargets(['codex']), { env: { CODEX_HOME: root }, home: root });
  process.send!({ id: request.id, result });
});
process.send!({ ready: true });
