# 机器自己的登录：Claude Code 2.1.303 的 `/usage` 实录

`usage.txt`：2026-11-12 在控制机上，用**机器上已经登录好的那份订阅登录**跑
`claude -p "/usage" --output-format json`，取结果 JSON 的 `result` 文本原样存下来。

怎么读这一份（`adapters/claude.ts` 的 `machineQuota`）：

- 这一条命令不跑推理：`num_turns` 是 0、`total_cost_usd` 是 0，不花额度；但本机实测 55 秒，
  大部分时间在数这台机器上自己的会话，所以机器上的客户端把这一读放在报告旁边，给 120 秒。
- 只有 `result` 里的窗口行被读：`<窗口名>: <数>% used · resets <时刻> (<时区>)`。窗口名原样作窗口名。
- 重置时刻按行里给的时区解析（这里是 `Asia/Shanghai`，+08:00，没有夏令时），年份取"下一个这样的
  日期"；没有时区、或那一版换了写法，就只记百分比、重置时刻记未知。
- `--output-format json` 的信封是 `{"type":"result","subtype":"success","result":"…","num_turns":0,…}`，
  契约测试按这个信封把 `usage.txt` 包进去；`result` 以外的东西没人读。

做过手脚的地方：这份文本里本来还有本机自己的会话统计（`What's contributing to your limits usage?`
下面那一串），和额度无关，已删除；文件的其余部分一个字没动。百分比和重置时刻是主人这台机器当时的
真实读数（78%、9%）。

没有录的：没有登录、或登录是 `setup-token` 令牌时的输出（那种令牌读 `/usage` 只出标题、没有任何窗口行，
`machineQuota` 报"没读到额度窗口"；tycho 保管的 Claude 账号不走这一条，见 `docs/design/usage.md` §3）。
