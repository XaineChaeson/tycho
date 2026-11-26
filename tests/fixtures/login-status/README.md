# 执行器自己的「是哪一版、登录了没有」

2026-11-06 在这台 Windows 工作站上录的（nodes.md §12「执行器登录查询的原话与退出码」那一行）。
用途：节点客户端问机器上的执行器这两件事时，**按退出码判断**、**只读版本那一行**，这份实录钉住
「问的是哪条命令」和「命令行输出在 stdout 还是 stderr、退出码是多少」这两件事。

```
claude --version              2.1.303 (Claude Code)                        stdout，退出码 0
claude auth status            一 JSON，loggedIn 为 true                     stdout，退出码 0
claude auth status            一 JSON，loggedIn 为 false（空配置目录）      stdout，退出码 1
codex --version               codex-cli 0.162.0                            stdout，退出码 0
codex login status            空 stdout，「Logged in using ChatGPT」在 stderr，退出码 0
codex login status            空 stdout，「Not logged in」在 stderr，退出码 1
```

| 目录 | 执行器 | 怎么来的 |
|---|---|---|
| `claude-2.1.303-win/` | `claude.exe`（`~/.local/bin`，2026-11-06 报 2.1.303） | 真命令行；登录态是这台机器上主人自己的登录 |
| `codex-0.162.0-win/` | `codex.cmd`（npm 装的 0.162.0） | 同上 |

文件：`version.stdout.txt`/`version.exit` 是版本那一条；`logged-in.*`、`logged-out.*` 是登录那一条的
`stdout.txt`、`stderr.txt`、`exit`。缺哪个文件就是那一条没有输出。

## 实录里做过手脚的地方

- 邮箱、组织标识、组织名、主目录和临时目录的路径都换成了 `<邮箱>`、`<组织标识>`、`<主目录>`、
  `<配置目录>`：这份文件进仓库，不能带主人的身份和机器上的路径。除此之外一个字没动。
- `codex ...` 的 stderr 里那两条 `WARNING: ...` 是这台机器上的受限沙箱拒绝建临时目录留下的，
  真实机器上不会有；路径照样抹成了 `<临时目录>`。**它们不影响结论**：判定不读这些字。
- `codex login status` 的「登录/没登录」原话在 **stderr**，stdout 是空的。这条是实录里最要紧的
  一条：谁要是去读 stdout 找那几句话，在这台机器上永远读不到。
- 没登录那一份是**用空的配置目录**得到的（`CLAUDE_CONFIG_DIR=<空目录>`、`CODEX_HOME=<空目录>`），
  没有动这台机器上主人自己的登录。它证明的是「没有登录时这条命令说什么、退出码是多少」。

## 没有录到的（照实说）

| 要录的 | 情况 |
|---|---|
| 令牌过期 | 没有录：造这个状态要改主人自己的登录，没做。按退出码判断时它和「没登录」落在同一个答案上。 |
| 命令不支持（不认 `auth status` 的旧 CLI） | 没有录：手上没有旧版本。设计上按「没有登录」显示（phase1-design §8）。 |
| macOS 上的这两条命令 | 没有录：macOS 这一步还没做过真机验收。 |
