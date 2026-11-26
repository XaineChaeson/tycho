# 协调者提供的样本，不是本仓库录制的

`quota.ndjson` 不是一次真实运行的完整输出。它由两行拼成：

1. 第十三步 brief 里给出的 `rate_limit_event` 样本，原样一行（外层是 `"type":"system","subtype":"rate_limit_event"`；本仓库录到的同类事件外层是 `"type":"rate_limit_event"`，见 `../2.1.309-win`、`../2.1.312-linux`）。
2. 一行结果：字段的形状取自 `../2.1.309-win/failure.ndjson` 录到的结果行，只把 brief 给出的三处换上去：`api_error_status: 429`、`api_error: "usage_limit_reached"`、`result` 的文字。

额度用完时 CLI 实际的退出码、stderr、以及那一刻 `rate_limit_event` 的 `status` 都没有录到；`quota.exit` 的 1 和空的 `quota.stderr` 是按连接失败那份实录假定的。录到真实输出后用它替换这一份。
