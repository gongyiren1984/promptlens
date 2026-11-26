# PromptLens

[中文](README.md) | English

A local-first workbench for prompt experimentation and evaluation. Organize prompts, test cases, model configurations, and scoring rules in your own project directories; run reproducible A/B and multi-variant experiments in batches; and generate decision-ready reports backed by evidence, cost, and latency.

> Current version: `0.1.0` (developer preview). A macOS build is available but unsigned; Windows and Linux have not been validated on real hardware. See [Platform support](#platform-support).

## Why PromptLens

- **Local-first**: project assets, run history, and reports stay on your machine by default and are never uploaded to a cloud service.
- **Reproducible**: each run freezes snapshots of prompts, cases, model parameters, scoring rules, and generation settings, so later edits never change historical results.
- **Evidence, not a single score**: rule-based metrics, optional LLM judge results, cost, latency, and failures are reported together instead of a decontextualized "accuracy".
- **One core, three entry points**: the desktop UI, CLI, and MCP server share the same core capabilities rather than maintaining three separate implementations.

## Features

- Prompt versioning, line-level diffs, and restoration of previous versions
- Atomic CSV / JSON / JSONL case import, frozen test sets, and a cross-project case library
- Multi-branch, multi-model, repeated experiments with retries, exponential backoff, fallbacks, budgets, and cancellation
- Rule-based scoring, optional LLM judge, scoring scales and weighted thresholds, and judge consistency warnings
- Live run monitoring (SSE), three-axis status, cost summaries, and P50/P95 latency
- Nine-section Markdown reports with immutable versions and redacted exports
- Project backups, trash, read-only recovery copies, and project relocation
- Cross-project model library; API keys stored in the system keychain (macOS), with projects storing only credential references
- Experiment wizard, prompt iteration, and optimization suggestions

## Quick start

### Run from source (recommended for evaluation)

Requires Node.js >= 24.

```bash
npm ci
npm test          # unit / integration / HTTP / MCP contract tests
npm run demo      # rebuild examples/demo/project and run the full loop
npm run dev       # start the core and Vite at http://localhost:5173
```

### Desktop app

```bash
npm run build:ui      # build WebView assets
npm run sidecar:build # build the bundled Node SEA sidecar
npm run tauri:build   # produce .app / .dmg (requires the Rust toolchain)
```

The current macOS build is ad-hoc signed and not notarized. Complete signing and notarization yourself before distributing it to other machines.

### CLI

```bash
node bin/promptlens.js project create ./my-exp --name "Support experiment" --json
node bin/promptlens.js prompts import --project ./my-exp --file prompts.json --json
node bin/promptlens.js cases import --project ./my-exp --file cases.json --set "Baseline" --json
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

## Platform support

| Platform | Status | System credentials |
| --- | --- | --- |
| macOS 11+ (arm64) | Built and smoke-tested; unsigned and not notarized | Keychain (`keychain:`) supported |
| Windows | Code path implemented; not validated on real hardware | Not yet supported; use `env:` references |
| Linux | Code path implemented; not validated on real hardware | Not yet supported; use `env:` references |

## Documentation

The design and specification documents are currently written in Chinese.

- [Machine-readable contracts](schemas/): experiment specs, CLI results, run traces, report templates, error codes, and pricing
- [Technical architecture and data model](docs/05_技术架构设计.md)
- [API / CLI / MCP integration specification](docs/09_API_CLI与MCP集成规范.md)

## Repository layout

```text
src/core      projects, assets, models, execution, reports
src/eval      rule-based and judge evaluation
src/cli       CLI commands and JSON envelopes
src/mcp       MCP stdio server and minimal client
src/server    local loopback HTTP API
apps/desktop  Tauri 2 + React 19 desktop workbench
packages      contracts and api-client
docs          public technical and contract design documents
```

The core in `src/` has no third-party npm dependencies; the desktop app uses React, TanStack Query, and Tauri.

## Development and verification

```bash
npm test
npm run typecheck
npm run contracts:check
npm run notices:check
npm run build:ui
```

CI configuration: [.github/workflows/ci.yml](.github/workflows/ci.yml).

## License

This project is dual-licensed under **AGPL-3.0-or-later** or **GPL-3.0-or-later**. A separate commercial license is also available.

- [LICENSE](LICENSE) (AGPLv3)
- [LICENSE-GPLv3.txt](LICENSE-GPLv3.txt)
- [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md)

Third-party component notices are available on the in-app "Third-Party Licenses" page.

## Contributing and security

Please describe your problem and use case in an Issue; for pull requests, it is best to discuss the approach first. Report security vulnerabilities privately through GitHub Security Advisories rather than a public Issue.

## Disclaimer

PromptLens is currently a developer preview (`0.1.0`). Its APIs, data formats, features, and behavior may change at any time, and it has not undergone the security, stability, performance, or compliance validation required for production use.

**Do not use this project in production, for critical business operations, or with any data or workflow that cannot be recovered.** By using this software, you acknowledge and agree that you are solely responsible for any direct or indirect loss, data loss, business interruption, security incident, compliance risk, or other consequence arising from the use of, or inability to use, this software. To the maximum extent permitted by applicable law, the authors and contributors provide no warranties, express or implied, and accept no liability for such consequences.

Before using this software with important data or external services, perform your own backups, isolated testing, security assessment, and compliance review, and comply with applicable laws, regulations, and third-party service terms. The "as is" and warranty-disclaimer provisions of the project license (AGPL-3.0-or-later or GPL-3.0-or-later) also apply.

## Development note

This project is developed with the assistance of **TRAE**, including requirements organization, code generation and refactoring, test authoring, and documentation editing. All code and release content are subject to final review by the maintainer. TRAE does not participate in the operation of the software and is not responsible for its output, behavior, or any consequences arising from them.
