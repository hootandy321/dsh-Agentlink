# 架构与安全模型

[English](architecture.md) | **简体中文**

本文档收纳了从用户向 README 中移出的 bridge 语义，描述当前 `0.1.0-alpha.1` 的行为，不代表永久兼容承诺。

## 定位与 Host 生命周期

DSH Orchestrator 是调用方一侧的 bridge，不是 DSH Cordis bundle。Codex 把它作为本地 STDIO MCP server 启动，bridge 再连接独立运行的官方 DSH Web Host。

bridge 采用 connect-only 模式：它不会启动、守护、停止或拥有 `dsh web`，也不负责 Host pidfile 或端口锁。Host 生命周期由用户或操作系统服务管理，因此单个 Codex MCP 进程退出后，DSH session 仍可留在官方 Web UI 中查看。

## 身份与状态模型

BridgeTask、DSH root session 和 DSH turn 是三种不同对象：

- 一个 BridgeTask 保存一条稳定的 `taskId -> rootSessionId` 映射。
- 一个 root session 可以运行多个 turn；`turn_completed` 不会删除 task，也不会阻止后续 follow-up。
- session-backed DSH subagent descendant 会从 `session.list`/`subagent.list` 中发现并独立 reconcile，在 task ledger 中保留 `parentSessionId` 与 `origin="subagent"`。

状态不会把连接可用性和执行状态压缩成一个枚举：

- `availability`: `connected | host_unreachable | session_not_found`
- `execution`: `starting | running | awaiting_approval | awaiting_input | turn_completed | failed | canceled | interrupted`
- availability 覆盖当前 execution observation 时，公开 `status` 为 `unknown`，同时保留 `lastKnownExecutionStatus`

queue depth 来自最新且完整的 `session/queue` snapshot：

- `nextTurn`: `placement="queued"`
- `steering`: `placement="steering"`
- `context`: `placement="context"`
- `nextStep`: steering 与 context 的合计
- `total`: 全部 pending item

一旦 `events.mux` 断开，queue 状态会立即标记为 stale 或 unknown。

## 事件账本与恢复

DSH session/history 是会话内容的唯一事实来源。bridge 不会把 prompt、用户或 assistant 文本、tool 参数与结果、question body 复制到本地文件。它只在三个彼此分离的 store 中持久化 coordination state：

1. `tasks/<taskId>.json` 只包含 `{taskId, sessionId}`。
2. `claims/<taskId>.json` 包含 canonical cwd、task/session owner、claim mode 和创建时间。
3. `ledgers/<taskId>/events.jsonl` 是可重建的 coordination index，保存 task cursor、lineage、source watermark、无正文的 execution/pending 状态、已发出的 rpcId 和 final-message pointer。

每条 JSONL record 都有单调递增的 task `cursor`/`mergeIndex`、`sourceSessionId`，以及可选的 `sourceSeq`、`parentSessionId`、`origin`、event type 和经过清理的 `coordination` 对象。它不会保存完整 mux/history envelope。`mergeIndex` 只表示 bridge 的观察与持久化顺序，不是 DSH 全局因果顺序。

task ledger append 与 workspace claim 变更使用 task/registry scoped 的跨进程锁。writer 持锁后重新读取磁盘状态，再分配 cursor 或修改 claim。不可变 task mapping 使用原子临时文件加 hard-link 创建。指向同一 `DSH_BRIDGE_HOME` 的 bridge 进程会共享 coordination state，也必须连接同一个 Host；更换 Host origin 时应使用新的 bridge home。

恢复流程采用 subscribe-first：

1. 打开 `events.mux` 并缓冲 live frame。
2. 读取每个 `session/subscribed.lastSeq` watermark；cold session 则以已打开的 stream 作为 fence。
3. 从 `session.history`/`subagent.history` 向后分页，直到已持久化的 per-session high watermark。
4. 按 `(sourceSessionId, sourceSeq)` 排序并做确定性去重。
5. 清空缓冲的 live frame，再对外提供已提交的 task cursor。

