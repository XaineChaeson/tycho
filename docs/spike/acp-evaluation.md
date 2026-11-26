# ACP 能不能当 tycho 驱动各家执行器的统一接口

2026-11-06，Windows 工作站上调研加实测。读者：要据此决定 tycho 执行器接口怎么走的人。

## 结论

**只能统一一部分，而且不是卡住 tycho 的那一部分。总控和执行者现在都不换 ACP。**

ACP（Agent Client Protocol）能统一的是：建会话、发提示、流式事件的词汇、取消、权限请求、建会话时带 MCP 服务器。tycho 另外依赖的四件事——禁掉内置工具、选档位、认出"登录失效"和"额度用完"、脱离连接运行——规范里都没有，三家要么各用各的私有办法，要么做不到。

- **总控不写死成 Claude，障碍不在传输格式。** Codex 去不掉内置工具，dsh 不给文本增量；换成 ACP 这两条照旧。能同时做到"流式 + 只留 MCP 工具"的仍然只有 Claude，而且靠的是适配器的私有字段。
- **执行者要脱离连接跑，ACP 要求客户端在场。** 三家在连接断开后都立刻退出，正在跑的那一轮作废（实测）。要用 ACP 就得在远端常驻一个小客户端，再装两个第三方适配器包，换来的只是少写两段输出解析。

统一接口留在 tycho 自己的适配器契约（`adapters/types.ts`）这一层。ACP 以后可以是这层契约下面的一种实现，条件见"建议"。

## 需求对照表

格子里是结论加出处。出处代号：`P-*` 是规范页，`R-*` 是还没定稿的提案（RFD），`T*` 是本文的实测记录，`C*` 是适配器的源码或文档，全部列在表后。"Claude Code""Codex"两列说的是它们的 ACP 适配器，不是 CLI 本身。

| tycho 的需求 | 规范（v1） | Claude Code | Codex | dsh |
|---|---|---|---|---|
| 建会话、发提示、回合结束带原因 | 支持，必选（P-init、P-turn） | 支持（T1） | 支持（T4） | 支持（T7） |
| 文本按增量流出 | 支持：有 `agent_message_chunk`，但不要求按增量发（P-turn） | 支持，一轮 10 段（T1） | 支持，2.5 秒 135 段（T4） | 不支持：整段在回合末尾到达（T7、C3） |
| 工具开始、结束事件 | 支持（P-turn） | 支持（T1） | 支持（T4） | 支持（T7） |
| 打断当前一轮 | 支持，必选（P-turn） | 支持，11 ms 返回 `cancelled`（T1） | 支持，14 ms 返回（T4） | 支持，7 ms 返回（T7） |
| 进程重启后续接会话 | 支持，可选能力：`session/load`（回放历史）或 `session/resume`（不回放）（P-setup） | 支持，两种都有；`load` 实测（T1） | 支持，两种都有；`load` 实测（T4） | 支持，只有 `resume`（T7、C3） |
| 建会话时带 MCP 服务器 | 支持，stdio 必选（P-setup） | 支持（T1） | 支持（T4） | 支持（T7） |
| 禁掉内置工具，只留给定的 MCP 工具 | 不支持：没有这个字段 | 私有扩展：`_meta.claudeCode.options.tools: []`（T2、C1） | 不支持：没找到办法，默认会话报出 13 个内置工具（T5） | 私有扩展，而且不在 ACP 里：启动参数 `--patch`（T8） |
| 结构化地核对实际工具清单 | 不支持 | 私有扩展：`_claude/sdkMessage` 转发原始 `init`（T3、C1） | 没测到 | 没测到（只有上下文占用变小的旁证，T8） |
| 权限请求由客户端按策略自动答 | 支持（P-tools） | 支持（T2） | 支持（T5） | 没测到：默认不问（T7）；文档说支持（C3） |
| "不问直接做"的模式 | 不支持：模式的名字各家自定（P-config） | 私有扩展：模式 `bypassPermissions`，本机默认就是它（T1） | 私有扩展：模式 `agent-full-access`，列出了没试（T4） | 默认就不问（T7） |
| 选模型或档位 | 支持机制：`configOptions` 加 `session/set_config_option`；取值各家自定（P-config） | 支持机制（T1）；档位文件走私有字段 `options.settings`，没测到（C1） | 支持机制（T4）；配置走环境变量 `CODEX_CONFIG`，没测到（C2） | 支持机制（T7）；`--patch` 能和 ACP 同用（T8） |
| 追加系统提示词 | 不支持：提案在预览阶段（R-sys） | 支持（声明了能力），没测到（T1） | 支持（声明了能力），没测到（T4） | 不支持：没声明（T7） |
| 不加载个人配置和技能 | 不支持 | 私有扩展 `options.settingSources`，没测到；默认加载了本机 45 个技能（T3、C1） | 没测到 | 没测到；默认读了个人指令（T7） |
| 认出"登录失效" | 支持：错误码 `-32000`（P-err、P-auth） | 支持（源码），没测到（C1） | 支持（源码），没测到（C2） | 不支持：密钥无效报成 `-32603 Internal error` 加一句文字（T6） |
| 认出"额度用完" | 不支持：提案明说不管（R-usage） | 私有扩展：`_claude/rateLimit` 实测到预警；用完时的报文没测到（T1、C1） | 私有扩展（源码），没测到（C2） | 没测到 |
| 每回合的 token 用量 | 不支持：提案还在草案（R-endturn）；上下文占用 `usage_update` 是标准的 | 私有扩展：回合应答里带草案字段 `usage`（T1） | 私有扩展：同上（T4） | 不支持：只有上下文占用（T7） |
| 用本机已有的订阅登录 | 不涉及 | 支持（T1） | 支持（T4） | 账号线路支持；默认线路（密钥）失败（T6、T7） |
| 客户端断开后那一轮继续跑 | 不支持：正式传输只有 stdio（P-transport）；远程传输是草案（R-http） | 不支持：0.1 秒内退出，回合作废（T9） | 不支持：约 2 秒后退出（T9） | 不支持：约 2 秒后退出（T9） |

出处：

