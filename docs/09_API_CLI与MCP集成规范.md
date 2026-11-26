# 09 API、CLI 与 MCP 集成规范

## 1. 目标

桌面应用、CLI、MCP 和未来自动化入口必须具有相同的业务语义。外部 Agent 应能完成项目、资产、运行、评估和报告全流程，同时不会因为自然语言错误、重试或断连导致重复任务、超额费用或越权访问。

三项硬要求：

1. 机器消费稳定字段与错误码，不依赖本地化文案。
2. 长任务使用持久化资源 ID，不依赖连接会话。
3. 所有写操作经过权限、校验、预算、版本和审计。

## 2. 集成角色

| 角色 | 连接方式 | 能力 |
| --- | --- | --- |
| 桌面 UI | 本地 IPC | 按本地用户权限访问全部项目 |
| CLI | 本地 IPC；可选进程内核心 | 全功能、非交互自动化 |
| MCP host/Agent | stdio 或已启用的回环 Streamable HTTP | 按 scope 暴露工具和资源 |
| 外部 MCP Server | MCP 客户端连接 | 在授权后提供资源/工具给用户流程 |
| 未来云任务 | HTTPS + 组织权限 | 通过同一应用服务契约，不直接写项目文件 |

## 3. 版本与兼容

### 3.1 API 版本

- 核心 API 路径使用 `/v1`；CLI JSON 和 MCP 工具结果均含 `apiVersion`。
- 同一大版本内只做向后兼容的字段增加；字段删除、语义改变、枚举收窄必须进入下一个大版本。
- 客户端必须忽略未知字段。
- 时间使用 RFC 3339 UTC，例如 `2026-11-25T08:10:00Z`。
- ID 使用大写下划线时间有序标识（ULID）或同等稳定字符串；客户端不得解析 ID 内容推断顺序或类型。
- 金额使用十进制字符串，避免浮点误差：`{"amount":"0.1250","currency":"USD"}`。

### 3.2 幂等

创建 Run、导入批次、导出报告等写请求必须支持 `Idempotency-Key`：

- 同 key、同请求体：返回首次结果；
- 同 key、不同请求体：返回 `STATE_IDEMPOTENCY_CONFLICT`；
- 默认保留 24 小时，项目审计可保留更久；
- CLI 在等待或重试时自动复用同一 key。

## 4. 核心本地 API

### 4.1 传输

- 首选 Unix Domain Socket（macOS/Linux）或 Windows Named Pipe。
- 可选的 loopback HTTP 仅绑定 `127.0.0.1` 或 `::1`，使用随机 Bearer token，token 文件仅当前用户可读。
- 不允许默认绑定 `0.0.0.0`。
- 为桌面实时 UI 提供 Server-Sent Events；断线后客户端按 `runId + afterEventSeq` 重放。

### 4.2 资源端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/health` | 版本、schema、组件健康 |
| GET | `/v1/projects` | 项目列表 |
| POST | `/v1/projects` | 创建或绑定项目 |
| GET | `/v1/projects/{projectId}` | 项目摘要与健康 |
| POST | `/v1/projects/{projectId}/open` | 激活项目并检查 |
| POST | `/v1/projects/{projectId}/attach-directory` | 迁移/修复目录绑定 |
| GET | `/v1/projects/{projectId}/prompts` | 提示词资产 |
| POST | `/v1/projects/{projectId}/prompt-imports` | 导入提示词 |
| GET | `/v1/projects/{projectId}/cases` | 用例与测试集 |
| POST | `/v1/projects/{projectId}/case-imports` | 用例导入预检/提交 |
| POST | `/v1/projects/{projectId}/case-generations` | 生成用例草稿 |
| GET | `/v1/model-connections` | 模型连接与健康 |
| POST | `/v1/model-connections` | 添加连接 |
| POST | `/v1/model-connections/{id}/test` | 测试连接与能力 |
| POST | `/v1/projects/{projectId}/runs/preflight` | 校验并返回快照摘要 |
| POST | `/v1/projects/{projectId}/runs` | 创建并可选择启动 Run |
| GET | `/v1/runs/{runId}` | Run 状态与计数 |
| GET | `/v1/runs/{runId}/trials` | 分页查询 Trial |
| GET | `/v1/runs/{runId}/events` | 事件流或分页事件 |
| POST | `/v1/runs/{runId}/cancel` | 停止指定范围 |
| POST | `/v1/runs/{runId}/retry-failed` | 创建派生 Run |
| POST | `/v1/runs/{runId}/evaluations` | 用指定方案重新评估 |
| GET | `/v1/reports` | 报告列表 |
| POST | `/v1/runs/{runId}/reports` | 生成报告版本 |
| GET | `/v1/reports/{reportId}/content` | 获取报告内容 |
| POST | `/v1/integrations/mcp-servers` | 配置外部 MCP Server |
| GET | `/v1/integrations/capabilities` | 当前权限与可用工具 |

