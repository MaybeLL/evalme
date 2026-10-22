# EvalMe CLI 0.2.0

用户安装与两步开始见[主说明](../README.md)。运行时支持 Node 22.16+（22.x）和 24.x。内置 SQLite 在 Node 22 上可能打印实验性提示到 stderr，不影响 stdout JSON 协议。

## 开发与本地安装

```sh
npm ci --ignore-scripts
npm test
sh scripts/install.sh --source "$PWD"
```

源码完整包含 CLI、Skill、两库 Provider、部署脚本和测试。`npm-shrinkwrap.json` 随包分发锁定依赖；修改依赖后须同步更新它与 `package-lock.json`。无需将包发布到 npm。

安装目录：`~/.local/share/evalme-mvp/installation/`，启动入口：`~/.local/bin/evalme-mvp`。入口绑定兼容 Node 绝对路径，Skill 绑定入口。安装不修改 shell 配置。升级保留旧代次直到卸载；配置、数据库不位于受管理程序目录内。

## 初始化与连接

`evalme-mvp init` 提供终端菜单。SQLite 默认 `~/.local/share/evalme-mvp/evalme.sqlite3`；配置默认 `~/.config/evalme-mvp/config.json`。PostgreSQL 可以逐项输入，密码隐藏输入，CLI 自动创建私有凭据。连接/权限/schema 验证失败不替换旧配置，并删除本次临时凭据。重配成功保留先前凭据文件，避免破坏其他配置引用；这些历史凭据不在默认卸载清理范围内。

已有配置切换需确认；非交互需 `--replace-config`，只切换连接，不迁移或删除数据。机器调用仍支持受保护 JSON：

```sh
evalme-mvp init --provider sqlite --path /absolute/data.sqlite3 --config /absolute/config.json --non-interactive --json
evalme-mvp init --provider postgres --connection-file /absolute/app.json --config /absolute/config.json --non-interactive --json
```

远程客户端使用 SELECT/INSERT 应用账号。未建表时，交互向导才询问是否初始化和临时管理用户名/密码；机器调用可显式提供 `--admin-connection-file`。管理身份必须指向同一服务器、端口、数据库及 TLS 设置，且不存入运行配置。`ssl` 显式为 `"verify-full"` 或 `false`。false 只用于已确认的 loopback/私有 tailnet，不代表 PG TLS。配置文件及秘密文件均须为 0600 普通文件。

## Skill 与诊断

```sh
evalme-mvp skill install
evalme-mvp skill install --force
evalme-mvp skill uninstall
evalme-mvp doctor --json
```

默认安装到 `~/.agents/skills/evalme-mvp`。兼容参数 `--agent codex` / `--agent pi` 指向同一共享目录。`--cli-path /absolute/launcher` 可显式绑定入口。修改过的受管理文件默认拒绝覆盖；`--force` 先备份到 `~/.local/share/evalme-mvp/skill-backups/`。未知目录和符号链接不会被强行覆盖。Skill 卸载保留额外用户文件，不修改数据库。安装器只验证文件，Pi/Codex 的真实发现仍需新会话验证。

`doctor` 输出 ready/checks；必需检查失败退出码 5，查询成功退出码 0。外层 ok 表示诊断命令成功执行，data.ready 表示使用环境是否就绪。检查数据库读取及声明权限，不写入合成练习。网络、认证、证书、权限和配置问题分别报告修复建议。

## 学习流程与机器协议

1. 从当前可访问学习对话提炼 task，可以没有参考答案/rubric，也可以尚无 trial/grade。
2. 按话题找 task，仅展示题面。等待真实作答后保存 trial，Agent 评价并提交 grade。复练新增记录，不覆盖历史。

```sh
evalme-mvp id new --json
evalme-mvp topic list --query 异步 --json
evalme-mvp task create --input /private/request.json --expect-api-version 1 --json
evalme-mvp task list --query 异步 --limit 20 --json
evalme-mvp task get TASK_UUID --prompt-only --json
evalme-mvp trial record --input /private/trial.json --expect-api-version 1 --json
evalme-mvp grade submit --input /private/grade.json --expect-api-version 1 --json
```

