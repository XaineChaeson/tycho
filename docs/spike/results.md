# 开工前实测结果（2026-11-04）

对应 [phase1-design.md](../design/phase1-design.md) §12。每项写结论、证据位置和对设计的影响。这是开工前那一次实测的记录，表里“未测”的项后来多半测过了：之后的实测在 [nodes.md](../design/nodes.md) §12、[readonly.md](readonly.md)、[global-entry.md](global-entry.md) 和 `tests/fixtures/` 的实录里。

| 实测 | 结论 | 证据 |
|---|---|---|
| 远端启动协议：一次性标记、`setsid` 后 SSH 断开存活、`exit` 原子落盘、六种判定状态可观察 | 通过，但原文启动行有两处必改 | [cluster-spike-report.md](cluster-spike-report.md)、`tests/fixtures/launch-protocol/` |
| 远端进程树清理 | Codex 收到 SIGINT 后 1 秒内整组退出，无残留；原文 `setsid bash -c … &` 会让 wrapper 忽略 SIGINT | 同上 |
| Codex `exec --json` 实录：正常、续接、中断、失败 | 已录 8 个用例；续接不能带 `--profile`；无 delta 事件；中断后无结束事件；provider 不可达时无限重连 | `tests/fixtures/codex/0.163.0/` |
| Claude `-p` 实录：正常、续接、失败 | 已录 3 个用例；API 不可达时重试 10 次约 186 秒后 `is_error: true`，`subtype` 仍为 `success`，退出码 1 | `tests/fixtures/claude/2.1.309-win/` |
| Windows 总控进程查找与整树清理 | 通过：`--session-id` 作命令行标记可查到，`taskkill /T /F` 连同 MCP 子进程一起清掉 | `local/win-tree-kill.ps1` |
| 远程设备经私网覆盖网络（EasyTier）的 HTTP 登录与 SSE | 通过：另一台 Windows 打开一次性链接、POST 兑换、不带 `Secure` 的 Cookie 生效、SSE 每秒推送正常；手机入网后也能到达服务。部署时需确认防火墙对虚拟网卡和 `node.exe` 的放行规则。已知冲突：代理类 VPN 与覆盖网络在 Android 上互斥；Windows 上若开启 TUN 模式需排除覆盖网段（如 `10.0.0.0/24`），系统代理模式下将其加入 `NO_PROXY` | — |
| 任务计划未登录启动、休眠唤醒 | 未测，需要用户账户配置 | — |
| 企微长连接收发、按钮回调、断线补发 | 未测，需要先建机器人 | — |
| Claude Worker 在 Linux 上的中断实录 | 未测，集群 Claude 账号周额度耗尽至 11-07 | — |

## 对设计的修改（已回写 phase1-design.md）

1. 启动行固定为 `setsid env --default-signal bash -c '…' </dev/null >wrapper.log 2>&1 &`：不加 `env --default-signal` 时后台 bash 继承 `SIG_IGN`，SIGINT 对整组无效；不重定向时 ssh 命令要等 Worker 结束才返回。
2. 启动脚本在 `mkdir started` 后先写 `started/launcher.pid`，再启动 Worker、写 `started/pid`，用于区分“启动中”和“启动脚本已死”。
3. 判定表：停止后 `exit` 文件可能不存在（Worker 被信号直接杀死时 wrapper 不写），`stopping` 路径不以 `exit` 为准，以进程不在为准。
4. Codex 第一阶段不用原生续接：`codex exec resume` 不接受 `--profile`，档位和沙箱无法指定；续做一律新开会话，brief 带账本摘要。Claude 保留 `--resume`。
5. 每次 Run 有墙钟上限（默认 3 小时，brief 可改），超时按中断处理，Task `held` 原因“超时”：Codex 在 provider 不可达时会无限重连，不会自己退出。
6. 活性只看进程：Codex `--json` 一轮内没有增量事件，Claude 重试期间只有 `api_retry` 事件；任务页对 Codex 的进度只到 item 级。
7. 失败判定：Claude 看 `is_error` 和退出码，不看 `subtype`；Codex 的错误有 `item.completed` 内 `type: "error"` 和顶层 `{"type":"error"}` 两种形态，都要解析。
8. 远端探测命令放在脚本里执行，不经 ssh 命令行直接 `pgrep -f`：命令行会匹配 ssh 自己的 `bash -lc`。
