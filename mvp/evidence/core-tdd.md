# 核心 TDD 记录

本文件记录实际执行；不代表六条产品验收均完成。

- 第一轮命令：`node --test mvp/tests/core.test.mjs`。
  - 红：缺少 `mvp/src/core.mjs`，`ERR_MODULE_NOT_FOUND`，见 `core-red.log`。
  - 最小实现：统一业务校验、SQLite/PG driver、五表 schema、不可变任务版本、练习和评价、幂等与事务、证据引用、字面搜索、分页。
  - 绿：SQLite 共享契约 11 项通过，见 `core-green.log`。包括两个独立连接的并发写入和关闭重新打开；不是整机重启。
- 第二轮先新增缺失数据库、未知 schema、非法日历日期及数据库触发器中断事务的用例。
  - 红：缺失数据库被自动创建、2 月 30 日被 Date 规范化，两项失败，见 `core-edge-red.log`。
  - 最小修复：非初始化连接不创建不存在的文件，时间进行日历日期校验。
  - 绿：14 项通过，见 `core-edge-green.log`。注入 task_topics 插入失败后 task 行不存在，证明实际事务回滚。

真实 PostgreSQL、跨进程写入及部署验证将在取得实际环境后另记；上述记录不冒充这些验证。

- 第三轮：评价者 version 缺省测试先失败（`core-evaluator-red.log`），随后允许 null；14 项通过（`core-evaluator-green.log`）。数据库写入时间分别由 SQLite strftime / PostgreSQL clock_timestamp 生成，不使用远端 CLI 时钟。
- 补充实际子进程回归：两个独立 Node 进程同时提交相同请求、同 ID 不同内容、子进程成功提交但丢弃响应后重放，均通过。完整 SQLite 15 项见 `core-process.log`。

- 查询重构：在已有绿测试下，将列表改为数据库端 WHERE、keyset 和 LIMIT，避免全表读入进程；SQLite 回归仍通过。新增真实短暂写锁重试回归。
- Unicode 回归先红后绿：拒绝孤立 UTF-16 代理项，避免两库转换差异损坏原文，见 `core-unicode-red.log` / `core-unicode-green.log`。
- 归属保护先红后绿：无 schema_meta 的外来非空 SQLite 库必须拒绝初始化（SCHEMA_INCOMPATIBLE），原有表/内容保留；随后将检查加强为整个文件字节不变，发现连接时启用 WAL 修改文件头，修复为确认归属或空新库后才启用 WAL。见 `core-ownership-*` 与 `core-foreign-bytes-*`；最终 SQLite 17 项通过。
