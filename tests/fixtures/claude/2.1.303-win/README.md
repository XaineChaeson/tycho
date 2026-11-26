# Claude Code 2.1.303 的实录

`quota-read.ndjson`：主机上读额度的那一轮（`claude -p --output-format stream-json --verbose --tools "" --strict-mcp-config --max-turns 1 "只回复数字 1"`，2026-11-11 在控制机上录），只留了 `rate_limit_event` 和结果行。

这一版的结果行没有 `model_usage_since_last_result`，只有累计的 `modelUsage` 和这一回合主线程的 `usage`：适配器取后者，模型只在 `modelUsage` 只有一个模型时取它的名字，不带标价（累计数在续接时含着之前几轮）。
