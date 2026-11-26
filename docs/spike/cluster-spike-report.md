# 集群 spike 报告：启动协议力学与 Codex `exec --json` 夹具

日期：2026-11-04。实例：`cluster-34fbc81b-…`（Linux，16 核，期间 load avg 76–82）。工具：`codex-cli 0.163.0`、`setsid`（util-linux）、`env`（GNU coreutils 9.4）。
脚本在 `D:\code\workflow-design\spike\cluster\`（`start.sh` / `state.sh` / `stop.sh` / `states.sh` / `codex-case.sh` / `interrupt-watch.sh` / `watch-exit.sh`），实例上放在 `~/.orchestrator-spike/bin/` 运行，运行目录 `~/.orchestrator-spike/runs/<run_id>/`。
原始记录：`D:\code\workflow-design\spike\fixtures\launch-protocol\*.txt`（Part A）与 `D:\code\workflow-design\spike\fixtures\codex\0.163.0\*`（Part B）。

## 结论先行

协议的核心机制成立：`mkdir started` 做一次性门闩、`setsid` 出来的 worker 自成会话且 pid==pgid==sid、ssh 断开后 worker 存活、`exit.tmp`→`mv exit` 原子落盘都验证通过。但**按原文逐字实现会踩两个必改的坑**，还有一个判定表要吸收的事实：

1. **原文 `setsid bash -c '…' &` 会让整棵 worker 树忽略 SIGINT。** 非交互 bash 对 `&` 启动的异步命令把 SIGINT/SIGQUIT 设为 SIG_IGN，这个处置跨 exec 继承：wrapper bash 的 `SigIgn=0x6`，`sleep` 也继承，`kill -INT -- -pgid` 完全无效，只能等 10 s 后 SIGKILL。（codex 例外：node 启动时把除 SIGPIPE/SIGXFSZ 外的信号全部复位为默认，所以 codex 本体能收到 SIGINT，但 wrapper 仍忽略。）修法：`setsid env --default-signal bash -c '…' &`，验证后 wrapper `SigIgn=0x4`（只剩 bash 自己忽略的 SIGQUIT），SIGINT 9 ms 内整组退出。
2. **原文的 wrapper 继承了 ssh 会话的 stdout/stderr 管道**（`/proc/<pid>/fd/1,2 -> pipe`），ssh 命令在 worker 结束前不返回（本次 `sleep 300` 让 ssh 挂了 120 s 直到被我杀掉）。修法：`</dev/null >"$dir/wrapper.log" 2>&1`。stdin 本来就是 `/dev/null`（bash 对无作业控制的后台命令自动重定向）。
3. **stop 之后 `exit` 文件是否存在取决于 worker 怎么死。** SIGINT 发给整个进程组时 wrapper bash 也收到：若前台子进程被信号杀死（`sleep`），bash 随之自杀，不写 `exit`；若子进程捕获 SIGINT 后正常退出（codex 以 1 退出），bash 继续执行并写出 `exit=1`。判定表不能把"stop 后无 exit"当异常。
4. **Codex 侧四个事实**：`exec --json` 没有 delta 事件，一条 2000 行的 agent_message 要等 ~1 min 才出现 `item.completed`，期间流上静默；SIGINT 后流上没有任何结束事件，退出码 1；`codex exec resume` 子命令没有 `--profile`/`--sandbox`，`-c profile=cheap` 被拒绝；API 不可达时 codex **无限重连**（7 min 内 10 条 `{"type":"error","message":"Reconnecting..."}`，没有终止事件，不退出），编排器必须自己设超时。`OPENAI_BASE_URL` 和 `--profile nonexistent` 在 0.163.0 都**不能**制造失败。

## Part A：启动协议力学

### A0 实现与两处修正

最终 `start.sh`（与原文的差异只在 `setsid` 那一行）：

```bash
run_id="$1"; shift
dir="$HOME/.orchestrator-spike/runs/$run_id"
mkdir -p "$dir"
mkdir "$dir/started" 2>/dev/null || exit 3
setsid env --default-signal bash -c 'dir="$1"; shift; [ -n "$ORCH_CWD" ] && cd "$ORCH_CWD"; "$@" > "$dir/stdout.ndjson" 2> "$dir/stderr.log"; echo $? > "$dir/exit.tmp"; mv "$dir/exit.tmp" "$dir/exit"' \
  "orchestrator-run:$run_id" "$dir" "$@" </dev/null >"$dir/wrapper.log" 2>&1 &
