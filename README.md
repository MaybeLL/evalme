# EvalMe MVP

将学习对话沉淀为题目，按话题练习，并保存作答、提示和有依据的评价。Agent 负责理解和评价，CLI 负责验证与持久化；支持 SQLite 与 PostgreSQL。

本仓库仅保留当前 MVP。源码、测试、Skill、部署工具和文档均位于 [`mvp/`](mvp/)。旧实现与示例数据已移除；Git 历史已重建，以当前 MVP 作为新的起点。

## 开始使用

需要 Node.js 24；运行完整终端测试还需要 Python 3。

```sh
cd mvp
npm ci
npm test
node src/cli.mjs --help --json
node src/cli.mjs init
```

- [安装与命令说明](mvp/README.md)
- [PostgreSQL 部署、备份与恢复](mvp/DEPLOYMENT.md)
- [验收结果及尚未验证的范围](mvp/ACCEPTANCE.md)
- [Agent Skill](mvp/skills/evalme-mvp/SKILL.md)

普通 `npm test` 验证本地组件及 SQLite，未配置 PostgreSQL 时相关测试会跳过。真实双库测试需按说明使用独立测试数据库运行 `npm run test:pg`。跨机器验收仍延期，不能将本机测试视为跨机器证明。
