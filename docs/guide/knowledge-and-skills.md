# 知识库、技能分发与 MCP

Tycho 内置一套跨会话、跨机器的知识与技能管理体系，让反复踩过的坑和团队 SOP 自动沉淀并在后续任务中生效。

## 一、账本知识库（Knowledge）

所有知识条目保存在主机 SQLite 账本中，支持版本修订与审计追溯，每条知识声明两个核心属性：

- **作用域（Scope）**：全局（所有项目可见），或显式指定的一组项目；并可按职能（Role）进一步收敛。
- **加载方式（Loading）**：
  - **常驻（`resident`）**：每轮执行全文注入上下文（只用于每轮都必须遵守的核心约定）。
  - **按需（`on_demand`）**：只注入标题与触发条件目录，执行器按需读取正文，节省上下文窗口。

知识来源包括控制台手工编写、执行器回执里的 `learned` 提案、项目总控提案，以及外部会话经 Knowledge MCP 提交的提案。派发任务时，Tycho 会把命中的知识修订号冻结到该轮快照中，保证过程完全可追溯。

---

## 二、技能目录与多节点自动镜像（Skills）

Tycho 原生支持标准的 **`<技能名>/SKILL.md`** 目录格式（兼容 `scripts/` 与 `references/` 子目录），只需在主机维护一份正本：

1. 将技能放入主机 `<TYCHO_DATA>/skills/<技能名>/SKILL.md`（支持普通目录、Linux/macOS 符号链接或 Windows Directory Junction）。
   - 推荐将团队或个人技能仓库统一放在 `~/.agents/skills/`，再按需软链到 `~/.tycho/host/skills/<技能名>`：
     ```bash
     # Linux / macOS
     ln -s "$HOME/.agents/skills/my-skill" "$HOME/.tycho/host/skills/my-skill"
     ```
     ```powershell
     # Windows (PowerShell)
     New-Item -ItemType Junction -Path "$HOME/.tycho/host/skills/my-skill" -Target "$HOME/.agents/skills/my-skill"
     ```
2. 打开控制台 **「知识」** 页即可看到自动扫描出的技能，可单独配置 **启用状态、加载方式、作用域、职能** 以及 **允许同步的机器（`machine_ids`）**。
3. **自动同步到远程节点**：主机通过已鉴权的节点通道，将授权给各节点的完整技能包增量镜像到节点本地缓存并自动联接到该机各执行器目录（绝不覆盖节点原有的非托管技能目录）。

---

## 三、为外部 CLI 会话挂载 Knowledge MCP

如果你在 Tycho 之外直接开了 `Claude Code`、`Codex`、`Gemini (agy)` 或 `dsh` 会话，也可以通过只读/提案受限的 **Knowledge MCP** 共享同一个项目知识库（仅开放 `get_working_context`、`search_library`、`read_library`、`propose_learning` 四个工具）。

### 1. 在控制台签发令牌
进入 **「知识」** 页 → **「知识 MCP 客户端」**，填写名称、选择执行器类型与权限（只读 / 读取+提议），复制签发出来的令牌。

### 2. 注册到你的 CLI

在主机本机运行时使用 `tycho knowledge-mcp`；在已接入的远程节点机器上运行时追加 `--node`。

**Claude Code（Linux / macOS）：**

```bash
claude mcp add tycho-knowledge --scope user -e TYCHO_KNOWLEDGE_TOKEN=<你的令牌> -- tycho knowledge-mcp
# 远程节点机器：
claude mcp add tycho-knowledge --scope user -e TYCHO_KNOWLEDGE_TOKEN=<你的令牌> -- tycho knowledge-mcp --node
```

**Codex（`~/.codex/config.toml`）：**

```toml
[mcp_servers.tycho-knowledge]
command = "tycho"
args = ["knowledge-mcp"]   # 远程节点改为 ["knowledge-mcp", "--node"]
env = { TYCHO_KNOWLEDGE_TOKEN = "<你的令牌>" }
```

> **Windows 提示**：Windows 上的 `tycho` 为 `.cmd` 启动器，配置 stdio MCP 时需经 `cmd /c` 启动，例如 `command = "cmd"`、`args = ["/c", "tycho", "knowledge-mcp"]`。

**成功标志**：在外部会话中要求调用 `get_working_context`，能正常返回目标项目的知识条目与修订号。