pid=$!
[ -n "$ORCH_LAUNCH_DELAY" ] && sleep "$ORCH_LAUNCH_DELAY"   # 只用于模拟慢 launcher
echo "$pid" > "$dir/started/pid"
echo started
```

标记放在 wrapper 的 `$0`：`pgrep -af orchestrator-run:<id>` 命中的就是 `started/pid` 里的那个 pid（组长），不依赖 worker 自身命令行。

| 现象 | 证据 | 修正 |
|---|---|---|
| ssh 不返回 | v1 启动 `sleep 300` 后 ssh 挂起 120 s 被本地杀掉；`ls -l /proc/250930/fd` → `0 -> /dev/null`，`1,2 -> pipe:[675939656]` | wrapper 整体 `</dev/null >wrapper.log 2>&1` |
| SIGINT 被忽略 | `grep SigIgn /proc/250894/status` → `0000000000000006`（INT+QUIT）；`kill -INT -- -250930` 后 10 s 组仍在，只能 SIGKILL | `setsid env --default-signal bash -c …`；修后 `SigIgn=0000000000000004` |

pgid 行为：launcher 是非交互 shell 的后台子进程、不是组长，`setsid` 不 fork 直接 `setsid()`+exec，所以 `$!` 就是 wrapper，`pid==pgid==sid`（如 `250894 250894 250894`），launcher 退出后 ppid 变 15（容器 tini）。这点和原文假设一致。

坑：通过 ssh 直接传含 `orchestrator-run:` 或脚本名的命令行时，`pgrep -f`/`pkill -f` 会匹配到 ssh 自己的 `bash -lc …`（有一次 `pkill -f interrupt-watch.sh` 把 ssh 会话自己杀了，exit 255）。编排器的探测命令要放在脚本里执行，或用 `pgrep -A`/排除自身 pid。

### A1 同一 run_id 调两次 → 第二次 exit 3，不启动任何东西：**通过**

```
bash start.sh A1 sleep 300 ; echo rc=$?      → started / rc=0
pgrep -af orchestrator-run:A1                → 250894 bash -c … orchestrator-run:A1 … sleep 300   (1 个)
bash start.sh A1 sleep 300 ; echo rc=$?      → (无输出) rc=3
pgrep -af orchestrator-run:A1                → 仍只有 250894；pgrep -g 250894 → 250894, 250896(sleep)
```

### A2 ssh 断开后存活：**通过**（而且是突然断开）

```
ssh … 'bash -lc "bash start.sh A2 sleep 300; …"'   (v1 脚本，ssh 被本地 kill 终止)
重连后: ps -o pid,ppid,pgid,sid,stat,etimes -p 250930 → 250930 15 250930 250930 Ss 144 ；子 250932 sleep 300
```

A1 的 `sleep 300` 自然跑完后，`exit` 文件也在无人连接的情况下写出（内容 `0`）。

### A3 停止：SIGINT 进程组，10 s 后 SIGKILL

| 对象 | 命令 | 结果 | 判定 |
|---|---|---|---|
| (a) sleep，v1 launcher | `kill -INT -- -250930` | 10 s 后组仍在（wrapper+sleep 都忽略 INT）；`kill -KILL -- -250930` 后 `pgrep -g` 空；**无 `exit` 文件** | 协议原文**失败**（见 A0.1） |
| (a) sleep，v2 launcher（S4、S2） | `kill -INT -- -252835` | 9 ms 组消失，`pgrep -g`/`pgrep -af orchestrator-run:S4` 皆空；**无 `exit` 文件**（wrapper bash 随被 INT 杀死的子进程自杀） | 通过；exit 缺失是预期 |
| (b) codex 长 prompt，v2（interrupt2） | 看门狗在 `turn.started`+15 s 触发 `kill -INT -- -252056` | 848 ms 组消失（wrapper、`node …/codex`、`…/vendor/…/bin/codex` 三层全无）；`pgrep -af "codex exec"` 空；**`exit`=1**；stdout 只有 `thread.started`、`turn.started` 两行，没有结束事件 | 通过 |
| (b') codex 卡在重连循环（fail-provider） | 同上，运行 439 s 后 | 744 ms 组消失，`exit`=1 | 通过 |

没有发现 SIGINT 后残活的 codex 子进程；两次 codex 停止都不需要 SIGKILL。

### A4 判定表六种可观察状态（v2 launcher；完整 `ls -la`+`pgrep` 在 `fixtures/launch-protocol/04-*.txt`）

| 状态 | 制造方法 | 观察（`ls -la` 要点 / `pgrep -af orchestrator-run:<id>` / `ps -p pid`） |
|---|---|---|
| (i) 无 `started/` | `mkdir runs/S1` | 目录空；pgrep rc=1 |
| (ii) `started/` 有、无 `pid`、launcher 还在 | `ORCH_LAUNCH_DELAY=20 setsid bash start.sh S2 sleep 300 &`，2 s 后看 | `started/` 空目录，`stdout.ndjson`/`stderr.log`/`wrapper.log` 已存在（0 字节）；**pgrep 已能命中 worker 252685**；launcher 252680 带子 `sleep 20`。20 s 后 `started/pid`=252685 出现 |
| (iii) `started/` 有、无 `pid`、没东西在跑 | 同上，2 s 时 `kill -KILL` launcher；再 `pkill -KILL -f 'orchestrator-run:S3 '` | **只杀 launcher 时 worker 252812 仍在跑且永远不会有 pid 文件**——只能靠标记找到；杀掉后 pgrep rc=1，目录同 (ii) |
| (iv) `started/pid` 有、进程活、无 `exit` | `start.sh S4 sleep 300` | pid=252835；`ps` 显示 `Ss`，组内 252835 + 252837 sleep |
| (v) `exit` 有 | `start.sh S5 true` | `exit`=`0`（2 字节）；`started/pid`=252855 仍在但 `ps -p` 空、pgrep rc=1；`wrapper.log` 空 |
| (vi) `started/pid` 有、进程没了、无 `exit` | `start.sh S6 sleep 300`，`kill -KILL -- -252874` | `ps -p 252874` 空、pgrep rc=1、无 `exit`；目录和 (iv) 一样 |

注意 (iii) 与 (ii) 的文件视图完全相同，只有 "launcher 进程是否还活着" 这一点不同，而 launcher 的 pid 在协议里没有记录；(v) 和 (vi) 的区别只有 `exit` 文件；stop 路径产生的也是 (vi)（sleep 类）或 (v)（codex 类）。

## Part B：Codex 0.163.0 `exec --json` 夹具

所有用例在 `~/.orchestrator-spike/codex/` 作为 cwd、经 `start.sh` 启动（stdin=/dev/null），夹具文件 = run 目录的 `stdout.ndjson`/`stderr.log`/`exit`/`last.txt`（`-o`）。

| 用例 | 命令（省略公共的 `--skip-git-repo-check --json -o last.txt`） | exit | 事件序列 / stderr | 夹具 |
|---|---|---|---|---|
| 1 normal | `codex exec --profile cheap --sandbox read-only '记住暗号：青松-7429。只回复"好的"。'` | 0 | `thread.started`(thread_id `01a1a679-2a95-76d2-ab19-b7b85e95871b`) → `turn.started` → `item.completed`(agent_message "好的") → `turn.completed`(usage)；stderr 仅 `Reading additional input from stdin...` | `normal.*` |
| 2 resume | `codex exec resume 01a1a679-… '刚才的暗号是什么？只回复暗号。'` | 0 | 同样四事件，`thread.started` 复用原 thread_id，回答 `青松-7429`；**stderr 为空**（resume 不读 stdin） | `resume.*` |
| 2' resume + `-c profile=cheap` | 同上加 `-c profile=cheap` | 1 | stdout 空；stderr：`Error: legacy profile = "cheap" config is no longer supported; use --profile cheap with cheap.config.toml instead` | `resume-with-c-profile-rejected.*` |
| 3 interrupt | 长 prompt（数到 2000），`turn.started`+15 s 时 SIGINT 进程组 | 1 | `thread.started` → `turn.started`，之后**没有任何事件**；stderr 仅 stdin 提示 | `interrupt.*`、`interrupt.watcher.log` |
| 3' 同 prompt 不打断（v1 launcher 那次来不及停） | 同 3 | 0 | 四事件；单条 agent_message 含 1…2000，`output_tokens` 5004，约 1 min 内流上无任何事件 | `long-prompt-completed.*` |
| 4a `OPENAI_BASE_URL=http://127.0.0.1:9/v1` | `env OPENAI_BASE_URL=… codex exec --profile cheap …` | 0 | **正常完成**，环境变量对 cheap profile 的 provider 无效 | `fail-openai-base-url-noeffect.*` |
| 4b `--profile nonexistent` | `codex exec --profile nonexistent --sandbox read-only …` | 0 | **正常完成**，不存在的 profile 被静默接受 | `fail-profile-nonexistent-noeffect.*` |
| 4c 自定义 provider 指向关闭端口（**有效的失败制造法**） | `codex exec --profile cheap … -c model_provider=spikefail -c model_providers.spikefail.name=spikefail -c model_providers.spikefail.base_url=http://127.0.0.1:9/v1 -c model_providers.spikefail.wire_api=responses` | （不退出）SIGINT 后 1 | `thread.started` → `item.completed`(type `error`，模型元数据缺失警告) → `turn.started` → 10 × `{"type":"error","message":"Reconnecting... waiting for network (Connection failed: error sending request)"}`，7 min 无终止事件、无 `exit`；stderr 3 条 `ERROR codex_models_manager::manager: failed to refresh available models` | `fail-provider-unreachable.*` |

