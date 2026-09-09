# Agentlink 开发记录（2026-09-09）

按已批准的 [开发设计](development-design-2026-09-09.zh-CN.md) 实施。目标版本是 npm latest 渠道的 DSH `0.1.2-rc.1`，不依赖 `0.1.5-alpha.1`。

## 改前与改后

| 场景 | 改前 | 本次行为 |
|---|---|---|
| status | 完整状态、连接与恢复信息混合返回 | 默认监督摘要，调用者用 include 选取详情 |
| wait | 普通 cursor 变化即可返回 | 默认 attention，只在需处理、结束、异常或截止时间返回 |
| tail | 中间过程与完整 status 一起返回 | 按事件类别、session、游标与大小读取；扫描位置独立推进 |
| 调用来源 | 只有 task → session | run 串联多个 task/session，记录 caller 与比较模型 |
| 费用 | 无统一记录 | DSH Host 记录请求 usage，按实际模型与主模型 API 价格比较 |
| 来源导航 | 原生工作目录视图 | 插件右栏中按 Codex/Claude 等来源查看 run/session |

## 验证范围

- 旧协议保留为显式 `DSH_BRIDGE_PROTOCOL=legacy`，默认走正式版 Remote 协议。
- 临时安装目录：`/tmp/agentlink-dsh-rc1-runtime`；临时 Host 数据：`/tmp/agentlink-dsh-rc1-home`。不升级或操作用户原有 Host。
- 已实测正式版认证交换、会话创建、模型目录、历史快照、WebSocket Remote 订阅。
- 正式版认证交换为 303；使用 `DSH_HOST_TOKEN` 换取 HttpOnly cookie。token 不放进 Host URL 配置，不输出到诊断。
- 普通测试覆盖精简返回、等待、恢复和工作区安全措施；成本核心覆盖小金额、缓存、长上下文、峰谷、自定义价格、缺失值、请求去重及价格生效日期。

## 交付检查

- [x] 默认信息减量和按需字段读取
- [x] 成本纯计算与请求级归属类型
- [x] 正式版 Remote 基础适配
- [x] 调用侧 caller/run/submission 接线
- [x] DSH 插件实际加载、持久采集与三层面板
- [x] 正式版 wire 问题/审批、子 session、重连及取消竞态测试
- [x] 全量测试、打包和浏览器验证

“预估节省”指相同观测 token 桶的价格替代试算。它不是订阅账单，也不证明主模型独立完成任务会使用相同 token。未知价格或缺失用量不能当零；失败、取消请求已有的用量仍保留。


## 实际联调结果

隔离的 npm 发布版 Host 上，使用明确选择的本地 fixture adapter，每个请求
提供未缓存输入 100、缓存读 50、输出 20 token。自定义 DSH 价为
0.22 / 0.007 / 0.66 USD 每百万对应 token；比较模型为
`openai/gpt-6-astra` standard。

- 两次 bridge delegate 启动两个根 session，传递相同 runId，得到两笔可比较请求。
- 每笔 DSH 试算 $0.00003555，主模型同量试算 $0.00205，差额 $0.00201445。
- run 的两笔差额 $0.00402890；summary 不含逐请求 requests 数组。
- 在 DSH 手动续写一次后，DSH 已知用量增加到 $0.00010665，但可比较请求仍为 2，差额保持不变。
- 重启隔离 Host 后，session/run/all 的全部汇总对象与重启前相同，无 memory-fallback 标记。
- 前期两次默认模型路由错误的测试请求均留下 errored、usage-missing 记录，累计范围显示部分估算；不声称这两笔有可计费用量。
- 正式版浏览器验证了 Agentlink 按钮、三层费用卡片、来源分组、两根会话跳转、切换后释放插件面板、恢复原生详情及重启后统计。桌面 1440×900 的右栏卡片可见且可滚动。

实测发现并修复了两处发布版兼容问题：前端必须产出普通脚本而非带
`export {}` 的模块；第三方 Remote namespace 不自动进入官方前端生成的
`ctx.remote`，前端改用同源公开 Remote HTTP carrier，沿用 Host 认证。
构建测试会实际执行打包后的普通脚本，读取测试验证 named args 和 rpcId。

## 信息减少的可重复测试

完成状态 + 100 个普通工具事件的 fixture 中，完整状态 JSON 为 1503 bytes，
默认摘要 611 bytes（减少约 59.3%）。对 100 个普通工具事件，attention
模式不提前唤醒，activity 模式唤醒 100 次。这只证明返回大小与唤醒行为，
不等于实测 token 或账单节省。

## 使用与边界

安装方式见 [配套插件说明](../dsh-plugin/README.md) 和
[调用侧配置](manual-configuration.zh-CN.md)。下述联调记录来自隔离测试环境。
来源分组位于插件右栏，原生工作区目录不被改写。
价格是带日期的快照；不认识的模型/路由或缺失用量继续显示未知。

并发注册同一 run 已串行合并，既有 task/session 主键归属不能被后续登记
重映射。重叠排队提交的逐请求归属目前保守显示不可比较，不采用最新模型猜测。
原生子会话跳转通过 Host `subagents.listChildren` 取得 mode 和父子地址；
该分支以正式版服务结构测试验证，完整原生 spawn→child UI 流程尚未实测。


## 最终检查

- 根目录 `npm run check`：101 passed / 0 failed，TypeScript 构建通过。
- `dsh-plugin` 的 `npm run check`：30 passed / 0 failed，Host 和普通脚本构建通过。
- `git diff --check`：通过。
- 最新构建在隔离正式版 Host 重新完成双根会话归属/成本试算和重启持久化检查。
- 根包 dry-run 包含 Remote adapter 与成本核心；配套包实际打包包含 43 个文件，包含 `lib/client.js`、`lib/cost-core`、Cordis patch 与安装说明。
- 安装包：`artifacts/dsh-agentlink-dsh-plugin-0.1.0.tgz`（生成产物，不纳入 Git）。

最后一次实际启动还验证了基础自定义价格可以不填长上下文规则；
修复了 Schemastery 默认空对象导致可选规则被误当必填的兼容问题，并增加回归测试。

