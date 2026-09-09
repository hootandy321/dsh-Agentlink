# dsh-Agentlink 0.2.0 发布说明

本文说明调用侧 bridge `0.2.0` 与配套 DSH 插件 `0.1.0` 的更新范围、使用方式和费用统计边界。两者分别安装、分别发包，但通过 `runId`、调用来源和 session 归属协作。

## 这次更新解决什么问题

此前主 agent 在监督 DSH 任务时容易收到完整状态、普通工具事件和流式中间过程。对于只需要知道“是否结束、是否需要我处理、结果是否可取”的调用方，这些内容会增加上下文和唤醒次数。本次更新把默认路径改成短摘要，并将详细信息变成按需读取；同时把多个 DSH session 归并到一次完整调用过程，交给 DSH 右栏查看费用和来源。

| 范围 | 之前 | 0.2.0 / 0.1.0 |
|---|---|---|
| 状态 | 监督状态与连接、恢复和细节混在一起 | 默认摘要，按 `include` 取指定类别 |
| 等待 | 普通 cursor 变化也可能唤醒主 agent | 默认 `attention`，问题、审批、结束、异常或超时才唤醒 |
| 中间过程 | tail 容易重复完整状态和流式噪声 | 按事件、session、游标和大小读取，扫描游标独立推进 |
| 归属 | 主要是 task → session | `runId` → submission/task → root/child session，并记录 caller/model |
| DSH 查看 | 没有专门的来源和费用视图 | 右栏按来源、run、session 导航，并提供三层费用统计 |

## 调用侧 bridge 的变化

### 默认返回更小

`dsh_status` 默认返回任务监督所需的摘要，包括可达性、执行状态、当前 turn、队列提示、交互数量、结果是否可取、游标和重要异常。需要更多内容时通过 `include` 明确选择：

- `result`：最终结果和可取状态；
- `interactions`：question、approval 等待处理的交互；
- `queue`：排队和 turn 信息；
- `workspace`：工作区 claim 和释放信息；
- `sessions`：根 session、child session 和 lineage；
- `connection`、`recovery`：连接与恢复诊断；
- `cost`：已有的调用归属和费用摘要。

类别互不暗含“返回全部状态”。这样主 agent 可以根据当前问题选择信息量，而不是每次把调试字段、完整历史和中间事件一起接收。

### `wait` 默认关注需要处理的事件

`dsh_wait` 默认使用 `wakeOn="attention"`。任务结束、收到问题或审批、连接/恢复异常以及截止时间到达时返回；普通工具进度、assistant delta、chunk 和 projection snapshot 会在 bridge 内推进观察位置，但不会单独唤醒主 agent。需要进度条或实时过程的调用方可以显式使用 `wakeOn="activity"`。

结束时可以直接取得最终结果；阻塞时返回对应交互；超时时返回短状态和原因。`dsh_observe` 继续作为兼容别名。等待使用 bridge 自己的持久游标，避免调用方重复消费同一个状态。

### `tail` 变成按需诊断通道

`dsh_tail` 支持事件类别、session、游标、条数和字节限制。默认不取用户 prompt、正常工具正文和流式占位事件，也不附带完整 `status`。日志扫描游标与状态最新游标分开：扫描到不匹配事件时仍推进扫描位置，避免分页时反复读取同一段日志。

## 调用来源、模型和 session 归属

- `runId` 表示一次完整调用过程，可以包含多个 delegate 根任务、followup 和 DSH 子 session；它不是一次 MCP 请求，也不等同于整个调用方聊天。
- `taskId` 继续表示 bridge 创建的根任务；`sessionId` 是 DSH 原生 session；一次 submission 表示一次具体 delegate/followup 及其提交时的调用方模型。
- 调用方可以传入 `caller.client`、`caller.conversationId` 和 `caller.model`。模型字段包括 `provider`、`id`、可选 `serviceTier` 与来源；例如 Codex 的 `gpt-6-astra` 或其他已明确报告的主模型。
- `caller.model` 只用于 API 费用比较，不改变 DSH 当前路由，也不因为 DSH catalog 名称相似就自动换模型。
- 同一个完整任务启动多个根 session 时复用已有 `runId`；新的完整任务创建新的 `runId`。followup 可以携带当次主模型，未提供时按未知处理，避免错误继承旧模型价格。
- DSH 原生 child session 会通过 Host 的 parent/child catalog 关联到已知根树。无法确认地址时保留记录但禁用跳转；不会伪造一个子 session 地址。
- 同一 session 存在重叠排队提交而无法精确关联时，对应请求保守标为不可比较；不会用最新的全局 caller 设置覆盖历史请求。