### 4.3 列表分页

使用游标分页：

```json
{
  "items": [],
  "page": {
    "nextCursor": "eyJvZmZzZXQiOjUwfQ",
    "hasMore": true
  }
}
```

不得用页面偏移处理运行中会变化的列表。筛选参数必须进入游标校验，防止同一游标跨筛选条件复用。

## 5. 结果与错误格式

### 5.1 成功结果

```json
{
  "apiVersion": "v1",
  "requestId": "req_01JBZ9...",
  "ok": true,
  "data": {
    "runId": "01JBZA...",
    "status": "queued"
  },
  "warnings": [
    {
      "code": "PRICE_UNKNOWN",
      "message": "模型价格未知，本次成本将标记为不完整。"
    }
  ],
  "error": null,
  "meta": {
    "serverVersion": "1.0.0",
    "completedAt": "2026-11-25T08:12:00Z"
  }
}
```

### 5.2 错误结果

```json
{
  "apiVersion": "v1",
  "requestId": "req_01JBZ9...",
  "ok": false,
  "data": null,
  "warnings": [],
  "error": {
    "code": "RUN_BUDGET_EXCEEDED",
    "message": "预计成本超过本次运行上限。",
    "retryable": false,
    "scope": "run_preflight",
    "details": {
      "limit": {"amount": "5.00", "currency": "USD"},
      "estimated": {"amount": "7.20", "currency": "USD"}
    },
    "remediation": "提高预算、减少试次或更换模型。"
  },
  "meta": {
    "serverVersion": "1.0.0",
    "completedAt": "2026-11-25T08:12:00Z"
  }
}
```

`message` 和 `remediation` 可本地化；自动化只能依赖 `code`、`retryable` 和结构化 `details`。

### 5.3 错误码族

| 前缀 | 范围 |
| --- | --- |
| `AUTH_` | 凭据、scope、项目访问 |
| `VALIDATION_` | 入参、资产、Schema、变量 |
| `NOT_FOUND_` | 项目、版本、Run、报告 |
| `STATE_` | 非法状态转换、版本冻结冲突 |
| `BUDGET_` | 金额、Token、时长、试次限制 |
| `PROVIDER_` | 鉴权、限流、超时、服务不可用 |
| `STORAGE_` | 磁盘、数据库、对象损坏 |
| `INTEGRATION_` | MCP、CLI、连接与协议错误 |
| `INTERNAL_` | 未分类内部错误 |

## 6. CLI 规范

### 6.1 命令结构

```text
promptlens [global-options] <domain> <action> [options]
```

核心命令：