- P-init：<https://agentclientprotocol.com/protocol/v1/initialization>
- P-setup：<https://agentclientprotocol.com/protocol/v1/session-setup>
- P-turn：<https://agentclientprotocol.com/protocol/v1/prompt-turn>
- P-tools：<https://agentclientprotocol.com/protocol/v1/tool-calls>（Requesting Permission 一节）
- P-config：<https://agentclientprotocol.com/protocol/v1/session-config-options>、<https://agentclientprotocol.com/protocol/v1/session-modes>
- P-auth：<https://agentclientprotocol.com/protocol/v1/authentication>
- P-err：<https://agentclientprotocol.com/protocol/v1/error>
- P-transport：<https://agentclientprotocol.com/protocol/v1/transports>
- R-usage：<https://agentclientprotocol.com/rfds/session-usage>
- R-endturn：<https://agentclientprotocol.com/rfds/end-turn-token-usage>
- R-sys：<https://agentclientprotocol.com/rfds/client-system-prompt>
- R-http：<https://agentclientprotocol.com/rfds/streamable-http-websocket-transport>
- C1：`@agentclientprotocol/claude-agent-acp@0.101.0` 的 `dist/acp-agent.js`：第 397–449 行（`_meta.claudeCode.options` 接受的键，含 `tools`、`settings`、`settingSources`、`strictMcpConfig`）、第 9129–9135 行（`tools` 的取值）、第 4043–4045 行（`_claude/sdkMessage`）、第 6264–6273 行（`_claude/rateLimit`）、第 532 行及 3814、5490、6089 行（`authRequired`）；`dist/session-failure-extension.js`（`auth_required`、`quota_exhausted`、`rate_limited` 分类）。
- C2：`@agentclientprotocol/codex-acp@2.5.0` 的 `dist/index.js` 第 37056–37064 行（Codex 错误到 `quota_exhausted`、`rate_limited`、`auth_required` 的映射）；包内 `README.md` 的 Runtime options 一节。
- C3：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md>（Protocol contract 一节）、<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/acp-app/README.md>。

## 协议本身

**版本。** 稳定版是 v1，三家对 `protocolVersion: 1` 都原样应答（T1、T4、T7）。v2 在 2026-07-20 发了草案，官方要求"不要在生产里默认启用"（<https://agentclientprotocol.com/announcements/acp-v2-draft>）。v2 改的正是 tycho 关心的地方：提示请求在消息被接受时就返回，回合结束改由状态更新表达；`session/load` 并进带回放游标的 `session/resume`。现在照 v1 写的客户端，到 v2 要改回合结束的判定。

**一轮怎么走。** 客户端启动智能体子进程，在它的标准输入输出上逐行收发 JSON-RPC。`initialize` 互报能力 → `session/new`（带工作目录和 MCP 服务器列表）→ `session/prompt` → 智能体用 `session/update` 通知推文本、思考、工具调用 → 提示请求的应答带 `stopReason`（`end_turn`、`max_tokens`、`max_turn_requests`、`refusal`、`cancelled`）。`session/new`、`session/prompt`、`session/cancel`、`session/update` 是必选的（P-init）。

**取消。** 客户端发 `session/cancel` 通知；智能体停下后必须用 `stopReason: "cancelled"` 应答原来的提示请求，不许报成错误（P-turn）。

**续接是可选能力。** `session/load` 要智能体声明 `loadSession`，会把整段历史用 `session/update` 重放一遍；`session/resume` 要声明 `sessionCapabilities.resume`，不重放（P-setup）。没声明就不许调用。

**权限请求。** 智能体执行工具前可以向客户端发 `session/request_permission`，带一组选项（`allow_once`、`allow_always`、`reject_once`、`reject_always`）；客户端选一个，或者在取消时答 `cancelled`。规范原话是客户端"MAY automatically allow or reject permission requests according to the user settings"（P-tools），所以无人值守按策略答是合规的。发不发请求由智能体决定，规范不规定哪些操作必须问。

**MCP 服务器。** `session/new`、`session/load`、`session/resume` 都带 `mcpServers`；stdio 方式所有智能体必须支持，HTTP 是可选能力。规范写明客户端可以借此把自己的工具交给模型（P-setup）。

**禁用内置工具。** 没有标准办法。规范页里没有任何字段描述或限制智能体自带的工具。

**模型和档位。** 标准机制是 `configOptions`：智能体在建会话的应答里列出可选项，每项可带语义类别（`mode`、`model`、`model_config`、`thought_level`），客户端用 `session/set_config_option` 改。类别"只为界面服务，不得作为正确性的依据"，选项的 id 和取值都是各家自定的（P-config）。旧的 `modes` 字段要被它取代。"档位"这个概念规范里没有。

**用量、额度、登录失效。**
- 登录失效：有标准错误码 `-32000 Authentication required`，规范只写了"建会话可能因此失败"（P-setup、P-err）；回合进行到一半失效怎么报没有规定。查询登录状态的提案还在草案（<https://agentclientprotocol.com/rfds/get-auth-state>）。
- 额度：没有。会话用量提案在问答里写明它只管上下文占用和累计花费，额度和限流留给以后的提案（R-usage）。
- 用量：标准的只有 `usage_update`（上下文已用、上限、累计花费）。每回合的 token 数是草案（R-endturn）。

**客户端必须一直连着。** 唯一正式的传输是 stdio：客户端把智能体当子进程启动，结束时"关闭标准输入，终止子进程"（P-transport）。规范没有写断开后那一轮该怎样，实测三家都是退出（T9）。远程传输（HTTP 加 WebSocket）是草案；它在 v1 里承诺"会话在断开后仍在"，同时写明"断开期间发出的消息不会补发"（R-http）。也就是说即使它定稿，tycho 仍然需要自己把事件落到文件里。

## 三家各自的接法与成熟度

| | Claude Code | Codex | dsh |
|---|---|---|---|
| 命令 | `npx @agentclientprotocol/claude-agent-acp` | `npx @agentclientprotocol/codex-acp` | `dsh --profile acp`（`dsh acp` 同义） |
| 谁维护 | ACP 项目组（Zed 的人），不是 Anthropic。`claude` 2.1.303 自己的 `--help` 里没有 ACP | ACP 项目组，不是 OpenAI。`codex` 0.162.0 的子命令里没有 ACP | DeepSeek 自己，随 dsh 发行；本机 0.2.2-rc.1，开发者预览版 |
| 底下是什么 | 官方 Claude Agent SDK 0.3.318，自带一份 Claude CLI；可用 `CLAUDE_CODE_EXECUTABLE` 指向已装的 | 自带 `@openai/codex` 0.165.0，驱动它的 `codex app-server`（Codex 自己标注为实验性） | dsh 自己的会话运行时 |
| 认证 | 直接用了本机已有的订阅登录，没有任何认证步骤（T1）；认 `CLAUDE_CONFIG_DIR` | 直接用了本机已有的 ChatGPT 登录（T4）；也可用 `CODEX_API_KEY` | 默认线路用密钥，本机密钥无效；账号线路可用（T6、T7） |
| 体积与依赖 | Node ≥ 22；也有免 Node 的独立可执行文件 | Node；也能打独立可执行文件 | 随 dsh 安装 |
| 更新节奏 | 2026-03-26 的 0.24.0 到 2026-11-05 的 0.101.0，几天一版；旧包名 `@zed-industries/claude-code-acp` 已弃用 | 2.5.0 发于 2026-11-03；旧包名 `@zed-industries/codex-acp` 已弃用 | 跟 dsh 版本走 |

