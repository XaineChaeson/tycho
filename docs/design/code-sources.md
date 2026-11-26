# 项目的代码来源：仓库和工作目录（按 Claude Code Projects 的思路）

读者：主人和实现者。状态：方向已确认（主人 2026-11-12：“Claude 的产品思路更符合我的使用习惯”；并发“让总控来决定，tycho 不应该管不属于职责范围的事”）。按终态写，不做过渡兼容；取代 project-sessions.md §1/§5 里“代码目录”的部分，以及 nodes.md、roles-and-tiers.md 里 git bundle 下发与收回的部分。

## 结论
1. 项目配两样代码来源，都可以有多个，有顺序，第一个是默认：
   - 仓库：一个 Git 地址。选它的活由干活的机器自己 clone 一份，改完用那台机器的 git 登录推分支、开 PR。
   - 工作目录：某台机器上的一个文件夹（机器登记号 + 路径）。选它的活只派到那台机器，执行器直接在这个文件夹里干活，用那里已有的检出、分支、工具和登录；改完的东西就在那个文件夹里。
   - 一个都不配：不写代码的项目，执行器在空的任务目录里干活。
2. 每件活开工时由总控选一个来源（create_task 的可选参数），不选就用默认。选定后钉在任务上，后续每一轮、它的审阅都用这一个。
3. tycho 不再搬代码。主机打 git bundle、送到机器、收回 bundle、并入主机检出的整层拿掉，不留第二条路。代码靠 clone 拿、靠推送和 PR 交（仓库），或者本来就在原地（工作目录）。这是“执行器是完整 harness，git 和目录透传”（merged-design §1.1）的直接推论。
4. 并发不归 tycho 管。同一个工作目录里几件活并行还是先后、要不要让执行器自己开 worktree，由总控在派活时决定。tycho 只让总控看得到事实：每个来源上现在有哪些活在跑。tycho 不排队、不加锁、不替执行器建 worktree。

## 1. 对象
- 项目：code_dir、repo 两列换成 sources：有序清单，每项 { id, kind: 'repo', url } 或 { id, kind: 'folder', machine_uid, path }。id 是项目内稳定编号，任务按它引用。
- 任务：新列，选定的来源（来源 id，连同建任务时那一项的内容快照，来源后来被改掉时如实说明）。没有来源的项目里为空。
- 一轮的说明（snapshot）：repo 换成 source：{ kind: 'repo', url, binding_key, branch?, commit? } 或 { kind: 'folder', path, binding_key }；不再有 bundle、base commit。`commit` 只有审阅那一轮给：它要检出被审的提交；`binding_key` 是这一来源的绑定身份（`shared/sources.ts` 的 `bindingKey`：来源 id + 钉住时内容的短哈希），由主机写进快照，机器不自行推断——机器按它在任务目录里分开保存每个绑定的副本（§8 第 7 条），主机和机器核对一份证据属于哪个来源也只看它。
- 来源被改或被删：在跑的轮次不受影响；钉在已删来源上的任务停住并写明原因（同“登录被去掉”）；总控可用 update_task 改派到别的来源。
- 仓库地址规则：只收机器能用、不带秘密的网络地址，沿用 shared/remote.ts 的 machineRemote。

## 2. 派发和开工

仓库：
- 派到项目允许的任意机器；同一任务后续轮次固定在第一轮那台（成果在它的任务目录里）。那台机器没了：任务停住说明原因，总控决定重来。改派来源会解除这条固定（§8 第 7 条）。
- 第一轮：机器在任务目录里 `git clone <url> tasks/<任务>/<binding_key>/`（机器自己的 git 登录；失败把这台机器 git 的原话带回这一轮，脱敏后写进理由）。在默认分支开工；分支策略由常驻规则或任务说明决定，tycho 不建分支。后续轮次沿用同一个绑定下的那一份：来源钉住之后不再变（§8 第 11 条），所以不再删掉重建 `origin`，第一轮 clone 出来的远端配置和跟踪引用都留着。
- 只读的一轮（审阅、分析、验证）都在**自己的一份检出**里跑（`runs/<轮>/repo/`，审阅按被审提交检出，其余的按 clone 下来的 HEAD），不碰任务保留的那一份，结束后核对并删掉。这样上一轮改过又没被采用的代码不会成为这一轮的基线。
- 交付：执行器推分支、开 PR，回执报分支、提交、PR（现有回执格式）；合入就是合这个 PR（现有 land 流程）。
- 审阅：审阅机器 clone 后检出被审的那个提交（回执里报的）。

工作目录：
- 只派到那台机器（不受项目“允许的机器”限制：主人点名了这台）。离线就等，任务页写“等 <机器> 上线”。
- 机器核一下目录存在且可读写；执行器 cwd 就是这个文件夹。tycho 不往这个文件夹里写任何东西，一轮的材料（说明、知识）和交付目录都在任务目录里，把绝对路径交给执行器（Claude 用 `--add-dir`；Codex 用 `sandbox_workspace_write.writable_roots` 把交付目录单独开给可写的一轮；没有等价手段的执行器见下面的“落地说明”）。后续轮次同一个文件夹，现状就是现状。
- 只读的那一轮读这个文件夹的 HEAD 和 `git status --porcelain`（开始、结束各一次，只读、不留可选锁），变化记一条“这一轮期间目录有变化”随结束报告上报，只作信息（§8 第 1、2 条）。
- 交付：改动在文件夹里；提交与否、提交到哪个分支，按常驻规则和任务说明；回执报分支和提交（有的话）。
- 审阅：同一个文件夹，执行器原生只读模式，对着被审的那个提交看。并发同样由总控安排。

审阅绑定和合入把关：原来绑在“收回的 bundle 及其提交”上，改成绑在回执报的提交上（仓库：推上去的那个提交，由干活的机器在一轮结束时用 `git ls-remote` 读那条分支的远端头、随这一轮的结束报告报回，主机照报告绑定；工作目录：同一份报告里机器读到的 HEAD。持有仓库访问身份的是机器，主机自己不问远端）。合 PR 仍只合审阅过的那个提交（`--match-head-commit`）。审阅身份 = 来源 + 提交 + 非代码产物的文件摘要集合；任务起点是第一轮开工时机器读到的 HEAD（仓库来源就是克隆下来那条默认分支的头），审阅范围是起点..被审提交。

### 落地说明：实际目录、占位符和交付目录

- 仓库来源的副本放在任务目录的 `tasks/<任务>/<binding_key>/`（快照里的 `binding_key`，即 `<来源 id>-<短哈希>`），只读的一轮放在 `runs/<轮>/repo/`；执行器的 cwd 就是这两处之一，或者是工作目录来源的那个文件夹；任务目录只放这一轮的材料和记录。
- 材料（说明、知识）和交付目录（`artifacts/`）都在任务目录里，而执行器的 cwd 是来源那一处，所以适配器命令里把它们写成占位符（`{tycho-materials}`、`{tycho-artifacts}`，Codex 的可写根再加一个 `{tycho-artifacts-toml}`），机器在起 Worker 之前换成绝对路径（TOML 那个换成编码之后的值）。
- 可写的一轮要把交付目录单独开给执行器的沙箱：Claude 用 `--add-dir`，Codex 用 `sandbox_workspace_write.writable_roots`。Codex 那个开关的值是 TOML，适配器写的又是第三个占位符 `{tycho-artifacts-toml}`：机器换进去的必须是**编码成 TOML 字符串之后**的绝对路径（路径带单引号时才合法），编码要在替换之后做——先编码再替换，带单引号的路径会提前结束字符串。Codex 这一条**没有实录**（本机没有可对照的录制），按它的配置参考写的，机器上实测要补。dsh 没有等价手段：`--permission-mode` 挑的是机器 profile 里定义好的预设，命令行加不了一个可写根。
- tycho 自己的默认（`danger-full-access`）能写交付目录；账号若自己选了 `workspace-write`，这一轮可能写不了，如实报在回执里，不悄悄放宽账号的权限模式，也不另立一条交付约定。

## 3. 总控
- get_project 列出来源（含默认项）和按来源分组的“正在跑的活”；list_tasks / get_task 带每件活用的来源。这是总控安排并发要看的全部事实。
- create_task / update_task 多一个可选的 source（来源 id）。
- 总控自己的 cwd：默认来源若是主机所在机器上的工作目录，就在那里起（只读，沿用“总控能读、不能写”）；否则空目录。总控看仓库用 gh。

## 4. 控制台
- 新建项目：名字；“代码”一栏可加若干项，每项二选一：“仓库地址”或“机器上的文件夹”（选机器、填路径）；可以一项都不加。说明文字讲代码从哪来、改完去哪，不出现 bundle、凭据这类词。
- 设置页“代码来源”：有序列表，可增删、调整顺序，第一项标“默认”。
- 任务页：显示用的是哪个来源；去掉“并入当前分支”；有 PR 的显示 PR。

## 5. 迁移（一次性）
- 有 code_dir 的项目：变成一个工作目录来源，机器 = 主机上那个机器客户端的登记号（找不到就记成待确认，项目页提示主人选机器）；若该目录 origin 过得了 machineRemote，再加一个仓库来源，排在后面。
- 进行中的任务：钉到迁移后的工作目录来源；已结束的不动。
- releases/ 里已登记的 bundle 产物保留为只读历史，不再有新的。
- 节点协议升一版：旧客户端不接有代码来源的活。

## 6. 拿掉的东西（移除干净）
主机侧：runner/repo.ts 的 bundle 打包和 repoProblem 主机检查、service/round-bundle.ts、派发里的 staging、bundleLimitBytes 设置、service/merge.ts（并入主机检出）、任务页并入按钮和接口、accept.ts / releases.ts 里只为 bundle 服务的部分（产物登记本身保留，它还服务上线包等非代码产物）。机器侧：node/unpack.ts 的 bundle 分支。文档：project-sessions、nodes、roles-and-tiers、AGENTS.md 相应段落。

