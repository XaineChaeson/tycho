# 部署方式调研（2026-11-06）

问题：成熟的自托管工具怎么把一个新用户从零带到“已启动、开机自启”，tycho 该照着做什么。调研对象：OpenClaw、n8n、Syncthing、Gitea/Forgejo、Coder、Claude Code 的原生安装。子代理查阅各自官方文档后的结论，来源见文末。

## 结论

**主分发用“安装脚本 + 发布包”，不用 npm。** Node 拒绝对 `node_modules` 下的 `.ts` 做类型剥离（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），无构建的 TypeScript 包经 `npm i -g` 或 `npx` 装上后跑不起来 [13][14]。

## 反复出现的做法

1. 一行安装，不要求用户自备工具链。
2. 首次启动自己生成配置、密钥和 token，能跑起来的都给默认值。
3. 终端只问极少的问题，其余放到网页首屏。
4. 服务装在用户级（LaunchAgent、systemd user、计划任务），以当前用户身份运行。
5. 一个 `doctor` 命令负责自检、迁移和修复服务定义。
6. 升级走“版本目录 + 稳定的启动器”，由升级命令同步服务定义。
7. 只绑定 127.0.0.1，并自动生成 token。

## 各工具现状

| 工具 | 首次命令 | 询问 / 默认 | 配置位置 / 网页可改 | 服务安装 | 自检 | 升级 |
|---|---|---|---|---|---|---|
| OpenClaw | `curl -fsSL https://openclaw.ai/install.sh \| bash`；`iwr -useb https://openclaw.ai/install.ps1 \| iex`（缺 Node 代装，随后进 `openclaw onboard`）[1][2] | 问：Quick/Custom、agent 名、访问模式、是否后台常驻。默认：探测已有 Claude Code/Codex 登录并试跑、自动生成 token [1][3] | `~/.openclaw/openclaw.json`；网页 Config 页可改；文件热加载；严格校验 [4] | `openclaw gateway install`：macOS LaunchAgent，Linux systemd user unit，Windows 计划任务，被拒则退到 Startup 文件夹 [1][5] | `openclaw doctor [--fix]` [6] | `openclaw update`：同步包与服务定义，留备份 [7] |
| n8n | `npx n8n` 或 `npm install n8n -g` [8] | 终端不问；网页首屏建 owner [9] | 环境变量；实例设置网页不可改 [9][10] | 未提供 | 未见 | `npm update -g n8n` [8] |
| Syncthing | 下载单文件，运行 `syncthing` | 不问；生成配置、密钥，自动开 `127.0.0.1:8384` [11] | `config.xml`；可经网页、命令行或手改 [12] | 无安装命令，文档逐 OS 手工 [15] | 无 | 自动升级；`syncthing --upgrade` [16] |
| Gitea / Forgejo | 下载二进制，`gitea web`，开首次配置页 [17][18] | 网页问：数据库、域名、管理员 [18] | 安装页写出 `app.ini`，之后改文件 [17][18] | Linux 手放 systemd unit；Windows `sc.exe create`，以系统账户运行 [19] | `gitea doctor check [--fix]` [20] | 备份、停、换二进制、启 [17] |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash`；`irm https://claude.ai/install.ps1 \| iex` [22] | 不问；不需 Node，不需管理员 | 不适用 | 无 | `claude doctor` [22] | 自动更新；启动器指向 `versions/` 目录 [22] |

## 分发选项

- **npm `bin`**：除上述 `node_modules` 限制外，从 GitHub 直装还依赖 git [24]。要走 npm 就必须发布前先去类型，等于引入构建。
- **Node 单文件可执行（SEA）**：仍是早期稳定度，要求单脚本，文档不提 TypeScript [25]；需要打包、每平台产物和签名。
- **安装脚本 + 发布包**：解到非 `node_modules` 的版本目录，配一个稳定的启动器；这是 Claude Code 原生安装的结构 [22]。
- **Docker**：容器里没有宿主的 `claude` 和 ssh 配置；登录凭据在 macOS 存于 Keychain，挂不进去 [27]。

## 要避开的坑

1. **服务换了用户就丢登录。** Gitea 的 Windows 服务以系统账户运行 [19]；换用户后读不到 Claude 的登录和 ssh 密钥 [27]。
2. **服务管理器不继承 shell 的 PATH。** nvm/fnm 装的 Node 会找不到 [29]。安装服务时要写入 `node` 和 `claude` 的绝对路径。
3. **文件和网页两处都能改配置，代价很高。** OpenClaw 为此背上了严格校验、拒绝启动、last-known-good 和 `doctor --fix` [4]。
4. **多处安装会分叉。** 切换 Node 版本后 `npm -g` 留下第二份，服务仍跑旧的那份 [7]。
5. **升级后服务定义或启动器会过期** [5][17]。
6. **结束计划任务可能只停掉监控进程**，要杀整棵进程树 [5][15]。
7. **无人值守时 Claude 登录过期，会话就停。** 控制台应显示登录状态 [27]。

## 来源

1. https://docs.openclaw.ai/start/getting-started
2. https://docs.openclaw.ai/install
3. https://docs.openclaw.ai/cli/onboard
4. https://docs.openclaw.ai/gateway/configuration
5. https://docs.openclaw.ai/platforms/windows
6. https://docs.openclaw.ai/gateway/doctor
7. https://docs.openclaw.ai/install/updating
8. https://docs.n8n.io/hosting/installation/npm/
9. https://docs.n8n.io/hosting/configuration/user-management-self-hosted/
10. https://docs.n8n.io/hosting/configuration/configuration-methods/
11. https://docs.syncthing.net/intro/getting-started.html
12. https://docs.syncthing.net/users/config.html
13. https://nodejs.org/api/typescript.html
14. https://nodejs.org/api/errors.html
15. https://docs.syncthing.net/users/autostart.html
16. https://docs.syncthing.net/users/faq.html
17. https://docs.gitea.com/installation/install-from-binary
18. https://forgejo.org/docs/latest/admin/installation/binary/
19. https://docs.gitea.com/installation/windows-service
20. https://docs.gitea.com/administration/command-line
22. https://code.claude.com/docs/en/setup
24. https://docs.npmjs.com/cli/v11/commands/npm-install
25. https://nodejs.org/api/single-executable-applications.html
27. https://code.claude.com/docs/en/authentication
29. https://docs.openclaw.ai/gateway/troubleshooting（经搜索摘要读到，未直接打开全文）
