# Tycho 文档中心

- 想在自己电脑 90 秒跑通 → [5 分钟快速上手](guide/quickstart.md)
- 想部署在公网云服务器 24×7 串联多台电脑与手机 → [部署拓扑与公网云服务器](guide/remote-access.md)

## 使用指南

| 文档 | 内容 |
| --- | --- |
| [5 分钟快速上手](guide/quickstart.md) | 安装、登录控制台、接入本机节点到跑通首条任务 |
| [部署拓扑与公网云服务器](guide/remote-access.md) | 公网 VPS + Nginx HTTPS、Tailscale、NAT 反向隧道（含 WSS `:443`） |
| [核心架构与安全边界](guide/architecture.md) | SQLite 账本、项目总控、主动外连节点与真实信任边界 |
| [账号池、档位与执行机器](guide/accounts-and-nodes.md) | 集中托管 vs 单机登录、固定三档、额度自动切号与多机 CLI 升级 |
| [扩展与插件开发指南](guide/extensibility.md) | 自定义 IM 双向签名协议、HMAC Webhook、额度探针插件与主题包 |
| [IM 通道与事件触发器](guide/channels-and-triggers.md) | 企微、个人微信、飞书、Cron、内部生命周期事件与播报群 |
| [知识库、技能分发与 MCP](guide/knowledge-and-skills.md) | 账本知识、多节点 `SKILL.md` 自动镜像与外部 Knowledge MCP |
| [多端客户端与手机 PWA](clients.md) | 3.6 MB Win/macOS/Linux 桌面薄壳与 iOS/Android 全屏 PWA |
| [生产运维手册](guide/operations.md) | 开机自启、自动备份与恢复、安全升级回退、双实例隔离 |

## 精确参考（源码自动生成）

| 文档 | 说明 |
| --- | --- |
| [CLI 命令参考](reference/cli.md) | 自动提取自 `cli/main.ts` 与 `node/cli.ts` |
| [全量配置项参考](reference/settings.md) | 自动提取自 `service/settings.ts` |
| [故障排查手册](reference/troubleshooting.md) | 按阶段分类的排错表与 `tycho doctor` |
| [本机额度探针插件规范](quota-plugins.md) | `~/.tycho/quota-probes/` 协议与样例 |
| [执行器自动升级器](executor-updaters.md) | 多机空闲升级原生 CLI 的机制 |

## 贡献与档案

- [贡献指南](../CONTRIBUTING.md) · [安全政策](../SECURITY.md) · [变更日志](../CHANGELOG.md)
- [维护者架构设计档案 (`docs/design/`)](design/terminal-architecture.md)
