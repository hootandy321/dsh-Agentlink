# 手动配置 Codex MCP

[English](manual-configuration.md) | **简体中文**

只有在配置向导无法修改 Codex 配置，或确实需要高级环境变量时，才需要使用这份文档。

Codex 默认从 `~/.codex/config.toml` 读取 MCP server；如果你的环境已经通过 `$CODEX_HOME` 使用自定义 Codex home，则配置文件位于 `$CODEX_HOME/config.toml`。编辑前请先备份。应用、CLI 与 TOML 配置方式也可以参考官方 [Codex MCP 文档](https://developers.openai.com/codex/mcp)。

## 构建并确认路径

在仓库目录执行：

```bash
npm install
npm run build
command -v node
pwd
```

下面的配置需要使用 Node.js 的绝对路径，并在仓库绝对路径后添加 `/dist/index.js`。

## 添加 MCP server

```toml
[mcp_servers.dsh_collab]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/dsh-orchestrator/dist/index.js"]

[mcp_servers.dsh_collab.env]
DSH_HOST_URL = "http://127.0.0.1:3080"
DSH_HOST_VERSION = "0.1.0-rc.6"
DSH_BRIDGE_AGENT_PRESET = "code"

[mcp_servers.dsh_collab.tools.dsh_resolve_approval]
approval_mode = "prompt"
```

请保留 `approval_mode = "prompt"`：DSH approval 可能允许 sandbox escalation，因此 `allow_once` 必须继续由人确认。

修改后需要重启 Codex 桌面应用、重启 IDE extension，或退出并重新打开 CLI。随后通过 `/mcp` 或 Codex 设置确认 `dsh_collab` 已连接。

## 环境变量

- `DSH_HOST_URL` — 官方 Web Host origin；默认 `http://127.0.0.1:3080`
- `DSH_HOME` — 用于推导 bridge home 的 DSH home；默认 `~/.dsh`
- `DSH_BRIDGE_HOME` — task mapping、workspace claim 与 coordination index 的目录覆盖值
- `DSH_REQUEST_TIMEOUT_MS` — unary 请求与 WebSocket 连接超时；默认 30 秒
- `DSH_BRIDGE_AGENT_PRESET` — 可选的已安装 DSH agent preset；省略时跟随 DSH 默认值
- `DSH_BRIDGE_TIME_ZONE` — 用于人机提示的可选 IANA 时区
- `DSH_HOST_VERSION` — 操作方可选声明的 DSH package 版本；不会从 `host.describe.version` 推断
- `DSH_APPROVAL_TIMEOUT_MS` — 默认关闭；启用后，仅在当前 bridge 进程和连接仍存活时尝试一次 best-effort reject
- `DSH_ALLOW_REMOTE_HOST=true` — 显式允许受信任的非 loopback Host

正常委派没有 model 参数。请在 DSH 中配置目标模型；每次委派都会读取 Host 当前的模型路由。

## Host 与版本说明

bridge 采用 connect-only 模式：它不会启动、守护、停止或拥有 `dsh web`。请自行启动 Host：

```bash
dsh web --host 127.0.0.1 --port 3080
npm run doctor
```

当前经过测试的目标是 DSH CLI `0.1.0-rc.6`。在 rc.6 中，`host.describe.version` 会返回占位产品版本 `0.0.1`，它不是 CLI/package 版本。doctor 会分别检查 CLI 版本与 Host capability。

rc.6 Web API 没有 auth token，因此 loopback-only 是安全默认值。远程 URL 必须是用户明确信任的部署，并同时设置 `DSH_ALLOW_REMOTE_HOST=true`。

DSH Orchestrator 不是 DSH Cordis bundle，请不要使用 `dsh plugin --profile ... add ...` 安装。
