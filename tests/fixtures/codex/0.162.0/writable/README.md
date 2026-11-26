# codex 0.162.0 可写的一轮

2026-11-10 在主人的 Windows 工作站上录的（codex-cli 0.162.0，主人自己的 `CODEX_HOME`，只读着用，跑前跑后核对过 `config.toml` 和两个 profile 文件的摘要没变）。任务都是在一个空的临时目录里“用 shell 命令写一个 `proof.txt`，内容是 `tycho-writable`”。路径换成了 `C:\work\probe\codex-writable` 和 `C:\Users\owner`，模型名换成了 `<模型名>`。

| 文件 | 怎么起的 | 结果 |
|---|---|---|
| `windows.*` | 适配器现在的可写跑法：只带 `--sandbox workspace-write`；这台机器自己的配置是 `[windows] sandbox = "elevated"` | 文件写出来了，内容对，命令退出码 0 |
| `windows-no-sandbox.*` | 改之前的跑法：不带任何沙箱开关 | 两次写都被拒（“对路径的访问被拒绝”），回合照样以 `turn.completed` 结束 |

`*.fs.json` 记启动参数、退出码、目录里多出来的文件；`*.ndjson` 是 `--json` 的标准输出原样。

`windows.*` 是 2026-11-10 第二次录的（第一次录时命令行还带着 `-c windows.sandbox="unelevated"`，那一份已换掉）。

另外只看启动摘要（不存实录，用不存在的模型名，不耗额度）：`--sandbox workspace-write` 在一个空的隔离 `CODEX_HOME` 里显示 `sandbox: read-only`；配置里有 `[windows] sandbox = "elevated"` 或 `"unelevated"` 时显示 `sandbox: workspace-write [workdir, /tmp, $TMPDIR]`。也就是说，Windows 上可写要靠那台机器自己配了 Windows 沙箱；没配时 codex 会把 workspace-write 不声不响地退成只读。用哪种 Windows 沙箱是机器自己的配置，tycho 不替它选，也不在档位里收；没配的机器目前没有探测，可写的一轮在那里会写不了。`docs/spike/readonly.md` 里“本机连 workspace-write 都显示 read-only”的那次，就是当时没配。

Linux（集群实例）上的 workspace-write 没有在这里测过。
