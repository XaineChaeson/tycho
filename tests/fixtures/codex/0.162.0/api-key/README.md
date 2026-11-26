# Codex 用 API 密钥跑一轮：codex-cli 0.162.0 的实录

2026-11-11 在控制器工作站上录的。密钥是一段假值（`sk-fake-not-a-key-000`），所以两轮都以 401 结束、没有花额度；
`cf-ray`、请求编号和线程编号换成了占位值，其余原样。

```
CODEX_API_KEY=<假密钥> codex exec --json --skip-git-repo-check --sandbox read-only --disable memories "say ok"
```

| 文件 | 那一轮 |
|---|---|
| `wrong-key` | `CODEX_HOME` 指到一个没有登录的空目录。请求带着环境里的密钥发出去，OpenAI 答 `Incorrect API key provided`（它自己把密钥中段打了星号），重试 5 次后 `turn.failed`，退出码 1 |
| `wrong-key-beside-chatgpt-login` | 这台机器真实的 `~/.codex`，里面有一份可用的 ChatGPT 登录。结果和上一份一样：环境里的密钥压过了机器自己的登录 |

适配器的声明依据这两件事：`codex exec` 从启动环境的 `CODEX_API_KEY` 取密钥；这个变量在时，机器自己的登录不参与。
所以一个 Codex API 密钥账号的一轮，在装了 Codex 的任何机器上都以这个账号的身份跑，不管那台机器自己登录了谁。

对照（没有留文件）：同一个空目录、不给变量，答的是 `Missing bearer or basic authentication in header`；
给 `CODEX_ACCESS_TOKEN` 一段假值，答的也是这一句——0.162.0 对假的访问令牌和没给一样，访问令牌这条路没有可用的实测，所以没有做。