两个适配器包装在一起占 870 MB（各带一份 CLI 二进制）。它们的私有扩展很多（`_meta.claudeCode.*`、`_claude/*`、`_auth/status_update`、`_session/steering`，以及为 JetBrains AIR 做的一整套），tycho 需要的"禁内置工具、原始 `init`、额度信息"全在这些私有扩展里，不在规范里。

dsh 的 ACP 明确定位成"只给自动化用"：只发已经落定的整段消息，不发增量，不发重试；不支持 `session/load`、模式、追加目录（C3）。这和 tycho 2026-11-04 的实测一致（`docs/design/merged-design.md` §6）。

## 实测记录

环境：Windows 11，Node 24.19.0。客户端是一个 189 行的 Node 脚本，另有一个 36 行、只有 `echo` 一个工具的 stdio MCP 服务器；两份都附在文末。每个方向的每一帧都记了下来。提示都是一两句话。下面的报文里，账号邮箱、密钥尾号和模型名已抹掉。

### T1 Claude Code：完整流程

`initialize` 的应答（节选）：

```json
{"protocolVersion":1,"agentCapabilities":{"_meta":{"claudeCode":{"promptQueueing":true},"authStatus":{}},
 "promptCapabilities":{"image":true,"embeddedContext":true},"mcpCapabilities":{"http":true,"sse":true},
 "auth":{"logout":{}},"providers":{},"loadSession":true,
 "sessionCapabilities":{"additionalDirectories":{},"close":{},"delete":{},"fork":{},"list":{},"resume":{},"systemPrompt":{"mode":{"override":{}}}}},
 "agentInfo":{"name":"@agentclientprotocol/claude-agent-acp","title":"Claude Agent","version":"0.101.0"},
 "authMethods":[],"_meta":{"steering":{"supported":true}}}
```

`session/new` 用时 2.0 秒，没有要求认证，应答前推了一条私有通知（邮箱已抹）：

```json
{"jsonrpc":"2.0","method":"_auth/status_update","params":{"authStatus":{"kind":"account","label":"<订阅档>","account":{"plan":"<订阅档>","email":"<已抹>","organization":"<已抹>"}}}}
```

应答里的当前模式是 `bypassPermissions`（可选的还有 `default`、`acceptEdits`、`plan`、`auto`），`configOptions` 有 `mode`、`model`、`effort`、`ultracode`、`agent` 五项。

第一轮让它调用 `echo`。6.7 秒出第一段文本，文本逐段到达，工具调用有开始和结束：

```json
{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"我"},"messageId":"msg_011C…"}
{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"先"},"messageId":"msg_011C…"}
{"sessionUpdate":"tool_call","toolCallId":"toolu_012m…","name":"mcp__echo__echo","rawInput":{},"status":"pending","title":"mcp__echo__echo","kind":"other","content":[],"_meta":{"claudeCode":{"toolName":"mcp__echo__echo"}}}
{"sessionUpdate":"tool_call_update","toolCallId":"toolu_012m…","status":"completed","rawOutput":[{"type":"text","text":"echo:ping-42"}],"content":[{"type":"content","content":{"type":"text","text":"echo:ping-42"}}]}
```

MCP 服务器自己的日志记到了这次调用。没有权限请求（模式是 `bypassPermissions`）。回合应答：

```json
{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","usage":{"inputTokens":8,"outputTokens":226,"cachedReadTokens":68625,"cachedWriteTokens":34518,"totalTokens":103377},"_meta":{"quota":{…}}}}
```

回合中间有一条带额度信息的上下文占用更新，额度在私有的 `_meta` 里：

```json
{"sessionUpdate":"usage_update","used":34340,"size":1000000,"_meta":{"_claude/rateLimit":{"status":"allowed_warning","resetsAt":1794081600,"rateLimitType":"seven_day_overage_included","utilization":0.97,"overageStatus":"rejected",…,"unifiedWindows":{"five_hour":{"utilization":0.18,…},"seven_day":{"utilization":0.69,…},"seven_day_overage_included":{"utilization":0.97,"status":"allowed_warning",…}}},"_claude/model":"<模型>"}}
```

第二轮让它写 600 词短文，等了 15 秒没有任何文本或思考增量（原因没查），发取消：

```json
> {"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"6fdd9453-…"}}
< {"jsonrpc":"2.0","id":4,"result":{"stopReason":"cancelled","usage":{"inputTokens":0,…}}}      （11 ms 后）
```

关闭标准输入，进程以退出码 0 结束。重新启动，`session/load` 同一个会话号：重放 9 条更新（3 条用户消息、2 条智能体消息、2 个工具调用及其结果），其中有 `ping-42`，被取消的那一轮显示为 `[Request interrupted by user]`。再问"你之前传给 echo 的文本是什么"，答 `ping-42`。

### T2 Claude Code：去掉内置工具，再看权限请求

`session/new` 带私有字段：

```json
"_meta":{"claudeCode":{"options":{"tools":[],"strictMcpConfig":true}}}
```

问"列出你能调用的所有工具"，回答只有一行 `mcp__echo__echo`。上下文占用从 T1 的 34 181 降到 7 776 token。

然后用 `session/set_config_option` 把 `mode` 改成 `default`，再让它调用 `echo`。这次收到权限请求，客户端自动选 `allow_once`，工具照常执行：

```json
< {"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"sessionId":"e3900555-…",
   "toolCall":{"toolCallId":"toolu_01J2…","name":"mcp__echo__echo","status":"pending","rawInput":{"text":"ping-43"},"title":"mcp__echo__echo","kind":"other","content":[],"_meta":{"claudeCode":{"toolName":"mcp__echo__echo","mcpServer":{"name":"echo","source":"dynamic"}}}},
   "options":[{"optionId":"allow-once","name":"Yes","kind":"allow_once"},{"optionId":"allow-with-updates","name":"Yes, and don't ask again for Echo commands","kind":"allow_always"},{"optionId":"reject","name":"No","kind":"reject_once"}]}}
> {"jsonrpc":"2.0","id":0,"result":{"outcome":{"outcome":"selected","optionId":"allow-once"}}}
```

### T3 Claude Code：结构化地拿到工具清单

