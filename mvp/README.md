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

远程客户端使用 SELECT/INSERT 应用账号。仅服务端首次建 schema 时临时提供 `--admin-connection-file`；管理员身份不存入运行配置。`ssl` 显式为 `"verify-full"` 或 `false`。false 只用于已确认的 loopback/私有 tailnet，不代表 PG TLS。配置文件及秘密文件均须为 0600 普通文件。

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
