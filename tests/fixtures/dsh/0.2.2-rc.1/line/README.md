# 账号的线路：dsh 0.2.2-rc.1 的实录

2026-11-11 在控制器工作站上录的。`DSH_HOME` 指到一个空的临时目录（不是真机的 `~/.dsh`），自定义线路的模型服务是本机起的
一个替身网关（只记下每个请求带了什么、回一段固定的流式回答），密钥都是假值，没有花任何额度。

```
<线路的密钥变量>=<假密钥> dsh --profile headless --patch tier.patch.yml --patch line.patch.yml \
    --json --permission-mode read-only --approval-policy never "say ok"
```

线路在档位之后：dsh 按顺序叠 `--patch`，同一条目以最后一次为准、`config` 整块替换，所以档位改不动线路和三个凭据服务。

| 文件 | 是什么 |
|---|---|
| `custom.line.patch.yml` | `adapters/dsh-provider.ts` 给一条自定义线路生成的 patch，原样（契约测试拿它和 `config()` 的输出逐字比） |
| `custom.tier.patch.yml` | 同一轮用的档位 |
| `custom.run.ndjson` | 上面两份加 `TYCHO_DSH_API_KEY` 跑出来的 stdout：一轮完成，退出码 0（会话编号换成了全零） |
| `custom.request.json` | 替身网关收到的请求：密钥走 `Authorization: Bearer`（密钥换成了 `<the key>`） |
| `official.line.patch.yml` | 官方线路生成的 patch：关掉存凭据的三个服务，钉住官方路由的密钥变量和地址 |
| `official.tier.patch.yml` | 官方线路那一轮用的档位 |
| `official-endpoint.run.ndjson` | 官方线路加一把假的 `DEEPSEEK_API_KEY`，同时把 `DEEPSEEK_BASE_URL` 指到本机另一个替身网关：请求仍然到了 DeepSeek 自己的接口（它答 `AUTH`，401），本机那个网关一个请求都没收到。说明 patch 里写明的地址压过机器环境里的变量 |
| `official.request.json` | 早一版（地址没钉住时）把官方路由的 `baseURL` 临时指到替身网关录的请求：密钥走 `x-api-key`，打到 `/v1/messages` |
| `missing-key.run.ndjson` | 自定义线路不给密钥变量：`MISSING_CREDENTIAL`，退出码 1 |

实测到的事，适配器的声明依据它们：

- headless 档默认关着 `credentials`、`authorization`、`deepseek-account` 三个服务；这时线路的密钥直接取启动环境里的变量。
- 自定义线路（`llm-pi-ai` 的手写路由）读它 `apiKeyEnv` 指的变量；官方线路读 `DEEPSEEK_API_KEY`。
- 这一轮的 stdout、stderr 和 `DSH_HOME` 里都搜不到密钥。
- 一份写了 `- id: credentials` / `disabled: false` 的档位放在线路前面，这一轮照样用启动环境里的密钥跑完（这台机器没有存着的密钥，所以只说明线路层生效、没有报错，没有直接看到“存着的密钥被挡住”）。

没有录的：一把真的 DeepSeek 密钥跑完一轮、`anthropic-messages` 和 `openai-responses` 两种协议的自定义线路、
机器上真存着一把别的密钥时它确实被挡住。