rc.6 会忽略 `events.mux.since`，它不是 durable backlog。项目承诺的是**至少一次交付加确定性去重**，不是 exactly-once。无法重建的 gap 返回 `unrecoverable_gap`；过旧 cursor 返回带 `earliestCursor` 的 `cursor_expired`。bridge 不会静默跳过这两类错误。

`dsh_tail` 返回有界 digest 与 `nextCursor`。Host 连接正常时，它在调用时从 `session.history` 解析 source pointer：assistant chunk 会省略或压缩，tool output 会归约，但 question、approval、error、turn outcome 和最终 assistant message 只在响应中完整返回。Host 不可用时返回 `contentUnavailable`，不会从 bridge 副本重建会话内容。

每次 root `turn/end` 时，ledger 只折叠最后一个用户可见的 `assistant/message` pointer（`sessionId + seq`）；`dsh_status` 从在线 history 解析该 pointer。terminal turn 没有 pointer 时返回 `terminal_missing_final`，不会伪装成成功的空结果。

event pump 即使无人调用 tail 也会运行。bridge 重启后从 JSONL 重建 coordination fold，再与权威 DSH history reconcile；不会从 bridge 文件恢复对话正文。

## 问题与审批

`dsh_followup` 不能回答 pending DSH interaction。bridge 持续消费 `events.mux`，并在内存中维护按 rpcId 索引的 pending map。连接正常时，当前 requested frame 会在 `dsh_status` 与 `dsh_tail` 中原样返回，但 question 文本不会持久化。

重连后，rc.6 会以稳定 rpcId replay 仍 pending 的 request。mux baseline quiet period 结束后，之前存在但本次缺失的 request 会收到 coordination tombstone；后续有效 replay 仍可重新打开该 item。这是显式的 rc.6 heuristic capability，不是 Host transaction。

公开接口只提供类型化响应工具：

- `dsh_answer_question(taskId, requestId, answers[])`
- `dsh_resolve_approval(taskId, requestId, outcome="allow_once"|"reject")`

它们验证 rpcId 类型、task/session lineage、question id、顺序与选项，然后只发送一次、不自动重试的 `POST /api/respond` client response。Host carrier receipt 是权威结果：`bad-response` 会保留 pending；`not-pending` 表示它已经被回答、取消、竞争处理或过期。

安全规则：

- bridge 永远不会自动允许 approval。
- 每个 `approval/requested` 都被视为 DSH sandbox escalation。
- `allow_once` 只映射到 wire outcome `allowed-once`，不会修改持久策略。
- 已配置的 timeout 只会在当前进程和连接仍存活时 best-effort reject 一次，不是 Host 级保证。
- 真正无人值守且 fail-closed 的运行应把 DSH approval policy 配置为 `never`；没有 answerer 时仍保持 fail-closed。
- question 必须原样展示，尤其不得替用户推断凭据、发布、release 或其他敏感答案。

## 追问与取消语义

`dsh_followup(mode="queue")` 对应 DSH `next-turn`；`mode="steer"` 对应 `next-step`。queue 会在当前 turn 结束后启动后续 turn；steer 会在当前 turn 的下一步注入指导。两者都不会自动重试写操作。

每次 session mutation 前都会重新读取 `session.list`/history 并 reconcile；follow-up 还会读取 live `session.models`，报告实际 route。mutation tool 接受可选 `sinceCursor` 与 `expectedRevision`。如果 reconcile 后的视图不同，bridge 返回带 observed changes 的 `stale_view`，而不是直接写入。

每次 bridge prompt 生成的 unary rpcId 会作为 coordination metadata 保留；匹配 `user/message.data.source.rpcId` 的消息标记为 `initiatedBy="bridge"`，未匹配消息标记为 `external_or_unknown`。这是 freshness check，不是 transaction；DSH Web 仍可能在 preflight 与写入之间发生 race。

`dsh_cancel(scope="turn")` 调用 rc.6 `session.cancel`，只取消 active root turn，并保留 queued inbox work。内置前台 shell tool 使用 cooperative abort，并在约三秒后把前台 process group 从 SIGTERM 升级到 SIGKILL，但：