tycho 现在靠 `init` 事件里的工具清单核对总控，对不上就停。ACP 里没有对应物。适配器有个私有开关能把 SDK 的原始消息转发出来：`session/new` 的 `_meta.claudeCode` 里加 `"emitRawSDKMessages":[{"type":"system","subtype":"init"}]`，发出提示后收到私有通知 `_claude/sdkMessage`，里面是：

```json
{"tools":["mcp__echo__echo"],"mcp_servers":[{"name":"echo","status":"connected","source":"dynamic"}],"permissionMode":"bypassPermissions", …}
```

同一条里还有 81 个斜杠命令、45 个技能：`tools: []` 去掉了内置工具，但个人配置照样加载。这条通知只在发了提示之后才来；只建会话不发提示，5 秒内没有收到。

### T4 Codex：完整流程

`initialize` 的应答（节选）：

```json
{"protocolVersion":1,"agentInfo":{"name":"@agentclientprotocol/codex-acp","title":"Codex","version":"2.5.0"},
 "agentCapabilities":{"auth":{"logout":{}},"providers":{},"loadSession":true,"promptCapabilities":{"embeddedContext":true,"image":true},
  "sessionCapabilities":{"resume":{},"list":{},"close":{},"delete":{},"fork":{},"additionalDirectories":{},"subagents":{},"systemPrompt":{}},
  "mcpCapabilities":{"acp":false,"http":true,"sse":false},"_meta":{"authStatus":{}}},
 "authMethods":[{"id":"api-key","name":"API Key",…},{"id":"chat-gpt","name":"ChatGPT",…}],"_meta":{"steering":{"supported":true}}}
```

没有做认证，`session/new` 直接成功。当前模式 `agent`（可选 `read-only`、`workspace-write`、`agent`、`agent-full-access`）；`configOptions` 有 `mode`、`collaboration_mode`、`model`、`reasoning_effort`、`fast-mode`。

第一轮调用 `echo`：没有向客户端发权限请求，Codex 自己做了一次内部审查，显示成一个工具调用：

```json
{"sessionUpdate":"tool_call","toolCallId":"exec-ea9c…","kind":"execute","title":"mcp.echo.echo","status":"in_progress","rawInput":{"server":"echo","tool":"echo","arguments":{"text":"ping-42"}},"_meta":{"is_mcp_tool_call":true}}
{"sessionUpdate":"tool_call","toolCallId":"guardian_assessment:854f…","kind":"think","title":"Guardian Review","status":"in_progress",…}
{"sessionUpdate":"tool_call_update","toolCallId":"exec-ea9c…","status":"completed","rawOutput":{"result":{"content":[{"type":"text","text":"echo:ping-42"}],…},"error":null}}
```

回合应答 `{"stopReason":"end_turn","usage":{"totalTokens":58467,"inputTokens":6283,"cachedReadTokens":52096,"outputTokens":88,…}}`。

第二轮写短文：1.9 秒出第一段，之后 2.5 秒内到了 135 段。发取消后 14 ms 收到：

```json
< {"jsonrpc":"2.0","id":4,"result":{"stopReason":"cancelled","usage":null,"_meta":{"quota":{"token_count":null,"model_usage":[]}}}}
```

关闭标准输入，进程以退出码 0 结束。重启后 `session/load`：重放 10 条更新，含 `ping-42`。再问，答 `ping-42`。

### T5 Codex：列工具，再看权限请求

没找到去掉内置工具的办法（适配器的说明和源码里都没有）。默认会话问"列出你能调用的所有工具"，它报了 13 个：`functions.exec`、`functions.wait`、`functions.request_user_input`、`functions.request_user_input_async`、`clock.sleep`、`collaboration.*` 六个、`mcp__cua_repl.js` 两个。

把模式改成 `read-only` 后让它调用 `echo`，收到权限请求，客户端自动选 `allow_once`，工具执行：

```json
< {"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"sessionId":"01a1af39-…","toolCall":{"toolCallId":"exec-ced1…","kind":"execute","status":"pending"},"_meta":{"is_mcp_tool_approval":true},
   "options":[{"optionId":"allow_once","name":"Allow","kind":"allow_once"},{"optionId":"allow_session","name":"Allow for this session","kind":"allow_always"},{"optionId":"allow_always","name":"Always allow","kind":"allow_always"},{"optionId":"cancel","name":"Cancel","kind":"reject_once"}]}}
> {"jsonrpc":"2.0","id":0,"result":{"outcome":{"outcome":"selected","optionId":"allow_once"}}}
```

### T6 dsh：默认设置起不来一轮

`initialize` 的应答：

```json
{"protocolVersion":1,"agentInfo":{"name":"deepseek-harness-acp","version":"0.0.1"},
 "agentCapabilities":{"mcpCapabilities":{"http":true},"promptCapabilities":{"image":false,"audio":false,"embeddedContext":false},"sessionCapabilities":{"close":{},"list":{},"resume":{}}},
 "authMethods":[]}
```

没有 `loadSession`。`session/new` 成功，`configOptions` 只有 `model` 和 `reasoning_effort`。默认线路是密钥线路，发提示 146 ms 后失败：

```json
< {"jsonrpc":"2.0","id":3,"error":{"code":-32603,"message":"Internal error: turn failed: Authentication Fails, Your api key: ****<已抹> is invalid (request_id: bf178509-…)"}}
```

这是登录失效，却没有用标准的 `-32000`。按约束没有去修密钥。

### T7 dsh：账号线路上的完整流程

为了测其余行为，用 `session/set_config_option` 选了它列出的"账号"分组里的第一项（脚本按位置取，没有写模型名；tycho 原有的 `docs/spike/dsh-acp-long.mjs` 也是这么做的）。这偏离了"用默认设置"，原因是默认线路在本机不可用。

- 调用 `echo`：1.5 秒完成，没有权限请求，最终文本只有一段。
- 写短文：15 秒内一条更新都没有。发取消后才吐出一整段思考，7 ms 后应答 `{"stopReason":"cancelled"}`。
- 回合应答里没有 token 用量，只有 `{"sessionUpdate":"usage_update","used":7978,"size":1048576}`。
- 重启后 `session/resume` 成功，不重放任何历史；再问，答 `ping-42`，说明上下文还在。

### T8 dsh：列工具、去掉内置工具

默认问"列出你能调用的所有工具"，报了 28 个，含 `pwsh`、`read`、`write`、`edit`、`web_fetch`、`subagent`、`mcp__echo__echo`。