```bash
promptlens project list --json
promptlens project create --name "客服实验" --path ./customer-support --json
promptlens project open 01JBZ8YQ1R2S3T4V5W6X7Y8Z9A --json

promptlens models list --project . --json
promptlens models test <connection-id> --json

promptlens prompts import --project . --file prompts.json --json
promptlens cases import --project . --file cases.jsonl --set "基础集" --json
promptlens cases generate --project . --spec generation.yaml --json

promptlens run preflight --project . --spec experiment.yaml --json
promptlens run start --project . --spec experiment.yaml \
  --idempotency-key exp-20261125-001 --json
promptlens run status <run-id> --json
promptlens run wait <run-id> --timeout 30m --json
promptlens run stop <run-id> --scope all --json
promptlens run retry-failed <run-id> --json

promptlens report generate <run-id> --template standard --json
promptlens report export <report-id> --path ./reports --json

promptlens mcp serve --stdio --scopes project:read,run:read,run:write
promptlens mcp servers list --json
```

### 6.2 全局选项

| 选项 | 语义 |
| --- | --- |
| `--project <id-or-path>` | 明确项目上下文 |
| `--json` | stdout 只输出一个 JSON 结果；日志写 stderr |
| `--no-input` | 禁止交互；缺少输入直接失败 |
| `--dry-run` | 完成校验与变更预览，不提交 |
| `--timeout <duration>` | 整体命令超时 |
| `--idempotency-key <key>` | 写操作幂等 |
| `--output <path>` | 将结果内容写入文件 |
| `--quiet` | 不显示非机器结果 |
| `--verbose` | 诊断日志，仍保持 stdout JSON 纯净 |

### 6.3 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 操作成功 |
| 2 | 参数或命令语法错误 |
| 3 | 校验/前置条件不满足 |
| 4 | 未授权或 scope 不足 |
| 5 | 目标不存在 |
| 6 | 状态冲突或幂等冲突 |
| 7 | 预算、配额或资源限制 |
| 10 | 可重试的操作失败 |
| 11 | 不可重试的操作失败 |
| 12 | 用户取消 |
| 124 | 等待超时，任务可能仍在运行 |
| 130 | 收到中断信号且已请求取消 |

错误族与退出码的固定映射如下；当 `error.retryable` 与错误族默认值冲突时，以 `error.retryable` 为准：

| 错误前缀 | 退出码 |
| --- | --- |
| `AUTH_` | 4 |
| `VALIDATION_` | 3 |
| `NOT_FOUND_` | 5 |
| `STATE_`（含 `STATE_IDEMPOTENCY_CONFLICT`） | 6 |
| `BUDGET_` | 7 |
| `PROVIDER_` 且 `retryable=true` | 10 |
| `PROVIDER_` 且 `retryable=false` | 11 |
| `STORAGE_` / `INTERNAL_` | 11 |
| `INTEGRATION_` | `retryable=true` 为 10，否则 11 |

用户取消固定退出 12，`run wait` 超时固定退出 124，收到中断信号且已请求取消固定退出 130。完整错误码、可重试性与退出码映射见 [error-catalog.json](../schemas/error-catalog.json)。

交互式人性化输出不得破坏这些退出码和 `--json` 契约。

### 6.4 CLI 被 Agent 调用的规则

1. 必须支持 `--no-input --json` 完成无人值守流程。
2. 进度与日志只在 stderr；stdout 始终是单一可解析结果。
3. `run start` 快速返回 `runId`，不长时间阻塞。
4. `run wait` 超时返回 124，同时返回当前状态，不得自动取消任务。
5. 写命令必须提供 dry-run 或预检等价能力。
6. 大批量导入提供批次 ID 和失败样本，不能依赖终端文本解析。

## 7. MCP 协议基线

PromptLens 按 Model Context Protocol 实现，使用 JSON-RPC 2.0，标准传输为：

- stdio：换行分隔的 JSON-RPC；
- Streamable HTTP：单一端点、POST 与请求级 SSE 响应。

协议版本规则（与 MCP 规范一致）：

