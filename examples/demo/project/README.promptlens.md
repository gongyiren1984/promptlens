# 客服回复质量实验

本目录由 PromptLens 管理。

- `promptlens.project.yaml`：项目清单，请用 PromptLens CLI 或界面修改。
- `.promptlens/`：项目数据库与不可变内容对象，请勿手工编辑。
- `exports/reports/`：按运行归档的 Markdown 报告。

常用命令：

```bash
promptlens project health --project . --json
promptlens run start --project . --spec experiment.json --idempotency-key demo-001 --json
promptlens report generate <run-id> --project . --json
```
