# Pull Request 审查指南

本仓库使用两层互补的审查机制。GitHub Actions 会对每个 Pull Request 运行确定性检查，包括来自 fork 的 PR；仓库启用 Codex 自动 Code Review 后，Codex 会对进入可审查状态的 PR 做语义审查。最终是否合并仍由维护者决定；自动化不会批准 DSH sandbox escalation，也不会自动合并 PR。

英文版是权威文档；中文版应与其保持语义一致。

## 仓库设置

1. 将仓库连接到 Codex cloud。
2. 打开 Codex 设置，为 `hootandy321/dsh-Agentlink` 启用 **Code review**，并打开 **Automatic reviews**。
3. 在 main 分支保护中继续要求名为 `check` 的检查通过，并要求分支与 `main` 保持最新。
4. 修改 [`AGENTS.md`](../AGENTS.md) 中的规则后，创建一个有代表性的 PR，并使用 `@codex review` 验证规则能产出有价值、低噪声的结果。

自动 review 是账号/仓库设置，不依赖 workflow secret。不要为了重复这项能力而添加 API key 或高权限的 `pull_request_target` workflow。

## 每个 PR 会运行什么

PR 被创建、重新打开、更新或从 draft 标记为 ready 时，都会触发 `CI` workflow。对于 fork PR，它只获得只读 GitHub token，不会获得仓库 secrets，然后运行：

```bash
npm ci
npm run check
npm pack --dry-run --ignore-scripts
```

GitHub 当前会要求维护者批准首次外部贡献者的第一次 Actions 运行。该 PR 仍会创建 workflow run，但确定性检查需要等待这项仓库级防滥用审批；不要仅为了少点一次按钮就削弱这项保护。

Codex 会审查 PR diff，并遵循 `AGENTS.md` 中仓库专用的 `## Code Review Rules`。Automatic reviews 覆盖新进入可审查状态的 PR，并有意只在 GitHub 上报告严重的 P0/P1 问题。实现或审查规则有明显调整后，可以在 PR 评论中发送 `@codex review`，请求再次审查。

## 人工审查流程

1. **确认意图和范围。** 阅读 issue、PR 描述、变更文件和依赖/lockfile 变化；拒绝无关重构或隐藏的生成物。
2. **追踪关键行为。** 视变更范围沿 MCP frontend、共享 service、DSH backend、持久化和 setup 边界检查，并覆盖失败、重连、取消和多进程竞争，而不只看成功路径。
3. **应用仓库约束。** 重点检查 connect-only Host 生命周期、对话内容不落盘、approval 必须由人把关、mutation 前读取实时 Host 状态、cursor 可恢复，以及所有 caller 共用一套 Runtime。
4. **核验证据。** 对外部可见行为要求聚焦的回归测试。可确定的协议行为用 mock Host 测试；依赖真实 DSH 版本的结论按验证指南提供现场证据。
5. **划分严重度。** 可利用的安全问题、数据泄漏、状态损坏、问题或审批丢失、错误取消、恢复失败和已记录的兼容性回归应阻塞合并；风格偏好和推测性的重设计不阻塞。
6. **修复并重跑。** 更新分支，等待 required `check` 通过；必要时重新请求 Codex review；只有代码或解释真正解决问题后才 resolve review thread。

## 外部 PR 的安全边界

CI workflow 有意使用 `pull_request` 和 `contents: read`。它会执行贡献者可控的 package scripts 与测试，但 fork PR 不会获得仓库 secrets 或写 token。禁止改成在 `pull_request_target`、`workflow_run`、携带 secrets 的 job，或暴露维护者本地 DSH 凭据的机器上执行 PR 代码。

以后如果引入独立 review bot，它必须保持 advisory、使用最小权限，把标题、正文、文件名和 patch 都视为不可信输入，并且永不自动 approve 或 merge。

## 手动命令

```bash
npm ci
npm run check
npm pack --dry-run --ignore-scripts
```

涉及 DSH 兼容性的变更还必须遵循 [`docs/validation.md`](validation.md)，并记录准确的 DSH 版本和现场证据。
