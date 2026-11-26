// The platform's own delivery conventions (docs/design/knowledge-and-skills.md §1.2, §6): what
// tycho itself asks of a round, which travels with the code and changes with its version, not
// with anyone's approval. The snapshot generator writes each into a brief when it applies.
import { HOST_URL_ENV, JOIN_MATERIALS_ENV } from '../shared/node-protocol.ts';

// A Task the Router asked a join quota for (docs/design/nodes.md §1.3): how a round opens a
// machine with the materials it is handed, and how it reports the instances it destroyed. Said to
// every round of such a Task, since a later round may be the one that destroys them.
export const SPAWN_SECTION = `## 派生机器

1. 环境变量 \`${JOIN_MATERIALS_ENV}\`（空格分隔的一次性接入材料，每台一份）与 \`${HOST_URL_ENV}\`（主机地址，新实例须可达；无材料则说明并交回负责人）。
2. 接入材料为机密：禁止输出到日志/命令行参数/文件/回执，须通过 stdin 传入：\`printf '%s\\n' "$JOIN_MATERIAL" | tycho node join --to "$${HOST_URL_ENV}" --material-fd 0 --name "<唯一名>"\`。
3. 开关实例使用项目自身方法；机器空闲后会自动注销但不会销毁底层实例。
4. 销毁实例后，在回执 \`destroyed_machines\` 中报告对应的主机机器名。

`;