`codex exec resume --help` 要点：`codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`，支持 `--last`、`--all`、`-c`、`--json`、`-o`、`--skip-git-repo-check`；**没有 `--profile`、`--sandbox`**。resume 用哪一档模型只能靠默认配置或 `-c` 单项覆盖，这与"档位 profile 是唯一设模型的地方"的规则冲突，需要在设计里决定（例如 resume 时由编排器从 profile 文件读出 provider/model 再用 `-c` 传，或接受 resume 走默认档）。

`item.completed` 里 `type:"error"` 与顶层 `{"type":"error"}` 是两种不同形态的错误事件（前者算 item，后者不算），解析器要都认。

## 清理

```
tar czf /tmp/orch-spike-runs.tgz runs log  → scp 到本机 → rm -rf ~/.orchestrator-spike; rm -f /tmp/orch-spike-runs.tgz
最终检查（脚本执行，避免 pgrep 自匹配）：
  ls ~/.orchestrator-spike → No such file or directory
  pgrep -af 'orchestrator-run:' / 'codex exec' / 'sleep 300' / 'orchestrator-spike' / 'bash -c dir=' → 全部 rc=1
  /tmp/orch-final-check.sh 已删除
```

实例上没有留下目录、进程或临时文件。

## 对设计的建议

1. 启动行固定为 `setsid env --default-signal bash -c '…' "orchestrator-run:$id" "$dir" "$@" </dev/null >"$dir/wrapper.log" 2>&1 &`，并把 (A0) 两条写进协议说明；用 `SigIgn` 检查作为启动自检之一。
2. 判定表把"stop 后无 `exit`"归为正常终态（记录 stop 时刻即可），不要据此重启；(ii)/(iii) 文件视图相同，要么让 launcher 也写 `started/launcher.pid`，要么直接让 wrapper 自己写 `$$` 到 `started/pid`（去掉 launcher 慢这一整类状态）。
3. Codex 的活性不能靠流事件判断（长消息期间静默），也不能靠 codex 自己超时（重连无限）：编排器要有自己的墙钟上限，按 `error` 事件连续出现计数提前终止；SIGINT 停止可靠且 <1 s，不需要给 codex 留 10 s 宽限。
4. 失败夹具的制造方法只有自定义 provider 一种有效；`fail-openai-base-url-noeffect`、`fail-profile-nonexistent-noeffect` 两份夹具保留下来是为了证明这两条路不可用。
