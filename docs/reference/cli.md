<!-- AUTO-GENERATED from cli/main.ts and node/cli.ts by scripts/gen-docs-reference.ts. Do not edit manually. -->

# CLI 命令参考（CLI Reference）

本文档由 `node scripts/gen-docs-reference.ts` 直接从 [cli/main.ts](../../cli/main.ts) 与 [node/cli.ts](../../node/cli.ts) 提取，确保命令参数与 `tycho help` / `tycho node help` 保持完全一致。

## 退出码约定

| 退出码 | 含义 |
| --- | --- |
| `0` | 执行成功 |
| `1` | 运行时错误（网络、权限、锁冲突、状态不满足等） |
| `2` | 命令行参数或子命令用法错误 |

## 环境变量

| 变量 | 作用域 | 说明 |
| --- | --- | --- |
| `TYCHO_DATA` | Host / Node | 指定数据目录，默认 `~/.tycho/host` |
| `TYCHO_PREFIX` | 安装器 | 指定程序安装目录，默认 `~/.tycho/app` |
| `TYCHO_NO_MODIFY_PATH` | 安装器 | 设为非空值时不修改用户 shell PATH |
| `TYCHO_RELEASE_URL` | 安装器 / 更新 | 自定义 `tycho.tar.gz` 下载地址 |
| `TYCHO_NODE_DIST_URL` | 安装器 | 自定义 Node 24 二进制镜像（校验值仍从 nodejs.org 核验） |
| `TYCHO_KNOWLEDGE_TOKEN` | Knowledge MCP | `tycho knowledge-mcp` 使用的知识访问令牌 |

## 主命令（`tycho help`）

```text
tycho：个人工作流编排服务

用法：
  tycho run [--open] [--port <端口>]
                             前台运行服务（不带子命令也是它）；--open 顺便在浏览器里打开控制台；
                             --port 只对这一次运行换一个端口
  tycho open [--print]       给运行中的服务取一条登录链接，并在浏览器里打开；--print 只打印链接
  tycho stop                 停止运行中的服务
  tycho status               服务在不在跑、装的和在跑的版本、数据目录、开机自启装没装
  tycho service install      装成开机自启：你登录后自动运行
  tycho service uninstall    卸掉开机自启
  tycho service start        让开机自启的那个服务现在就启动
  tycho service stop         停止服务（同 tycho stop）
  tycho service status [--json]
                             开机自启与系统服务运行状态；--json 只读结构化输出
  tycho doctor [--fix]       自检；--fix 修掉安装器自己写的、已经过期的东西
  tycho update [--to <版本> | --from <发布包或解开的目录>]
                             默认用本机 gh 登录取稳定发行版；--to 可选预发行版
  tycho restore --from <备份文件或目录>
                             用备份恢复账本（先停服务）
  tycho node <join|run|status|leave|service>
                             把这台机器接到主机上（机器主动连回来）；子命令的说明见 tycho node help
                             装了之后 tycho node service install 让它开机登录后自动连回来
  tycho knowledge-mcp [--node] [--url <地址>]
                             知识 MCP（stdio），给 Claude Code、Codex、dsh、Gemini（agy）挂上；令牌放环境变量
                             TYCHO_KNOWLEDGE_TOKEN。--node 经这台机器接入主机的通道去连
  tycho project-home help    查看环境身份与离线项目移交命令
  tycho project-directory help  管理可直接访问的其他 Tycho 环境
  tycho uninstall            卸载程序，不删数据
  tycho version              版本号
  tycho help                 这段说明

数据目录：环境变量 TYCHO_DATA；没设就是主目录下的 .tycho/host。
```

## 执行节点子命令（`tycho node help`）

```text
tycho node：让这台机器自己连回主机

用法：
  tycho node join --to <主机地址> [--name <名字>]
                             加入：打印一个六位数，在已经登录的控制台上点侧栏的“放行”，
                             输入这个数（配了企业微信也可以在手机卡片上点放行），然后
                             在这个终端里接着运行；要在后台、开机就运行，用
                             tycho node service install。主机就在这台电脑上、--to 填的是
                             本机地址时，不用放行
  tycho node join --to <主机地址> --material-fd <n> [--name <名字>]
                             任务派生的临时机器加入：从文件描述符 n 读一份一次性接入材料
                             （0 是标准输入），不用六位数、不用放行，然后常驻。材料不要写在
                             命令行上。任务结束、这台机器空闲后，它自己注销并退出
  tycho node run [--to <主机地址>] [--name <名字>]
                             用这台机器已经加入过的身份常驻
  tycho node status          这台机器是谁、加入过没有、客户端在不在跑、主机答不答
  tycho node leave           本机注销：不再收活。主机那边的机器还在，删它到控制台删
  tycho node service install|uninstall|start|stop|status
                             把常驻客户端装成开机自启（和主机服务的自启各管各的，同一台
                             电脑两个角色可以都装）

  --log <文件>               把客户端的输出写到这个文件（开机自启就是这么做的）

同一台机器、同一个身份同时只能有一个客户端在跑：第二个会说明已经有一个（进程号），
然后退出。看管进程不归客户端管：客户端重启、升级、被停，正在跑的那一轮照跑。

主机地址填控制台的对外地址（配了门牌就是门牌的 https 地址），也可以填局域网里的
http://地址:端口。这台机器只要能打开这一个地址就行。
```
