# CLI TDD 执行记录

2026-10-21，当前工作区，未提交。

- RED：先创建 `tests/cli.test.mjs`，运行 `node --test mvp/tests/cli.test.mjs`，3 项失败（CLI 文件尚不存在，子进程退出码与协议断言失败）。
- 最小实现：命令解析、JSON 包装、独立配置、ID 生成、SQLite 初始化与业务入口。
- 中间结果：基础无配置/协议测试通过；业务测试在存储模块未完成时仍失败，未跳过。
- 集成发现：真实无标准练习流程的评价因 evaluator.version 必填失败；已交存储负责人修复为可缺省，避免编造版本。

后续完整结果见 ACCEPTANCE.md。此日志只记录实际红/绿过程，不代表人工语义或跨机验收通过。

独立审阅新增 `config-review.test.mjs`：密码空格、非对象配置、输入文件校验顺序、SQLite误用PG参数四项先全部失败，修复后 4/4 通过。测试保留有效秘密原值且不在输出中打印。

真实 PTY 测试：使用 Python 标准库 pty 驱动终端。初跑3/4通过，切换配置缺少确认提示为RED；实现显式目标与[y/N]确认后4/4通过，包括拒绝不创建新库、确认不删除旧库、PG错误保护旧配置。SQLite CLI完整子进程流程与四项配置审阅最终7/7通过。

## 独立审阅：真实 PTY 与 PostgreSQL 菜单

2026-10-21，`mvp/tests/tty.test.mjs` 使用 Python 标准库 pty 启动真实 Node CLI，并按可见提示逐次发送上下箭头、Enter 和输入。最初四项为 3 通过、1 失败：切换 SQLite 目标没有 `[y/N]` 提示而直接 CONFIG_CONFLICT。实现修复后四项通过，覆盖拒绝切换保持配置且不建新库、确认后保存新目标且保留旧库。

新增真实 PG 案例由 `EVALME_TEST_PG_CONFIG` 启用，`EVALME_TEST_PG_ADMIN_CONFIG` 可提供临时初始化身份。首次 sandbox 运行连接被限制，不能作为数据库行为证据；允许访问本机测试服务后，仅提供运行身份得到 SCHEMA_SETUP_REQUIRED（尚未初始化），随后提供临时管理身份运行成功。

```sh
EVALME_TEST_PG_CONFIG=<private-app-connection.json> \
EVALME_TEST_PG_ADMIN_CONFIG=<private-admin-connection.json> \
node --test mvp/tests/tty.test.mjs
```

实际本机服务端口 15433：5 tests / 5 pass / 0 fail / 0 skipped。验证 PG 菜单、初始化、只保存运行身份与 secret_file 引用、不保存密码或管理连接，以及新 CLI 子进程通过保存配置查询成功。无真实跨机器操作，不证明跨机器验收完成。

测试夹具修正：PTY EOF 后子进程可能尚未被 waitpid 观测到，现有限等待其退出，避免将正常退出竞争误记为产品失败。