ACP 里没有办法去掉它们。dsh 自己的办法是启动时加一层补丁：写一个只把 16 个工具插件行标成 `disabled: true` 的补丁文件（放在临时目录，没有动 `~/.dsh`），用 `dsh --profile acp --patch <文件>` 启动。再问，只报 `mcp__echo__echo`；上下文占用从 8 284 降到 1 801 token。

### T9 三家：回合中途断开连接

`echo` 遇到以 `slow` 开头的文本会等 20 秒再答。让智能体调用它，工具调用开始 3 秒后关闭智能体的标准输入。

| | 断开后进程 | 那一轮 | 重启后看到的 |
|---|---|---|---|
| Claude Code | 0.1 秒内退出，退出码 0 | MCP 服务器收到了调用，没等到回答就被一起结束 | `session/load` 重放出用户消息和一个停在 `pending` 的工具调用，没有结果 |
| Codex | 2.1 秒内退出，退出码 0 | 调用还在内部审查，没到 MCP 服务器 | `session/load` 重放出用户消息和第一句回答，没有工具调用 |
| dsh | 2.2 秒内退出，退出码 0 | MCP 服务器收到调用，3 秒后被结束，没有回答 | `session/resume` 后问它，它说那次调用返回的是错误，没拿到结果 |

三家一致：连接没了，进程就走，那一轮不会自己跑完。

### 没跑成的

- "登录失效"在 Claude Code 和 Codex 上的报文：要注销才能触发，约束不允许。
- "额度用完"的报文：三家都没有触发。Claude 的周额度预警已经到 0.97，没有为了看报文去打满它。
- dsh 的权限请求：默认不问，也没有模式可切。
- Codex 的 `agent-full-access` 模式、两家的系统提示词追加、Claude 的 `settings` 和 `settingSources`：只看了声明或源码，没有发请求验证。

## 和 tycho 的两种用法对不对得上

### 总控

tycho 的总控现在靠 `claude -p` 的双向 stream-json（`service/session-host.ts`）。逐项对照：

| 总控的需求 | 判定 |
|---|---|
| 只能用 tycho 给的 MCP 工具，没有内置工具 | 都不是规范支持。Claude 靠私有字段做到；dsh 靠启动补丁做到；Codex 做不到 |
| 启动后核对工具清单，对不上就停 | 规范不支持。只有 Claude 靠私有通知做到 |
| 建会话时带编排工具的 MCP 服务器 | 规范支持，三家都支持 |
| 流式输出 | 规范支持。Claude、Codex 支持；dsh 不支持 |
| 打断 | 规范支持，三家都支持 |
| 续接会话 | 规范支持（可选能力），三家都支持；dsh 不重放历史 |
| 追加总控的系统提示词 | 规范不支持（预览中的提案）。Claude、Codex 声明支持，没测；dsh 不支持 |
| 档位文件 | 规范只有选模型的机制，没有档位。三家各用私有办法 |
| 不加载个人配置 | 规范不支持。Claude 有私有字段，没测 |
| 认出登录失效 | 规范支持（`-32000`）。Claude、Codex 按源码支持，没测；dsh 实测不支持 |
| 认出额度用完 | 规范不支持。Claude、Codex 有私有扩展，没测到耗尽时的样子；dsh 没测到 |

换成 ACP 之后，能当总控的仍然只有 Claude：Codex 缺"只留 MCP 工具"，dsh 缺流式。而 Claude 在 ACP 下要满足 tycho 的硬条件，用的全是 `_meta.claudeCode.*` 和 `_claude/*` 这些私有字段——这等于把 `claude -p` 的参数换了个写法，中间多了一个不归 Anthropic 维护、几天一版的适配器。"靠结构不靠提示词"这条原则在 ACP 下没有标准的落点。

### 执行者

执行者是经 SSH 脱离连接启动的：`runner/remote/start.sh` 把命令放进独立的进程组，输出落到 `stdout.ndjson`，退出码落到 `exit`，之后 tycho 读文件、看进程组。ACP 要客户端在场，T9 证实断开即作废。所以只能在远端放一个通用的小客户端，由它当这个"命令"。

**它要做的事：** 启动智能体的 ACP 进程；`initialize`；`session/new`，或者有会话号时 `session/load`、`session/resume`；切到不问的模式，或者自动答权限请求；发 `session/prompt`；把收到的每一帧原样写到标准输出；收到 SIGINT 时发 `session/cancel` 并等应答；最后写一行结果、按成败退出。

**它有多大：** 零依赖的 Node 脚本，150 到 200 行。依据是本次的测试客户端：含四个场景一共 189 行，其中连接、记帧、自动答权限、发一轮这些通用部分约 90 行。

**tycho 要改的：**

- `start.sh`、`state.sh`、`stop.sh` 和判定表不用改。小客户端就是被启动的那个命令，在同一个进程组里；它死了智能体也跟着退出（T9），不会留下孤儿。
- `adapters/claude.ts` 和 `adapters/codex.ts`（共 270 行）换成一个 ACP 适配器：`parse` 把 `session/update` 映射到现有词汇，`result` 读最后的结果行，估计 100 行上下。
- 每家仍然要一张表，因为下面这些 ACP 不管：启动命令、登录目录用哪个环境变量、不问的模式叫什么、档位怎么给（Claude 的私有字段、Codex 的环境变量、dsh 的 `--patch`）、问"登录了没有"用哪条 CLI 命令、额度和登录错误的文字怎么认（dsh 连登录失效都只给一句文字）。
- 每台远端机器要多装：Node、小客户端、两个适配器包。按 tycho"Run 记录 harness 版本，升级先过测试"的规则，每个执行器要管的版本从一个变成两个。
- `tests/fixtures/` 的实录全部重录。
- 会丢的东西：Claude 的"重试中"事件在 ACP 里没有对应的更新类型（有没有被适配器以别的形式带出来没测）；dsh 的文本只能整段显示。

**比现在简单还是复杂：更复杂。** 现在每家的适配器是 80 到 190 行，对着的是厂商自己的无人值守模式（`claude -p`、`codex exec --json`），天生跑完就退出、不需要客户端。换 ACP 省掉的是两段事件解析，约 150 行；加进来的是一个小客户端、一个 ACP 适配器、一张逐家的表、两个第三方包和它们的版本管理。每家的启动知识一条也没少。

## 建议

**总控：不用。** 理由是换了也只有 Claude 能当，而且要依赖私有扩展和一个第三方中间层，没有换来可替换性。重新评估的条件：出现第二个候选，它经 ACP 能同时做到文本增量和结构上只留 MCP 工具。到那时把 `session-host.ts` 里 Claude 专有的部分（启动参数、输入行、中断行、输出解析、工具清单核对、登录失效判定）收到一个驱动接口后面，ACP 做它的第二种实现。现在没有第二个实现者，先不抽这个接口。

