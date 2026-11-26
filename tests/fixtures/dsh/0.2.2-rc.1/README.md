# dsh 0.2.2-rc.1 的实录

`dsh --profile headless` 的 `--json` 输出，在这台机器上录的（命令名在本机是 `dsh`，装在
`D:\software\dsh`）。任务走参数，一次一个：

```
dsh --profile headless --patch <档位>.patch.yml --patch <本机 overlay>.patch.yml \
    --json --permission-mode danger-full-access --approval-policy never "<任务>"
```

| 文件 | 那一轮 |
|---|---|
| `tools` | 成功：一次 `write` 加一次 `read`，两个工具调用都完成，末了 `final` |
| `resume` | `--session-id session-1cfe8f45-…` 续接 `tools` 那一轮（同一目录、同一会话），`turn` 从 2 起 |
| `missing-credential` | 去掉本机 overlay、只留档位层：deepseek-official 没有凭据 → `reason.kind: "error"`，`code: MISSING_CREDENTIAL`，退出码 1 |
| `interrupt` | 一轮生成中途被打断：文件里只有 `session` 和两条 `status`，没有 `turn_end`、没有 `final` |
| `usage-error` | 给了一个不存在的选项：stdout 只有一行 `{"type":"error","message":"unknown option …"}`，没有 `session`、没有 `final`，退出码 1 |

`dump-config-headless.yml` 是 `dsh --profile headless --dump-config` 输出的节选（开头几条和 `agent-default-model` 前后几条，
原样；整份有三百多行，后面是别的插件的设置，没有收）。它说明两件事：不带 `--profile` 时启动器只回
`error: --profile <name> is required`、退出码 1；随包的 headless profile 不写任何 `models:` 清单，只在
`agent-default-model` 里写了默认的线路和模型。

`*.exit` 是进程退出码。`usage-error` 这一份的 `DSH_HOME` 指到一份 `profiles/` 的副本（不是真机的 `~/.dsh`），
也没有给 `--patch`：这一轮在解析命令行时就结束了，轮不到档位。它的 stderr 里那行 crashpad 报错是环境噪声，
和 `tools` 一样删掉了，所以文件是空的。`interrupt` 这一份要说明：dsh 是 Electron 的 GUI 子系统可执行文件，本机没有
控制台可挂，`GenerateConsoleCtrlEvent` 送不到它（它的 koffi 控制台处理器不会触发），所以这一轮是用
`TerminateProcess` 停的，退出码记 1。生产上 `runner/remote/stop.sh` 是给进程组发 SIGINT、dsh 自己
以 130 收场——那份输出没录到，`result()` 对它的处理没有被实录覆盖。

录完做过三件事：把录制目录的临时路径换成固定的 `C:\work\probe`；`callId` 换成 `call_1`、`call_2`；
删掉 Electron crashpad 在录制沙箱里写不出转储目录而打的那行 stderr（那是环境，不是这一轮）。

没录到的形状：工具返回 `status: "error"`（dsh 的投影里是这一支，见 `json-stream`），
`pwsh`/`grep`/`edit` 等其它工具名与它们的类别，`reason.kind` 除 `completed`、`error` 以外的取值
（`aborted`/`blocked`/`max-tokens`/`interrupted`/`forked`，见 dsh 自己的 `TurnEndReasonMap`），
以及凭据和额度类报错里除 `MISSING_CREDENTIAL` 以外的码（`AUTH`、`INVALID_CREDENTIAL`、
`ACCOUNT_SIGN_IN_REQUIRED`、`ACCOUNT_TOKEN_INVALID`、`ACCOUNT_SIGNED_OUT`、`QUOTA`、`ACCOUNT_QUOTA`、
`RATE_LIMIT`；这些码和它们的含义抄自 dsh 自己的错误表，见 `adapters/dsh.ts` 和
`tests/adapter-dsh.test.ts` 的注释）。
