# 机器上执行器自己的配置：怎么列、怎么按名字关掉知识 MCP（实录）

2026-11-11 在这台 Windows 工作站上录的，依据 docs/design/knowledge-and-skills.md §1.2、§4.1。
路径里的用户名换成了 `owner`，录制目录换成了 `C:/work/probe`。没有一条花过模型额度（Codex 那几次 `exec` 在没有登录的
`CODEX_HOME` 里跑，连不上模型就停）。

录制用的知识 MCP 是一个只往旁边写“起过一次”标记、只报一个工具 `knowledge_probe_tool` 的最小 stdio 服务器，注册名 `tycho-knowledge`。

## claude-2.1.303-win

| 文件 | 那一次 |
|---|---|
| `context-mcp-on.md` | `claude -p /context --strict-mcp-config --mcp-config <只有 tycho-knowledge>`：MCP Tools 一段列出 `mcp__tycho-knowledge__knowledge_probe_tool`（只摘这一段） |
| （没有文件） | 同一条命令加 `--disallowedTools mcp__tycho-knowledge`：输出里没有 MCP Tools 这一段，那个工具不在上下文里；服务器进程照样起了一次 |
| （没有文件） | 再加 `--permission-mode bypassPermissions` 和另一个 `--disallowedTools Write`：MCP 工具同样不见，System tools 从 19.8k 降到 19.5k（Write 也去掉了）。两个 `--disallowedTools` 分开写都生效，bypass 不让它失效 |
| （没有文件） | 不配任何 MCP、只带 `--disallowedTools mcp__tycho-knowledge`：照常退出 0，没配这个服务器时带着它也没事 |
| `plugin-list.json` | `claude plugin list --json`：装了的插件，每个一项，`id` 是 `名字@市场`；不启动任何 MCP 服务器，2.7 秒 |

`claude mcp list` 的帮助自己写着已批准的服务器会逐个做健康检查（就是把它们起起来），所以不拿它列 MCP。

## codex-0.167.1-win

| 文件 | 那一次 |
|---|---|
| `mcp-list-three.config.toml` / `mcp-list-three.json` | `codex mcp list --json`：三个服务器（一个 `enabled = false`），每个一项，带 `name` 和 `enabled`。只读配置，不启动服务器（标记文件没出现） |
| `mcp-list-three-off.json` | 同一份配置加 `-c mcp_servers.tycho-knowledge.enabled=false`：只有它变成 `enabled: false`，其余照旧 |
| `mcp-list-http.json` | 知识 MCP 配成 `url`（streamable http）时的样子 |
| `mcp-list-none.json` | 什么都没配：`[]` |
| `enabled-false-absent.stderr` | 没配知识 MCP 时带 `-c mcp_servers.tycho-knowledge.enabled=false`：整条命令报错退出 1（`invalid transport`），所以这个参数只在机器报告的清单里有它时才能带 |
| （没有文件） | 换成整张表 `-c 'mcp_servers.tycho-knowledge={command="…",enabled=false}'`：没配时能用，配成 `url` 的那种却报错（`url is not supported for stdio`），所以不用这种写法 |
| （没有文件） | `codex exec`，配了知识 MCP：服务器起了一次；加上 `enabled=false` 那个参数：一次都没起 |
| `version.txt` | 录制时的版本 |