**执行者：不用。** 重新评估的条件是下面任意一条成立：

- 要接的执行器只有 ACP、没有无人值守的 JSON 输出模式；
- 执行器多到逐家写解析不划算（现在两家，加 dsh 是三家，而 dsh 有 `dsh --profile headless --json`）；
- 要把执行者的权限请求转给主人审批，或者要回合内插话。这两件事 ACP 有现成的表达（`session/request_permission`；插话是两个适配器共有的私有扩展 `_session/steering`），现在的命令行模式没有。

**不用 ACP，统一接口落在哪一层：** 就是现有的 `adapters/types.ts`——四个接触点加统一事件词汇。它和 ACP 的词汇几乎一一对应：

| tycho 的事件 | ACP 里的对应 |
|---|---|
| `text` | `agent_message_chunk` |
| `thinking` | `agent_thought_chunk` |
| `tool.start`（带类别） | `tool_call`（带 `kind`：`read`、`edit`、`search`、`execute` 等） |
| `tool.end` | `tool_call_update`，`status` 为 `completed` 或 `failed` |
| `turn.end` | 提示请求的应答，带 `stopReason` |
| `interrupted` | `stopReason: "cancelled"` |
| `error` | JSON-RPC 错误 |
| `usage` | 应答里的 `usage`（草案）和 `usage_update` |
| `retry` | 没有 |

所以这层契约不用为 ACP 改形状；哪天要接一个 ACP 执行器，写一个适配器加那个小客户端就够，不动账本和 Runner。

## 没能证实的事

- Claude Code 和 Codex 在 ACP 下登录失效、额度用完时的实际报文。只读了源码里的分类，没有触发。
- 两家适配器的类型化失败扩展（`quota_exhausted`、`rate_limited`、`auth_required`）要客户端声明一个为 JetBrains AIR 做的私有能力才启用；没有试 tycho 这样的客户端声明后能不能用。
- Claude 的 `_meta.claudeCode.options.settings`（档位文件）和 `settingSources`（不加载个人配置）、两家的系统提示词追加、Codex 的 `agent-full-access`：没有发请求验证。
- Codex 有没有任何办法去掉内置工具：只查了适配器的说明和源码，没有查 `codex app-server` 自己的全部配置项。
- T1 第一轮里，最后一段文本到回合应答之间隔了 22 秒；第二轮 15 秒没有任何增量。原因都没查（T2 和续接后的那一轮没有这个现象）。
- dsh 仓库的说明是主干版本，本机装的是 0.2.2-rc.1；实测到的行为和说明一致，但没有逐条对过。
- Linux 集群实例上的表现：全部实测都在这台 Windows 工作站上。
- v2 草案下三家的行为：只测了 v1。
- `~/.codex/config.toml` 的修改时间是 13:08:36，落在测试时段内，晚于最后一次 Codex 运行结束（约 13:07:25），文件里没有本次临时目录的条目。适配器源码里唯一写配置的地方是没有调用过的 `_codex/hooks/trust`。同一时段本机还有别的 Codex 会话在跑（当天目录里有 2 个不属于本次测试的新会话文件）。没能证实是谁写的。

## 测试留下的东西

- 三个智能体各自在自己的目录里写了会话记录（`~/.claude/projects/` 下以本次临时目录命名的一个文件夹、`~/.codex/sessions/2026/11/06/` 下 5 个文件、`~/.dsh/sessions/` 下以本次临时目录命名的一个文件夹）。这是智能体自己写的，没有手工改动这三个目录里的任何文件，也没有删。
- Claude 一共跑了 5 个会话、7 轮，其中 4 个会话去掉了内置工具以省用量；Codex 3 个会话、6 轮；dsh 账号线路 7 轮，默认线路 3 轮都在 0.2 秒内失败。
- 适配器会把账号邮箱经 `_auth/status_update` 发给客户端。以后真要接，日志里要抹掉它。

## 附：测试脚本

两份脚本在本机临时目录下运行；适配器包装在同一目录的 `pkgs/` 里（`npm install @agentclientprotocol/claude-agent-acp@0.101.0 @agentclientprotocol/codex-acp@2.5.0`）。

用法：

```sh
node acp-client.mjs claude full                      # T1
ACP_MODE=default node acp-client.mjs claude notools  # T2
ACP_META='{"claudeCode":{"options":{"tools":[],"strictMcpConfig":true},"emitRawSDKMessages":[{"type":"system","subtype":"init"}]}}' node acp-client.mjs claude list   # T3
node acp-client.mjs codex full                       # T4
ACP_MODE=read-only node acp-client.mjs codex list    # T5
node acp-client.mjs dsh full                         # T6
ACP_ROUTE_GROUP=deepseek-account node acp-client.mjs dsh full   # T7
ACP_ROUTE_GROUP=deepseek-account ACP_DSH_ARGS='--patch "<补丁文件>"' node acp-client.mjs dsh list   # T8
node acp-client.mjs <claude|codex|dsh> drop          # T9（Claude 加 T2 的 ACP_META，dsh 加 ACP_ROUTE_GROUP）
```

<details>
<summary>acp-client.mjs（189 行）</summary>

```js
// ACP spike client: node acp-client.mjs <claude|codex|dsh> <full|list|notools|newonly|drop>
// Every frame in either direction goes to logs/<agent>-<scenario>.ndjson; a summary goes to stdout.
// Env: ACP_META (JSON for session/new _meta), ACP_MODE (mode id to switch to), ACP_ROUTE_GROUP, ACP_DSH_ARGS.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [, , agentName, scenario = 'full'] = process.argv;
const pkgs = path.join(here, 'pkgs', 'node_modules', '@agentclientprotocol');
const AGENTS = {
  claude: {
    cmd: process.execPath, args: [path.join(pkgs, 'claude-agent-acp', 'dist', 'index.js')],
    noTools: { claudeCode: { options: { tools: [], strictMcpConfig: true } } },
  },
  codex: { cmd: process.execPath, args: [path.join(pkgs, 'codex-acp', 'dist', 'index.js')] },
  dsh: { cmd: 'cmd.exe', args: ['/d', '/s', '/c', `""D:\\software\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd" --profile acp${process.env.ACP_DSH_ARGS ? ` ${process.env.ACP_DSH_ARGS}` : ''}"`], verbatim: true },
};
const spec = AGENTS[agentName];
if (!spec) throw new Error('unknown agent');

const work = path.join(here, 'work', agentName);
const logs = path.join(here, 'logs');
mkdirSync(work, { recursive: true });
mkdirSync(logs, { recursive: true });
const logFile = path.join(logs, `${agentName}-${scenario}.ndjson`);
const errFile = path.join(logs, `${agentName}-${scenario}.stderr.log`);
const echoLog = path.join(logs, `${agentName}-${scenario}.echo.log`);
for (const f of [logFile, errFile, echoLog]) rmSync(f, { force: true });
const t0 = Date.now();
// Claude Code refuses to start nested inside a session it recognises (same filter as tycho's session host).
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_)/i.test(k)));
const echoServer = { name: 'echo', command: process.execPath, args: [path.join(here, 'mcp-echo.mjs')], env: [{ name: 'ECHO_LOG', value: echoLog }] };
const say = (label, value) => console.log(`## ${label}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 1)}`);