UUID v4 使用 `id new`。同 ID 同内容重试返回原记录，同 ID 不同内容冲突；提交不明时保留原请求，用原 ID 重试。完整输入见 [Skill 输入说明](skills/evalme-mvp/references/inputs.md)。所有列表支持 `--limit 1..100` 和 `--cursor`，搜索为字面包含/标签；游标绑定筛选条件。`trial list --task ID --family` 查题系历史，`grade list --trial ID` 查评价。

stdout 机器模式只返回一个 JSON 对象，错误具有 code、退出码、retryable；不会打印秘密。CLI 不调用隐藏 LLM。数字评分、目标距离和复杂推荐不在实现范围。

## 升级、卸载与验证

```sh
evalme-mvp upgrade
evalme-mvp uninstall
evalme-mvp uninstall --yes --purge-config
```

仅管理本安装器创建的程序和入口。默认保留配置和数据；purge-config 只清理默认配置和当前引用的自动生成凭据，不清空配置目录、不删除外部密码文件或数据库。使用自定义 `--config` 的文件须自行维护。旧版 npm/手工安装入口先按原方式卸载，不盲目接管。Node 与其他工具均保留。

```sh
npm test
EVALME_TEST_PG_CONFIG=/private/test-app.json \
EVALME_TEST_PG_ADMIN_CONFIG=/private/test-admin.json npm run test:pg
```

真实 PG 测试只用独立测试实例，禁止指向学习数据。PTY 测试需要 Python 3。安装生命周期测试在隔离 HOME 中运行真实打包与安装，需依赖缓存或 npm 网络访问。普通 npm test 缺 PG 时会跳过相关测试，不代表双库通过。


### 数据库状态与故障恢复

普通向导不询问连接 JSON 路径。首次用户默认本机 SQLite；PostgreSQL 会只读检测固定 evalme schema 的表、列、约束、索引、版本和运行时权限。已就绪时不执行 DDL 或授权；完全未初始化时才提供建表。部分对象、未知对象或结构变化会拒绝自动修复。高级显式管理参数也遵守该规则，这是比旧版 CREATE IF NOT EXISTS 更严格的行为。

所有路径在数据库写入前确认旧配置替换，同目标重新输入凭据也需确认。新库仅显式授予 schema_meta SELECT，业务表 SELECT/INSERT；既有 schema_meta INSERT（包含默认授权）仍兼容，不撤销管理员预设权限。管理凭据仅在本次进程内使用；应用凭据验证成功后才保存。

| 错误码 | 退出码 | 下一步 |
| --- | --- | --- |
| SCHEMA_SETUP_REQUIRED | 5 | 运行交互 init，或显式提供管理连接初始化 |
| SCHEMA_INCOMPATIBLE | 5 | 联系管理员检查结构，不自动补表或迁移 |
| SCHEMA_CHECK_FAILED | 5 | 无法可靠检测，请管理员检查目录访问和服务兼容性 |
| DB_NOT_FOUND | 5 | 请管理员先创建目标数据库 |
| DB_PERMISSION_DENIED / UNSAFE_RUNTIME_ROLE | 5 | 管理员修正应用账号权限，再运行 init |
| CONFIG_AUTH_FAILED / DB_TLS_FAILED | 5 | 修正认证或证书配置，再运行 init |
| DB_CONNECTION_FAILED / DB_BUSY | 6 | 检查网络或稍后重试 |
| CONFIG_CONFLICT | 4 | 明确确认替换；机器模式使用 --replace-config |
| CANCELLED | 130 | 原配置保留，可重新运行 init |
| COMMIT_UNKNOWN | 6 | 提交结果未知，重新运行 init 只读检测，不盲目重复建表 |
| INIT_VERIFICATION_FAILED | 5 | 结构已初始化，应用验证失败；检查网络/权限后重新 init，旧配置保留 |
| INIT_CONFIG_SAVE_FAILED | 5 | 结构已初始化，修复本机保存位置后重新 init |

