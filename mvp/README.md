# EvalMe MVP CLI

当前实现位于本目录；仓库内旧实现、旧文档与旧示例数据已按用户授权移除；Git 历史已重建为当前 MVP 的新起点。Node.js 24，SQLite 使用内置 `node:sqlite`，PostgreSQL 使用锁定的 `pg` 驱动。无 LLM API 调用；语义评价由兼容 Agent 完成。

## 安装与开始

```sh
cd mvp
npm ci
npm pack
# 在选定安装前缀中安装生成的本地 tgz；不需要发布到公共注册表。
npm install --prefix /absolute/installation /absolute/evalme-mvp-cli-0.1.0.tgz
/absolute/installation/node_modules/.bin/evalme-mvp --version --json
/absolute/installation/node_modules/.bin/evalme-mvp skill install --agent codex --scope user --json
/absolute/installation/node_modules/.bin/evalme-mvp init
```

TTY 初始化支持上下键选择 SQLite/PostgreSQL。SQLite 默认新路径 `~/.local/share/evalme-mvp/evalme.sqlite3`；配置默认 `~/.config/evalme-mvp/config.json`，不读取旧 `EVALME_HOME`。PG 可以逐项填写 host/port/database/user/私有密码文件/TLS，也可读取受保护连接 JSON。重新打开支持 Skills 的宿主会话以发现新安装的 `evalme-mvp`；宿主发现及语义抽查与自动安装测试分开报告。

如果已有配置，新目标需明确确认；非交互使用 `--replace-config`。这只切换连接，不移动或删除数据。

```sh
evalme-mvp init --provider sqlite --path /absolute/data.sqlite3 --config /absolute/config.json --non-interactive --json
evalme-mvp init --provider postgres --connection-file /absolute/app.json --admin-connection-file /absolute/admin.json --config /absolute/config.json --non-interactive --json
```

PG 运行配置使用仅 SELECT/INSERT 身份。schema 尚未创建时临时提供 admin 连接，完成后仅保存应用身份；后续客户端无需管理员。连接文件和秘密文件须为0600普通文件。`ssl` 必须显式为 `"verify-full"` 或 `false`；false 仅用于已确认的 loopback/私有 tailnet 路径，不表示PG TLS已启用。部署说明见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 两条主要流程

1. 学习后触发 Skill：从当前可访问对话提炼题目，经 CLI 保存；可以只有 task，没有 trial/grade；参考答案、评分要点均可缺省。
2. 有空时触发 Skill：查话题与任务、展示题面、真实作答后记录 trial、Agent 评价并提交 grade。复练新增记录；查看旧答案不新增练习。

```sh
evalme-mvp id new --json
evalme-mvp topic list --query 异步 --json
evalme-mvp task create --input /private/request.json --expect-api-version 1 --json
evalme-mvp task list --query 异步 --limit 20 --json
evalme-mvp task get TASK_UUID --prompt-only --json
evalme-mvp trial record --input /private/trial.json --expect-api-version 1 --json
evalme-mvp grade submit --input /private/grade.json --expect-api-version 1 --json
```

请求必须携带由 `id new` 产生的 UUID v4。同ID同内容重试返回原记录；同ID不同内容报冲突。提交结果不明时保留原请求文件并重试，不生成新ID。完整输入例子见 [Skill 输入说明](skills/evalme-mvp/references/inputs.md)；命令概览见 `--help --json`。

所有列表支持 `--limit 1..100` 与 `--cursor`；任务按标签及标题/题面的字面包含匹配。返回游标只适用于原筛选条件，不代表跨请求快照。`trial list --task ID --family` 回看题系全部版本；`grade list --trial ID` 回看评价。题目修订和记录更正均追加新记录，保留证据引用。无替代撤销与删除不在首版。

机器模式 stdout 仅一个JSON对象，错误含稳定 code、退出码及 retryable；不会打印数据库秘密。数字评分、目标距离和复杂推荐不属于本实现。

## 验证

```sh
npm test
# 必须使用独立真实PG测试实例，不能指向含用户数据的库。
EVALME_TEST_PG_CONFIG=/private/test-app.json \
EVALME_TEST_PG_ADMIN_CONFIG=/private/test-admin.json npm run test:pg
```

不传PG配置时普通测试只证明SQLite及本地组件；`test:pg` 缺配置直接失败，不能用SQLite替代。测试用合成学习内容，不证明用户真实掌握。PTY测试需要 Python 3 标准库。产品验收和本轮限制见 [ACCEPTANCE.md](ACCEPTANCE.md)，TDD过程见 [evidence](evidence/)；部署/备份恢复与跨机步骤见部署说明。
