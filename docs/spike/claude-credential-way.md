# 账号令牌怎么交给一轮：环境变量，不是文件描述符（实测）

读者：改适配器、机器客户端或派发实现的人。问题：一条按账号派的 Claude 轮次，令牌要怎么交到进程手上才会真的被采用，
以及别的执行器各能怎么核实“交过去的令牌会被采用”。结论决定了 `Adapter.credential` 只剩启动环境一种交法，
和机器上报结果里的 `credential`（`Adapter.credentialCheck`）。实录在
[tests/fixtures/claude/2.1.303-win/auth-status](../../tests/fixtures/claude/2.1.303-win/auth-status/README.md)；
契约测试是 `tests/adapter-claude.test.ts` 和 `tests/node-credential-probe.test.ts`。

## 结论

| 交法 | Windows，claude.exe 2.1.303 | 结果 |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3`，令牌写进子进程的 stdio[3] 管道 | `claude auth status` 答的和不给令牌时一模一样：机器上有登录就是 `authMethod: "claude.ai"`，没有就是 `none` | 不被读。按账号派的一轮会悄悄用机器自己的登录跑，身份错了没人知道 |
| `CLAUDE_CODE_OAUTH_TOKEN=<令牌>` | `authMethod: "oauth_token"`；机器自己也有登录时仍是 `oauth_token` | 被采用，而且压过机器自己的登录 |

Linux 上两种都能跑一轮（2026-11-06 实测，见 [../design/accounts-and-machines.md](../design/accounts-and-machines.md)），
但文件描述符在 Windows 上不成立，所以从 2026-11-11 起只有环境变量这一种交法。代价是 Worker 起的子进程会继承这个变量，
同机同用户也能读到：机器是边界。节点协议不升版本，`NodeStart.credential` 里保留 `via` 字段并只发 `'env'`，
让第 5 版的老客户端照旧读得懂；客户端收到 `via: 'fd'` 时明确拒绝，说“把主机升级到同一版”。

**Claude 能问。** `claude auth status` 不联网、不写东西、不耗额度，只说它这一轮会用的登录。机器在上报执行器时，
用一段占位值（`tycho-credential-probe`，不是真令牌）设好 `CLAUDE_CODE_OAUTH_TOKEN` 跑一次：
`authMethod === 'oauth_token'` 才算交过去的令牌会被采用；机器自己的 `claude.ai`、`none`、或者读不出 JSON，都算不会被采用。
退出码不是 0 也照样交给适配器判——什么都没登录时它就是 1，而它的 JSON 仍然说得清用的是 `none`。

**Codex 不能问。** `CODEX_API_KEY` 确实压过机器自己的 ChatGPT 登录
（[tests/fixtures/codex/0.162.0/api-key](../../tests/fixtures/codex/0.162.0/api-key/README.md)：带假密钥的两轮都发到了 OpenAI、
以 401 结束，其中一轮的机器上有可用的 ChatGPT 登录）。但 `codex login status` 不看这个变量：0.167.1 实测，
空的 `CODEX_HOME` 加上 `CODEX_API_KEY`，它仍然答 Not logged in。所以没有不耗额度的“会不会采用”的问法，
适配器不声明 `credentialCheck`，这份实录就是全部依据。

**dsh 也不能问。** 没有问登录状态的命令；账号的线路补丁把存凭据的服务关掉，唯一来源就是启动环境。
适配器同样不声明 `credentialCheck`，依据写在那份声明的注释里。

因此主机对账号的活按报告挑机器：声明了问法的执行器（现在只有 Claude），报了“不会被采用”的机器不接；
报告里没有这一项（旧客户端）算还没报告，等它下次上报，不据此停下任务；还有机器没报告就只是等；
所有能用的机器都说不会采用时任务停下，理由“没有能用账号登录跑 <执行器> 的机器：……”。
机器自己的登录不交令牌，不受这一项影响。

## 怎么测的

在控制机上（Windows 11，原生安装的 claude.exe 2.1.303），用一段假令牌（`tycho-probe-not-a-token`）录了四份
`claude auth status`；`auth status` 不联网、不耗额度。邮箱、组织编号和用户目录换成了占位值，其余原样：

| 文件 | 环境 | `authMethod` | 退出码 |
|---|---|---|---|
| `env-token` | `CLAUDE_CONFIG_DIR` 指向一个没登录的空目录，`CLAUDE_CODE_OAUTH_TOKEN=<假令牌>` | `oauth_token` | 0 |
| `env-token-beside-machine-login` | 这台机器真实的 `~/.claude`（里面有一份 claude.ai 登录），`CLAUDE_CODE_OAUTH_TOKEN=<假令牌>` | `oauth_token` | 0 |
| `none` | 空目录，不给令牌 | `none` | 1 |
| `machine-login` | 真实的 `~/.claude`，不给令牌 | `claude.ai` | 0 |

对照（没有留文件，结果和上表逐字相同）：设 `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3`、在子进程的 stdio[3]
管道写入同一个假令牌加换行再关掉——空目录下答的和 `none` 一样，真实目录下答的和 `machine-login` 一样。
也就是说这一版在 Windows 上不从文件描述符读令牌，按账号派发的一轮会悄悄用机器自己的登录跑。

`authMethod` 是 Claude Code 自己说“这一轮用哪份登录”的字段：交过去的令牌被采用时是 `oauth_token`，
别的值（`claude.ai`、`none` 等）都说明没被采用。假令牌一样答 `oauth_token`：它说的是“用哪份”，不是“这份有没有效”。

## 这项核对不保证什么

探针用的是机器的查找环境：POSIX 上是登录 shell 的 PATH（`node/lookup-env.ts`），Worker 继承的却是
客户端的进程环境。两边找命令用的是同一份查找环境、找到的是同一个程序，不同的只可能是继承到的环境变量（比如只在一边有的 `ANTHROPIC_API_KEY`）。

探针也不带这一轮的档位设置文件。档位或机器设置里的 `apiKeyHelper`、`env` 之类可能盖过交过去的令牌；
这些是机器自己的配置，tycho 不管。它只回答“用现在这个环境问，CLI 会说它用哪份登录”。

Windows 上探针和 Worker 继承的是同一个进程环境，两边没有这一层差别。
