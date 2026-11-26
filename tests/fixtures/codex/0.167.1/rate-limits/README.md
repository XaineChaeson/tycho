# 机器自己的登录：codex-cli 0.167.1 的 rate-limits 实录

`rate-limits.json`：2026-11-12 在控制机上，用**机器上已经登录好的那份 ChatGPT 登录**跑
`codex app-server --listen stdio://`，按行收发 JSON-RPC，把 `account/rateLimits/read` 的回答
（`result` 那一段）原样存下来。

怎么录的（`adapters/codex.ts` 的 `machineQuota`）：

1. 起 `codex app-server --listen stdio://`；
2. 写一行 `{"id":1,"method":"initialize","params":{"clientInfo":{"name":"tycho","title":"tycho","version":"…"}}}`；
3. 等 id 1 的回答（实测 2.2 秒）；
4. 写 `{"method":"initialized","params":{}}` 和 `{"id":2,"method":"account/rateLimits/read"}`；
5. 等 id 2 的回答（实测 3.7 秒），存下它的 `result`；
6. 关标准输入，结束进程树。

不跑推理、不耗额度。回答按这个形状读：优先 `rateLimitsByLimitId`（按桶），没有才用 `rateLimits`，
一个桶也不重复计；每个桶的 `primary`/`secondary`（可空）各是一个窗口，`used = usedPercent/100`，
`resetsAt` 是 Unix 秒，窗口名按 `windowDurationMins` 起并带上桶的名字。

做过手脚的地方：`accountId`（账号编号）已删除——身份信息不上报给主机；`rateLimitResetCredits` 里的
`credits` 本来就是空的。其余一个字节没动。

没有录的：`ordinaryUsageAllowed` 为 false 的回答、`credits.hasCredits` 为 true 的回答、以及
`secondary` 非空的回答（主人的这份套餐只有一个 10080 分钟的窗口）。契约测试只按这一份断言。