## 7. 不做
- 一个任务同时用多个来源：拆成每个来源一件活。
- tycho 管同一目录的并发（排队、加锁、建 worktree）：主人明确由总控决定。
- 主机替机器 clone 或保存仓库副本：那就是又搬了一次代码。

## 8. 盘点后的裁决（2026-11-12）
实现清单（附录）找出 11 处设计没说清的地方，逐条裁决如下，正文以本节为准。

1. **工作目录里 tycho 只读。** 一轮结束时的核对对工作目录来源只读（`git rev-parse HEAD` 和 `git status --porcelain`，开始、结束各一次），不改 `.gitignore`、`.git/info/exclude` 或任何文件；改写规则文件的做法只留给任务目录里 tycho 自己的 `repo/`。读的时候不带可选锁（`GIT_OPTIONAL_LOCKS=0`），主人目录的 index 不被这次读取刷新；读不出来（不是 git 仓库、git 失败）就如实说读不出来，不说“没变化”。
2. **工作目录里的变化只作信息。** 一轮期间文件夹有变化，记一条“这一轮期间目录有变化”，随结束报告上报（`code_check.folder_change`），不据此拒收回执：那个文件夹不归 tycho，别的活和主人也在动它；只读轮次“改了代码就拒收”的保证只对仓库来源（任务目录里独占的 `repo/`）成立。
3. **审阅读被审的提交。** 审阅说明让执行器读那个提交（`git show`、`git diff 起点..提交`）；要跑测试由执行器自己开 worktree。HEAD 不等于被审提交或有未提交改动时，审阅如实写“测试没有在被审的提交上核实”。tycho 不替它 checkout。
4. **远端分支头由干活的机器核实。** 有仓库访问身份的是干活的机器：一轮结束时它查远端分支头（`git ls-remote`）并随回执上报，主机照这份报告绑定。合入时 `gh pr merge --match-head-commit <被审提交>` 是唯一真正的把关，主机不做第二道。
5. **审阅身份 = 来源 + 提交 + 非代码产物的文件摘要集合。** “当前产物”只由这一处判定，`releaseGate`、验收关、审阅结算都读它；同一提交重新打出的不同包不复用旧审阅。
6. **任务起点。** 第一轮开工时机器读到的 HEAD 记作任务起点，随回执报；审阅范围 = 起点..被审提交。仓库来源的起点就是 clone 下来的默认分支头。
7. **改派来源。** 只有没有在跑的轮次时才能改派；改派即解除机器固定（机器绑定只看当前这次来源选择下的轮次：快照的 `source` 和任务当前钉住的来源相同才算，比较用 `bindingKey`），任务目录里的仓库副本按绑定身份分开（`tasks/<任务>/<binding_key>/`，即快照里那一项的 `binding_key`：来源 id 加钉住时内容的短哈希，所以同一个 id 改了地址也是新的一份），旧的不删，归保留期清理。
8. **待确认的机器。** 迁移时找不到主机上的机器客户端，工作目录来源的 `machine_uid` 记空串，表示待确认：派发不接，项目页提示主人选机器。只有仓库地址、没有代码目录的项目迁成一个仓库来源。主人在项目页把机器选上就是这次确认：同一个事务里，钉在这个来源上、还没结束、`machine_uid` 仍是空串的任务的绑定也补上这台机器（已有的 Run 快照不动；每个补过的任务记一条 `task.source_machine` 审计），主人不会被同一个动作问第二次。
9. **历史 bundle 照保留期清理。** 旧的 bundle 产物和其他登记产物一样到期清掉字节、保留账本历史，不开例外。
10. **全量升级。** 节点协议升到 6，版本不符仍是整机不通信（现行政策），所有机器的客户端都要升级。迁移时还没结束、快照里带旧 bundle 的轮次，交给现有的“需要核实”恢复路径收尾，不建兼容通道。
11. **下一轮按钉住的快照。** 任务上钉的来源快照决定以后每一轮用什么；来源后来被改只提示“来源已改”，被删就停住并写明原因，总控用 update_task 改派。

### 不保证
- 工作目录来源里，几件活和主人自己同时动同一个文件夹时，tycho 分不清谁改了什么（第 2 条），也不保证审阅跑测试的现场就是被审的提交（第 3 条）；起点之后可能混进别的活的提交，审阅范围会包含它们（第 6 条）。理由：并发和现场归总控与执行器安排（主人 2026-11-12），tycho 不在共享目录里假装能隔离。要隔离，总控派活时让执行器自己开 worktree，或改用仓库来源。

---

## 附录：实现清单（2026-11-12 盘点，契约提交 b58cbee 之前的代码）

本次改造应当完整移除“主机打包、下发代码、收回代码、并入主机检出”这一条运行链。保留非代码产物的取回、原子登记、上线校验和历史记录；PR 合入继续走 `land`。

检索范围为 `service/`、`runner/`、`node/`、`shared/`、`cli/`、`console/src/`、`tests/`、`docs/`、`AGENTS.md`。基准为 `HEAD 1e42c20` 及当前工作区。工作区已有 `shared/sources.ts` 等未提交契约骨架，但来源解析、派发、机器执行和审阅尚未接通。以下行号按查阅时文件标注；已有骨架导致行号变化的地方同时给出函数名。

全程只读，没有修改文件，也没有运行测试。

### A．账本、迁移、项目接口、总控工具

| 位置 | 现在做什么 | 按设计改成什么 |
|---|---|---|
| `shared/sources.ts:35`、`:48`、`:56`、`:65` | 已声明目标账本版本、`Source`、`TaskSource`、来源状态；尚未接到账本。 | 作为统一来源契约落地：项目内稳定 id、有序列表、任务选定来源及内容快照；不要让页面、派发各自解释来源状态。 |
| `shared/sources.ts:130` `parseSources` | 仍为 `not implemented`。 | 实现来源入口解析：唯一稳定 id、repo 地址经 `machineRemote` 正规化、folder 机器登记号和路径；补迁移“机器待确认”的表示。 |
| `shared/sources.ts:136` `defaultSource`、`:149` `sourceLabel` | 已有默认项和标签纯函数，尚无消费者。 | 项目接口、总控和页面共用；默认项只由顺序推出。 |
| `service/db.ts:11`、项目/任务建表定义 | 当前 schema 35；项目仍有 `repo`、`code_dir`，任务没有来源列。 | 升 schema，项目两列换为有序 sources，任务增加来源绑定；更新新建库 schema。 |
| `service/db.ts` `MIGRATIONS`；旧 `11` 迁移 | 历史迁移给项目增加 `code_dir`。 | 保留旧迁移历史，新增一步迁移；不要倒改旧迁移。新迁移转换旧目录、活动任务来源，保留已结束任务和旧 Run 快照。 |
| `service/db.ts:1593` 本机机器绑定迁移 | 已根据有效本机接入记录保存 `host_machine_uid`，不能确认时记 null。 | 来源迁移复用这份身份依据，不能按 hostname 或机器名猜测；失效/未知进入待确认。 |
| `service/messages.ts:87` `ProjectRow` | 公开 `repo`、`code_dir`，注释说明 bundle 下发。 | 换为 sources；删除旧字段及 bundle 注释。 |
| `service/ledger.ts:89` `TaskRow` | 没有任务来源。 | 增加选定来源 id、内容快照及必要的机器现场绑定；无来源任务为空。 |
| `service/ledger.ts:2177` `createProject` | 接受 `repo`、`codeDir`，分别写旧列。 | 只接受统一 sources，通过同一个入口解析并保存顺序。 |
| `service/ledger.ts:4162` `setProjectCodeDir` | 裁空白、更新目录、记 `project.update`。 | 替换为完整来源列表更新；维护稳定 id、顺序、变更审计和删除事实。 |
| `service/ledger.ts:2201` `createTask` | 建任务时没有来源选择；审阅只绑定被审任务登记。 | 可选 source id；普通任务省略时选默认并钉住内容；审阅从被审轮次继承来源，不能另选代码。 |
| `service/ledger.ts:2289` `updateTask` | 修改目标、职能、登录、档位、技能等；定义变化递增修订并禁止执行中修改。 | 增加改派 source；作为定义变化处理，递增修订，执行中先中断；明确旧 repo 现场和机器绑定如何处理。 |
| `service/ledger.ts:1509` `requireMachine`、`:1562` `machineRange` | 普通任务一律按项目允许机器及登录范围判定；知识任务按材料项目交集判定。 | folder 直接限定到所指机器，不受项目机器列表限制；repo 首轮按项目范围、以后固定现场机器。保留登录、执行器只读能力和知识任务交集约束。 |
| `service/ledger.ts:2644` `createRun` | 在事务内核对修订、登录、机器、职能、知识等。 | 同一事务再核对任务来源、准备快照中的来源和固定机器仍一致；已删来源不能开新轮；旧 Run 使用其原快照。 |
| `service/ledger.ts:2730` `rehostRun` | 未启动 Run 可以改到另一台允许机器。 | 使用同一个来源机器范围判断；folder 不换机器，已有 repo 现场的任务不能任意 rehost。 |
| `service/ledger.ts:3935` `hostMachine` | 返回本机有效机器的名字，底层依据登记 uid。 | 给迁移和 Router cwd 提供可核对的本机登记身份；比较 source 的 `machine_uid`，不能直接比较显示名字。 |
| `service/http.ts:1306` `projectView` | 返回 `repo`、`code_dir`。 | 返回有序来源、默认标记、机器名称及待确认事实。 |
| `service/http.ts:1341` `shownProject` | 每次读取主机当前分支，增加 `code_branch`。 | 删除为本机并入服务的磁盘查询；项目读取不再依赖主机仓库。 |
| `service/http.ts:1347` `createProject` | 接收 `code_dir`，在主机调用 `repoProblem` 后建项目。 | 接收零到多项 sources；folder 路径由指定机器开工时核实，主机不做仓库准入检查。 |
| `service/http.ts:1531` `putProject` | 校验 `code_dir`，同登录、机器、授权一起保存。 | 换来源列表；保持一次事务提交。未修改来源的请求不能回写旧来源列表。 |
| `service/http.ts:941` `taskPage` 及任务列表投影 | 任务响应没有来源事实。 | 返回任务钉住来源、当前是否变更/删除、实际等待机器；轮次显示当时 snapshot 的来源。 |
| `service/tools.ts` `TaskSourceArgument`、`ProjectSourcesView` | 已新增接口声明，尚未接工具 schema 和执行逻辑。 | 把声明接到真实工具入口，不能把类型存在算作实现完成。 |
| `service/tools.ts` `create_task` | 没有 source 参数；审阅先 `accept.register`。 | 增加 source 参数和账本调用；审阅来源由系统继承。审阅核实部分归 C。 |
| `service/tools.ts` `update_task` | patch 不含来源。 | 增加 source，走账本统一改派及修订规则。 |
| `service/tools.ts` `get_project` | 输出 `repo/code_dir/code_branch`，说明代码目录和当前分支。 | 输出来源、默认项、按来源分组的活跃任务/Run；删除主机分支查询。 |
| `service/tools.ts:194` `taskLine`、`list_tasks`、`get_task` | 列表摘要不带来源。 | 加入来源事实；完整任务和列表使用相同解释。 |
| `service/router-material.ts:49` 恢复材料任务列表 | 展示活跃轮次和产物 registration，没有来源。 | 增加任务来源及现场机器，使总控重开上下文后仍能安排目录并发；非代码 registration 保留。 |
| `service/router-prompt.md:1`、`:7`、`:10` | 假定 cwd 是主机代码目录，`get_project.repo` 是唯一仓库，代码目录是已合入基线。 | 按来源解释 cwd 和 `gh --repo`；先看来源上的活跃工作再安排并发。删除唯一主机基线假设，保留总控只读权限边界。 |