提交之前的初始化失败会回滚建表和授权；提交之后不承诺远端回滚。没有任何失败恢复路径会删除学习数据。权限或管理认证失败可修正后重新运行向导。

结构检测契约由实际 DDL 在一次性测试数据库中生成，当前在 PostgreSQL 18 验证；其他 PostgreSQL 大版本尚未验收。修改 schema 后必须重新生成 `src/providers/postgres-schema-contract.json` 并运行结构一致性测试。开发环境可指定专用测试实例 `EVALME_SETUP_PG_PORT`（127.0.0.1，测试 postgres 账号），运行 `node scripts/dev/schema-contract.mjs`；该命令会创建并删除一个随机测试数据库，不能指向生产服务。

### 删除整道题（存储结构 v2）

```sh
# 任意版本 ID 都代表整个题目系列；终端显示范围，默认取消
evalme-mvp task delete <task-id>
# Agent / 脚本先预览，再提交同次预览返回的令牌
evalme-mvp task delete <task-id> --dry-run --json
evalme-mvp task delete <task-id> --confirm <plan-token> --json --non-interactive
```

删除包括全部题目版本、练习、评价、更正历史和话题关联；保留话题实体、其他题目、配置与凭据。共享 PostgreSQL 的删除影响全部连接设备。不会清理备份，也不提供恢复或单版本删除。

预览返回 `family_id/title/counts/can_delete/blockers`，仅可删除时包含 `plan_token`。异常引用阻止删除，不扩删、不自动清空引用。预览后任何范围或内容变化均返回 `DELETE_PLAN_CHANGED`，须重新预览确认；`--yes`、`--force` 不能跳过删除计划。不存在的题目返回 `NOT_FOUND`。

`COMMIT_UNKNOWN` 或响应丢失时，先查询题目当前状态，仍存在则重新预览；**删除不能采用新增记录的同 ID 自动重试规则**。`DB_BUSY` 表示锁等待超时/冲突，没有确认删除成功。提交前取消会回滚；提交期间断线则不承诺回滚。

### 旧库启用删除能力

新库 `init` 直接建立 v2。既有 v1 的连接、普通读写继续可用，不会自动迁移；`doctor` 另报 `delete_capability.ready=false`。先更新所有设备的 CLI，再备份并显式迁移：

```sh
evalme-mvp db migrate --dry-run --json
evalme-mvp db migrate
# 无终端的 PostgreSQL 管理流程：管理连接与应用连接必须同目标、同 TLS
evalme-mvp db migrate --admin-connection-file /absolute/admin.json --yes --non-interactive --json
```

交互 PostgreSQL 迁移可临时输入管理用户名与隐藏密码，不保存到运行配置。扫描发现历史跨题反馈、无效版本链或更正链时，迁移全部回滚并报告 blockers；不会修写历史记录。v2 重复迁移验证后无操作，未知结构或安全设置漂移拒绝自动修复。

PostgreSQL 的 `evalme` schema 及业务表需由受限管理角色拥有（非应用账号、非超级用户、无 CREATEDB/CREATEROLE）。已有部署的 `evalme_admin` 满足这一角色定位；其他部署由管理员先准备 owner，新库初始化也适用。应用账号仍只获得表 SELECT/INSERT、元数据 SELECT，以及具名预览/删除函数 EXECUTE，不能直接 UPDATE/DELETE/TRUNCATE。

存储结构版本升级至 2，业务记录 `schema_version` 仍为 1。旧 CLI 不兼容 v2。`based_on_grade_id` 只允许同一题目系列，允许跨版本；跨题目反馈不再接受。

结构契约 v1/v2 分别为 `src/providers/postgres-schema-contract.json` / `postgres-schema-v2.json`；v2 生成器为 `scripts/dev/schema-contract-v2.mjs`，仅用于隔离测试服务。完整设计和验收见 [删除设计](../docs/task-deletion-v1-design.md) 与 [TDD 验收](evidence/task-deletion-tdd.md)。
