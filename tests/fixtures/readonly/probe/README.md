# 只读探针的实录

机器的客户端上报执行器时，按适配器声明的只读方式问一次（`node/executors.ts`）。这些问题都不写文件、不耗模型额度。
这里录的是这些问题在真机器上的原话，契约测试（`tests/readonly-adapters.test.ts`）对着它们判“只读可用 / 不可用”。

2026-11-09 在这台 Windows 工作站上录：

| 文件 | 命令 | 退出码 |
|---|---|---|
| `codex-0.162.0-win.sandbox.*` | `codex sandbox -c sandbox_mode=read-only -- codex --version` | 0 |
| `dsh-0.2.2-rc.1-win.version.stdout.txt` | `dsh --version`（本机直接起 `D:\software\dsh` 里的程序，和 `dsh.cmd` 一样），给最低版本的判断用 | 0 |

Codex 的 stderr 那行 `WARNING: … Could not find home directory` 是沙箱里的受限令牌找不到主目录留下的，命令照样跑完，判定不读它。

没有另录、取自别处的：

- Codex 在 Linux 集群上沙箱起不来的原话：`../codex/codex-sandbox-linux.txt`（`codex sandbox -- …`，bwrap 报错，退出码 1）。
- dsh 0.2.1-rc.5 不认 `--permission-mode`：`../dsh/dsh-adapter-linux.*`（`unknown option '--permission-mode'`，退出码 1），最低版本的判断对着它。dsh 不声明只读，不问它只读（`docs/spike/readonly.md`）。
- Claude 的 `--help`：`../../claude/models/help.recorded.txt`，里面有只读要用的 `--disallowedTools`（2026-11-11 之前查的是 `--tools` 和 `--strict-mcp-config`）。