账本版本还有一个同步点不在上述目录中：`package.json` 的 `tycho.ledger` 必须与新 `SCHEMA_VERSION` 一起更新。

### B．派发、机器执行、材料路径和 Router cwd

### 派发与 bundle 下发整层

| 位置 | 现在做什么 | 按设计改成什么或删除 |
|---|---|---|
| `service/dispatcher.ts:30` `DispatcherOptions` | 要求 `bundleLimitBytes`，另有 `reviewedFile` 回调供审阅读取 bundle。 | 删除两项 bundle 专用依赖；来源读取由账本统一提供。 |
| `service/dispatcher.ts:183` `prepare` | 把 `RepoBase` 传给 `prepareSnapshot`。 | 改传任务选定来源；来源、权限和机器选择使用同一次读取结果。 |
| `service/dispatcher.ts:225` `reviewRepo` | 从审阅绑定找到 `.bundle`，核对登记文件后 `stageFile`。 | 删除；审阅按被审来源和核实提交准备代码，提交契约归 C。 |
| `service/dispatcher.ts:242` `repoFor` | 从项目 `code_dir` 读仓库；核对主机有旧 base commit；刷新 remote。 | 删除主机仓库、基准提交和 origin 依赖；改读取任务来源。 |
| `service/dispatcher.ts:284` `offeredMachines`、`:344` `machineFor` | 按项目机器范围挑机器。 | 加入 folder 指定机器、repo 固定机器、来源已删/机器已不存在的判定；离线 folder 等上线，不当成可换机器。 |
| `service/dispatcher.ts:520` `continueLost` | 先找到可接续机器，再核实旧 Run 不在。 | 保留旧执行判定底线；repo 现场机器被销毁后停住，不自动换机器重建代码；让总控决定重来。 |
| `service/dispatcher.ts:570` `createAndLaunch` | 接收 `StagedRepo`，调用 `runner.launch(run, staged.file)`。 | 删 staged 参数及文件传递。 |
| `service/dispatcher.ts:670` 派发准备和 `finally` | 开 Run 前打 bundle、限制大小；异常和结束时清 staging。 | 删除整段打包、大小限制和 staging 生命周期；代码准备失败改由机器报告。 |
| `runner/repo.ts:23` `RepoBase`、`:34` `StagedRepo` | 表示主机目录、base commit、remote、bundle 临时文件。 | 删除运行期类型，使用来源契约。 |
| `runner/repo.ts:115` `repoProblem`、`:134` `repoBase`、`:143` `withRemote`、`:154` `hasCommit` | 主机仓库准入、读 HEAD/origin、查 base。 | 删除运行期路径；迁移需要读旧 origin 时，只保留迁移用途，不能留下第二条运行链。 |
| `runner/repo.ts:167` `stageRepo`、`:202` `stageFile`、`:213` `dropStaged` | 打 bundle、复制审阅 bundle、清临时目录。 | 整段删除。 |
| `service/round-bundle.ts` 全文件 | 在内存暂存每轮 bundle，供机器主动下载。 | 整文件删除。 |
| `runner/runner.ts:1048` `launch` | 接收可选 `repoBundle`，复制进待下发 snapshot。 | 删除参数和复制；普通 snapshot 的落地、送达哈希核对保留。 |
| `runner/runner.ts:1080` 启动前换机器 | prepare 失败后可改派另一台机器。 | 候选必须受来源现场约束；不能绕开 folder 定向和 repo 后续固定机器。 |
| `runner/node-channel.ts:26`、`:35`、`:56` | 接收 `RoundBundles`。 | 删除依赖和构造参数。 |
| `runner/node-channel.ts:114` `place` | 读取 `repo.bundle`，stage → prepare → drop。 | 删除二进制 staging；只传普通 snapshot 材料。 |
| `service/http.ts:336` `roundBundle` option | 向 HTTP 层注入 bundle 查询。 | 删除。 |
| `service/http.ts:2017` `nodeSnapshot` | snapshot 响应附 bundle 的摘要和大小。 | 删除 bundle 字段，保留 snapshot 归属、协议和普通文件。 |
| `service/http.ts:2036` `nodeBundle`、`:2508` 路由 | 提供 `/api/node/runs/:id/repo-bundle`。 | handler 和路由一起删除。 |
| `service/main.ts:73`、`:346`、`:380`、`:764`、`:785`、`:1067` | 创建 roundBundles，注入 channel/HTTP，给 dispatcher 体积上限和审阅文件回调。 | 全部删除对应装配。 |
| `service/settings.ts:248` `repo.bundleLimitMb` | 声明代码包大小上限。 | 删除设置、读取、表单和测试；旧持久化 override 不能继续形成有效配置项。 |
| `service/settings.ts:258` `artifacts.fileLimitMb` 帮助 | 把代码 bundle 列为取回产物。 | 保留通用产物限额，删代码 bundle 说明。 |

### Snapshot、机器代码准备与材料交付

