# codex 0.162.0 的 `codex debug models`

在这台机器上录的：`codex debug models`（codex-cli 0.162.0），一盘 JSON，顶层 `{"models": [...]}`，
每个模型一项，退出码 0。`codex debug models` 不需要登录，也不连网，读的是 CLI 自带的模型目录。

`models.json` 是这份实录，只做了一件事：每个模型项里除了下面这几项，别的都删掉了。

| 留下的 | 是什么 |
|---|---|
| `slug` | 档位里写的模型名（`model=<slug>`） |
| `display_name` | 它自己给这个模型起的显示名 |
| `supported_reasoning_levels` | 这个模型接受的推理强度（每项一个 `effort`，还带一句说明） |
| `default_reasoning_level` | 不给强度时它用的那一档 |
| `visibility` | `list` 是它自己的选择器会列的，`hide` 是不列的 |

删掉的那些是模型自带的整篇指令模板（`model_messages.base_instructions` 等），原文一份 1.29 MB，
和“有哪些模型、各接受什么强度”无关，所以没有留。模型的数量、顺序、名字、强度、默认强度和可见性标记都是原样。

实测：`visibility: "hide"` 的模型在 `codex debug models` 里照常出现，只是 CLI 自己的选择器不列它。
`supported_reasoning_levels` 的项数各模型不同（有六个的，也有五个的），所以强度不能按一张全局表写。

# 一轮真实 Worker 的 `codex exec --json`（`site-windows.*`）

这台机器上 tycho 派发的一轮只读任务（“看一下 adapters 目录”），codex-cli 0.162.0，Windows，
主人在任务页截图里看到的就是这一轮的现场。`site-windows.ndjson` 是那一轮 `stdout.ndjson` 原样，未改一个字节。

它录到了别的实录没有的形状：

| 形状 | 在哪 |
|---|---|
| 开头两条内容一样的 `item.completed` / `type: "error"`（配置项告警），回合照样完成 | `item_0`、`item_1` |
| `command_execution` 的 `command` 是一整条 POSIX 引号拼起来的命令行：`"C:\…\powershell.exe" -Command "<脚本>"`，脚本里有 `'"'…'"'` 这种拼接 | 每条命令 |
| `item.started` 里 `aggregated_output: ""`、`exit_code: null`、`status: "in_progress"`；`item.completed` 带完整输出、退出码和 `completed`/`failed` | 每条命令 |
| 退出码 1 的命令 `status: "failed"`（脚本里的 `rg` 不存在），输出是 PowerShell 的报错 | `item_7` |
| 几条命令并发：先连着几个 `item.started`，再按完成顺序 `item.completed` | `item_4`–`item_6`、`item_10`–`item_11` |
| 输出里有按 GBK 读坏的中文（PowerShell 5.1 不加 `-Encoding UTF8` 的结果），这是那一轮的事实 | `item_4`、`item_6` |

`site-windows.stderr` 只留了第一行（`Reading additional input from stdin...`）：原文后面是一个 MCP 服务器连不上时
CLI 打的那行日志，内容是对方返回的一整页 Cloudflare 校验网页，和这一轮的执行无关（环境，不是这一轮）。
退出码没有录下：回合以 `turn.completed` 结束，测试按 0 读，这是假定。