function connect(tag) {
  const child = spawn(spec.cmd, spec.args, { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: !!spec.verbatim });
  const pending = new Map();
  const conn = { updates: [], permissions: [], cancelling: false, onUpdate: undefined, exit: undefined };
  let next = 1, buffer = '';
  const log = (dir, msg) => appendFileSync(logFile, JSON.stringify({ ms: Date.now() - t0, tag, dir, msg }) + '\n');
  const send = (msg) => { log('>', msg); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); };
  child.stdin.on('error', () => {});
  child.stderr.on('data', (c) => appendFileSync(errFile, c));
  child.on('exit', (code, signal) => { conn.exit = { code, signal }; for (const done of pending.values()) done({ exited: conn.exit }); pending.clear(); });
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { log('<!', line); continue; }
      log('<', m);
      if (m.method && m.id !== undefined) {
        if (m.method === 'session/request_permission') {
          conn.permissions.push(m.params);
          const options = m.params.options ?? [];
          const pick = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always') ?? options[0];
          send({ id: m.id, result: { outcome: conn.cancelling || !pick ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: pick.optionId } } });
        } else send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
      } else if (m.method) {
        if (m.method === 'session/update') { conn.updates.push({ ms: Date.now() - t0, ...m.params.update }); conn.onUpdate?.(m.params.update); }
      } else { pending.get(m.id)?.(m); pending.delete(m.id); }
    }
  });
  conn.call = (method, params, timeoutMs = 240_000) => new Promise((resolve) => {
    const id = next++;
    const timer = setTimeout(() => { pending.delete(id); resolve({ timeout: timeoutMs }); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    send({ id, method, params });
  });
  conn.notify = (method, params) => send({ method, params });
  conn.close = async (waitMs = 8000) => {
    const closedAt = Date.now();
    child.stdin.end();
    while (!conn.exit && Date.now() - closedAt < waitMs) await new Promise((r) => setTimeout(r, 100));
    const graceful = !!conn.exit;
    if (!conn.exit) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    return { exitedOnStdinClose: graceful, exitAfterMs: Date.now() - closedAt, exit: conn.exit };
  };
  return conn;
}

const init = (conn) => conn.call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'tycho-acp-spike', version: '0.0.1' } }, 90_000);
const outcome = (r) => r.result ?? { error: r.error, timeout: r.timeout, exited: r.exited };

// One prompt; with cancelAfterMs, session/cancel goes out that long after the first chunk (or 15 s after sending).
async function turn(conn, sessionId, text, cancelAfterMs) {
  const from = conn.updates.length, permsFrom = conn.permissions.length, sent = Date.now();
  let timer, cancelledAt;
  const cancel = () => { cancelledAt = Date.now() - sent; conn.cancelling = true; conn.notify('session/cancel', { sessionId }); };
  if (cancelAfterMs) {
    timer = setTimeout(cancel, 15_000);
    conn.onUpdate = (u) => {
      if (!/_chunk$/.test(u.sessionUpdate) || cancelledAt !== undefined) return;
      conn.onUpdate = undefined; clearTimeout(timer); timer = setTimeout(cancel, cancelAfterMs);
    };
  }
  const response = await conn.call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  clearTimeout(timer); conn.onUpdate = undefined; conn.cancelling = false;
  const updates = conn.updates.slice(from);
  const kinds = {};
  for (const u of updates) kinds[u.sessionUpdate] = (kinds[u.sessionUpdate] ?? 0) + 1;
  const chunks = updates.filter((u) => u.sessionUpdate === 'agent_message_chunk');
  return {
    response: outcome(response), totalMs: Date.now() - sent, cancelSentAtMs: cancelledAt, kinds,
    messageChunks: chunks.length, firstChunkMs: chunks[0] ? chunks[0].ms - (sent - t0) : undefined,
    lastChunkMs: chunks.length ? chunks.at(-1).ms - (sent - t0) : undefined,
    text: chunks.map((u) => u.content?.text ?? '').join('').slice(0, 1500),
    toolCalls: updates.filter((u) => u.sessionUpdate === 'tool_call').map((u) => ({ title: u.title, kind: u.kind, status: u.status })),
    permissionRequests: conn.permissions.length - permsFrom,
  };
}

async function open(tag, meta) {
  const conn = connect(tag);
  const initialized = await init(conn);
  say(`${tag} initialize`, outcome(initialized));
  if (!initialized.result) return { conn };
  const created = await conn.call('session/new', { cwd: work, mcpServers: [echoServer], ...(meta ? { _meta: meta } : {}) }, 120_000);
  const r = created.result;
  say(`${tag} session/new`, r ? {
    sessionId: r.sessionId, modes: r.modes && { current: r.modes.currentModeId, available: r.modes.availableModes?.map((m) => m.id) },
    configOptions: r.configOptions?.map((o) => ({ id: o.id, category: o.category, type: o.type, currentValue: o.currentValue })), metaKeys: r._meta && Object.keys(r._meta),
  } : outcome(created));
  // ACP_ROUTE_GROUP=<group>: the default route cannot answer, so take the first option the agent lists in that group.
  const route = r?.configOptions?.find((o) => o.id === 'model')?.options?.find((g) => g.group === process.env.ACP_ROUTE_GROUP)?.options?.[0];
  if (route) say('set route', outcome(await conn.call('session/set_config_option', { sessionId: r.sessionId, configId: 'model', value: route.value }, 30_000)).error ?? `first option of group ${process.env.ACP_ROUTE_GROUP}`);
  return { conn, caps: initialized.result.agentCapabilities ?? {}, sessionId: r?.sessionId };
}