- `run_in_background` job 不会被该 turn signal 杀死，需要使用 DSH `job_kill`。
- 第三方 tool 只有在遵守 `AbortSignal` 时才能被取消。

`dsh_cancel(scope="queue")` 使用当前 mux queue snapshot，对每个 item id 发出一次 `session.updateQueue(remove)`。该操作不是原子的，结果会分别列出 `requested`、`removed`、`alreadyClaimed` 和 `failed`，不会承诺 all-or-nothing queue clear。

## 工作区协作

`dsh_delegate` 通过 `realpath` 解析目标 cwd，然后取得持久化 workspace claim。默认是 `exclusive-write`；`read-only` 允许只读任务互相重叠，但任何祖先或后代路径上的 exclusive claim 都会冲突。使用同一 bridge home 的 bridge 进程共享 claim。claim 在 `turn/end` 后仍保留，因为用户可能稍后从 DSH Web 继续该 session。

只有 `dsh_release_workspace` 会释放 claim。释放 claim 不会关闭或取消 DSH session。follow-up、question answer 和 `allow_once` 要求 task claim 仍有效；安全取消与 approval reject 即使没有 claim 仍可用。

workspace claim 是 cooperative coordination。它能阻止同一 bridge store 观察到的冲突 delegation，但不能阻止 DSH Web、另一个 bridge home、Codex、shell 或编辑器直接写文件。task 持有 `exclusive-write` 时，负责监督的 Codex 不得编辑该 cwd。对可写 delegation，独立 git worktree 是推荐的强隔离边界。

如果 DSH session 创建后才发生 claim acquisition race，bridge 会返回指出无 prompt session/task mapping 的 conflict，不会在没有 claim 的情况下静默运行。

## 明确限制

- 不管理 Host 进程生命周期、auth layer、pidfile、port lock，也不会自动启动 Host。
- 不自动重试非幂等写操作，包括 `session.create`、prompt/follow-up、cancel、queue mutation 和 `/api/respond`。
- WebSocket 断开会产生 `host_unreachable`/unknown，不会把 task 误判为失败；只读 reconnect/history recovery 会自动继续。
- Host 重启会丢失 process-local active turn、pending interaction、queue 和 background-job state；bridge 不承诺 seamless continuation。
- fresh history 仍停在 `turn/start`，但 fresh `session.list` 表明 session 已不再运行时，status 会记录不含正文的 `interrupted` coordination marker；后续 durable `turn/end` 会在 reconcile 时覆盖它。
- DSH durable session/history 可以在 Host 重启后保留，但只有创建记录、尚无 event 的 session 可能延迟出现。bridge process-restart mock test 使用带 durable event 的 session；当前实现运行没有做 live rc.6 restart test。
- mux connect 或 reconnect 后，只有 rc.6 发出真实 `session/queue` snapshot，queue state 才能确定；bridge 不会根据 `session/subscribed` 推断空 queue。
- 普通用户创建的 session fork 不会折叠进 BridgeTask；session-backed subagent descendant 会。
- Host-origin affinity 受配置约束，不存储在严格 task mapping 中。更改 `DSH_HOST_URL` 后不要复用旧 `DSH_BRIDGE_HOME`；不支持 per-task cross-Host migration。
- workspace claim 不能提供 OS 级排他，fresh write preflight 也不能消除 Web client 的 TOCTOU race。项目不承诺完整的“多 Codex 加交互式 Web 同时操作无冲突”。
- 不支持 exactly-once delivery、atomic queue clear、`events.mux.since` resume、argument-dependent Codex approval policy、自动取消 background job，或通过 `host.describe.version` 检测 Host package 版本。
- 真实浏览器可见的端到端交互属于 operator acceptance，不是 `npm test` 的组成部分。修改 DSH 版本、model route、agent preset、event reconciliation 或 mutation semantics 后，请执行[验证指南](validation.md)。

当前源码预览中的缺陷与临时处理方式见[已知问题](../KNOWN_ISSUES.md)。
