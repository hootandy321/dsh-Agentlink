## Changes

### 新增：ZCode 插件适配（二开说明）

本项目是基于 [hootandy321/dsh-Agentlink](https://github.com/hootandy321/dsh-Agentlink) 的**二次开发**，在保留全部原有 Codex 功能的基础上，新增了以下 ZCode 专属内容：

1. **`.zcode-plugin/plugin.json`** — ZCode 插件 manifest，含 MCP 服务器配置、用户可配置的 DSH Host URL 和 agent preset
2. **`skills/dsh-collab/SKILL.md`** — ZCode 专用协作技能，包含完整的工具调用指南、工作流和安全规则
3. **`scripts/install.ps1`** — ZCode 一键安装脚本，自动检测环境并写入配置
4. **`.github/workflows/sync-upstream.yml`** — 自动同步上游更新的工作流，每 6 小时检查一次

### 新功能：sessionId 参数

- `dsh_delegate` 工具新增可选 `sessionId` 参数，支持复用已有的 DSH 会话
- 适用于需要续接上一次对话的长期任务场景

## 说明

- 本仓库 `main` 分支始终与上游保持同步
- 上游的新功能会自动通过 GitHub Action 同步到本仓库
- 我们的 ZCode 适配文件不受上游影响，始终保留

请原作者审阅，如有问题随时沟通。
