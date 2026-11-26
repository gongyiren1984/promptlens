# PromptLens 提示镜

[English](README.en.md) | 中文

本地优先的提示词实验与评估工作台。在本地目录中组织提示词、测试用例、模型配置与评分规则，批量运行可复现的 A/B（及多分支）实验，并生成带证据、成本与耗时的决策报告。

> 当前版本：`0.1.0`（开发预览）。macOS 已产出未签名安装包；Windows / Linux 尚未完成实机验收，详见[平台支持](#平台支持)。

## 为什么用它

- **本地优先**：项目资产、运行记录与报告默认只保存在本机，不上传云端。
- **可复现**：每次运行冻结提示词、用例、模型参数、评分规则与生成参数快照，后续编辑不改变历史结果。
- **证据组合**：规则指标 + 可选 LLM Judge + 成本/耗时/失败情况，不输出没有依据的单一“正确率”。
- **一处核心，三种入口**：桌面 UI、CLI 与 MCP 共用同一套核心能力，不维护三套业务逻辑。

## 功能

- 提示词版本、行级 Diff 与旧版本恢复
- 用例 CSV / JSON / JSONL 原子导入，测试集冻结与跨项目用例库
- 多分支、多模型、多次重复实验，支持重试、指数退避、fallback、预算与取消
- 规则评分、可选 Judge、评分刻度与权重门槛、Judge 一致性提示
- 运行监控（SSE）、三轴状态、成本汇总与 P50/P95
- 9 章节 Markdown 报告，版本不可变，支持脱敏导出
- 项目备份、回收站、只读恢复副本、目录移动后的项目定位
- 跨项目模型库；API Key 写入系统钥匙串（macOS），项目只保存凭据引用
- 实验向导、提示词迭代与优化建议

## 快速开始

### 从源码运行（推荐用于评估）

要求 Node.js >= 24。

```bash
npm ci
npm test          # 单元 / 集成 / HTTP / MCP 契约测试
npm run demo      # 重建 examples/demo/project 并跑完整闭环
npm run dev       # 启动核心 + Vite，打开 http://localhost:5173
```

### 桌面应用

```bash
npm run build:ui      # 构建 WebView 资源
npm run sidecar:build # 生成内置 Node SEA sidecar
npm run tauri:build   # 生成 .app / .dmg（需要 Rust 工具链）
```

macOS 产物当前为 ad-hoc 签名、未公证；跨机器分发前需自行完成签名与公证。

### CLI

```bash
node bin/promptlens.js project create ./my-exp --name "客服实验" --json
node bin/promptlens.js prompts import --project ./my-exp --file prompts.json --json
node bin/promptlens.js cases import --project ./my-exp --file cases.json --set "基础集" --json
node bin/promptlens.js models add --project ./my-exp --name mock-a --provider mock --model-id mock-large --json
node bin/promptlens.js models credential set --from-env OPENAI_API_KEY --name openai
node bin/promptlens.js run start --project ./my-exp --spec experiment.json --json
node bin/promptlens.js report generate <run-id> --project ./my-exp --json
```

### MCP

```bash
node bin/promptlens.js mcp serve --project ./my-exp --scopes project:read,run:read,run:write
node bin/promptlens.js mcp info --project ./my-exp
```

## 平台支持

| 平台 | 状态 | 系统凭据 |
| --- | --- | --- |
| macOS 11+ (arm64) | 已构建并冒烟验证；未签名、未公证 | 支持钥匙串 `keychain:` |
| Windows | 代码路径已实现，未实机验收 | 暂不支持，请使用 `env:` 引用 |
| Linux | 代码路径已实现，未实机验收 | 暂不支持，请使用 `env:` 引用 |

## 文档

- [机器契约](schemas/)：实验规格、CLI 结果、运行轨迹、报告模板、错误码与价格表
- [技术架构与数据模型](docs/05_技术架构设计.md)
- [API / CLI / MCP 集成规范](docs/09_API_CLI与MCP集成规范.md)

## 目录结构

```text
src/core      项目、资产、模型、执行、报告
src/eval      规则与 Judge 评估
src/cli       CLI 命令与 JSON envelope
src/mcp       MCP stdio 服务端与最小客户端
src/server    本地环回 HTTP API
apps/desktop  Tauri 2 + React 19 桌面工作台
packages      contracts 与 api-client
docs          公开的技术与契约设计文档
```

核心 `src/` 不依赖第三方 npm 包；桌面端依赖 React、TanStack Query 与 Tauri。

## 开发与验证

```bash
npm test
npm run typecheck
npm run contracts:check
npm run notices:check
npm run build:ui
```

CI 配置见 [.github/workflows/ci.yml](.github/workflows/ci.yml)。

## 许可

本项目采用双许可：**AGPL-3.0-or-later** 或 **GPL-3.0-or-later**，也可另行签订商业授权。

- [LICENSE](LICENSE)（AGPLv3）
- [LICENSE-GPLv3.txt](LICENSE-GPLv3.txt)
- [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md)

第三方组件许可见应用内「第三方许可」页面。

## 贡献与安全

欢迎通过 Issue 描述问题与使用场景；提交 PR 前建议先沟通方案。安全漏洞请使用 GitHub Security Advisories 私下报告，不要公开 Issue。

## 免责声明

PromptLens 目前为开发预览版本（`0.1.0`），接口、数据格式、功能与行为均可能随时变更，尚未经过生产环境所需的安全性、稳定性、性能与合规验证。

**请勿将本项目用于生产环境、关键业务或任何不可恢复的数据与流程。** 使用本软件即表示你理解并同意：因使用或无法使用本软件而产生的任何直接或间接损失、数据丢失、业务中断、安全事件、合规风险或其他后果，均由使用者自行承担。在适用法律允许的最大范围内，作者与贡献者不提供任何明示或默示的担保，也不承担由此产生的任何责任。

在将本软件用于重要数据或对外服务前，请自行完成数据备份、隔离测试、安全评估与合规审查，并遵守适用的法律法规及第三方服务条款。本软件的许可条款（AGPL-3.0-or-later 或 GPL-3.0-or-later）中关于“按原样提供”与免责的约定同样适用。

## 开发说明

本项目使用 **TRAE** 辅助开发，包括需求整理、代码生成与重构、测试编写以及文档编辑；所有代码与发布内容由维护者负责最终审核。TRAE 不参与软件运行，也不对软件的输出、行为或由此产生的后果承担责任。
