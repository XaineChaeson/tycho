# Antigravity CLI (`agy`) 1.5.9 Windows 实录

2026-11-16 在 Windows 11 控制器工作站上对 `agy.exe` `1.5.9` 录制的真实输出（`USERPROFILE`/`HOME` 指到临时隔离目录，未碰真机 `~/.gemini`）。

Worker 回合调用形态：

```
agy -p "<prompt>" --output-format stream-json --settings <tier.json> --effort <level> \
    --dangerously-skip-permissions --add-dir <workdir> [--add-dir <artifactsDir>]
```

| 文件 | 场景与结果 |
|---|---|
| `version.{stdout,stderr,exit}` | `agy --version`：stdout `1.5.9`，退出码 `0` |
| `help.stderr` | `agy --help`：全部 CLI 参数与子命令说明（输出在 stderr，退出码 `0`） |
| `models.{stdout,stderr,exit}` | `agy models`：stderr 打印 `Fetching available models...`，stdout 为 `<id>\t<name>` TSV（22 个可用模型），退出码 `0` |
| `mcp-empty.stdout` | `agy mcp list` 空配置：`No MCP servers configured.` |
| `mcp-listed.stdout` | `agy mcp list` 含 `alpha (stdio, enabled)` 与 `beta (http, disabled)` 的表格输出 |
| `plugins-empty.stdout` | `agy plugin list --json` 空配置：`[]` |
| `plugins-listed.stdout` | 本地安装 `sample-plugin` 后 `agy plugin list --json`：对象数组，插件名键为 `name`，带 `enabled: true` |
| `tools.{ndjson,stderr,exit}` | 可写 Worker 依次调用 `read_file`（含一次目标不存在的 `ERROR`）、`write_file`、`run_command`、`edit_file`，末了 `result`（`status: "SUCCESS"`，`num_turns: 1`），退出码 `0` |
| `resume.{ndjson,stderr,exit}` | 带 `--conversation <id>` 续接 `tools` 会话：`result.num_turns` 为 `2`，**`result.usage` 为前两轮累计和**，而各 `step_update`（`state: "DONE"`）中的 `usage` 为本步增量，且 `input_tokens` 已不含 `cache_read_tokens` |
| `timeout.{ndjson,stderr,exit}` | `--print-timeout 10ms` 提前截止：`result.status` 为 `"ERROR"`、`finished_reason` 为 `"print_timeout"`，退出码 `3` |
| `failure-auth.{ndjson,stderr,exit}` | 设 `"modelProvider": "gemini"` 与无效 `GEMINI_API_KEY`：`step_type: "error_message"` 后接 `result`（`status: "ERROR"`, `finished_reason: "error"`, `API_KEY_INVALID` / `Error 400`），退出码 `3` |

## 脱敏说明

- 所有本机临时路径替换为 `C:\work\probe` / `file:///C:/work/probe`，用户名替换为 `owner`（`resume.ndjson` 中横跨多个 `text_delta` 的链接碎片作同等拼接等价替换，已校验拼接后与 `result.response` 逐字节一致）。
- 协议结构、字段名、数字与退出码未改。

## 没录到的形状

- `step_type: "thinking"` / `thinking_delta`、`step_update` 含 `tool_name: "call_mcp_tool"` 或其它文件工具（`list_dir`、`grep_search`、`find_by_name`、`replace_file_content`、`multi_replace_file_content`）的实录。
- 额度耗尽（`429` / `RESOURCE_EXHAUSTED`）与 `--output-format stream-json` 中 `finished_reason: "interrupted"` 的实录；`adapters/gemini.ts` 对 `429`/`quota` 与 `401`/`403`/`API_KEY_INVALID` 的错误分类基于常见 HTTP/gRPC 错误文案规则。
