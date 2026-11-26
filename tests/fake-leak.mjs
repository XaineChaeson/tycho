// A process a Worker starts and leaves behind, for the tests about a round's residue
// (docs/design/nodes.md §4.2): it writes the file it is given for ever, and it answers the
// interrupt by going on, so only a kill ends it. Its pid goes beside that file.
import { writeFileSync } from 'node:fs';

const file = process.argv[2];
writeFileSync(`${file}.pid`, `${process.pid}\n`);
process.on('SIGINT', () => {});
for (let step = 0; ; step += 1) {
  writeFileSync(file, `${step}\n`);
  await new Promise((resolve) => setTimeout(resolve, 50));
}