1. 版本在 `initialize` 请求中由客户端提出，服务端在 `initialize` 结果中确认 `protocolVersion`；无法支持时返回规范错误，不猜测降级。
2. `initialize` 之后，stdio 传输不再逐请求重复携带版本；Streamable HTTP 的后续请求通过 `MCP-Protocol-Version` 头声明版本，缺失时按规范默认规则处理。
3. 客户端能力 `capabilities` 只在 `initialize` 中交换，不逐请求重发。
4. 服务端不得依赖 stdio 进程、SSE 连接或传输会话保存业务状态；跨请求状态必须由显式 ID（`projectId`、`runId`、`cursor`）表达。
5. 支持版本以配置项固定并列入兼容矩阵，默认锁定 `2025-06-18`；新增版本需通过协议兼容测试后才可声明支持。

参考：

- [MCP 架构](https://modelcontextprotocol.io/specification/2025-06-18/architecture)
- [MCP 传输](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP 生命周期](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)

## 8. MCP 服务端角色

### 8.1 工具

| 工具 | 读/写 | 重要参数 | 结果 |
| --- | --- | --- | --- |
| `promptlens_projects_list` | 读 | filter、cursor | 项目摘要 |
| `promptlens_project_get` | 读 | projectId | 项目健康与摘要 |
| `promptlens_prompts_list` | 读 | projectId、cursor | 提示词版本摘要 |
| `promptlens_cases_list` | 读 | projectId、setId、cursor | 用例摘要 |
| `promptlens_run_preflight` | 读/校验 | projectId、spec | 快照摘要、预算、风险 |
| `promptlens_run_start` | 写 | projectId、spec、idempotencyKey | runId |
| `promptlens_run_get` | 读 | runId | 状态、进度、计数 |
| `promptlens_run_events` | 读 | runId、afterSeq | 事件页 |
| `promptlens_run_cancel` | 写敏感 | runId、scope | 新的状态 |
| `promptlens_run_retry_failed` | 写 | runId、selection | 派生 runId |
| `promptlens_report_generate` | 写 | runId、templateId | reportId |
| `promptlens_report_get` | 读 | reportId、format | 内容/资源链接 |
| `promptlens_case_import_preview` | 读 | projectId、source | 解析与错误摘要 |
| `promptlens_case_import_commit` | 写 | previewId、mapping | 导入批次 |
| `promptlens_capabilities_get` | 读 | 无 | scope、版本、限制 |

工具结果使用与 CLI 相同的结果 envelope，并放入 MCP 的兼容结果结构；业务内容不得只存在于自然语言文本块。大内容通过资源链接/分页提供。

### 8.1.1 工具结果映射

每个工具的 MCP `CallToolResult` 固定为：

```json
{
  "content": [
    { "type": "text", "text": "已创建运行 01JBZA...，共 100 个 Trial。" }
  ],
  "structuredContent": { "apiVersion": "v1", "requestId": "req_...", "ok": true, "data": {}, "warnings": [], "error": null, "meta": {} },
  "isError": false
}
```

- `structuredContent` 是唯一权威负载，字段与 CLI `--json` 完全一致，并受 [cli-result.schema.json](../schemas/cli-result.schema.json) 约束。
- `content` 仅供人阅读，只允许对 `structuredContent` 做本地化复述，不得引入新事实。
- `isError` 等于 `envelope.ok` 取反；业务错误使用 envelope 的 `error`，不抛协议层异常。只有未知工具、未知方法、非法 JSON-RPC 才返回协议错误。
- 超过 64 KiB 的正文（报告、逐用例证据）通过 `resource_link` 指向 `promptlens://` 资源，并在 `structuredContent` 给出 `nextCursor`；不得把大文本整段塞入 `content`。
- 结果中禁止出现密钥、完整鉴权头、未脱敏敏感字段；脱敏规则与 UI、CLI 一致。

### 8.2 资源

```text
promptlens://projects/{projectId}/summary
promptlens://projects/{projectId}/runs/{runId}
promptlens://projects/{projectId}/reports/{reportId}
promptlens://projects/{projectId}/cases/{caseId}?version=N
```

资源 URI 是应用层定位符，不是已签名的公网 URL。读取前每次校验项目 scope。

### 8.3 Prompt 模板

可暴露版本化任务模板，例如：

- “对最近 Run 生成受限质量摘要”
- “从失败项提取可复现问题”
- “创建下一轮实验草稿但不启动”

模板只提供说明和参数结构，不自动授予工具权限，也不能包含项目敏感内容。

### 8.4 长任务与确认

- `run_start` 只创建任务并立即返回 `runId`。
- `run_cancel`、永久删除、高预算启动等敏感工具可返回输入请求，要求用户明确确认；适配器需要兼容当前规范中的多轮输入结果。
- 不依赖资源订阅是否可用；Agent 可用 `run_get` 轮询。支持订阅时作为优化，不作为正确性条件。
- 传输断开不取消 Run。调用方通过 `runId` 重新查询。

## 9. MCP 客户端角色

PromptLens 可作为 host/client 连接外部 MCP Server：

1. 用户添加 Server，选择 stdio 或 Streamable HTTP。
2. 显示该 Server 请求的资源、工具、权限和潜在数据外发。
3. 默认只允许读取显式选择的资源，不自动允许外部 Server 调用其工具。
4. 外部 Server 返回的资源进入“待导入素材”，经用户确认后才进入用例库。
5. 需要模型推理时，不依赖已废弃的 sampling/roots 行为作为核心路径。
6. 每个 Server 独立配置作用域、网络、超时、日志与允许的数据类型。
7. 外部工具不得直接操作本地项目；所有写入都必须经过 PromptLens 自身工具/API。

双向不等于双向信任：服务端角色向 Agent 暴露受控能力，客户端角色只消费用户批准的外部能力。

## 10. 权限 scope

| Scope | 能力 |
| --- | --- |
| `project:read` | 读取项目、资产摘要、运行和报告 |
| `assets:read` | 读取提示词/用例原文 |
| `assets:write` | 导入、创建草稿；不能删除无引用历史 |
| `run:read` | 查询运行、事件、Trial |
| `run:write` | 预检和启动运行 |
| `run:cancel` | 停止运行 |
| `eval:read` | 查看评分和证据 |
| `eval:write` | 重新评估、创建评分方案 |
| `report:export` | 生成和导出报告 |
| `admin` | 迁移、凭据、永久删除等高危操作，默认不授予 Agent |

scope 还受项目边界约束。仓库级 token 与项目级 token 不得混为一谈。

## 11. 外部调用示例

预检：

```bash
promptlens run preflight --project . --spec experiment.yaml --no-input --json
```

启动：

```bash
promptlens run start --project . --spec experiment.yaml \
  --idempotency-key exp-20261125-001 --no-input --json
```

成功时 `data.runId` 是后续唯一句柄；调用方不应从日志中抓取 ID。

查询：

```bash
promptlens run status 01JBZA... --no-input --json
```

停止：

```bash
promptlens run stop 01JBZA... --scope all --no-input --json
```

报告：

```bash
promptlens report generate 01JBZA... --template standard --no-input --json
promptlens report export 01JBZR... --path ./reports --no-input --json
```

## 12. 集成验收

- CLI 的同一命令重复执行由幂等键得到同一 Run，不重复计费。
- `--json` 的 stdout 在成功和错误时都能被单一解析器读取。
- 模拟 stdio 断开后 Run 继续执行，重连可查询。
- MCP 请求缺少当前规范所需的版本/能力元数据时返回规范错误，不依赖连接历史猜测。
- 外部 Server 未被授权时不能读取项目资源或调用本地写工具。
- 取消命令后监控 Provider 请求数不再增加。
- 权限不足、资源不存在、预算超限和状态冲突具有不同稳定错误码。

