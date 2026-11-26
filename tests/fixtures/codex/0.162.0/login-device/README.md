# codex 0.162.0 的 `codex login --device-auth`

2026-11-11 在这台机器上录的：codex-cli 0.162.0，在一个隔离的 `CODEX_HOME`（新建的空目录）里运行
`codex login --device-auth`，标准输入不给、不是终端，录下标准输出。

`stdout.txt` 是那一次的标准输出，原样保留了 ANSI 颜色序列（`ESC[90m`、`ESC[94m`、`ESC[0m`），只改了一处：
一次性用户码换成了 `ABCD-12345`（真码的形状一样：四个字符、一个连字符、五个字符）。验证网址
`https://auth.openai.com/codex/device` 是原样。

进程在印出网址和用户码之后就被结束了，没有人去授权，所以这里**没有成功画面的实录**。tycho 不读成功画面：
登录成功只认这条命令以 0 退出（`adapters/codex.ts` 的 `signIn`）。
