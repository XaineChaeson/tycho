# Codex 可写任务使用原生 Auto-review

读者是维护适配器和部署节点的人。可写 Worker 使用 `codex exec --approve-for-me`；只读 Worker 保持 `--sandbox read-only -c approval_policy="never"`。Tycho 不实现审批代理，不以关闭沙箱解决 Git 提交失败。

## 为什么改

家庭 Ubuntu 的真实 Tycho 开发任务可以写源码，却不能写 `.git/index.lock`，最后 failed，任务 held。旧适配器只传 `--sandbox workspace-write`，非交互回合没有可完成 Git 提交的原生审批路径。该失败轮没有提交或通过审阅，仍保留失败事实。

采用 Codex 已有的无头 Auto-review 预设，免去 Tycho 自建审批桥与权限 profile。它以 workspace-write 为基线，由原生审批处理符合条件的额外动作。它不是仅开放 `.git` 的硬隔离保证。用户、组织管理策略、原生命令规则仍由 Codex 执行；拒绝或无法启动时报告原错误，不降级到更宽权限。

## 适配器边界

- 可写轮只传 `--approve-for-me`，不同时传旧 `--sandbox` 或另一审批策略。
- 本轮交付目录使用 `--add-dir` 的一个原始 argv 路径，增加到原生可写目录，不覆盖机器配置中的目录。节点在已有协议边界替换 `{tycho-artifacts}`；空格和引号不经过 shell 或 TOML 编码。
- 只读轮不给交付目录写权，也不启用 Auto-review。已有只读探针、派发判定与代码事后核对继续负责各自的事实。
- 档位不承担权限配置。适配器拒收已知沙箱和审批键，包括较新的 `default_permissions`、`permissions`、`approvals_reviewer`，支持 quoted/dotted/inline table 形式；不把该提示当成新的配置安全解析器。
- 旧 Codex 若在启动解析阶段明确拒绝 `--approve-for-me`，保留 stderr 并提示升级或选择其他登录。不设影响只读和总控路径的全局最低版本，也不另造节点能力协议。实际可写能力以本机执行结果为准。

Router 的 app-server 通道不在本次变更范围。数据 schema、节点协议、模型、身份、MCP、记忆和用户原生配置均不因该适配器变化而迁移。依赖安装、网络和远端发布是否可用仍由现场环境与原生审批决定。

## 已有证据与发布门

截至 2026-11-16，正式办公、家庭服务及实际节点仍为 0.1.765；0.1.779 私有候选已完成回归和审阅，经 [PR #27](https://github.com/XaineChaeson/tycho/pull/27) 合入 main，尚未正式推广。家庭原生开发链路已有真实成功证据，Windows 可写 Worker 仍未通过，不能把适配器合入写成全部原生环境可用。

2026-11-15 的家庭 Ubuntu Codex 0.169.0 独占仓库探针使用此原生预设完成提交：源码和交付目录可写，`.git` 仍列为受保护路径，network_access 为 false；两项 Git 工具请求都明确请求原生审批，最终工作区干净。公开输出未提供内部审批理由，不能据此声称完整展示了审查决策。随后，正常 Tycho 作者任务 `01M7FPKJCBMXZG2CEN5AQ6Y7C6` 修订 2 的 Run `01M7FSP5ZM5Z3W7RSVZQGKAR4N` 实际产生提交 `ee0d8dad8742648874ffb1539ae2aae5f6775415`，只读审阅在同一 Codex 执行器的新会话中通过。此前 failed 轮次和恢复过程仍保留，后续成功不覆盖失败事实。

Windows Codex 0.167.1 的额外可写 Worker 验证中，手工启动和计划任务启动两轮均 failed，任务 held；计划任务一轮不再出现先前的 Core 上下文错误，但 setup helper 仍退出 1。原生 profiles 和 sandbox 未改，不能把 npm 升级到 0.169 写成已证实的修复。Windows node-role 新后缀计划任务的注册和正常停启已实测，尚未注销重登录；macOS 真机按主人决定下次补验。

正式推广前仍须核对冻结源码、后端回归、独立复审，以及正常 Tycho Worker 的实际开发提交和只读审阅证据；原生执行结果只证明实际验证过的节点组合。正式服务升级走既有安装包 updater，升级前核对空闲、归属和快照，回退程序保留当前账本，不把旧库还原当作回退。此改动没有新增数据迁移，回到 765 会恢复旧可写策略及其限制；原生拒绝或启动失败仍报告原错误，不降级权限。

原生接口依据：[无头运行](https://learn.chatgpt.com/docs/non-interactive-mode)、[Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review)、[保护路径与审批](https://learn.chatgpt.com/docs/agent-approvals-security)。
