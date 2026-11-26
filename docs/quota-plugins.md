# 本机额度查询插件（Quota Probe Plugins）

Tycho 内置了对常见公开协议的额度/余额探针（Claude OAuth、Codex app-server、Gemini `agy /usage`、DeepSeek 官方余额、以及标准 OpenAI / One-API / New-API 账单接口）。

如果你的团队或个人使用**自建私有网关、定制鉴权或内部计费系统**，无需修改 Tycho 源码，只需在对应机器本地放置一个轻量插件脚本即可接入。密钥与查询全程留在机器本地，只有标准化的额度窗口摘要上报给主机。

## 放置位置与命名

默认目录：`~/.tycho/quota-probes/`（可通过环境变量 `TYCHO_QUOTA_PROBES_DIR` 自定义）。

按执行器名称放置可执行文件（按以下顺序匹配第一个命中的文件）：

- Node.js ESM/CJS（跨平台推荐）：`<executor>.mjs` 或 `<executor>.js`（由 Tycho 自带 Node 运行）
- Windows 脚本：`<executor>.cmd` 或 `<executor>.bat`
- macOS / Linux 脚本：`<executor>.sh` 或无后缀可执行文件 `<executor>`

例如为 `dsh` 增加私有网关余额查询，放置 `~/.tycho/quota-probes/dsh.mjs`。

## 输入与输出协议

- **环境变量**：`TYCHO_EXECUTOR=<executor>`
- **标准输入（stdin）**：一段 JSON，包含内置探针刚读到的结果（可用于增量合并）：
  ```json
  {
    "executor": "dsh",
    "builtin": {
      "windows": [{ "window": "balance:CNY:39.84", "used": 0, "resets_at": null }]
    }
  }
  ```
- **标准输出（stdout）**：返回一段 JSON：
  ```json
  {
    "mode": "merge",
    "windows": [
      { "window": "gateway_budget:corp_gw:$180.00/$200", "used": 0.1, "resets_at": null }
    ]
  }
  ```
  - `mode`：`"merge"`（默认，与内置探针窗口合并）或 `"replace"`（完全替代内置结果）。
  - 常用 `window` 命名约定（控制台会自动美化展示）：
    - 百分比窗口：`five_hour`、`seven_day`（`used` 取 `0`～`1`）
    - 账户余额：`balance:<币种>:<金额>`（如 `balance:CNY:39.84`，`used: 0`）
    - 网关预算：`gateway_budget:<名称>:$<剩余>/$<总额>`（`used` 取已用比例）
    - 无限额网关：`gateway_unlimited:<名称>:$<近30天已用>`（`used: 0`）
  - 如查询出错可返回：`{ "problem": "可读的错误说明" }`

## 示例：`~/.tycho/quota-probes/dsh.mjs`

```js
// 读取自定义内部网关余额并与内置 DeepSeek 官方余额合并
const res = await fetch('https://gateway.internal.example/api/my-quota', {
  headers: { Authorization: `Bearer ${process.env.MY_GATEWAY_TOKEN}` },
});
const data = await res.json();

console.log(JSON.stringify({
  mode: 'merge',
  windows: [
    {
      window: `gateway_budget:corp:$${data.remainingUsd.toFixed(2)}/$${data.limitUsd.toFixed(0)}`,
      used: Math.min(1, Math.max(0, data.usedUsd / data.limitUsd)),
      resets_at: null,
    },
  ],
}));
```
