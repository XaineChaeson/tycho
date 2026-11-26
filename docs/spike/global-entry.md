# 执行器的全局指令入口与自带记忆（实测）

读者：改适配器或机器客户端的实现者。问题：知识与技能第 2 步（[knowledge-and-skills.md](../design/knowledge-and-skills.md) §4.3、§4.1、§1.3）要的三件事，
每个执行器各是什么——全局常驻条目写到哪里它启动时一定读；派出的一轮怎样不读它；它自带的跨任务记忆怎样关。实录在
[tests/fixtures/global-entry](../../tests/fixtures/global-entry/README.md)，契约测试是 `tests/global-entry.test.ts`。

## 结论

| | Claude Code 2.1.303 | Codex 0.162.0 | dsh 0.2.2-rc.1 |
|---|---|---|---|
| 入口 | `$CLAUDE_CONFIG_DIR/rules/tycho-knowledge.md`（默认 `~/.claude`）：rules 目录里每个文件都是一份用户级指令，和 CLAUDE.md 并列加载，tycho 用自己的文件，不碰主人的 CLAUDE.md | `$CODEX_HOME/AGENTS.md`（默认 `~/.codex`），整个文件就是那一份 | `$DSH_HOME/AGENTS.md`（默认 `~/.dsh`） |
| 什么时候不读 | 实录里没找到会盖住它的文件 | 旁边的 `AGENTS.override.md` 有字（不只是空白）时只读那一份；空的、只有空白的不算 | 取决于机器上的 profile：默认 profile 下和 `~/.agents/AGENTS.md`（`$DSH_AGENTS_HOME`）共用 65 536 字节的渲染预算，超了先丢这一份、相同内容只算一次；profile 能改上限或关掉指令插件。文件本身看不出来，报“读不读确认不了” |
| 自己的大小上限 | 没找到 | 60 000 字节照样整份进了输入，没找到 | 见上一行 |
| 派出的一轮怎样不读 | 这一轮的设置文件里加 `claudeMdExcludes: ["**/rules/tycho-knowledge.md"]`；档位内容由快照写成文件，tycho 把排除项并进去。只在 2.1.303 上实测过：机器报的版本低于它、或者没报版本（走 SSH 的机器），排除项照样带上，快照只说“可能读到”。档位是机器上的文件（`ref`）时加不进去 | 没有办法：只有换 `CODEX_HOME`，那里也是登录 | 没有办法：`DSH_HOME` 里也是这一轮启动用的 profile；能关的只有整个指令插件，连项目的 AGENTS.md 一起关 |
| 自带的跨任务记忆 | 自动记忆，按仓库路径存在配置目录下，`autoMemoryDirectory` 能指到任何地方：按跨任务算 | `memories` 功能，存在 `$CODEX_HOME/memories/`：跨项目 | 自带的包里没有自写自读的笔记；会话检索是选装的、只认同一工作目录；但档位和 profile 能插入任何插件：确认不了 |
| 派出的一轮怎样关 | 环境变量 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | `--disable memories`（没有这个功能的版本整条命令报错，所以最低版本定为 0.162.0） | 不关，快照标“可能读到” |

## 怎么测的

都在这台工作站上，不调模型、不花额度，也不写主人的 `~/.claude`、`~/.codex`、`~/.dsh`。

- **Claude**：`claude -p /context` 是本地命令，列出这一轮加载的指令文件。用主人现有的登录（临时配置目录没有登录，`/context` 也不答），
  在录制目录里放一份项目级的同名规则文件，比较加不加 `--settings` 里的 `claudeMdExcludes`：项目级的同名文件和用户级 rules 里的文件都被排除，
  设置文件里的其它键照样生效。两个 `--settings` 只认最后一个。`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 让系统提示少了自动记忆那一段（2.9k → 2.1k token）。
  二进制里 `claudeMdExcludes` 的说明写的是“只对 User、Project、Local 三类生效，管理策略下发的不能排除”。
  “两份 `--settings` 只认最后一份”另用一个空的临时配置目录录过（不用登录、不碰主人的 `~/.claude`）：两份文件各带一个只写标记文件的
  `apiKeyHelper`，不论顺序都只有后一份的被执行。官方文档另说 2.1.239 之前规则文件是符号链接时只按它指向的路径排除，
  旧版本又会悄悄忽略不认识的设置，所以“不读”只按实测的版本承诺。
- **Codex**：`codex debug prompt-input` 打印模型会看到的输入，用一个空的 `CODEX_HOME` 就能跑。放入、覆盖、6 万字节三种情形各录一份。
  空的和只有空白的覆盖文件各录一份：都不算覆盖。记忆功能用 `codex features list` 读生效值：config.toml 打开、`-c` 在前在后，`--disable memories` 都把它压成 false。注入的记忆内容没有录到
  （`prompt-input` 在打开时也不显示），所以验证的是开关，不是注入。
- **dsh**：没有离线看输入的命令。依据是它随包带的 `@deepseek-ai/dsh-agent-instructions` 说明（从安装目录的 `app.asar` 截出，存为实录）。

## 没做的

- 比 2.1.303 旧的 Claude 有没有认这个排除项，没有测；这些版本的轮次快照上写“可能读到”。
- 没有在机器上起一个真实的交互会话去验证“写进去的那份确实被读到”（§6 第 4 步的验证），这一步留给迁移。
- Codex 的 `memories` 注入什么、什么时候生成，没有录到；关掉它的开关录到了。

- **Gemini（`agy` `1.5.9`）**：见 [gemini-adapter.md](gemini-adapter.md)。从无关工作目录运行时会同时加载 `~/.gemini/AGENTS.md` 与 `~/.gemini/GEMINI.md`（互不覆盖），无 `--settings` 排除键；文档说明单文件超过 24 KB 截断、全部全局规则共用 20 000 token 上限，因此写入后同样标为“读不读确认不了”（`unconfirmed`），并在派发快照标明这一轮仍可能读到。