## DSH companion 0.1.0

配套插件面向官方 DSH npm `latest` 渠道中的 `0.1.2-rc.1`。它使用 DSH 原生右侧 details 和 session header action 扩展点，目标是跟随 DSH 当前 session，而不是改写 DSH 的工作目录或项目归属。

右栏包含两个视图：

1. **调用**：调用来源（Codex、Claude Code 等）→ `runId` → root session / child session，并支持打开可确认的原生 session。
2. **成本**：当前 session、本次 run 的全部 session、当前 Host 内 Agentlink 的累计统计。

插件把归属、usage 和价格信息写入 DSH 原生 `storageDomain`，不保存 prompt、工具正文或 API key。请求开始时创建记录，结束时更新同一记录；中断且没有 usage 的记录保留为未知。统计范围是当前 DSH Host，不自动跨机器合并。

## 费用对比的计算方式

费用对比需要同时知道 DSH 请求的实际用量与调用方当时登记的主模型价格。插件按请求实际 provider、model、计费层级和价格生效时间匹配价格，把以下 token 桶分别计价：

- 未缓存输入；
- cache read；
- cache write；
- output（reasoning token 已属于 output 时不重复收费）。

面板展示的是“相同观测 token 下的 API 价格替代试算”：

```text
预估差额 = 调用方主模型 API 价格（同一组 token）
         - DSH 实际模型 API 价格（同一组 token）
```

这不是 Codex 或 Claude Code 的订阅账单，也不证明主 agent 如果独立完成同一任务会消耗完全相同的 token。DSH 手动续写会增加 DSH 实际费用，但没有新的调用方比较登记时不进入可比较的主模型费用集合。

以下情况必须显示未知、部分估算或不可比较，不能当作零：

- DSH adapter 没有返回 usage；
- provider、model、service tier 或价格快照无法匹配；
- 请求归属无法从重叠排队中确认；
- 任务失败或取消，但已有请求只收到部分用量；
- 手动 DSH 续写没有对应的主模型 submission。

三层聚合使用去重的请求记录，不能把父 session 的“含子会话”金额和子 session 金额再次相加。当前 Host 累计不包括普通 DSH 会话；跨 Host 或跨机器的全局汇总不在本版范围内。

## 安装和升级

调用侧 bridge 与 DSH companion 分开安装：

```sh
# 调用侧 bridge
npm install
npm run build
npm run setup

# DSH companion
cd dsh-plugin
npm ci
npm run check
npm pack
dsh plugin add /absolute/path/dsh-agentlink-dsh-plugin-0.1.0.tgz --profile web
```

DSH Web Host 升级到目标版本后，先等待已有任务结束，再重启 Host 并刷新 DSH Web；Codex 或 Claude Code 也要重新加载 MCP 配置。使用自定义 DSH 路由时，需要在插件 `prices` 配置中明确填写 provider、model、计费桶、币种、生效时间和来源，不把第三方路由自动套成官方价格。

本次支持的 DSH 目标是官方 npm `latest` 渠道的 `0.1.2-rc.1`。`0.1.5-alpha.1` 不属于本次目标版本；“latest 渠道”表示安装来源和兼容目标，不把 `rc` 称为无预发布后缀的 GA 版本。

## 验证范围

发布前检查覆盖：

- compact status、按需 `include`、attention/activity wait 和 bounded tail；
- caller、run、submission、root/child session 归属与重连；
- 缓存桶、缺失 usage、未知价格、长上下文、自定义价格和请求去重；
- 正式版 Remote 认证、问题/审批、取消竞态和 DSH companion 打包加载；
- Codex 与 Claude Code 的安装器、skill 写入边界、preset 只读校验和保留无关配置。

当前根目录检查通过 172 个测试，`dsh-plugin` 检查通过 30 个测试；CI 还会执行配套插件的 `npm ci`、`check` 和 `pack`。

## 相关文档

- [英文 README](../README.md)
- [中文 README](../README.zh-CN.md)
- [DSH companion README](../dsh-plugin/README.md)
- [开发实现记录](implementation-2026-09-09.zh-CN.md)
- [开发设计](development-design-2026-09-09.zh-CN.md)
