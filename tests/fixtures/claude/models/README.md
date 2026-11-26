# 两份实录，两份构造

`recorded.json`、`help.recorded.txt` 是 2026-11-07 用真实账号录的。`models.json`、`help.txt` 是按字段形状写的，不是实录，用来钉住实录里没有的不整齐情况。

| 文件 | 是什么 | 从哪里来的形状 |
|---|---|---|
| `models.json` | `GET https://api.anthropic.com/v1/models?limit=100` 的一页回答 | API 公布的字段名：`data[]` 里每项有 `id`、`display_name`，`capabilities` 里每个能力是 `{ "supported": true/false }`，强度在 `capabilities.effort` 里按名字列出，取 `supported: true` 的那些 |
| `help.txt` | `claude --help` 的输出 | 适配器里已经记下的事实：`--effort` 的取值是 `low, medium, high, xhigh, max`（2.1.303 读到的）；`--model` 一行的措辞按 CLI 自己公布的说法写，它举的别名换成了 `<别名甲>` 这样的占位名——这份要验的是“两行说明里引号中的词就是别名”，不是具体哪个别名 |

三处故意写得不整齐，好在测试里把“能解析多少算多少”钉住：`<模型乙>` 的 `xhigh`、`max` 是
`supported: false`；`<模型丙>` 只有 `medium`、`high`，且 `batch`、`image_input` 都是 false；
`help.txt` 里 `--model` 的说明跨两行。模型名和强度名不在代码和文档里出现，只出现在实录里。