if (scenario === 'full') {
  const first = await open('run1');
  if (first.sessionId) {
    say('turn A (tool call)', await turn(first.conn, first.sessionId, 'Call the `echo` tool from the echo MCP server with text "ping-42", then reply with exactly what it returned.'));
    say('turn B (cancelled)', await turn(first.conn, first.sessionId, 'Write a 600-word essay about rivers.', 2500));
  }
  say('run1 close', await first.conn.close());
  if (first.sessionId) {
    const conn = connect('run2');
    const initialized = await init(conn);
    const caps = initialized.result?.agentCapabilities ?? {};
    const params = { sessionId: first.sessionId, cwd: work, mcpServers: [echoServer] };
    const method = caps.loadSession ? 'session/load' : caps.sessionCapabilities?.resume ? 'session/resume' : undefined;
    if (!method) say('run2', 'agent advertises neither loadSession nor sessionCapabilities.resume');
    else {
      const restored = await conn.call(method, params, 120_000);
      const kinds = {};
      for (const u of conn.updates) kinds[u.sessionUpdate] = (kinds[u.sessionUpdate] ?? 0) + 1;
      say(`run2 ${method}`, { ok: !!restored.result, error: restored.error, replayedUpdates: conn.updates.length, kinds, replayMentionsPing42: JSON.stringify(conn.updates).includes('ping-42') });
      if (restored.result) say('turn C (after restart)', await turn(conn, first.sessionId, 'Which exact text did you pass to the echo tool earlier? Answer with that text only, do not call any tool.'));
    }
    say('run2 close', await conn.close());
  }
} else if (scenario === 'drop') {
  // Close the connection 3 s into a 20 s tool call: does the turn go on without a client, and what does a restart find?
  const { conn, sessionId } = await open('run1', process.env.ACP_META ? JSON.parse(process.env.ACP_META) : undefined);
  const toolStarted = new Promise((resolve) => { conn.onUpdate = (u) => { if (u.sessionUpdate === 'tool_call' && /echo/.test(JSON.stringify(u))) resolve(); }; });
  const prompt = conn.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Call the `echo` tool with text "slow-1" (it takes a while), then reply with what it returned.' }] }, 60_000);
  await Promise.race([toolStarted, new Promise((r) => setTimeout(r, 40_000))]);
  await new Promise((r) => setTimeout(r, 3000));
  say('dropped connection mid-turn', await conn.close(30_000));
  say('prompt request outcome', outcome(await prompt));
  await new Promise((r) => setTimeout(r, 22_000));
  const again = connect('run2');
  const caps = (await init(again)).result?.agentCapabilities ?? {};
  const method = caps.loadSession ? 'session/load' : 'session/resume';
  const restored = await again.call(method, { sessionId, cwd: work, mcpServers: [echoServer] }, 120_000);
  say(`run2 ${method}`, { ok: !!restored.result, error: restored.error, replayed: again.updates.map((u) => `${u.sessionUpdate}${u.status ? `:${u.status}` : ''} ${JSON.stringify(u.content ?? u.rawOutput ?? '').slice(0, 120)}`) });
  if (restored.result && !caps.loadSession) say('turn after restart', await turn(again, sessionId, 'Did the earlier echo call with "slow-1" return a result to you? Answer RESULT:<text> or NONE. Do not call any tool.'));
  say('run2 close', await again.close());
} else {
  const meta = process.env.ACP_META ? JSON.parse(process.env.ACP_META) : scenario === 'notools' ? spec.noTools : undefined;
  const { conn, sessionId } = await open('run1', meta);
  if (scenario === 'newonly') await new Promise((r) => setTimeout(r, 5000));
  else if (sessionId) say(`turn (${scenario})`, await turn(conn, sessionId, 'List the exact names of every tool you can call, one per line, nothing else. Do not call any tool.'));
  // ACP_MODE=<mode id>: switch the session to an asking mode, then make it call the tool, to see the permission request.
  if (sessionId && process.env.ACP_MODE) {
    const set = await conn.call('session/set_config_option', { sessionId, configId: 'mode', value: process.env.ACP_MODE }, 30_000);
    say('set mode', set.result ? { mode: set.result.configOptions?.find((o) => o.id === 'mode')?.currentValue } : outcome(set));
    say('turn (tool call under asking mode)', await turn(conn, sessionId, 'Call the `echo` tool with text "ping-43" and reply with what it returned.'));
    say('permission requests (raw)', conn.permissions);
  }
  say('close', await conn.close());
}
say('echo tool calls recorded by the MCP server', (await import('node:fs')).existsSync(echoLog) ? (await import('node:fs')).readFileSync(echoLog, 'utf8') : '(none)');
process.exit(0);
```

</details>

<details>
<summary>mcp-echo.mjs（36 行）</summary>

```js
// Minimal stdio MCP server with one tool, `echo`. Each call is appended to ECHO_LOG.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const send = (id, body) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }) + '\n');
const tool = {
  name: 'echo',
  description: 'Returns the given text prefixed with "echo:".',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
};

const note = (entry) => { if (process.env.ECHO_LOG) appendFileSync(process.env.ECHO_LOG, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry }) + '\n'); };
process.stdout.on('error', () => note({ phase: 'stdout-broken' }));

createInterface({ input: process.stdin }).on('close', () => note({ phase: 'stdin-closed' })).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') {
    send(m.id, { result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '0.0.1' } } });
  } else if (m.method === 'tools/list') {
    send(m.id, { result: { tools: [tool] } });
  } else if (m.method === 'tools/call') {
    const text = String(m.params?.arguments?.text ?? '');
    note({ text });
    // A text starting with "slow" takes 20 s, so a client can drop the connection while the tool runs.
    setTimeout(() => {
      note({ text, phase: 'replied' });
      send(m.id, { result: { content: [{ type: 'text', text: `echo:${text}` }] } });
    }, text.startsWith('slow') ? 20_000 : 0);
  } else if (m.method === 'ping') {
    send(m.id, { result: {} });
  } else {
    send(m.id, { error: { code: -32601, message: 'Method not found' } });
  }
});
```

</details>

<details>
<summary>dsh-notools.patch.yml</summary>

```yaml
# Spike only: switch off every built-in tool row of the acp profile for one launch.
- id: tool-plugin-manager
  disabled: true
- id: tool-working-directory
  disabled: true
- id: tool-bash
  disabled: true
- id: tool-pwsh
  disabled: true
- id: tool-jobs
  disabled: true
- id: tool-fs
  disabled: true
- id: tool-fs-search
  disabled: true
- id: tool-skill
  disabled: true
- id: tool-subagent-control
  disabled: true
- id: tool-subagent
  disabled: true
- id: tool-subagent-fork
  disabled: true
- id: tool-workflow
  disabled: true
- id: tool-todo
  disabled: true
- id: tool-goal
  disabled: true
- id: tool-web
  disabled: true
- id: mcp-resources
  disabled: true
```

</details>
