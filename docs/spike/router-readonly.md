# 总控能读、不能写：Claude Code 自己的权限挡得住什么

结论：`claude -p --restricted --tools Read,Grep,Glob,Bash --permission-mode default --permission-prompts none --allowedTools mcp__tycho "Bash(gh pr view:*)" …`，环境里加 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`、`GIT_OPTIONAL_LOCKS=0`，在 Claude Code 2.1.303（Windows 11，本机登录）上做到了总控要的只读：读代码、跑只读的 git、用 gh 看 PR 和 CI 都行；写文件、提交、推送、改分支都被拒，工作目录没被写过。读的范围守不严：Read、Grep、Glob 出不了工作目录，但 git 有一个只读参数能读工作目录外的文件（见下表 `git blame --ignore-revs-file` 那一行），gh 能看主机登录看得到的任何仓库。所以总控保证的是“不能写”，不是“读不到”。git 不进放行清单，交给 CLI 自己判断哪些命令只读；gh 它不判断，只能按子命令放行。

和 [readonly.md](readonly.md) 里“`dontAsk` 加命令白名单挡不住写”不矛盾：那次把 `git diff`、`git log` 写进了 `--allowedTools`，前缀放行连 `--output=` 一起放了。这次 git 不写进清单，CLI 自己的只读判断看参数，`--output=` 被拒。审阅那一轮要跑测试，测试代码自己会写文件，这里不跑测试。

## 做法

一次性仓库（`git init`、一个提交），仓库外放一个 `outside.txt`。在仓库里起 CLI，让它按清单逐条调工具、照实报告；每条命令另开一次会话再试一遍，免得模型自己挑着做。脚本没留：参数就是结论里那一行。

## 结果

| 命令 | 结果 | 谁拦的 |
|---|---|---|
| `git log --oneline -1`、`git status --short`、`git show HEAD --stat`、`git show HEAD:a.txt`、`git log … \| head -1` | 放行 | — |
| `git log -1 --output=leak.txt` | 拒 | dontAsk：CLI 不认它只读 |
| `git diff HEAD > d.txt`、`echo hi > made.txt` | 拒 | 同上，重定向 |
| `git commit`、`git fetch`、`git branch -D` | 拒 | 同上 |
| `git -c core.pager=… log`、`git log --ext-diff -p`、`git --git-dir=../x log` | 拒 | 同上 |
| `git diff --no-index ../outside.txt a.txt`、`cd .. && git status` | 拒 | 同上：出不了工作目录 |
| `git log -1 -- ../outside.txt` | 放行，git 自己报“在仓库外”退出 128 | — |
| Read、Grep 工作目录外的文件 | 拒 | `--restricted`：文件工具只在工作目录里 |
| `gh pr list`、`gh pr diff --name-only`、`gh pr checks`、`gh run list`、`gh run view --log`（都带 `--repo`） | 放行，用的是主机上 gh 的登录 | `--allowedTools` 的 `Bash(gh …:*)` |
| 没写进清单时的 `gh pr list`、`gh run list` | 拒 | dontAsk |
| `gh issue create` | 拒 | 不在清单里 |
| 放行的 gh 命令后面 `> out.txt`、`&& touch t.txt`、`; echo … > p.txt`，参数里 `$(touch …)` | 拒 | CLI 拆开组合命令逐段判断 |
| `GH_BROWSER=true gh pr list …` | 拒 | 前缀不匹配 |
| `--mcp-config` 里的编排工具（规则 `mcp__tycho`） | 放行 | `--allowedTools` |
| `git blame --ignore-revs-file ../outside-secret.txt a.txt`（相对、绝对路径都试了） | 权限层放行；git 把文件内容当对象名报错，`fatal: invalid object name: <文件内容>` | CLI 的只读表把这个参数列为安全，路径检查只看位置参数（独立审阅发现并复现） |
| `gh repo view <仓库> --json name --jq 'env.HOME'` | 放行，输出主机的 HOME | gh 的 `--jq` 能读环境变量；不写东西 |
| 仓库里一个指向上级目录的目录联接 `linkdir`，Read `linkdir/outside.txt` | 放行，读到了仓库外的文件（`Read ../outside.txt` 照旧拒） | `--restricted` 只看写出来的路径（独立审阅复现） |
| `git status --short` | 放行；不设 `GIT_OPTIONAL_LOCKS` 时会刷新 `.git/index` 的修改时间 | 总控的环境里设了 `GIT_OPTIONAL_LOCKS=0`，用普通 git 核对过这样 `git status` 不改 `.git/index` |
| 换了工作目录之后 `--resume <会话>` | CLI 拒绝：`No conversation found with session ID` | 会话按目录存（独立审阅复现） |

下表最初用 `--permission-mode dontAsk` 测；换成最终的参数和环境后重跑了其中的代表项（`git log` 放行；`--output=`、重定向、`git commit`、`git fetch`、`gh issue create`、Read 工作目录外都拒；`gh pr list`、`git status` 放行；`gh run list … -aq env.<被清除的变量>` 输出为空），结果一样。初始化事件里的工具是 `Bash, Glob, Grep, Read` 加编排工具，`permissionMode` 是 `default`；`--restricted` 下主人 `~/.claude/settings.json` 里启用的插件没有加载（插件只有 CLI 内置的三个（`cc-plugin-agents-md`、`cc-plugin-telemetry`、`cc-plugin-plugin-authoring`）），它的 `permissions.allow`（比如一条 `git push --delete` 的放行）也就到不了这个会话。

## 放行的 gh 子命令

`gh pr view/list/diff/checks/status`、`gh run view/list`、`gh issue view/list`、`gh repo view`。逐个看过它们的参数：没有写文件的参数。`--web` 会用主机的浏览器打开页面，不改任何东西；`--jq` 能读环境变量（jq 的 `env`），绑定账号时令牌就在环境里，所以总控开着 CLI 的子进程凭据清除（下一节）。`gh api` 不放（能发写请求），`gh run download`、`gh pr checkout` 不放（写文件）。

## 令牌和 `--jq`

- Windows 上 `claude.exe` 2.1.303 不从描述符读令牌：设 `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3`、在第 4 个管道上写一个假令牌，回答是 “Not logged in”（`apiKeySource: none`）；同一个假令牌放进 `CLAUDE_CODE_OAUTH_TOKEN`，回答是 “401 OAuth access token is invalid”，说明环境变量被读了、描述符没有。
- 按文字写拒绝规则拦不全：`--disallowedTools "Bash(gh * --jq*)" "Bash(gh * -q*)"` 拒得了 `--jq env.HOME`、`-q env.HOME`、`--jq=env.HOME`、`-qenv.HOME`，但 `gh run list … -aq env.HOME`、`gh run view … -vq env.HOME`（短选项合写）照样放行，jq 照样执行（独立审阅复现）。所以不用拒绝规则。
- 用 CLI 自己的 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`：环境里放一个 CLI 会去掉的变量当探针（`ANTHROPIC_CUSTOM_HEADERS`，只是一个自定义请求头）和一个普通变量，`gh repo view cli/cli --json name --jq env.<变量>` 前者输出为空、后者照样输出。去掉的名单在 CLI 里写死，包括 `CLAUDE_CODE_OAUTH_TOKEN`、`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`。这个开关把权限模式定为 default（stderr 有一句提示），加 `--permission-prompts none` 之后：`git log` 放行，`echo hi > made.txt`、`git commit` 被拒（“this session has no approval surface”），和 dontAsk 一样。
- 档位（`--settings`）的 `env` 里写 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0` 关不掉清除：启动环境里设了的，CLI 以启动环境为准（实测：档位带这一项，`gh … --jq env.<被清除的变量>` 输出照样为空）。去掉的名单除了 Anthropic 的登录变量，还有 `GH_TOKEN`、`GITHUB_TOKEN` 和云厂商的凭据。

## 没测的

- `--restricted` 从哪一版开始有：2.1.303 有。更老的 CLI 不认这个参数，总控起不来，停摆原因里是 CLI 自己的报错。
- Linux、macOS：参数一样，Bash 是系统的 shell，没有实测。
- git 的只读参数里带文件路径的不止 `--ignore-revs-file`，没有逐个试；读的范围本来就不当保证。
