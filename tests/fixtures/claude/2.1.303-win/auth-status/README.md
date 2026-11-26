# `claude auth status`：令牌交没交进去，Claude Code 自己怎么说

2026-11-11 在控制机（Windows 11，claude.exe 2.1.303，原生安装）上录。令牌是一段假值（`tycho-probe-not-a-token`），
`auth status` 不联网、不耗额度；邮箱、组织编号、用户目录换成了占位值，其余原样。`.exit` 是退出码。

| 文件 | 环境 | `authMethod` |
|---|---|---|
| `env-token` | `CLAUDE_CONFIG_DIR` 指到一个没登录的空目录，`CLAUDE_CODE_OAUTH_TOKEN=<假令牌>` | `oauth_token` |
| `env-token-beside-machine-login` | 这台机器真实的 `~/.claude`（里面有一份 claude.ai 登录），`CLAUDE_CODE_OAUTH_TOKEN=<假令牌>` | `oauth_token`：变量压过机器自己的登录 |
| `none` | 空目录，不给令牌 | `none`，退出码 1 |
| `machine-login` | 真实的 `~/.claude`，不给令牌 | `claude.ai` |

对照（没有留文件，结果和上表逐字相同）：设 `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3`、在子进程的 stdio[3]
管道写入同一个假令牌加换行再关掉——空目录下答的和 `none` 一样，真实目录下答的和 `machine-login` 一样。
也就是说这一版在 Windows 上不从文件描述符读令牌，按账号派发的一轮会悄悄用机器自己的登录跑。

`authMethod` 是 Claude Code 自己说“这一次用哪份登录”的那个字段：交过去的令牌被采用时是 `oauth_token`，
别的值（`claude.ai`、`none` 等）都说明没被采用。假令牌一样答 `oauth_token`：它说的是“用哪份”，不是“这份有效”。
