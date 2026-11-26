# 5 分钟快速上手

照着本文做完，你会在本机装好 Tycho 主机，把本机接入为执行节点，创建第一个项目，并亲眼看到原生执行器跑完你的第一条任务。

> [!TIP]
> 不需要 `root` / 管理员权限，不需要 Docker，也不需要预装 Node.js（安装脚本会自动准备隔离的 Node 24 运行时）。

## 准备清单

| 条件 | 验证方式 |
| --- | --- |
| 至少已安装并登录 1 个原生执行器 CLI（任选其一） | `codex --version` / `claude --version` / `agy --version` / `dsh --version` 有输出且可正常对话 |
| 普通日常用户权限（**不要用 `root` 或管理员**） | `whoami` 为你的日常登录用户 |

> **不需要预先安装 Node.js**：本机没有 `Node >= 24.3.0` 时，安装脚本会自动下载一份只给 Tycho 使用的私有 Node 24 运行时，不影响系统环境。

---

## 第 1 步：安装 Tycho

**Linux / macOS：**

```bash
curl -fsSL https://github.com/XaineChaeson/tycho/releases/latest/download/install.sh | bash
```

**Windows（PowerShell）：**

```powershell
irm https://github.com/XaineChaeson/tycho/releases/latest/download/install.ps1 | iex
```

<details>
<summary>离线安装或手动校验安装包</summary>

从 [GitHub Releases](https://github.com/XaineChaeson/tycho/releases) 下载对应版本的 `tycho.tar.gz`、`install.sh`（或 `install.ps1`）与 `SHA256SUMS`，核对校验值后运行：

```bash
# Linux / macOS
sha256sum -c SHA256SUMS && bash install.sh --from tycho.tar.gz
```

```powershell
# Windows (PowerShell)
Get-FileHash -Algorithm SHA256 tycho.tar.gz
powershell -ExecutionPolicy Bypass -File install.ps1 -From tycho.tar.gz
```

</details>

**成功标志**：终端打印 `tycho <版本> 已装到 ~/.tycho/app`。新开一个终端运行 `tycho version`，输出对应版本号。

- 程序文件在 `~/.tycho/app`，数据（账本、密钥、日志）在 `~/.tycho/host`。两者分离，升级和卸载都不会动你的数据。

---

## 第 2 步：启动主机并打开控制台

```bash
tycho run --open
```

如果默认的 `8787` 端口已被占用，本次可临时指定其他端口：

```bash
tycho run --port 8788 --open
```

**成功标志**：
1. 终端输出 `服务已启动。`、控制台地址 `http://127.0.0.1:8787` 以及一条一次性登录链接。
2. 浏览器自动打开登录页，点击 **「进入」** 即可登录控制台（会话默认保持 30 天）。

> 前台运行的终端需要保持打开；需要长期后台运行与开机自启时，完成第 4 步后执行 `tycho service install`（见[生产运维手册](operations.md)）。

---

## 第 3 步：把本机接入为执行节点

打开**第二个终端**，执行：

```bash
tycho node join --to http://127.0.0.1:8787
```

（若第 2 步改了端口，把 `8787` 换成实际端口。）

**成功标志**：
1. 本机回环接入无需人工输码，终端打印 `已加入` 并开始持续轮询。
2. 回到控制台 **「机器」** 页，看到本机状态为 **「在线」**，并列出本机探测到的执行器（Claude / Codex / Gemini / dsh）。
3. 切到 **「账号」** 页，本机已登录的执行器会自动出现为单机本地登录，并带好默认档位。

> 如果你使用 Codex 作为项目总控，可到 **「设置 › 负责人」** 选择刚出现的 Codex 登录并点击 **「重启负责人」**。

---

## 第 4 步：跑通你的第一条任务

1. 点击左侧栏 **项目** 旁的 **`+`**，输入项目名（例如 `sandbox`），添加一个本机代码目录或 Git 仓库作为代码来源。
2. 进入该项目对话页，发送：
   > 请派一条验证任务，报告执行机器的操作系统版本和当前时间。
3. 切到 **「工作」** 页，点击新出现的任务卡片。

**成功标志**：你能实时看到执行器的工具调用流，几秒到几十秒后任务结算为完成并交回结果报告。

---

## 接下来推荐做什么？

- **设为后台常驻服务**：运行 `tycho service install`（主机）与 `tycho node service install`（本机节点）→ 详见 [生产运维手册](operations.md)
- **装上桌面客户端或手机全屏 PWA**：下载 3 MB 桌面壳或在手机浏览器「添加到主屏幕」→ 详见 [多端客户端指南](../clients.md)
- **接入第二台机器 / 配置多账号池与额度调度**：→ 详见 [账号池、档位与执行机器](accounts-and-nodes.md)
- **在外网安全访问**：→ 详见 [远程访问与公网门牌](remote-access.md)
