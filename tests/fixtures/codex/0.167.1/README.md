# codex-cli 0.167.1 的实录

2026-11-11 主人决定把控制器工作站上的 Codex 从 0.162.0 升到 0.167.1，升级前后在这台机器上录的。只录了不花额度的那些命令
（主人的 Codex 额度要到 11 月 15 日才恢复），契约测试是 `tests/adapter-codex-0.167.test.ts`。

| 目录 | 命令 | 结果 |
|---|---|---|
| `login-status/` | `codex --version`；`codex login status`（主人的登录 / 空的 `CODEX_HOME`） | `codex-cli 0.167.1`；退出码 0「Logged in using ChatGPT」/ 退出码 1「Not logged in」，原话在 stderr，和 0.162.0 一样 |
| `models/` | `codex debug models`，登录着 / 空的 `CODEX_HOME` | 登录后是厂商给这个账号的清单（有 `gpt-6.1-terra`）；没登录是这一版自带的清单。每个模型只留了 `slug`、`display_name`、`supported_reasoning_levels`、`default_reasoning_level`、`visibility`，删掉的是各模型自带的整篇指令模板 |
| `login-device/` | 空的 `CODEX_HOME` 里 `codex login --device-auth`，出码后结束 | 画面和 0.162.0 一样：固定网址、一次性用户码（换成了 `ABCD-12345`）、15 分钟有效 |
| `api-key/` | 空的 `CODEX_HOME`、假的 `CODEX_API_KEY`，`codex exec` 带上一轮会带的全部开关（`-c model=…`、`--sandbox workspace-write` 或 `read-only`、`--disable memories`、`--skip-git-repo-check`、`-C`） | 开关全部被接受（有 `thread.started`，没有用法错误）；OpenAI 答 401，退出码 1 |
| `readonly/` | `codex sandbox -c sandbox_mode=read-only -- codex --version`（机器上的只读探针） | 退出码 0。沙箱里那个 `codex` 答的是 0.162.0：沙箱里找命令是 Codex 自己的事，探针只看退出码 |
| `global-entry/` | `codex features list` 里的 `memories`；`--disable` 一个不存在的功能；空的 `CODEX_HOME` 里放 `AGENTS.md`（再放 `AGENTS.override.md`）后 `codex debug prompt-input` | `memories` 还在（stable）；不认识的功能整条命令退出码 1；全局入口读 `AGENTS.md`，旁边有非空的 `AGENTS.override.md` 时读它不读前者 |

做过手脚的地方：这台机器的主目录和临时目录路径换成了 `<主目录>`、`<临时目录>`；`cf-ray`、请求编号、线程编号换成了占位值；
用户码换成了 `ABCD-12345`。别的一个字没动。

没有录的：一轮真跑完的输出（要花额度）。0.162.0、0.163.0 的输出解析实录还在旁边的目录里，`codex exec --json` 的事件格式
这次没有重新录。
