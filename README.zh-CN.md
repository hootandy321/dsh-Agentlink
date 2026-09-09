# dsh-Agentlink

![dsh-Agentlink 首图](assets/dsh-agentlink-cover.webp)

[![CI](https://github.com/hootandy321/dsh-Agentlink/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hootandy321/dsh-Agentlink/actions/workflows/ci.yml) [![GitHub Stars](https://img.shields.io/github/stars/hootandy321/dsh-Agentlink?style=flat-square&logo=github)](https://github.com/hootandy321/dsh-Agentlink/stargazers) [![License: MIT](https://img.shields.io/github/license/hootandy321/dsh-Agentlink?style=flat-square)](LICENSE) [![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![DSH plugin](https://img.shields.io/badge/DSH-plugin-4B6BFB?style=flat-square)](https://www.deepseek.com/harness/en/)

[English](README.md) | **简体中文**

dsh-Agentlink 是一个让你直接在原本的 AI 工作工具里调用 DeepSeek Harness（DSH）协作的插件。你的主 agent 可以把实现、调研、调试和长日志整理等任务交给 DSH，再在原有工作流中观察、继续或取消对应会话。当前支持 Codex 与 Claude Code，ZCode 正在适配，OpenCode、Workbuddy 等主流 AI coding 与 agent 工具待后续接入。

## 调用方支持情况

| 调用方 | 状态 | 安装方式或可用性 |
|---|---|---|
| Codex | ✅ 已支持 | `npm run setup` |
| Claude Code | ✅ 已支持 | `npm run setup:claude -- --project /项目的绝对路径` |
| ZCode | 🚧 适配中 | 正在验证适配方式与打包形式 |
| OpenCode | ⏳ 待适配 | 尚不可用 |
| Workbuddy | ⏳ 待适配 | 尚不可用 |

目前只有标记为**已支持**的调用方在本仓库中提供可用安装路径。“适配中”和“待适配”是当前方向，不代表发布承诺。

默认监督只返回短状态；详情由 `include` 选择。相同任务的多次委派可复用 `runId`，并传入主模型 `caller.model`。DSH 右栏来源导航和成本估算由独立的 [DSH 配套插件](dsh-plugin/README.md) 提供。

## 0.2.0 更新内容

`0.2.0` 是调用侧 bridge 的二级版本更新；单独安装的 DSH 配套插件版本为 `0.1.0`。

- **默认减少监督信息。** `dsh_status` 默认只返回监督任务所需的摘要；需要时通过 `include` 选择 `result`、`interactions`、`queue`、`workspace`、`sessions`、`connection`、`recovery` 或 `cost`。`dsh_wait` 默认使用 `attention`，普通工具进度和流式 chunk 不会唤醒主 agent；需要逐步进度时再显式使用 `wakeOn="activity"`。`dsh_tail` 支持按事件、session、有界条数和游标读取，不再每次附带完整 status。
- **调用来源和任务归属。** 一个 `runId` 可以串起多个委派根任务及其 DSH 子 session。每次 submission 都可以带调用方和主模型（`provider`、`id`、`serviceTier`、来源），因此 Codex、Claude Code 等来源可以分组并进行 API 价格对比，同时不改变 DSH 中配置的执行模型。归属不明确或提交重叠时保留为未知，不用最新调用方设置猜测。
- **Claude Code 与 preset 感知安装。** Codex 和 Claude Code 都有独立的安装路径。Claude 安装器将项目 MCP 与 skill 限定在选定项目，分别报告信任、审批和 Host 状态，并保留无关配置。preset 感知路由当前只做只读校验和解析结果报告。
- **DSH 配套插件右栏。** 插件在 DSH 原生 session 详情区域增加 Agentlink 入口，按来源（例如 Codex、Claude Code）→ run → session 组织调用，并通过原生 catalog 打开根 session 和子 session。面板同时展示当前 session、这次完整 run，以及当前 Host 内插件累计的统计。
- **API 价格对比。** 面板使用相同的已观测未缓存输入、缓存读取、缓存写入和输出 token 桶，对比 DSH 执行模型与调用方主模型的 API 价格。这是价格替代试算，不是订阅账单，也不说明主模型实际会使用相同 token。价格未知或 usage 缺失时保留未知，绝不显示为零；DSH 手动续写默认只计 DSH 费用，除非显式登记新的调用方比较关系。
- **官方 DSH 目标版本。** 当前验证目标是官方 npm `latest` 渠道的 DSH `0.1.2-rc.1`。本次更新不以 `0.1.5-alpha.1` 为目标；调用侧 bridge 与 DSH 配套插件分别安装。

> **API 费用对比截图占位** —— 发布审核后可在此放入最终的价格对比截图。
<!-- 建议文件名：assets/agentlink-api-price-comparison.png -->

## 安装

安装前先准备环境：只需要 **Node.js 22+**、一个已支持的调用方（**Codex 或 Claude Code**）和可以正常运行的 **DSH CLI**。先在 DSH 中配置一次你希望使用的模型，之后 dsh-Agentlink 会自动使用当前路由。

### 让你的 AI agent 帮你安装

把下面的仓库地址和指令直接发给 Codex 或其他 coding agent：

```text
请从 https://github.com/hootandy321/dsh-Agentlink 安装 dsh-Agentlink。
先检查 Node.js 22+、DSH CLI 和我的 DSH Web Host，在我确认的目录中 clone；
运行 npm install 和 npm test。Codex 使用 npm run setup -- --yes；Claude Code 使用
npm run setup:claude -- --yes --project /项目的绝对路径。
Claude Code 会安装项目 MCP 入口和随仓库提供的项目 skill；只有在审查已有文件后再使用 --replace 和 --replace-skill。
如果已经存在 dsh_agentlink 或旧版 dsh_collab 配置，先向我展示冲突，再决定是否使用 --replace。
不要替我启动或停止 dsh web，完成后告诉我何时需要重载调用方并完成项目级 MCP 的信任确认。
```

### 手动安装

1. 检查环境。当前经过测试的 DSH CLI 目标是 `0.1.2-rc.1`。

   ```bash
   node --version
   dsh --version
   ```

2. 在独立终端启动官方 DSH Web Host。

   ```bash
   dsh web
   ```

   正式版 Host 启动链接含 token。通过 `DSH_HOST_TOKEN` 环境变量将它提供给 MCP 进程；Host 地址仍只填 origin，详见[手动配置](docs/manual-configuration.zh-CN.md)。

3. 克隆仓库、安装依赖并运行配置向导。

   ```bash
   git clone https://github.com/hootandy321/dsh-Agentlink.git
   cd dsh-Agentlink
   npm install
   ```

4. 配置你使用的调用方。

   Codex：

   ```bash
   npm run setup
   npm run doctor
   ```

   Codex 向导会备份 TOML 配置，并以 `approval_mode = "prompt"` 安装 MCP 入口。重启 Codex 后，通过 `/mcp` 或 Codex 设置确认 `dsh_agentlink` 已连接。需要手动 TOML 配置时，参见[Codex MCP 手动配置](docs/manual-configuration.zh-CN.md)。

   Claude Code 2.1.199 或更高版本：

   ```bash
   npm run setup:claude -- --project /你的项目绝对路径
   cd /你的项目绝对路径
   claude mcp get dsh_agentlink
   ```

   Claude 向导只修改该项目的 `.mcp.json` 和 `.claude/skills/claude-code-dsh/SKILL.md`，并保留其他无关的 server 配置。它会分别报告以下各项：

   - MCP 注册
   - 项目级 MCP 信任状态
   - Claude skill 状态
   - Claude 审批能力
   - DSH permission/sandbox 归属
   - DSH Host 可达性

   在该项目中打开 Claude Code，通过 `/mcp` 批准 pending server；bridge 会把 `dsh_resolve_approval` 标记为必须人工交互。

   无交互使用默认值时增加 `--yes`。需要更新已有 MCP 条目时，请先检查原配置，再增加 `--replace`；需要更新已有的 Claude 项目 skill 时，请先审查后增加 `--replace-skill`；如果要自己管理 skill，则增加 `--no-skill`。两个配置工具都会识别旧版 `dsh_collab`，并且只在得到这次明确的替换授权后迁移为 `dsh_agentlink`。它们不会启动 DSH、不会改变 DSH permission/sandbox 设置，也不会替你重启调用方。

doctor 会以只读方式报告 `DSH_BRIDGE_HOME` 下的 fail-closed 锁位置，且从不清理它们，因此即使存在锁也能安全运行。

当前源码补丁会阻止新的 projection/chunk 洪峰继续扩大 coordination ledger，但不会自动压缩已有的 5 MB 以上 ledger。请保留旧 bridge home 备查；新的委派可以选择独立的 `DSH_BRIDGE_HOME`。对话真源始终是 DSH `session.history`，不是 bridge ledger。保守恢复边界见[已知问题](KNOWN_ISSUES.md)。

根目录 dsh-Agentlink 是调用侧 MCP，不是 DSH Cordis bundle；不要用 `dsh plugin` 安装根目录。`dsh-plugin/` 是另行构建安装的 DSH 配套插件。

## 为什么需要 dsh-Agentlink？

### 利用 DSH 的 Harness 能力

DSH 为复杂任务提供持久 session、工具调用、subagent 和人工监督等能力。dsh-Agentlink 让你的主调用方（当前为 Codex 或 Claude Code）能够与这套独立 harness 讨论并协作，同时不离开原本的工作入口。

![Codex 与 DeepSeek Harness 协作](assets/codex-dsh-collaboration.webp)

*Codex 继续负责规划、讨论和总控，DSH 负责执行 harness、会话与 worker。*

### 不只是再增加一个原生 subagent

原生 subagent 仍属于调用方自己的 agent tree。dsh-Agentlink 接入的是一套由用户配置的独立 harness：会话可以在 DSH Web 持续查看，使用 DSH 自己的 worker 与模型路由，并由主调用方观察、继续或取消。

![dsh-Agentlink 与原生 subagent 对比](assets/dsh-vs-native-subagents.webp)

*主 agent 专注判断和验收，DSH 使用你配置的模型承担更大规模的执行工作。*

### 省时间、也省成本

- **省时间。** 把实现、检索、资料提取和长日志整理等执行型任务交给你在 DSH 中配置的高速模型，例如 DeepSeek V4 路由，主 agent 可以继续规划和验收。
- **省成本。** 把大量执行 token 路由到成本更低的 DeepSeek 模型，可以减少对昂贵主模型的消耗。

实际速度和费用取决于模型、服务商、部署方式、网络与任务本身。完成安装后，你仍然可以像平常一样使用 Codex 或 Claude Code，只在适合交给 DSH 执行时直接让它发起委派即可。

## 如何使用

启动 `dsh web`，并让调用方加载、信任 MCP 配置后，直接用自然语言告诉 Codex 或 Claude Code，例如：

> 使用 dsh-Agentlink，把当前仓库里的这个实现任务委派给 DSH。保持会话在 DSH Web 可见，向我报告进度，任何 approval 都先询问我。

之后调用方可以委派任务、观察事件、继续同一会话、与你一起回答 DSH 的问题，或取消任务。打开 `http://127.0.0.1:3080`，即可在 DSH Web 查看并操作同一个 session。

## MCP 工具

- `dsh_host_status` — 读取 connect-only Host 状态与 capabilities
- `dsh_delegate` — 创建 root session 并排队初始 prompt；默认 detached（`waitSeconds=0`）；`workspaceMode` 是 bridge-local claim，不是 DSH sandbox selector
- `dsh_followup` — 以显式 `mode="queue"|"steer"` 继续同一个 root session；默认 `queue`
- `dsh_continue` — `dsh_followup` 的兼容别名
- `dsh_status` — 默认返回 availability、execution 和 cursor 摘要；通过 `include` 选择结果、交互、启动路由、lineage、连接、费用和 workspace claim semantics
- `dsh_tail` — 使用 bridge task cursor 读取有界事件摘要
- `dsh_wait` — 最多等待 30 秒，默认在需要处理、结束或异常时返回；普通进度需显式选 `wakeOn="activity"`
- `dsh_observe` — `dsh_wait` 的兼容别名；bridge cursor 取代原始 per-session seq cursor
- `dsh_cancel` — `scope="turn"|"queue"`
- `dsh_list` — 列出 task mapping，并附带当前派生状态
- `dsh_answer_question` — 通过 pending question rpcId 提交类型化答案
- `dsh_resolve_approval` — 对 pending approval rpcId 提交 `allow_once|reject`
- `dsh_release_workspace` — 显式释放持久化 workspace claim，但不关闭 DSH session

正常委派没有 model 参数。目标模型只在安装或调整 DSH 时配置。每次 delegate 都会读取 `session.models.current` 并信任 Host 返回的 `routable`；bridge 不会修改模型，也不会根据 catalog group 自行推导 routability。

`dsh_wait` 只观察 bridge 的持久化状态。assistant delta/chunk 帧和顶层 `session/projection` snapshot 会被跳过，因此不会 bump task revision，也不会唤醒 waiter；turn 结束后的完整 final message 仍可通过 status/tail 观察。

## 后续方向

以下内容是计划方向，不代表已经实现或 release 承诺。

1. **更多调用方入口** — 完成 ZCode 支持，再通过共享 Integration Pack 架构接入 OpenCode、Workbuddy、Claude Desktop MCP 等调用方。
2. **Agent 调用与信息传输** — 优化 prompt 组织、上下文打包、输出摘要和压缩策略，同时确保问题、审批、错误和最终答案可靠传输。
3. **支持 DSH 插件能力的 session** — 保留当前面向 preset 型插件的 `agentPreset` 路径，增加只读 preset/能力校验和已解析 preset 的报告；只有真实插件证明需要创建后的类型化初始化时，才引入声明式 session launch profile。
4. **更多集成** — 待共享 Runtime 与调用方兼容性约定稳定后继续扩展。

## 更多文档

- [0.2.0 发布说明](docs/release-0.2.0.zh-CN.md) — 默认精简监督、调用归属、DSH 配套插件和 API 费用对比边界
- [更新记录](CHANGELOG.md) — 调用侧 bridge 和配套插件的版本变更
- [架构与安全模型](docs/architecture.zh-CN.md) — 身份、状态、恢复、审批、取消与工作区协作
- [多调用方扩展架构](docs/caller-integration-architecture.zh-CN.md) — Codex、Claude Code 与后续调用方共享 Runtime 和 Integration Pack 边界
- [插件感知路由需求](docs/plugin-aware-routing-requirements.zh-CN.md) — 面向用户配置的 DSH Harness preset 选择目标、安全边界、验收标准与延期范围
- [插件感知路由架构](docs/plugin-aware-routing-architecture.zh-CN.md) — 热路径 Card Router、冷路径维护流程、DSH 实时校验与分阶段实现
- [验证指南](docs/validation.md) — 兼容性检查与人工验收流程
- [兼容性矩阵](docs/compatibility.md) — 已测试的 DSH 版本与验证证据
- [已知问题](KNOWN_ISSUES.md) — 当前升级与并发运行限制
- [贡献指南](CONTRIBUTING.md)与[安全说明](SECURITY.md)

## 许可证

[MIT](LICENSE)

发布说明：DSH 仍处于 developer preview，本项目是独立社区项目，不代表 DeepSeek 或 OpenAI 官方背书。`0.1.0-alpha.1` 的共享账本问题已纳入 `0.2.0` 发布线修复。升级或并发运行 bridge 前请阅读[已知问题](KNOWN_ISSUES.md)。
