# 扩展与插件开发指南（IM · 触发器 · 额度探针 · 主题与技能）

Tycho 的核心设计原则是**「内核保持零依赖克制，通过标准协议开放一切扩展」**。无需 Fork 或修改 Tycho 主源码，你可以随时接入任何 IM 平台、外部事件系统、私有网关计费与自定义主题。

---

## 一、接入任意自定义 IM（双向签名入站 + 原话题回读协议）

除了开箱即用的**企业微信（长连接）**与**个人微信（iLink 扫码）**，任何支持收发消息的平台（飞书、Slack、Discord、Telegram、钉钉、Mattermost）都可以通过 Tycho 的开放 **`tycho-v1` 双向协议**在 10 分钟内接入（官方参考实现见 [integrations/feishu/README.md](../../integrations/feishu/README.md) 与 `scripts/feishu-bridge.ts`）。

### 核心工作原理（安全隔离 + 群聊快慢分流）
1. **快慢分流留在桥接侧**：普通群闲聊直接忽略；命中预设 FAQ 直接秒回；真正需要调查/改代码/跟进的消息才附带最近群上下文投递给 Tycho。
2. **零私有泄露**：桥接器只拥有单个 `tycho-v1` 入站来源的签名密钥，拿不到控制台会话、看不见内部轨迹与私有链接；只有项目总控显式调用 `reply_to_inbound_source` 发布的公开答复，才会被桥接器回读并回复到原话题。

### 1. 发送签名事件（`POST /inbound/<sourceId>`）

签名算法为 `HMAC-SHA256(secret, payload)` 的小写十六进制，其中待签正文为：

```text
v1\n<X-Tycho-Timestamp>\n<X-Tycho-Event-Id>\n<X-Tycho-Project>\n<原始请求体字节>
```

请求头：
- `X-Tycho-Event-Id`：幂等事件编号（重试同一事件返回原 `fire_id` 凭证，绝不重复建任务）
- `X-Tycho-Timestamp`：UTC Unix 秒（超出允许时间偏差自动拒收防重放）
- `X-Tycho-Project`：目标项目 ID（必须在控制台为该来源显式放行；若来源仅放行一个项目可省略）
- `X-Tycho-Signature`：计算得到的 HMAC-SHA256 十六进制字符串

响应示例（HTTP 202 / 200）：
```json
{ "fire_id": "01J9X...", "project_id": "01J0...", "outcome": "delivered" }
```

### 2. 回读总控发布的公开答复（`GET /inbound/<sourceId>/result/<fireId>`）

在控制台该来源开启 **「允许来源回读答复」** 后，桥接器按以下 5 段内容计算 `X-Tycho-Signature` 轮询结果：

```text
tycho-result-v1
GET
/inbound/<sourceId>/result/<fireId>
<X-Tycho-Timestamp>

```
（注意最后一行是空串。）读取到总控发布的公开回复正文后，桥接器使用原平台 `message_id / thread_ts` 直接回复到原话题。

---

## 二、接入任意外部事件源（GitHub / GitLab / 监控 / n8n）

在控制台 **「入站来源」** 创建来源，获取独立 URL（`POST /inbound/<sourceId>`）与可平滑轮换的密钥：

- **`github` 翻译器**：直接把 URL 与密钥填进 GitHub 仓库 Webhook 设置（`X-Hub-Signature-256` 自动验签），Tycho 自动按 `repository.full_name` 路由到绑定了该仓库的项目，自动丢弃臃肿原始载荷只保留摘要。
- **`tycho-v1` 通用翻译器**：任何 CI 流水线、Prometheus Alertmanager、Sentry 或 n8n 节点都可用 10 行脚本按上述 HMAC 协议唤醒项目总控，并可选将总控结论自动播报到绑定的 IM 群聊。

---

## 三、即插即用本机额度探针插件（Quota Probe Plugins）

如果你使用**自建私有 API 网关、团队内部额度代理或定制计费接口**，在对应执行节点放置一个可执行脚本即可让控制台与调度器原生展示你的余额和预算进度条，**密钥全程留在节点本地**：

- 默认目录：`~/.tycho/quota-probes/<executor>.mjs`（支持 `.mjs` / `.js` / `.sh` / `.cmd`，环境变量 `TYCHO_QUOTA_PROBES_DIR` 可覆盖）。
- 协议：从 `stdin` 读取内置探针结果 JSON，向 `stdout` 输出标准化窗口 JSON（`mode: "merge" | "replace"`）。

```js
// ~/.tycho/quota-probes/dsh.mjs
const res = await fetch('https://gateway.internal.example/api/quota', {
  headers: { Authorization: `Bearer ${process.env.MY_GATEWAY_TOKEN}` },
});
const { remainingUsd, limitUsd, usedUsd } = await res.json();

console.log(JSON.stringify({
  mode: 'merge',
  windows: [{
    window: `gateway_budget:corp:$${remainingUsd.toFixed(2)}/$${limitUsd.toFixed(0)}`,
    used: Math.min(1, Math.max(0, usedUsd / limitUsd)),
    resets_at: null,
  }],
}));
```

完整命名约定与示例见 **[本机额度查询插件规范](../quota-plugins.md)**。

---

## 四、热插拔主题皮肤包与跨机技能包

### 1. Drop-In JSON 主题包（`<TYCHO_DATA>/themes/*.json`）
Tycho 内置 6 套高质感视觉皮肤（测控星盘 HUD、Linear、Tactile、浮光玻璃、工业合成器、暖纸书房、量化暗房、瑞士黑白）。把符合规范的自定义 JSON 主题文件放入主机 `<TYCHO_DATA>/themes/<slug>.json`，**无需重启服务**，Web 控制台、桌面端与手机 PWA 即刻同步可选。

### 2. 标准 `SKILL.md` 技能包自动全网同步
在主机 `<TYCHO_DATA>/skills/<技能名>/SKILL.md`（可带 `scripts/`、`references/`）维护一份正本，控制台勾选授权节点后，Tycho 自动通过加密节点通道增量镜像到所有授权机器的各执行器技能目录（`~/.claude/skills`、`~/.codex/skills`、`~/.gemini/config/skills`、`~/.agents/skills`）。详见 [知识库、技能分发与 MCP](knowledge-and-skills.md)。
