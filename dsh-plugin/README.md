# Agentlink DSH companion

配套包在 DSH 原生右栏标签页提供来源导航和费用预估。目标是 npm `latest`
渠道发布的 `@deepseek-ai/dsh@0.1.5-rc.1`，不依赖 `next` 或 `alpha` 渠道。
调用侧 MCP 和这个 Cordis bundle 分别安装。

## 0.1.0 更新内容

这是与 dsh-Agentlink `0.2.0` 配套的首个 DSH companion 版本：

- 在 DSH session 顶部增加 Agentlink 入口，打开原生右栏标签页，按调用来源、run、root session 和 child session 导航。
- 提供三个费用视角：当前 session、本次 `runId` 涉及的全部 session，以及当前 DSH Host 内所有 Agentlink 调用的累计统计。
- 记录调用方主模型，用同一组已观测 token 对比 DSH 实际模型和主模型的 API 价格；调用方模型只用于比较，不会改变 DSH 的执行路由。
- 将 `input`、`cache read`、`cache write` 和 `output` 分桶计价；未知价格、缺失 usage、无法确认归属的请求保持未知并显示覆盖范围，不按零计算。
- 统计写入 DSH 的原生 `storageDomain`，不保存 prompt、工具正文或 API key；查询按需读取摘要，避免把逐请求明细塞进主 agent。

> **API 费用对比截图占位** —— 可以在此放置 DSH 右栏中 session、run 和累计金额的最终截图。
<!-- 建议文件名：assets/agentlink-api-price-comparison.png -->

## 构建与安装

在仓库的 `dsh-plugin` 目录执行：

```sh
npm ci
npm run check
npm pack
```

开发依赖显式选择 DSH `0.1.5-rc.1` 的配套包，避免 npm 将满足上游 `^0.1.5-rc.1` 的 `next` 渠道 rc.2 包混入检查环境。请使用提交的 lockfile 执行 `npm ci`。

在你要使用的 DSH Host 上，用实际生成的 tgz 绝对路径安装到 Web profile：

```sh
dsh plugin add /absolute/path/dsh-agentlink-dsh-plugin-0.1.0.tgz --profile web
```

如果 Host 使用自定义数据目录，给命令传入同一个 `DSH_HOME`。然后重启该
Host 并刷新网页。不要在有运行中任务时直接重启；升级前先等待已有任务结束。

打开会话顶部 **Agentlink** 按钮：

- **成本**：本 session、同 run 的所有 session、当前 Host 插件累计。
- **调用**：Codex / Claude / 其他来源 → run → 根会话与子会话。
- **右栏首页**：打开 DSH 原生 guide 标签页。
- **关闭**：只关闭当前 Agentlink 标签页；其他右栏标签页保持可用。

来源分组属于插件导航；不会把 Codex/Claude 伪装成工作目录，或改动会话 cwd。
费用是同量 token、同缓存结构的 API 价格试算，不是订阅账单节省。
缺价格、缺 usage、手动续写等情况显示覆盖率和原因，不能当零。

三个费用视角的边界如下：

| 视角 | 统计范围 |
|---|---|
| 当前 session | 当前 session 自己产生的 DSH 请求；子 session 不会重复加到父项 |
| 当前 run | 同一个 `runId` 下已归属的根 session、子 session 和可证明关联的内部请求 |
| 插件累计 | 当前 DSH Host 内所有 Agentlink run 的去重集合；不跨 Host 合并，也不包含普通 DSH 会话 |

“预估节省”是把相同观测 token 桶代入另一套 API 单价后的差值。它不代表
主模型实际重做任务的 token 数，也不代表 Codex 或 Claude Code 的订阅额度。
DSH 手动续写默认只增加 DSH 实际费用；只有显式登记新的 comparison submission
才会进入主模型可比较集合。并发排队无法精确归属时显示不可比较，不使用最新
caller 模型覆盖历史记录。

## 调用归属与模型

桥层在发送 prompt 前登记 invocation/submission。首次调用传：

```json
{
  "caller": {
    "client": "codex",
    "conversationId": "current-task-id",
    "model": {
      "provider": "openai",
      "id": "gpt-6-astra",
      "serviceTier": "standard",
      "source": "caller-reported"
    }
  }
}
```

把回执的 `runId` 传给同一任务启动的其他根会话。每次 followup 都传当次
主模型；未提供就按未知处理，避免模型切换后仍沿用旧价格。
`caller.model` 只用于比较，不改变 DSH 配置的模型。
默认在 DSH `turn/end` 关闭 submission；prompt 被接受并不表示已结束。
原生子会话继承已知提交的归属；结束后的 DSH 手动续写只计 DSH 用量。
同 session 存在多个重叠提交时，尚未精确关联执行队列；对应请求保守显示
不可比较，不会用最新 caller 冒充实际归属。子会话地址取自 Host 原生 catalog，
暂时无法确认地址时保留条目并禁用跳转。
旧 TaskStore 仅回填已经证实的任务映射，不猜测历史调用模型。

## Remote 与存储

Host 提供 `agentlink` Remote namespace。正式版浏览器的 `ctx.remote` 只含
编译时生成的 namespace，因此本插件前端使用同源公开 Remote HTTP carrier：

```text
POST /api/agentlink/summary
{"type":"client-request","rpcId":"<uuid>","method":"agentlink/summary",
 "payload":{"args":{"input":{"sessionId":"<session-id>"}}}}
```

- 写入：`registerInvocation`、`registerSubmission`、`closeSubmission`、`attachSession`。
- 按需读取：`summary({sessionId?, runId?})`、`listRuns({callerClient?, limit?})`、
  `sessions({runId})`、`details({sessionId?, runId?, limit?})`、`prices()`。
- `prices` 的 `args` 是 `{}`；其余方法均用 `args: {input: ...}`。
- 所有请求沿用 DSH Host 认证。summary 不携带每笔请求明细。

记录保存在 DSH 原生 `storageDomain`，只保存归属、usage 与价格信息，
不保存 prompt、工具正文或 API key。持久存储缺失时面板明确显示内存回退。
请求开始时先保存记录，结束时更新同一记录；中断且无 usage 保留为未知。
累计范围是当前 Host，不自动跨机器合并。

## 价格配置

内置官方价格带来源、核对时间与生效范围。自定义 provider/model 需要在
该插件配置的 `prices` 中明确填价，不把第三方路由套成官方价：

```yaml
- id: dsh-agentlink-dsh-plugin
  config:
    prices:
      - priceId: my-provider-small
        provider: my-provider
        model: small
        currency: USD
        checkedAt: '2026-09-09T00:00:00.000Z'
        sourceType: custom
        sourceUrl: 'https://your-provider.example/pricing'
        rates:
          inputUsdPerMillion: '0.22'
          cacheReadUsdPerMillion: '0.007'
          outputUsdPerMillion: '0.66'
```

数值为 USD / 百万 token。价格会按请求实际开始时间、模型与计费层级匹配；
未知模型不会自动套价。reasoning token 已包含在 output 时不重复收费。
DSH 用量桶区分未缓存输入、缓存读、缓存写和输出。

成本计算唯一源码在仓库 `src/cost`；配套包构建时同步到 `src/cost-core`，
编译后随包分发，Host 运行时不依赖仓库上级路径。前端单独构建为普通脚本，
与正式版 `__ModuleLoader__` 加载方式一致。
