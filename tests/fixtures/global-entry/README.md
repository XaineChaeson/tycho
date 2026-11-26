# 执行器的全局指令入口与自带记忆：实录

2026-11-10 在这台 Windows 工作站上录的，依据和结论见 [docs/spike/global-entry.md](../../../docs/spike/global-entry.md)。
路径里的用户名换成了 `owner`，录制目录换成了 `C:\work\probe`、`C:\work\codex-home`。没有一条调过模型、花过额度。

## claude-2.1.303-win

`claude -p /context` 是 CLI 自己的本地命令，列出这一轮加载了哪些指令文件（Memory Files）和各部分占多少（不发模型请求）。
录制目录里放了一份项目级的 `.claude/rules/tycho-knowledge.md`（文件头就是 tycho 的生成标记），用户级的是主人机器上现成的
`~/.claude/rules/this-machine.md`。只摘了“Context Usage”“Estimated usage by category”“Memory Files”三段。

| 文件 | 那一次 |
|---|---|
| `context-default.md` | 什么都不加：用户级 CLAUDE.md、它引用的文件、用户级 rules 里的文件、项目级的 `tycho-knowledge.md` 都加载 |
| `context-excluded.md` | `--settings excluded.settings.json`：一份同时带档位键（`effortLevel`）和 `claudeMdExcludes` 的设置文件。两份 rules 文件都不见了，CLAUDE.md 照常 |
| `excluded.settings.json` | 上一行用的那份设置文件 |
| `context-auto-memory-off.md` | 环境变量 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`：系统提示从 2.9k 降到 2.1k token（自动记忆那一段没了），指令文件不变 |
| `two-settings.txt` | 两次 `--settings`，两份文件各带一个只往录制目录写标记文件的 `apiKeyHelper`；配置目录是空的、没有登录。不论顺序，只有后一份的标记文件被写出来：只认最后一份，所以排除项必须和档位在同一份文件里 |

## codex-0.162.0-win

`codex debug prompt-input "hi"` 是 CLI 自己的调试命令，打印模型会看到的输入列表（不需要登录、不发模型请求）。
`CODEX_HOME` 指到一个空目录，只放下表里说的文件。`prompt-input-*.txt` 是其中来自 AGENTS.md 的那一项。

| 文件 | 那一次 |
|---|---|
| `prompt-input-global.txt` | `$CODEX_HOME/AGENTS.md` 带 tycho 的生成标记：原文进了输入 |
| `prompt-input-override.txt` | 旁边再放 `AGENTS.override.md`：只有它进了输入，AGENTS.md 不进 |
| `prompt-input-override-empty.txt` | 覆盖文件是空的：AGENTS.md 照样进了输入 |
| `prompt-input-override-blank.txt` | 覆盖文件只有空格、制表符和换行：AGENTS.md 照样进了输入 |
| `prompt-input-big-60000.txt` | 60 000 字节的 AGENTS.md：首尾两个标记都在，没被截断 |
| `features-memories.txt` | `codex features list` 读 `memories` 的生效值：config.toml 打开时是 true；加 `--disable memories` 后是 false，和 `-c features.memories=true` 写在前后都一样 |
| `unknown-feature.stderr` / `.exit` | `--disable` 一个这版没有的功能：整条命令报错退出 1 |
| `version.txt` | 录制时的版本 |

记忆功能把笔记放在 `$CODEX_HOME/memories/`（二进制里的路径），`prompt-input` 在打开记忆时没有显示它注入什么，所以这里验证的是开关的生效值，不是注入的内容。

## dsh-0.2.2-rc.1

dsh 没有不调模型就能看输入的命令，这台机器上的 dsh 也没有能离线跑的凭据。`agent-instructions.README.md` 是 dsh 自己随包带的
`@deepseek-ai/dsh-agent-instructions` 说明，从安装目录的 `resources/app.asar` 里原样截出“Use this package”这一节。它写明：
用户级的一条链是 `$DSH_HOME/AGENTS.md`、再 `$DSH_AGENTS_HOME/AGENTS.md`（默认 `~/.agents/AGENTS.md`）；dsh-base 给每条链 65 536 字节；
超了先丢 harness home 那一份；`dsh-base` 默认开、profile 能关，但关的是整个插件（连项目里的 AGENTS.md 一起）。这些都随机器上的 profile 变，
文件本身看不出来，所以写进去的那份只报“已写入、读不读确认不了”，不按文件大小去推算。
