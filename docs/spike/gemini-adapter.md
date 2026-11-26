# Antigravity CLI (`agy` 1.5.9) 接入能力实测

2026-11-16 在 Windows 11 工作站上针对 `C:\Users\dev\.gemini\bin\agy.exe`（`1.5.9`）完成隔离目录实测（`USERPROFILE`/`HOME`/`LOCALAPPDATA`/`APPDATA` 指向临时目录），为 `adapters/gemini.ts` 决定每一项声明边界。实录归档于 [tests/fixtures/gemini/1.5.9-win](../../tests/fixtures/gemini/1.5.9-win/README.md)。

## 结论表

| 能力面 | 实测事实 | `adapters/gemini.ts` 声明 |
|---|---|---|
| 命令与定位 | `agy --version` 在 stdout 打印 `1.5.9`，退出码 `0` | `probe: { command: 'agy', version: ['--version'] }`；`installs` 声明 `~/.gemini/bin/agy(.exe)` 与 `~/.local/bin/agy(.exe)` |
| 最低版本 | 二进制内嵌变更记录显示 `1.4.11` 起才在 `stream-json` 的 `result` 中引入 `finished_reason` 区分正常完成与 `print_timeout`/`interrupted`/`error` | `minVersion: { version: '1.4.11', lacks: 'stream-json 结果里没有 finished_reason，分不出提前结束和正常做完' }` |
| 档位与 `--settings` | `--settings <path>` 接收 JSON 对象文件并校验键名，未知键直接 `exit=1`；`model` 合法，**`effort` 在 1.5.9 上报 `unknown setting "effort"`**，推理强度须通过 `--effort <low\|medium\|high\|xhigh\|max>` 命令行参数传入 | 账本与控制台使用 `GEMINI_SETTINGS_JSON`（`model` + `effort`）；`runner/snapshot.ts` 写快照 `tier.json` 时剥离 `effort` 给 `--settings`，`launch`/`resume` 从 `tier.text` 读出 `effort` 传 `--effort` |
| 托管凭据（API Key） | 仅设 `GEMINI_API_KEY=tycho-invalid-key-probe` 而不改 `modelProvider` 时，**忽略环境变量并仍以本机 Keyring 登录成功完成（`exit=0`）**；只有同时设 `"modelProvider": "gemini"` 才读取 `GEMINI_API_KEY` | 声明 `credential: () => ({ variable: 'GEMINI_API_KEY' })`、`accountLogin: ['key']`；`runner/snapshot.ts` 对托管账号轮次在快照 `tier.json` 自动注入 `"modelProvider": "gemini"`（哪怕档位文本为空也传入 `--settings`），同时 `checkTier` 禁止档位自写 `modelProvider`，杜绝静默回退本机 Keyring；`listModels({ token })` 走 Generative Language HTTP API |
| 登录状态命令 | `agy --help` 无独立的非推理登录态查询命令 | 不声明 `loginStatus`（`logged_in: null`，配合 `ownLoginTiers` 在 `installed: true` 且可用时自动采用机器登录） |
| 全局指令入口 | 从无关工作目录运行，`$HOME/.gemini/AGENTS.md` 与 `$HOME/.gemini/GEMINI.md` **均自动加载且互不覆盖**；`--settings` 不存在仅排除该文件的键；按 `agy` 规则文档，单文件超过 24 KB 截断，全部全局规则共用 20 000 token 预算 | `globalEntry: { home: { dir: '.gemini' }, file: 'AGENTS.md', unconfirmed: '…' }`，无 `offInRound` |
| 原生只读 | `--mode plan`（不带 `--dangerously-skip-permissions`）时 `init.tools` 仍含全部 `write_file`/`edit_file`/`run_command`，实测往 `~/.gemini/antigravity-cli/brain/.../implementation_plan.md` 写入文件并挂起至超时（SIGTERM），仅靠提示词 `/plan` 约束 | **不声明 `readOnly`**（与 `dsh` 一致，不接审阅、知识把关与整理等只读职能） |
| 跨任务记忆 | 轨迹、记忆与上下文保存在 `~/.gemini` 下，无单轮关闭开关 | `memory: { scope: 'shared', why: '…' }`（无 `off`） |
| 配置列举 | `agy mcp list` 表格列 `NAME/TYPE/STATUS`（`enabled`/`disabled`）；`agy plugin list --json` 返回 `[{ name, enabled, ... }]` | `config` 声明 `mcp` 与 `plugins`（不触发服务启动） |
| 会话续接与用量 | `--conversation <id>` 续接保留上下文并使 `result.num_turns` 递增；**`result.usage` 是全会话跨轮累计和**，每个 `step_update`（`state === "DONE"`）的 `usage` 为单步增量且 `input_tokens` 已不含 `cache_read_tokens`、`output_tokens` 已含思考输出 | `resumable: true`；结算与事件以 `step_update` 增量 `usage` 累加，避免续接轮重复计费 |

## 细节记录

### 1. `--settings` 键名探测结果

以非法类型值 `[1]` 搭配 `--print-timeout 1ms`（不触发模型调用）逐键实测 `--settings` 校验逻辑：

- **可识别键**（报错 `invalid value for setting`）：`model`、`modelProvider`、`customModelsConfig`、`agentMode`、`toolPermission`、`permissions`、`enableTerminalSandbox`、`allowNonWorkspaceAccess`、`trustedWorkspaces`、`disableSlashCommands`。
- **拒绝键**（报错 `unknown setting`）：`effort`、`reasoningEffort`、`reasoning_effort`、`thinkingLevel`、`effortLevel`、`effortByBase`、`planModel`、`defaultModel`、`includeDefaultCustomizations`、`enabledPlugins`、`pluginsDisabled`、`mcpServers`、`mcpAllowlist`、`memory`、`hooks`、`rules`、`mode`、`sandbox`。

据此确定：权限/沙箱隔离键 `['agentMode', 'toolPermission', 'permissions', 'enableTerminalSandbox', 'allowNonWorkspaceAccess']` 及认证来源键 `'modelProvider'` 由 `checkTier` 在保存与派发前拦截；`effort` 保留在 `GEMINI_SETTINGS_JSON` 以便控制台表单编辑，但在生成快照 `tier.json` 时剥离并改为 `launch`/`resume` 传入 `--effort`。

### 2. Token 账本与续接算式验证

实测 `tools`（第 1 轮，3 个 `agent_response` 步骤）与 `resume`（同一会话第 2 轮，1 个 `agent_response` 步骤）：

- `tools` 各步增量之和：`9385 + 2660 + 2305 = 14350` input、`308 + 100 + 8 = 416` output、`0 + 7331 + 7942 = 15273` cache_read，与第 1 轮 `result.usage` 吻合，且 `total_tokens === input_tokens + output_tokens`（证明 `input_tokens` 已扣除缓存读取，而 `output_tokens` 已包含 `thinking_tokens`：见另测 `output_tokens: 31, thinking_tokens: 18, input_tokens: 10207, total_tokens: 10238`）。
- `resume` 第 2 轮增量：`input_tokens: 2276, output_tokens: 113, cache_read_tokens: 8198`；而第 2 轮 `result.usage` 返回 `16626 / 529 / 23471`，恰好等于第 1 轮与第 2 轮之和。因此适配器的 `usage` 结算必须以 `step_update`（`state === 'DONE'`）的增量为准，绝不可直接采用多轮会话的 `result.usage`。