| 位置 | 现在做什么 | 按设计改成什么或删除 |
|---|---|---|
| `shared/sources.ts:90`、`:142` | 已声明 `SnapshotSource`，转换函数仍占位。 | 实现 repo URL/可选 branch、folder path 的转换；新 snapshot 不写 bundle/base。 |
| `runner/snapshot.ts` `Snapshot.repo/source` | 已加 `source` 类型，但旧 `repo` 和所有消费链仍在。 | 接通 source；停止生成旧 repo 输入。历史 JSON 的展示读取与运行期兼容路径分开。 |
| `runner/snapshot.ts:238` `tierFor`、`:711` `roundTurn` | prompt、tierPath、linePath 相对任务目录；workdir 固定任务目录。 | 区分执行器实际 cwd 和材料目录，使用机器端可解析的绝对路径或等价机制。 |
| `runner/snapshot.ts:350` `repoSection` | 描述 bundle 基准、`tycho/<task>` 分支、补历史、推送和交 bundle；远端失败还能交 bundle。 | 重写为 repo/folder 两类说明；删除 tycho 建分支、base、bundle 和无远端仍可代码交付的回退。分支策略交任务说明/常驻规则。 |
| `runner/snapshot.ts:400` `OWN_REPO` | 只读代码固定在本轮专用 `repo/`。 | 代码路径由来源和审阅准备结果给出，不能统一使用固定相对目录。 |
| `runner/snapshot.ts:535`、`:560` `renderBrief` | 有 `repo` 才生成代码说明。 | 按 source 生成；无来源正常使用空任务目录。 |
| `runner/snapshot.ts:735`、`:765`、`:783` `prepareSnapshot` | 接 repo；只读时剥 remote。 | 接 source；repo 审阅仍需 URL 获取代码，不能保留“只读不给远端”的规则；folder 不改 Git 配置。 |
| `runner/snapshot.ts:817` `snapshotFiles` | 生成 `repo.commit`、`repo.remote`。 | 删除两种材料，生成 source 材料；保留 brief、知识、技能、档位、线路和 access。 |
| `node/client.ts:318` `getBytes` | 专供 bundle 下载。 | 删除无消费者的方法。 |
| `node/client.ts:432` `prepare`、`:454` bundle 分支 | 下载 bundle，核对 bytes/sha256，随 snapshot 原子发布。 | 删除 bundle 下载；保留普通 snapshot 完整落地后才能启动。 |
| `node/unpack.ts:32` 错误说明、`:100` `handed` | 从 `repo.commit/repo.bundle` 判断代码是否齐全。 | 删除 bundle/base 协议；按 source 准备代码，无来源正常执行。 |
| `node/unpack.ts:46` `gitIn` | 执行解包相关 Git，处理超时和原话。 | 若复用，改为网络 clone/检出提交；使用机器自己的 Git 登录，失败如实报告。 |
| `node/unpack.ts:67` `remoteOf`、`:84` `setOrigin` | 每轮删除或重设 origin。 | 删除；repo 首次 clone 自然产生 origin，folder 的 origin 不动。 |
| `node/unpack.ts:120` `unpackOwn` | 从 bundle 为只读轮次解出独占副本。 | repo 审阅 clone 并检出绑定提交；folder 原地审阅，不 checkout 改动主人目录。 |
| `node/unpack.ts:143` `unpackRepo` | bundle clone，建立固定任务分支、默认 Git 身份；后续查 base 后复用。 | repo 首轮 `clone <url> repo/`、默认分支开工，后续复用现场；删除固定分支、代设身份、base 校验、每轮 origin 修复。folder 仅核实并返回目录。 |
| `node/unpack.ts:192` `noteNotStarted` | 记录未开工原因。 | 保留并移到合适出口；clone/目录准备失败仍是没有开工。 |
| `node/watch.ts:195` 代码准备 | 根据只读与否调用 unpack。 | 根据 source 准备 cwd，代码准备和权限分别判定。 |
| `node/watch.ts:225`、`:235` | 定位执行器时排除任务目录；spawn cwd 固定任务目录。 | 使用实际来源 cwd，并把它加入命令定位排除；日志、快照、证据仍放任务目录。 |
| `node/watch.ts:327` 核对与清理 | 等进程树退出，核对独占代码，再删除专用目录。 | 只删除 tycho 创建的 clone/scratch；folder 走不写目录的核对方案，不能调用原清理。 |
| `node/code-check.ts:149` `metaOf`、`:160` `takeBaseline` | 假设 `.git` 是目录，记录 Git 元数据、ignore 和文件。 | 支持来源目录及 worktree；基线材料仍写任务目录。folder/非 Git 目录核对边界见末节。 |
| `node/code-check.ts:173` `restoreRules`、`:276` 调用 | 为按基线规则枚举文件，实际恢复 `.gitignore` 和 `.git/info/exclude`。 | folder 不能复用这一写目录实现；改为纯读取核对。 |
| `node/code-check.ts:253` `dropOwn` | 删除本轮代码副本和 scratch。 | 只接受明确由 tycho 创建的临时目录，不按实际 cwd 删除。 |
| `node/runbox.ts:166` | 用解包失败解释 not-started。 | 改为 clone/来源目录准备失败；证据语义不变。 |
| `node/launch.ts:66` `roundDirs/launchOf` | 排除任务目录、repo、cwd 中的执行器候选。 | 传真实来源 cwd，保留不能从任务代码中启动执行器的保证。 |
| `runner/conventions.ts:14` | 秘密禁止写入 repo、artifacts、任务目录等。 | 保留，目录例子覆盖 folder 实际 cwd。 |

### 协议、清理和 Router

| 位置 | 现在做什么 | 按设计改成什么 |
|---|---|---|
| `shared/node-protocol.ts:32`、`:38` | 当前协议 5；已有下一版来源协议骨架。 | 升版，明确 source、材料路径和结束 HEAD 证据；协议门槛不能随当前版本继续漂移。 |
| `shared/node-protocol.ts` `NodeSnapshot` | 含 bundle 摘要/大小。 | 删除 bundle 字段。 |
| `shared/node-protocol.ts` `NodeState`、`NodeCodeCheck` | 上报进程和只读核对，没有独立结束 HEAD。 | 补机器在 Worker 结束时采集的 HEAD 事实及失败原因，供 C 核实 folder 提交。 |
| `service/nodes.ts` 协议检查、poll/report 解析；`service/http.ts` node 入口 | 当前按整版协议一致性接纳通信。 | 同步新消息解析和能力判断；旧客户端处理政策见末节。 |
| `service/ledger.ts:661` `judgedCheck` | 根据 `snapshot.repo` 拒绝“有代码却报 no-code”。 | 改按 source，不能把 folder 核对不了当作无代码。 |
| `shared/roles.ts:109` `CodeCheck` 及采用函数 | 仅 same/no-code 采用只读回执。 | 对齐新的 folder 核对语义；保留如实报告不可核实。 |
| `service/retention.ts:80` `dropMachineCopies` | 对到期任务的每台机器发清理任务 repo。 | repo clone 仍可清理；folder 不作为代码副本清理。 |
| `service/ledger.ts` `retentionDue`、`noteTaskCodeDropped` | 按任务/机器记清理完成。 | 只对确实拥有 tycho 代码副本的轮次记账，不把 folder 记成已清理。 |
| `runner/node-channel.ts:106`、`node/client.ts:635`、`node/runbox.ts:457`、`shared/node-protocol.ts` `NodeDropTaskCode` | 清理 `tasks/<task>/repo/`，有进程或未知时拒绝。 | 保留有限删除范围，服务 repo clone；禁止扩展成删除 source.path。 |
| `service/session-host.ts:474` `workDirOf` | 项目 `code_dir` 可进入就作为 Router cwd，否则空目录。 | 仅默认来源为本机登记号对应的 folder 时使用；repo、远程 folder、无来源、机器待确认均用空目录。 |
| `service/session-host.ts:492` `heldDir/codeDirChanged/changedDir` | 比较 launch_json 的 cwd/code_dir 决定是否续上下文。 | 比较默认来源身份、配置及实际 cwd；默认项顺序或本机归属变化也要处理。 |
| `service/session-host.ts:768` 启动、`:807`/`:900` 目录失效回退 | 按解析目录启动；目录丢失时回退空目录。 | 保留回退及消息处理保证，文案改默认工作目录来源。 |
| `service/session-host.ts:943` `launch_json` | 记录 cwd/code_dir。 | 新记录改 source/cwd；旧记录只作历史读取。 |

材料交付还有几处超出指定目录，但 B 无法绕过：

| 位置 | 现在做什么 | 必须同步修改 |
|---|---|---|
| `adapters/types.ts:11` `Turn` | 只有 workdir、prompt、tierPath、linePath，没有独立材料目录。 | 明确实际 cwd、材料位置及附加可读目录契约。 |
| `adapters/claude.ts:124` | `--add-dir` 当前传 `turn.workdir`。 | folder cwd 下传外置材料目录。 |
| `adapters/codex.ts:325` | `-C turn.workdir`。 | cwd 与材料可读范围一起验证，不能只改 `-C`。 |
| `adapters/dsh.ts:228`、`:376` | 读取 tierPath/linePath。 | 同步不依赖 cwd 的材料路径。 |

### C．审阅、提交核实、产物登记和 PR 合入

