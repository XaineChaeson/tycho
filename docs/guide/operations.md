# 生产运维手册

本文覆盖长期自托管运行 Tycho 所需的全部日常运维：开机自启、备份与恢复、安全升级回退、卸载以及同一台电脑上的双实例隔离。

## 一、开机自启（后台常驻）

### 主机服务

```bash
tycho service install
```

| 操作系统 | 安装形态 | 日志查看方式 |
| --- | --- | --- |
| **Linux** | systemd 用户服务（默认随登录启动；要退出登录不中断，额外执行一次 `loginctl enable-linger`） | `journalctl --user -u tycho`（或按 `tycho service status` 输出的实际单元名） |
| **Windows** | 计划任务（Windows 10 1809+ 经 `conhost.exe --headless` 无窗口后台运行） | `<TYCHO_DATA>\service.log` |
| **macOS** | LaunchAgent | `<TYCHO_DATA>/service.log` |

常用管理命令：

```bash
tycho status              # 查看运行状态、已装版本、运行版本与自启定义
tycho open                # 为后台服务生成一次性登录链接并打开浏览器
tycho stop                # 干净停止（不会触发自动重启）
tycho service start       # 重新拉起后台服务
tycho service uninstall   # 仅卸载自启定义，不删程序与数据
```

### 执行节点客户端

机器用 `tycho node join` 接入主机后，在同一台机器运行：

```bash
tycho node service install
```

节点服务与主机服务完全独立，同一台电脑可以同时安装主机自启与节点自启。查看节点状态用 `tycho node status` 与 `tycho node service status`。

---

## 二、自动备份与灾难恢复

### 开启自动备份
打开控制台 **「设置 › 备份」**，填入一个**已经存在的目录**（建议在另一块磁盘或网盘同步目录），保存后立即备份一次，之后每天按设定时刻（默认 `03:30`）自动备份并默认保留 14 天。

> 备份包含 `ledger.db`、`backup.json` 与 `.tycho-backup` 标识；**不包含** `secrets/` 中的凭据与通道密钥。迁移到新机器后需在控制台重新填入托管凭据与企微 Secret。

### 从备份恢复

```bash
tycho stop
tycho restore --from <备份文件或某一天的备份目录>
tycho service start   # 或 tycho run --open
```

恢复后 Tycho 会进入保守清点模式（暂停派发、留存旧账本副本、列出备份时仍在排队的任务），防止重复执行有副作用的任务。在控制台逐项点击 **「继续」** 或 **「放弃」**，确认清点完成后点击 **「恢复派发」** 即可。

---

## 三、安全升级与回退

### 联网一键升级（公开仓库免登录）

```bash
tycho update                # 升级到最新稳定服务端发行版
tycho update --to 0.2.10    # 明确指定某个版本或预发行版（不带 v 前缀）
```

### 离线包升级

```bash
tycho update --from tycho.tar.gz
```

**升级安全机制**：
1. 校验发布包文件大小、SHA256 摘要与账本 schema 兼容性。
2. 等待正在进行的项目总控回合自然收尾，再停止旧服务并原子切换 `current`。
3. 拉起新版本并执行完整自检（进程、账本读写、真实登录换会话、核心 API、10 秒稳定观察）。
4. 若新版本健康检查失败且账本版本未升，自动回退到上一版本。
5. 主机升级完成后，所有在线的执行节点会在空闲时自动拉取同版本并平滑更新。

> 涉及账本 schema 升级的版本会在首次启动前自动在数据目录保留一份升级前账本副本；如需人工回退，请先 `tycho stop`，恢复旧账本副本后再执行 `tycho update --from <旧版发布包>`。

---

## 四、同机多实例隔离（如办公 + 家庭两套环境）

同一系统用户可通过指定不同的 `TYCHO_PREFIX` 与 `TYCHO_DATA` 并行运行多套互不干扰的 Tycho 实例：

```bash
TYCHO_PREFIX="$HOME/.tycho/home/app" bash install.sh --from tycho.tar.gz
TYCHO_DATA="$HOME/.tycho/home/host" "$HOME/.tycho/home/app/bin/tycho" run --port 8788 --open
TYCHO_DATA="$HOME/.tycho/home/host" "$HOME/.tycho/home/app/bin/tycho" service install
```

每套安装会自动使用带稳定后缀的独立自启定义名称，互不覆盖。

---

## 五、卸载

```bash
tycho uninstall
```

该命令会停止服务、移除开机自启、撤销安装器对 PATH 的修改并删除程序目录。**不会删除数据目录**（`~/.tycho/host`）；如确认不再需要历史账本，手动删除该目录即可。