| 位置 | 现在做什么 | 按设计改成什么或删除 |
|---|---|---|
| `service/accept.ts:25`、`:82` `check` | 识别 `.bundle`，限制一个 bundle、一个分支，从字节读 commit。 | 删除 Git bundle 校验与提交提取。 |
| `service/accept.ts:103` `takeNow` | 取回文件、校验、一次 rename、事务登记 files/commits；失败保留旧登记。 | 保留非代码产物原子取回、登记、孤儿清理和失败事实；提交核实不再由 bundle 取回顺带完成。 |
| `service/accept.ts:44` `Registered`、`:196` `register` | 固定 task revision/run，取回产物，以 registration id 作为审阅绑定前提。 | 代码部分改为固定 run/revision/source/delivery 后核实提交；非代码文件仍须登记并绑定，保留异步期间对象变化拒收。 |
| `service/review.ts:57` `receiptCommits` | 返回所有 commit；目前只作无 bundle 时的后备。 | 成为代码交付入口的一部分；解析唯一分支/提交/PR，核实后形成代码身份，不能继续任取第一项。 |
| `service/review.ts:118` `Registration` | files 与 bundle commits 同一个登记。 | 新代码提交与文件登记解耦；历史 commits 保留可读，非代码文件登记继续存在。 |
| `service/review.ts:145` `Product`、`:155` `productStale` | 当前产物身份是最近 run、revision、完整登记文件集合；不比较 commit。 | 增加来源和核实代码提交身份；非代码完整文件集合继续比较。验收、上线、审阅结算仍共用这一判定。 |
| `shared/review.ts` `ReviewOf` | 原有 commits/base/files；已有可选 `reviewed` 骨架。 | 落地核实后的来源/提交绑定；新数据停止写 bundle/base，旧绑定只读历史；files 保留非代码审阅用途。 |
| `shared/sources.ts:99` `Delivery`、`:111` `ReviewedCommit` | 已声明交付和核实提交形状，尚无实际核实链。 | C 实现回执解析、repo `ls-remote` 核实、folder 结束 HEAD 核实，并与账本事务写入衔接。 |
| `service/ledger.ts:1134` `productOf` | 从最新 Run 和 registration 形成 Product。 | 汇合该轮 source、核实交付和非代码文件登记。 |
| `service/ledger.ts:1146` `bindReview` | 要求 registration id 匹配；base 来自旧 snapshot.repo；commit 优先登记、其次回执。 | 改从固定轮次的核实交付生成绑定，审阅者不能自行指定提交；删除 bundle 优先/base 推导。 |
| `service/ledger.ts:1215` `requireLandable`、`reviewGateOf`、`:1249` `settleVerdict`、`:2465` `acceptTask` | 共用 `productStale` 开关审阅和验收。 | 保留关卡，改读新代码身份；不能因不再收 bundle 而绕过审阅。 |
| `service/ledger.ts:2511` `registerArtifacts` | 登记 files、commits、编号，拒绝已清理轮次重新登记。 | 保留非代码登记和事务；停止从新 bundle 产生 commits。 |
| `service/ledger.ts:2607` `releaseGate` | 发布包必须属于审过的完整文件集合。 | 保留这个文件摘要保证；代码 commit 不能替代发布包字节身份。 |
| `runner/snapshot.ts` `renderReviewBrief` | 展示 bundle/base→commit diff；没 bundle 就说没有代码；代码统一在专用 repo。 | 展示来源、核实提交和实际代码位置；repo clone 后检出提交，folder 原地针对提交审阅；审阅输入边界统一按 [职能与档位 §4](roles-and-tiers.md#4-审阅) 处理。 |
| `service/dispatcher.ts` `reviewRepo` | 用主机登记 bundle 给审阅机器代码。 | 删除；B 使用 C 的绑定来源/提交准备审阅现场。 |
| `service/releases.ts:76` `TaskRelease`、`:126` `releasesOf` | 把登记文件中特定后缀投影成 `bundles`。 | 删除新代码 bundle 操作投影；旧登记保留只读历史。packages、files、摘要校验、登记目录和清理继续存在。 |
| `service/releases.ts` `registeredFile/registeredPackage`、`sweepReleases` | 校验登记身份和磁盘字节，清理无登记目录。 | 保留非代码用途；删调用方后再删仅为 bundle 服务的部分，不能整文件删除。 |
| `service/merge.ts` 全文件 | 核对 bundle、复制固定字节、合到任务分支或主机当前分支，使用引用锁和隔离仓库。 | 整文件删除，包括 `Merger`、请求/响应类型、两个操作和锁装配。 |
| `runner/repo.ts:219` `bundleHeads/soleBundleHead`、`:255` `applyBundle`、`:273` `currentBranch`、`withIntegrationLock/integrateBranch` | 校验 bundle、隔离合并并原子更新主机引用。 | 随本机并入删除；B/C 消费者清完后，文件无用途就整个删除。 |
| `service/http.ts:389` merge option、`:1141` `mergeBundle`、`:1154` `integrateBundle`、`:2587` 两条路由 | 任务页调用 `/merge`、`/integrate`。 | options、handler、路由全部删除。 |
| `service/http.ts:1079` `releaseView` | `releases.bundles[].pr` 把 PR 显示挂在 bundle 上。 | PR 从回执/代码交付事实独立投影；保留非代码取回状态、发布包和历史只读文件。 |
| `service/main.ts:24`、`:479`、`:481`、`:998` | 创建并向工具/HTTP 注入 merger。 | 删除所有装配。 |
| `service/tools.ts` `accept_task` | 文案说取回 bundle 供并入。 | 改成取回非代码产物；代码交付按来源完成。 |
| `service/tools.ts` `integrate_task` | 有 PR 用 `registration.commits[0]` 建 land 子任务；无 PR 回退 bundle 本机并入。 | 只保留 PR land，用核实后的被审提交；无 PR 明确无可合 PR，不留本机回退。 |
| `service/land.ts:38`、`:93` `landingTask` | 使用“登记提交”，生成 `gh --match-head-commit` / `glab --sha` 合入任务。 | 改提交来源为核实交付；保留匹配提交、分支保护、子任务去重和固定合入身份。子任务来源不能误选项目当前默认项。 |
| `service/ledger.ts:2313`、`:3090` | 限制 land 任务目标修改；结算后在父任务记 `task.integrate` 和 merged 事件。 | 保留并对齐来源/提交绑定，不能随 `merge.ts` 一起删除。 |
| `service/ledger.ts:4100` `noteAction` 的 `task.merge` 路径 | 本机合任务分支后发 merged。 | 删除新运行期的 task.merge 入口和事件生成；历史 change 仍可读。`task.integrate` 的 PR land 用途保留。 |
| `shared/labels.ts:384` `taskBranch` 及本机并入提示 | 统一生成 `tycho/<task>`，用于机器分支和页面。 | 移除新运行期固定分支政策及无消费者提示。 |
| `shared/pull-request.ts` | 唯一解析 PR URL 和“恰好一项”规则。 | 保留，新的交付、land、页面继续共用，不能再写第二份 PR 识别。 |

### D．控制台

| 位置 | 现在做什么 | 按设计改成什么或删除 |
|---|---|---|
| `console/src/lib/types.ts:611` `Project` | `repo/code_dir/code_branch`。 | 换 sources、默认项和迁移待确认事实。 |
| 同文件 `:125` `Task`、`:315` `RunSnapshot` | 不声明任务/轮次代码来源。 | 接任务来源绑定与轮次 snapshot.source，历史轮次不借用当前项目配置。 |
| 同文件 `:203` `ReleaseFetch` | 当前登记与最近取回失败。 | 保留非代码产物用途。 |
| 同文件 `:211` `ReleaseBundle`、`:233` `TaskReleases.bundles`、`:247`/`:254` 合入响应 | bundle 操作及依附的 PR、本机 merge/integrate 结果。 | 删除新 bundle 操作和本机响应；旧 bundle 只读、PR 独立展示。 |
| `console/src/lib/projects.ts:20` `ProjectDraft`、`draftOf/changed/projectBody` | 编辑单个 codeDir；保存其他设置也发送 code_dir。 | 编辑有序多来源；支持稳定 id、种类、地址/机器/路径、顺序；只在实际修改来源时更新它。 |
| 同文件 `:95` `NewProjectDraft`、`:105` `newProjectBody` | 名字加可选 code_dir。 | 名字加零到多项来源。 |
| `console/src/components/new-project.tsx` `BLANK/NewProjectForm`、`:44` | 单目录输入，解释 bundle 与凭据。 | 来源列表；仓库地址或机器文件夹，可为空；只解释代码从哪来、改完去哪。 |
| `console/src/pages/project-settings.tsx:193` | 单个主机目录，解释 bundle、任务分支、回收；旁显 repo。 | “代码来源”有序列表，增删、调整顺序、首项默认；显示待确认/失效机器。 |
| 同文件 `:142`、`:253` | 改名不影响代码目录；所有任务受项目机器范围限制。 | 改来源词汇，并明确 folder 指定机器优先于项目机器范围。 |
| `console/src/pages/projects.tsx:27` | 项目卡片显示 code_dir，否则 repo。 | 显示默认来源，必要时加来源数量；无来源显示非代码项目。 |
| `console/src/pages/task.tsx:9`、`:35` imports | 引入 taskBranch、bundle、本机合入结果。 | 删除专用 import。 |
| 同文件 `:365` `MergeCard` | 合到任务分支、并入当前分支，调用两条本机接口，显示主机目录和分支。 | 整卡删除，包括按钮、请求、处理中/失败/成功状态和分支推导。 |
| 同文件 `:345` `LandedByPullRequest`、`:981` | PR 卡片受 `releases.bundles.length` 控制。 | PR 独立显示，不依赖任何 bundle；异常 PR 显示公共规则给出的原因。 |
| 同文件 `:607` `ReviewFacts` | 展示绑定 commits 和文件身份。 | 展示核实的代码提交、来源及仍需保留的非代码文件身份；历史绑定如实显示。 |
| 同文件任务/轮次详情 | 没有来源展示。 | 任务显示选定来源及变更/删除事实；轮次显示当时 source；folder 离线显示等哪台机器。 |
| 同文件 `:319` `DroppedCopies` | 清理说明兼含 bundle 操作。 | 保留非代码清理事实，删除可本机合 bundle 的含义。 |

### 测试与 fixture 清单

以下按测试文件列出归属。历史 schema 和原始 CLI 实录是证据，不能为了消除关键词改写。

### A：账本、迁移和工具

| 位置 | 现在覆盖什么 | 修改要求 |
|---|---|---|
| `tests/project-sessions-http.test.ts:26`、`:39` | 默认 code_dir、新建主机 Git 目录。 | 改 sources 为空、多 repo/folder、有序默认；删除主机仓库验证。 |
| `tests/projects-http.test.ts:129` | 设置/清空目录、拒非仓库、裁空白、审计。 | 改来源增删改、稳定 id、顺序、机器引用、待确认和网络 URL。 |
| `tests/tools.test.ts:144`、`:603`、`:631` | 工具清单、项目边界、审阅创建。 | 保留 integrate_task 的 PR 用途；补 source 参数、跨项目来源拒绝、审阅来源继承、按来源活跃工作。 |
| `tests/migration.test.ts:147`、`:217` | 当前项目投影和各历史版本列差异。 | 当前投影换 sources；历史版本真实列继续保留。 |
| 同文件 `:1245`、`:1270` | code_dir 加列迁移崩溃点、当前目录更新接口。 | 保留中间版本原子性；最终断言换来源迁移，更新接口换 sources。 |
| 同文件 `:1377`、`:1418`、`:1478` | 旧 SQL 中 repo/code_dir，升级后目录保留。 | 旧 SQL 保留；补本机 uid、origin 正规化、待确认、进行中任务绑定、已结束任务不动。 |
| `tests/repo-remote.test.ts:13`、`:21`、`:28`、`:38`、`:48` | 地址去秘密、SSH 别名/用户、幂等、拒本地地址/参数/helper。 | 保留，作为来源入口的统一地址规则测试。 |
| `tests/fixtures/ledger/schema-v4.sql` 至 `schema-v34.sql` | 历史 project.repo；v12 起有 code_dir。 | 全部保留；新增改造前当前 v35 的完整 schema fixture，再测新迁移。 |
| 同批 fixture 的 `review_of_json/artifacts_json/landing_json` | 历史审阅、登记和 land 结构。 | 保留历史输入，新增旧 bundle 只读及旧绑定处理的迁移验收。 |

历史列的定位：`repo` 在 v4–5 第 5 行、v6 第 6 行、v7 第 7 行、v8–9 第 9 行、v10 第 10 行、v11–18 第 8 行、v19–34 第 7 行；`code_dir` 在 v12–18/v24–34 第 11 行、v19–23 第 10 行。

### B：派发、机器和 Router

| 位置 | 现在覆盖什么 | 修改要求 |
|---|---|---|
| `tests/repo-bundle.test.ts` 全文件，主要 `:93`、`:114`、`:142`、`:155`、`:169`、`:192`、`:217`、`:230`、`:258`、`:271`、`:299` | bundle/base/limit/repoProblem/staging/origin/只读无 remote。 | 删除旧机制测试；换 repo clone/固定机器/复用、folder 定向/原地 cwd、无来源、删除/改派来源。 |
| `tests/task-rework.test.ts:90`、`:111`、`:121`、`:135` | 退回仍钉原 snapshot.repo/base 和会话现场。 | 改固定 source/机器/现场；保留输入与会话断言。 |
| `tests/runner-snapshot.test.ts:107` | 输出 repo.commit。 | 改 source 三种情景；不得生成 repo.commit/repo.remote/repo.bundle。 |
| `tests/readonly-check-settle.test.ts:32`、`:44`、`:92` | 由 snapshot.repo 判断有代码，核对失败拒收和重派。 | 改 source，保留采用规则及一次重派。 |
| `tests/node-watch.test.ts:348` `withRepo` | 制造 bundle/base fixture。 | 换 repo 远端 fixture；folder fixture 放任务目录之外。 |
| 同文件 `:369`、`:381` | 解 bundle，后续不覆盖。 | 首轮 clone 默认分支、不建 tycho 分支，后续保持现场；补 folder cwd。 |
| 同文件 `:399`、`:414`、`:422` | 缺 base/bundle 不启动。 | 删除；换 clone 失败、来源材料损坏、folder 不存在/不可访问，均报告 not-started。 |
| 同文件 `:431`、`:443`、`:463`、`:474` | 改/撤 origin、配置锁失败。 | 删除每轮修 origin；补 folder Git 配置不变。 |
| 同文件 `:492` | 无代码正常启动。 | 改无来源，保留。 |
| `tests/node-watch-readonly.test.ts:67`、`:87`、`:102`、`:114`、`:121`、`:130`、`:143` | 独占只读副本、核对、删除；可写复用。 | repo 审阅 clone/检出、folder 原地；只删自建副本。folder 核对须先补设计。 |
| `tests/node-run.test.ts:157`、`:218`、`:256`、`:269` | 真服务→客户端→watch 的 bundle E2E。 | 换 repo/folder 两条 E2E，验证 cwd、外置材料和来源事实。 |
| 同文件 `:447` | 版本不符不是失联。 | 保留并更新协议版本。 |
| `tests/node-client.test.ts:343` | bundle 不完整不发布 snapshot。 | 删除 bundle 断言；保留 `:329` 普通 snapshot 原子落地。 |
| 同文件 `:223`、`:257`、`:267`、`:287` | 代码副本清理及进程守卫。 | repo clone 保留；补 folder 永不被删。 |
| 同文件 `:672`、`:703` | 协议不符停下、声明清理能力。 | 对齐协议政策和新 HEAD/source 证据。 |
| `tests/node-http.test.ts:140`、`:153`、`:162`、`:167` | bundle 元数据、下载路由、归属。 | 删除下载测试，snapshot 归属保留。 |
| 同文件 `:208`、`:222` | 旧 Run 无节点身份时拒 snapshot/bundle/credential。 | 从表中删 bundle，其余保留。 |
| 同文件 `:314`、`:498` | 清理能力、旧版 poll 拒绝。 | 清理按来源；协议政策见末节。 |
| `tests/node-unverifiable.test.ts:27`、`:74` | 注入 createRoundBundles。 | 删除注入，未知进程测试保留。 |
| `tests/runner-artifacts.test.ts:177` | channel 注入空 bundles 对象。 | 删除参数，通用产物测试保留。 |
| `tests/session-host.test.ts:1686` | code_dir 是 Router cwd。 | 换本机默认 folder；repo/远端 folder/无来源为空目录。 |
| 同文件 `:1696`、`:1728` | 目录变化换上下文、丢失回退。 | 改来源身份/默认顺序/cwd 变化，保留失败降级。 |
| `tests/helpers.ts:207`、`tests/tuned-getters.test.ts:3`、`:25` | bundleLimitBytes 必填及默认 getter。 | 删除该设置和断言，其余显式 getter 要求保留。 |
| `tests/console-helpers.ts:69`、`:73`、`:188`、`tests/router-live.test.ts:100` | roundBundle 注入。 | 删除。 |

### C：审阅、登记、land 和本机并入

| 位置 | 现在覆盖什么 | 修改要求 |
|---|---|---|
| `tests/repo-integrate.test.ts` 全文件 | 本机隔离合并、引用锁、工作区不动、禁 hooks/filter、保 merge 修正。 | 整文件删除，不转成新来源承诺。 |
| `tests/merge-http.test.ts` 全文件 | bundle 本机 merge/integrate、任务分支、锁、PR 分流、恶意 bundle。 | 删除旧操作测试；独立 PR 形状/页面事实转到保留的 task/land 测试。 |
| `tests/git-repo.ts:96`、`:116` `unpack/bundleOf` | 模拟 bundle 解包/回传。 | 消费者清完后删除；scratchRepo/git/hasGit 留给新 Git 测试。 |
| `tests/review-dispatch.test.ts:52`、`:59`、`:65`、`:98`、`:119` | 作者交 bundle，审阅者收 bundle。 | 改回执交付、远端/结束 HEAD 核实，审阅同来源和固定提交。 |
| 同文件 `:174`、`:181`、`:186`、`:202`、`:207` | 绑定 bundle commit/files/writers，篡改拒审，独立 brief。 | 换核实代码身份；writers、新会话、排除作者评价保留；非代码篡改仍测。 |
| 同文件 `:432`、`:453`、`:491`、`:509` | 取回期间新轮、失败保旧登记、并发取回。 | 对非代码产物保留；代码核实另测 run/revision 竞争。 |
| 同文件 `:475` | 多 bundle/多 head 拒收。 | 删除，换回执 commit/branch 唯一性及核实失败。 |
| `tests/review.test.ts:37`、`:80`、`:85`、`:102`、`:119` | bundle commit 优先于回执。 | 改核实回执提交；文件登记独立保留。 |
| 同文件 `:182`、`:212`、`:399`、`:414`、`:424`、`:431` | run/revision/files 改变使结论 stale，验收/上线共用。 | 保留并增加 source/commit 身份，不放松发布包文件覆盖。 |
| `tests/review-http.test.ts:33`、`:38`、`:39` | 页面绑定/结论/升档。 | 更新新绑定，保留主人绕过与审计。 |
| `tests/logins.test.ts:161`、`:162`；`tests/snapshot-machine-inputs.test.ts:201`、`:204` | 用空登记建立审阅 fixture。 | 换绑定 fixture，登录排除及独立视角测试保留。 |
| `tests/migrated-history.test.ts:108`、`:111` | 旧轮次 report 登记审阅。 | 保留非代码历史；补旧代码历史边界。 |
| `tests/grants.test.ts:30`、`:61`、`:117`、`:120`、`:123`、`:189` | land 取登记 commit，授权/验收/去重。 | 改核实提交，原关卡保留。 |
| 同文件 `:219`、`:232` | 无 PR 本机回退；bundle/package 同登记。 | 删除回退；普通非代码文件替换新 bundle fixture，发布包选择保留。 |
| `tests/landing.test.ts:43`、`:79`、`:97`、`:113`、`:158` | land 固定身份、结算、事件、推送。 | 保留，补来源继承及变更边界。 |
| 同文件 `:219`、`:228`、`:244` | 本机接口验收关、历史 landing 迁移。 | 删本机接口断言；PR 验收关、历史迁移保留。 |
| `tests/release-registration.test.ts:25`、`:68`、`:74`、`:82`、`:131`、`:144`、`:194`、`:274`、`:285` | bundle/package 原子登记、merger 持旧登记。 | 删 bundle 解析与 merger 读者；用 package/普通文件保留原子性、孤儿清理、并发和失败测试。`:311` 发布命令持旧 package 路径保留。 |
| `tests/cli-release.test.ts:342`、`:348`、`:353`、`:361` | package 与新 bundle 同登记。 | 新登记改普通文件；旧 bundle 只读历史单测。 |
| `tests/release-http.test.ts:240`、`:288`、`:294`、`:299` | releases.bundles 响应和发布包上线。 | 对齐新历史响应；package 识别/上线保留。 |
| `tests/retention.test.ts:123`、`:129`、`:160`、`:181`、`:200`、`:217`、`:229` | 清登记后禁止 package/bundle/merge/review 使用。 | 删 merger 读者；非代码清理保留；旧 bundle 保留期政策先明确。 |
| 同文件 `:235`、`:272`、`:298`、`:310`、`:470` | 清理与取回竞争、写库失败。 | 保留，fixture 换非代码产物。 |
| 同文件 `:388`、`:404`、`:432`、`:453` | 按任务/机器清 repo 并记所有轮次。 | B/C 一起补来源区分，folder 永不清。 |
| `tests/console-helpers.ts:12`、`:137` | 构造并注入 createMerger。 | 删除。 |
| `tests/helpers.ts:418`、`:439`、`:443`、`:445` | review registration helper、MERGE 假对象。 | 改审阅 helper，删本机 MERGE fixture。 |
| `tests/gateway-routes.test.ts:139`、`:141`、`:247` | integrate 和 repo-bundle 路由覆盖。 | 删除旧路由覆盖；保留/补来源接口和 PR 流程权限。 |
| `tests/internal-trigger.test.ts:133`、`:138` | task.integrate 产生 merged。 | 保留 PR land 场景。 |

### D：页面测试与公共 fixture

| 位置 | 现在覆盖什么 | 修改要求 |
|---|---|---|
| `console/src/lib/projects.test.ts:13`、`:40`、`:56`、`:102` | code_dir 编辑、清空及保存请求。 | 换多来源、稳定 id、默认顺序、空列表和不回写未改来源。 |
| `console/src/pages/projects.test.tsx:21`、`:142`、`:195`、`:268` | 单目录创建、展示和设置。 | 换来源完整交互；该文件其他 code_dir 请求 fixture 一并更新。 |
| `console/src/pages/task.test.tsx:415` 至 `:564` | 本机合入、当前分支、目录缺失、PR 分流。 | 删除已消失操作；补无本机按钮/请求、无 bundle 也显示 PR。 |
| 同文件 `:473`、`:1587` | 清理后操作和 bundle 型审阅绑定。 | 保留发布包清理，改新审阅身份；旧 bundle 历史单列。 |
| 同文件 `:100`、`:420`、`:1221`、`:1656` | releases/project 公共 fixture。 | 对齐新接口。 |
| 同文件 `:830` | 原始回执 PR artifact 已能渲染链接。 | 保留，防止新卡片改造破坏原始回执。 |
| `console/src/components/shell.test.tsx:24`、`:312`；`pages/home.test.tsx:551`；`pages/project.test.tsx:451`；`pages/work.test.tsx:21` | 旧 project/releases fixture。 | 一并更新来源和产物响应。 |

### 文档与 AGENTS.md

| 位置 | 现在的约定 | 修改归属及要求 |
|---|---|---|
| `AGENTS.md:3` | 设计索引未列来源专题。 | A–D：增加来源设计覆盖关系。 |
| `AGENTS.md:10` | bundle 下发、设置 origin、只读不给 origin。 | B：换 repo clone/folder cwd，保留执行器自行推送的职责边界。 |
| `AGENTS.md:11` | Router cwd 为主机代码目录。 | B：换本机默认 folder，否则空目录。 |
| `AGENTS.md:16` | 整条本机并入、隔离仓库和引用锁保证。 | C：删除本机并入，保留 PR 合入及提交匹配。 |
| `AGENTS.md:21` | bundle 字节提交、登记绑定、bundle 审阅及清理。 | C：核实回执提交；非代码登记原子性保留。B/C：改审阅取代码和清理对象。 |
| `AGENTS.md:22` | 只读独占代码副本、核对后删除。 | B/C：对齐原地 folder 的新核对边界，不能沿用写 ignore/删目录。 |
| `AGENTS.md:32` | land 用登记提交，无 PR 走 merge.integrate。 | C：只留核实提交的 PR land；授权、验收、事件保留。 |
| `AGENTS.md:56`、`:57`、`:61` | runner 打包、node 解包、技能随代码包。 | B：换来源准备、机器 clone/原地目录；删除代码包表述。 |
| `docs/design/phase1-design.md:189` | 项目 repo/code_dir、任务 base bundle。 | A/B：换来源和任务绑定。 |
| 同文件 `:550` | 清登记及所有任务 repo；清理影响 bundle/merge/integrate。 | B/C：只清自有 clone，保留非代码登记和历史政策，删旧操作。 |
| `docs/design/merged-design.md:42` | 只读结束时仍为快照绑定提交。 | B/C：改成能兑现的来源/只读核对说明。 |
| `docs/design/nodes.md:310`、`:352` | repo-bundle API、暂存下载解包。 | B：删除传输整层，换来源准备和新协议。 |
| 同文件 `:354` | 每轮主机 origin→repo.remote→机器改 origin。 | B：换来源 URL 规则；保留非交互 Git 失败报告。 |
| 同文件 `:356` | 固定分支目标、必交 bundle、从字节读提交。 | B/C：换执行器分支策略、回执交付及核实。 |
| `docs/design/roles-and-tiers.md:84`、`:185` | 登记身份、bundle commit、base、productStale。 | C：代码提交与非代码文件身份分开；保留当前产物关卡。 |
| 同文件 `:109`、`:110`、`:113`、`:205` | 独占只读目录、unpackOwn、恢复忽略文件和删除。 | B/C：按新只读方案改写。 |
| 同文件 `:186` | 审阅 bundle，base→commit diff/log。 | B/C：来源与固定提交；比较范围见末节。 |
| 同文件 `:204` | brief 旁边固定 repo/。 | B：实际 cwd 与材料路径分开。 |
| `docs/design/project-sessions.md:11`、`:24`、`:131`、`:140` | 单代码目录及创建页面。 | A/D：多来源、可为空、有序默认。 |
| 同文件 `:85`、`:281` | code_dir 变化换上下文、launch_json、目录回退。 | B：默认来源/本机身份/cwd；原有回退和消息保证保留。 |
| 同文件 `:249`、`:252` | integrate_task 读登记提交或本机回退；页面读 bundles.pr。 | C/D：PR 唯一合入路径，PR 响应独立。 |
| 同文件 `:277`、`:279`、`:283` | Router 本机目录、基线、只读 git/gh。 | B：仅本机默认 folder 可读原地代码；其他来源空 cwd 用 gh。 |
| 同文件 `:295` | 删除项目不碰代码目录。 | A/B：不碰任何来源目录和远端。 |
| `docs/design/console.md:76` | 每 15 秒读取主机当前分支供并入。 | C/D：删除 code_branch 轮询，使用来源与任务事实。 |
| `docs/design/knowledge-and-skills.md:339` | 无项目知识任务不拿项目代码目录。 | A/B：改无项目来源；知识材料机制保留。 |
| `docs/design/self-iteration.md:25`、`:26`、`:64` | bundle 下发、回传、凭据不足仍开工。 | B/C：换 clone/push/PR 或 folder 原地交付。 |
| 同文件 `:68`、`:70`、`:80`、`:187` | bundle/package 共登记、本机并入、bundle 审阅。 | C/D：保留发布包登记和关卡，删除本机并入。 |
| 同文件 `:173` 至 `:176` | 项目主机目录、交 bundle 和发布包。 | A/B/C：新来源配置、提交/PR、非代码发布包。 |
| 同文件 `:218` | bundle 端到端验收。 | B/C：换真实 clone/原地 cwd、固定机器、提交核实和 PR land。 |
| `docs/design/code-sources.md` | 已确认方向。 | 接入本附录；末节具体缺口补决后同步正文。 |

### 同名但不属于删除范围的引用

这些命中应保留，避免把“删 bundle/staging/unpack”扩大成删发布、备份或证据机制。

| 位置 | 实际含义及处理 |
|---|---|
| `cli/archive.ts:1`、`:18`；`cli/install.ts:211`、`:406`、`:952` 起；`cli/main.ts:690`；`cli/paths.ts:58`、`:71` | 发布安装包解压、安装 `.staging-*` 和程序路径，保留。 |
| `tests/backup.test.ts:980` | 备份原子 staging，保留。 |
| `tests/cli-commands.test.ts:715`；`cli-doctor.test.ts:42`；`cli-install.test.ts:117`、`:953`、`:976`；`cli-install-e2e.test.ts:242`；`cli-release-live.test.ts:116`、`:185` | 安装发布 staging/unpack，保留。 |
| `tests/cli-pack.test.ts:248`；`cli-helpers.ts:166`；`cli-tar.ts:52` | 发布 tar 解包，保留。 |
| `tests/node-client.test.ts:174`、`:179` | `bundle.tar.gz` 是任意二进制产物，不是 Git bundle 协议。 |
| `tests/runner-artifacts.test.ts:123`、`:147`、`:156` | `.bundle` 多用于通用文件名/摘要测试；通用测试保留，可改普通后缀避免混淆。 |
| `tests/cli-release-live.test.ts:578`、`:591`、`:592` | 发布包 registration，保留。 |
| `console/src/lib/machines.ts:188`、`machines.test.ts:259`；机器、登录、doctor、ephemeral、UID 迁移测试中的 registration | 机器登记身份，保留。 |
| `tests/fixtures/codex/0.162.0/site-windows.ndjson`；`0.167.1/global-entry/prompt-input-global.txt`、`prompt-input-override.txt` | 原始执行器实录，保留原文。 |
| `docs/spike/readonly.md:19`；`cluster-spike-report.md:27`、`:90` | 当时实验的 cwd/目录事实，不改写历史。 |
| `docs/spike/acp-evaluation.md:57`、`:423`、`:507`、`:530`、`:555` | 上游 `packages/bundle` 和 ACP 实验 cwd，保留。 |
| `docs/design/self-iteration.md:236` | 浏览器前端 bundle，保留。 |
| `service/backup.ts:430` 等自然语言 `land`、其他 report/registration | 与代码合入、产物提交无关，不列入删除。 |

### 跨块文件与合入顺序

建议按文件指定整合者。各块提交接口需求和对应代码段，不同时编辑同一文件。

| 文件 | 各块修改边界 | 建议顺序与整合者 |
|---|---|---|
| `shared/sources.ts` | A：来源解析、任务绑定、标签；B：SnapshotSource 转换；C：交付/核实提交。 | 先定共同契约，由 A 统一整合；随后各块消费，清掉占位。 |
| `service/db.ts`、`tests/migration.test.ts`、schema fixture、`package.json` | A 持有 schema；B 提供固定机器/旧 Run 需求；C 提供历史绑定需求。 | A 独占一次迁移，其他块提前交需求。 |
| `service/ledger.ts` | A：来源 CRUD/任务修订；B：machineRange/createRun/rehost/清理；C：Product/bindReview/gates/land 结算。 | A 先；C 定代码身份，B/C 按段顺序接入，单人整合整文件。 |
| `service/tools.ts` | A：五个来源工具；C：create_task 的审阅核实、accept/integrate；B：机器列表事实。 | A 先工具来源契约，C 后改审阅/land；不并行编辑 create_task。 |
| `service/http.ts` | A：项目/任务来源接口；B：删 bundle 下载和 node 新事实；C：删本机接口、改 releases/PR。 | A 定响应，B/C 各提供段落，由一个整合者提交。 |
| `service/main.ts` | B：删 roundBundles/limit、接机器事实；C：删 merger、装配新核实链。 | B 先清传输装配，C 后接审阅；统一检查 options 构造。 |
| `service/dispatcher.ts` | A：权威来源/机器范围接口；B：选机器、snapshot、删 staging；C：审阅来源/提交准备。 | A 接口先，C 绑定形状先定；B 统一修改 dispatcher。 |
| `runner/snapshot.ts` | B：source、普通 brief、cwd/材料路径；C：renderReviewBrief/提交范围。 | B 先完成结构调整，C 随后改审阅渲染；同一人最后整合。 |
| `runner/repo.ts` | B：删打包/主机检查；C：删 bundle 校验和本机合并。 | B/C 消费者先迁完，再一次删除剩余文件，不留下共用工具箱。 |
| `shared/review.ts`、`service/review.ts` | C：新代码身份和 current-product；A：账本写入；D：展示消费。 | C 定契约，A 接事务，D 后接页面。 |
| `shared/node-protocol.ts`、`service/nodes.ts`、`node/client.ts` | B：协议/source；C：结束 HEAD 证据。 | C 先交证据形状，B 一次升版并整合。 |
| `node/watch.ts`、`node/code-check.ts` | B：代码准备/cwd/清理；C：审阅提交和只读核对要求。 | 先补决 folder 保证，再由 B 统一实现。 |
| `service/accept.ts`、`service/releases.ts` | C：删 bundle 专用部分，保留文件登记；B：传输链变化；D：响应消费。 | C 持有，不让 B 随删传输一并删文件登记。 |
| `service/retention.ts`、`tests/retention.test.ts` | B：repo clone/folder 清理；C：非代码与历史 bundle 保留。 | 先定历史政策和副本归属，再统一改 fixture/清理。 |
| `tests/helpers.ts` | A：来源任务 fixture；B：删 bundle getter；C：新 review helper/删 MERGE。 | 一人一次整合公共 helper，各块尽量新增独立测试文件。 |
| `tests/console-helpers.ts` | B 删 roundBundle；C 删 merger；D 消费 HTTP fixture。 | B/C 一次更新 options 后，D 再改页面测试。 |
| `tests/review-dispatch.test.ts` | C：绑定/核实；B：审阅机器/source/checkout。 | 先共同重写 setup，再按失败场景拆测试。 |
| `tests/grants.test.ts`、`tests/landing.test.ts` | A：来源绑定；C：核实提交、授权、land。 | A/C 契约先定，C 统一改测试。 |
| `console/src/lib/types.ts` | A 项目/任务；B snapshot；C 审阅/PR/releases。 | 各块先给响应契约，D 一次整合类型。 |
| `console/src/pages/task.tsx`、对应测试 | B 来源/等待机器；C 审阅/PR/历史产物；D 页面。 | B/C 契约先定，D 独占 JSX 和页面测试。 |
| `AGENTS.md` 及多个设计文档 | A/B/C/D 各有相关段落。 | 功能契约确定后，由一个文档整合者收尾，避免各块重复改长段落。 |

### 设计稿站不住或没说清的地方（已裁决，见正文 §8）

### 1．原地 folder 的“不写目录”与现有只读核对直接冲突

`node/code-check.ts:173` 的 `restoreRules` 会删除、重写 `.gitignore` 和 `.git/info/exclude`；`node/watch.ts:333` 在结束时调用核对。它目前依赖可丢弃的独占副本。

把 folder 路径传进去会实际修改主人目录。必须先改成不写目录的核对，不能只换 cwd。

### 2．共享 folder 上的前后差异无法归因给审阅者

`node/watch.ts:203` 当前为只读轮次准备独占代码；`node/code-check.ts:264` 将起止差异作为该轮代码变化；`shared/roles.ts` 的采用规则据此拒绝回执。`tests/node-watch-readonly.test.ts:87` 明确保护这一保证。

新设计同时要求原地目录、允许并发、tycho 不加锁。主人或其他任务的修改也会造成差异。建议明确：核对只能报告目录变化，不能据此声称审阅者写了代码；是否拒收该轮仍须统一决定，不能悄悄取消核对。

### 3．folder 的当前检出不一定是被审提交

`runner/snapshot.ts` `renderReviewBrief` 当前通过干净副本和绑定提交保证测试对象；新设计只要求在同一个 folder 中“对着提交看”，并允许目录继续变化。

即使结束时 HEAD 等于回执 commit，之后仍可切分支或留下未提交改动。审阅者在原目录跑测试，测试的可能不是被审 commit。设计需要区分“读取某个提交”和“测试当前工作区”，并说明不一致时如何结论为不可核实；不能为兑现旧保证偷偷 checkout 或复制目录。

### 4．主机 `ls-remote` 没有机器的仓库访问身份

`shared/remote.ts:17` 允许 SSH 用户、机器 SSH 别名等地址；`node/unpack.ts:46` 的 Git 运行发生在执行机器，而新设计要求主机直接 `ls-remote`。

机器能 clone/push 不代表主机能解析同一 SSH 别名或访问私有仓库。建议由持有 Git 登录的机器执行核实并上报；如果坚持主机核实，就必须把主机访问条件写明，不能把核实失败一律解释成提交没推上去。

### 5．代码提交绑定不能替代发布包文件绑定

`service/review.ts:155` 当前比较完整登记文件集合；`service/ledger.ts:2607` `releaseGate` 要求审阅覆盖所上线文件的摘要。

设计保留非代码产物登记，但没有完整说明新 current-product 如何同时包含代码 commit 和发布包。若只改绑 commit，同一提交重新打出的不同包可能错误复用旧审阅。建议明确保留“run/revision/source/commit + 非代码完整文件集合”的统一身份。

### 6．取消 base 后，现有审阅 diff 范围没有替代定义

`service/ledger.ts:1164` 从 snapshot.repo 推出 base；`runner/snapshot.ts` `renderReviewBrief` 用 base→commit 给审阅范围。设计明确删除 base，却只给被审 commit。

固定提交能确定版本，不能单独确定“本任务改了什么”。需要说明审阅是看整棵树、PR diff，还是其他可核实范围；不能继续生成旧 diff 指令。

### 7．改派来源后，旧 repo 和固定机器如何处理没有定义

`node/unpack.ts:143` 当前复用任务级 repo，并用 base 检查适配性；`runner/runner.ts:1080` 允许未启动时换机器。新设计允许 update_task 改来源，同时要求 repo 后续固定第一台机器。

从仓库 A 改到 B，旧 `tasks/<task>/repo/` 仍在；从 folder 改 repo 也可能已有现场。需要定义何时建立/重置机器绑定、如何识别旧 URL、旧现场保留在哪里。不能仅凭 repo 目录存在就继续使用，也不能无说明删除旧工作。

### 8．迁移的“机器待确认”没有可存储形状；repo-only 项目也没有迁移规则

`shared/sources.ts:48` 的 folder 要求 `machine_uid: string`，没有待确认形式；`service/ledger.ts:3935` 的本机绑定可能不存在或未知。

另外，`service/ledger.ts:2177` 确实允许只有 repo、没有 codeDir 的项目，而设计迁移只说明有 code_dir 的项目。需要补这两类数据的明确映射，避免迁移丢来源或伪造机器身份。

### 9．历史 bundle “保留”与既有保留期清理不一致

`service/ledger.ts:2567` 会标记到期登记；`service/releases.ts:201` 会删除登记目录；`tests/retention.test.ts:123`、`:181` 验证此行为。

设计说旧 bundle 保留为只读历史，没有说是继续按原保留期删除字节，还是永久保留。建议延续现有保留期，仅保留账本历史；若要求永久留字节，须明确这是新增成本和清理例外。

### 10．旧客户端和旧活跃 Run 的升级边界没有说清

`shared/node-protocol.ts:1` 的现行政策是版本不符不通信；`tests/node-http.test.ts:498`、`tests/node-client.test.ts:672` 证明它是整机拒绝。设计“旧客户端不接有来源的活”容易被理解成还能接无来源任务。

同时，`service/dispatcher.ts` `watchActive` 会继续跟踪旧 Run，旧 snapshot 仍可能含 repo/bundle。设计要求不留旧运行链，却未给这些未结束轮次的升级前置条件。建议明确采用全量客户端升级，并规定切换前旧代码轮次如何结束或清点，不另建长期兼容通道。

### 11．现有 worktree 和来源契约骨架尚不能直接兑现设计

`node/code-check.ts:149`、`:166` 写死 `.git` 为目录；设计允许执行器自行建 worktree，实际 `.git` 可以是文件，核对还涉及共享 Git 元数据。

此外，`shared/sources.ts:52` 的注释说来源快照“不用于执行”，`:73` 又说来源被修改后“按钉住内容继续”；两处指向不同执行依据。必须先统一哪个对象决定下一轮来源，再接派发，避免各块实现出不同答案。
