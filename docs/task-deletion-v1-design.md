# EvalMe 第一版题目删除设计

日期：2026-10-22
状态：设计已实现，已完成隔离测试验收；真实共享库尚未迁移，未执行生产删除。

## 1. 目标与已确认决策

提供通过 CLI 永久删除整道题及其全部练习、评价的能力。用户面对的是一道题，不需要逐条处理版本、练习或评价。

**保留 `based_on_grade_id`，但只允许引用同一个 `family_id` 内的评价，可以跨题目版本，不允许跨题目系列。** 这是用户已确认的决定。

其用途是记录“参考了这道题的既有反馈后再次练习”，不是实现跨题迁移训练。引用反馈不替代 `conditions.hint_status` 等真实作答条件的记录，不得据此把有反馈的作答标为无提示。

既有题目修订、练习更正、评价更正继续追加记录，日常不覆盖旧证据；显式整题删除是新增的数据生命周期操作，不改变上述记录语义。

## 2. 删除范围

命令接受任意版本的 task ID，解析到其 `family_id`，删除整个题目系列。

| 对象 | 第一版处理 |
| --- | --- |
| 同一 family_id 的所有题目版本，包括初始版本 | 删除 |
| 这些版本下的全部练习，包括被更正和更正后的记录 | 删除 |
| 这些练习的全部评价，包括被替代和替代后的记录 | 删除 |
| 上述题目的 task_topics 关联 | 删除 |
| topics 话题实体 | 保留，包括暂时没有题目的话题 |
| 其他题目系列及其练习、评价 | 保留 |
| 配置、凭据、数据库本身、结构版本 | 保留 |
| 已存在的备份或外部导出 | 不自动清理 |

确认界面必须写明“全部版本和关联练习、评价”，而不是只显示某一个版本标题。

第一版不提供单版本删除、单条练习/评价删除、批量删题、自动删除相关其他题目、回收站或恢复命令。永久删除指从当前数据库删除记录，不声称清除了备份、日志或磁盘底层残留。

## 3. 同题系列引用规则

创建练习时，若填写 `based_on_grade_id`，验证完整关系：

```text
当前练习.task_id → 当前题目.family_id
引用评价.trial_id → 来源练习.task_id → 来源题目.family_id
两个 family_id 必须相同
```

- 同题同版本引用：允许。
- 同题不同版本引用：允许。
- 跨题目系列引用：拒绝，返回稳定校验错误，不插入记录。
- 引用不存在的评价：保留不存在错误，不自动清空引用。
- 练习更正保持原 task_id，评价更正保持原 trial_id；保留现有“练习更正不能以自身更正链的评价为反馈”的检查，不因新规则放宽。

校验与插入必须在同一写事务中执行。SQLite 和 PostgreSQL 的 CLI 行为相同。PostgreSQL 还需数据库侧约束触发器或等价的受限写入机制，阻止旧版 CLI 通过现有 INSERT 权限继续写入跨题引用；仅升级客户端校验不足以保护共享数据库。

新规则生效后，正常题目系列应构成独立的删除范围。仍保留跨题引用防御检查，用于识别历史异常数据或绕过 CLI 的写入，不能把“不应该出现”当作“不需要检查”。

## 4. 旧数据检查与迁移

启用新规则之前，只读扫描反馈引用、题目版本链、练习与评价更正链，以及题目系列根的完整性，使用第 6 节的完整阻塞规则。报告仅包含 relation、source_id、target_id、相关 family_id 与计数，不输出作答内容或凭据。

- 没有跨系列引用或异常链关系：可安装新约束与删除能力。
- 存在跨系列引用或异常链关系：阻止此次迁移完成，提供异常清单和明确原因。由用户另行决定如何处理；本设计不授权删除历史记录、重归属题目或清空引用。
- 迁移未完成前，保留原有日常读取和兼容的业务操作；删除命令报告能力尚未安装，不能因新版本 CLI 引入而让旧库整体无法使用。

检查、安装约束与启用能力必须受一致的数据库锁保护。迁移在安装约束前重新检查，防止扫描后又插入跨题数据。约束安装失败则事务回滚，不留下半完成状态。

发布前的只读扫描和正式迁移是不同动作；不得把“没有检查”表述为“现有数据没有跨题引用”。

## 5. CLI 与确认体验

### 交互式删除

```sh
evalme-mvp task delete <task-id>
```

先读取删除计划，再显示：

```text
将永久删除「固定 CLI 的 Node 版本」

目标：共享 PostgreSQL / 数据库 evalme
题目系列：<family-id>
题目版本：3 个
练习记录：12 条
评价记录：15 条

包含全部历史版本和更正记录。
共享数据库上的删除会影响所有连接设备，话题保留。

是否确认？
  ○ 删除题目及关联记录
  ● 取消
```

SQLite 显示实际文件位置；PostgreSQL 显示服务器、端口和数据库名。不得输出密码或完整含凭据连接串。交互取消、Ctrl+C 或默认回车不删除数据。

### 机器模式

```sh
evalme-mvp task delete <task-id> --dry-run --json
evalme-mvp task delete <task-id> --confirm <plan-token> --json
```

以上为已实现的命令协议。`--dry-run` 不修改数据库；检查完成返回 `ok=true`，data 包含 family_id、按类别计数、`can_delete` 和 `blockers`。仅 `can_delete=true` 时提供 plan_token；有阻塞时返回 `can_delete=false`、完整关系诊断且不提供可执行 token。题目不存在或数据库检查失败仍返回错误。标题等展示信息可包含在计划中，但不返回完整作答内容。

交互确认建立在 `can_delete=true` 的计划上。阻塞时显示诊断，不提供删除选项；机器执行时发现阻塞则返回 `DELETE_BLOCKED_REFERENCES`，details 保留结构化 blockers。

`--json` 或 `--non-interactive` 本身不是删除授权。缺少 `--confirm` 时返回确认所需错误及预览用法，不等待 stdin、不执行删除。不提供跳过计划校验的 `--force` 或裸 `--yes`。

plan_token 是 provider-specific 的不透明 SHA-256 摘要，不要求 SQLite 与 PostgreSQL 生成相同 token；两者行为协议一致。摘要输入包括 `task-delete-v1`、provider、结构版本、持久 database_uuid、family_id、完整题目/练习/评价行与 task_topics 关联。按明确的字段顺序和记录主键排序，固定编码和空值表示。包括 payload_hash 但不能只依赖它；直接 SQL 改写内容而未改 payload_hash 也必须使计划失效。不包含保留的 topics 实体内容，不把作答全文输出给客户端。

PostgreSQL 由只读预览函数和删除函数共用的内部计划函数生成规范快照与摘要；使用原生 jsonb 表示、固定 UTC/ISO 日期设置、显式数组排序，不由 JavaScript 重新实现 SQL 的序列化。SQLite 由本地共用计划函数固定 JSON 字段和数组排序，UTF-8 编码后取摘要。规范版本写入 token；实现必须提供非 ASCII、空值、JSON 字段和时间字段的固定测试向量。token 是范围一致性凭据，不替代账号认证，也不代表人的授权。

v2 新增仅管理身份可写的单行 `database_identity(database_uuid)` 元数据，在初始化/迁移时生成。SQLite CLI 同时将数据库规范绝对路径绑定入本地 token；PG 服务端摘要绑定 database_uuid 和 current_database，不绑定客户端主机别名。备份恢复或克隆若保留 UUID，就视为同一个逻辑数据库，不能承诺区分内容完全相同的副本；若希望作为独立库使用，管理员必须在开放访问前更换 UUID。确认界面始终展示实际连接目标，此例外必须在复制/恢复说明中写明。

若预览后新增版本、练习、评价或关联发生变化，返回 `DELETE_PLAN_CHANGED`，要求重新预览和确认，不能静默扩大或缩小删除范围。

Skill 先展示删除范围，再在用户已明确授权的范围内执行。范围变化必须重新确认。用户明确提出删除且已经指定完整范围时，不机械重复索取相同授权；技术层面的计划匹配始终保留。

## 6. 历史跨题引用的处理

预览、执行与迁移审计必须枚举以下关系，不能只检查 `based_on_grade_id`：

| 关系 | 必须满足的边界 |
| --- | --- |
| tasks.family_id | 根必须存在，且根.family_id = 根.id |
| tasks.previous_task_id | 同 family，版本链完整、无环，版本序号连续，初始版本才可无 previous |
| trials.task_id、grades.trial_id | 所属对象存在，按所属题目归入完整删除集合 |
| trials.based_on_grade_id | 同 family，可跨版本 |
| trials.supersedes_trial_id | 相同 task_id，链无环 |
| grades.supersedes_grade_id | 相同 trial_id，链无环 |
| task_topics.task_id | 关联跟随题目删除；topic_id 指向保留的话题 |

对待删集合的所有外键入向边和非话题的出向边进行闭包检查；边界不满足时报告 `relation/source_id/target_id` 和所属 family，不扩删、不置空。包括“其他系列记录引用待删记录”与“待删记录指向其他系列”的历史异常。根或链不可信也阻止删除，不能在异常 family_id 上直接执行。

第一版不提供用删除命令绕过未完成迁移的通道。这是异常数据的防御策略，不意味着继续允许跨题练习。反馈引用的新规则由 PostgreSQL 触发器覆盖 INSERT/相关 UPDATE（包括直接 SQL），触发器查询不到引用目标时拒绝写入；此限制不要求支持在同一事务中先写引用再写评价。其他链规则继续由 CLI 校验并由审计拦截异常，不扩展成一套新的通用写入 API。

## 7. 事务、引用环与并发

题目版本有自引用，练习引用评价，评价又归属练习，采用受控的事务内外键延迟检查，不关闭外键，不清空字段来绕过关联。

事务边界包括：获得锁 → 重新计算计划 → 检查所有边界引用 → 比较 token → 删除完整集合 → 强制完整性检查 → 提交。预览到用户确认之间不持有锁或长期事务。

- PostgreSQL 预览使用 REPEATABLE READ READ ONLY 一致快照（只读 SQL，不获取写表锁），不会拼接多次读取的不同状态。
- PostgreSQL 执行使用 READ COMMITTED；删除函数拒绝其他隔离级别，以免等待锁后仍使用旧快照。先获得现有 `pg_advisory_xact_lock(109539641,1)`，再固定按 `schema_meta → database_identity → topics → tasks → task_topics → trials → grades` 顺序取得 SHARE ROW EXCLUSIVE 表锁；取锁后才计算计划。粗粒度锁阻止同库写入但允许普通读取，适合当前单用户共享库 MVP；锁等待上限 5 秒，超时 DB_BUSY，用户稍后重试。不得在等待用户确认时持锁。
- v1 迁移时 database_identity 尚不存在，先按同一相对顺序锁住现有 schema_meta 和业务表，再在事务内创建并初始化新元数据；v2 删除或检查迁移使用完整锁名单。两条路径均先持有同一 advisory lock。DDL 需要更强锁时在同一事务升级。不能假设 advisory lock 能约束旧客户端或直接 SQL，表锁和外键提供额外保护。遇到直接 SQL 逆序锁导致死锁时回滚并返回 DB_BUSY，不跳过检查。
- v2 将 `tasks.family_id`、`tasks.previous_task_id`、`trials.task_id`、`trials.based_on_grade_id`、`trials.supersedes_trial_id`、`grades.trial_id`、`grades.supersedes_grade_id`、`task_topics.task_id` 的外键设为 DEFERRABLE INITIALLY IMMEDIATE，使用明确约束名。删除函数仅延迟这组约束，删除 task_topics → grades → trials → tasks 的完整集合后，显式恢复这组约束为 IMMEDIATE 强制检查。话题外键不放宽。函数不自行提交；CLI 必须等外层 COMMIT 成功才报告完成。
- SQLite 使用 BEGIN IMMEDIATE、保持 foreign_keys=ON，仅在删除事务执行 PRAGMA defer_foreign_keys=ON，按同序删除并运行 foreign_key_check，失败则回滚；提交/回滚后检查连接的延迟状态已恢复，复用连接不得留下宽松配置。
- 成功才返回删除计数；失败或提交前取消则全部回滚。
- 提交结果因断线不明时返回 `COMMIT_UNKNOWN`，不宣称已删除或已回滚。重新读取题目系列确认当前状态；若仍存在，重新预览，不能直接复用未知结果的操作。
- 已不存在的 task ID 返回 `NOT_FOUND`，不伪造删除计数。第一版不引入保存题目内容的删除日志，也不承诺可查询的删除收据。
- 删除后从 get 返回不存在，list 不再出现相关对象；其他系列及话题保持原样。

## 8. PostgreSQL 最小权限与升级

当前应用身份是 SELECT/INSERT，且 CLI 拒绝通用 DELETE 权限。保留这一边界，新增受限的题目系列删除函数，只授予应用账号该函数的 EXECUTE 权限；不授予任意 UPDATE/DELETE/TRUNCATE 或 schema CREATE。

删除函数只能对显式 family_id 和匹配计划执行，内部固定表与 schema，不接受任意 SQL、表名或删除条件。使用 SECURITY DEFINER：固定 `search_path=pg_catalog,pg_temp`，业务对象始终使用 evalme 全限定名，固定 UTC/ISO 日期设置，撤销 PUBLIC EXECUTE，并在函数内部完成范围、引用和计划检查。只开放具名的 preview/delete 入口，不接受任意动态 SQL；辅助函数不向应用账号开放。

函数所有者不能是应用账号或超级用户。迁移默认使用现有合格的 schema owner（例如受限 evalme_admin）；若该 owner 是超级用户或不满足策略，则提示管理员事先准备具备所需对象权限的受限 owner，CLI 不自动创建角色。迁移连接可以是更高权限管理账号，但必须将函数归属到选定受限 owner。安装函数、设置 owner、撤销 PUBLIC 执行权及授予应用执行权在同一事务完成，避免中间公开窗口。

结构安全契约必须检查函数签名、规范化函数体/定义摘要、SECURITY DEFINER 标志、安全配置、owner 与 ACL（PUBLIC 无执行权；受控 owner 保留固有权限，除此之外仅声明的应用角色拥有显式或继承的有效 EXECUTE，其他普通角色不得获权）；还要检查触发器定义、是否启用及绑定函数、外键可延迟属性和能力元数据权限。不能沿用当前仅按函数/触发器名称匹配的检查。owner 身份按当前数据库角色策略验证，不把部署实例的 OID 写死在代码里；任意替换同名函数或放宽 ACL 都应让删除能力检查失败。

预览由受限只读函数生成，执行函数必须自行验证，不能信任客户端给出的 ID 列表或计数。函数并不建立目前产品没有的多租户隔离：能够操作同一共享库的应用账号，仍可删除该共享库内获授权操作的题目。未来若引入用户归属，需另行设计所有权校验。

首次安装或升级删除能力需要管理员一次性迁移；日常删除不询问管理密码。管理凭据不保存到运行配置。不借机改变其他角色属性或撤销不相关权限。

### 结构版本与迁移入口

正式采用**存储结构版本 2**；业务行的 `schema_version` 继续为 1，不重写已有题目、练习或评价，也不改变其 payload_hash。需要将当前混用的结构版本常量与记录版本常量拆分。v2 的 schema_meta 唯一版本标记为 2，修改原先仅允许 1 的约束；SQLite 可在显式迁移事务重建仅含元数据的 schema_meta，不重建业务内容。

```sh
# 检查结构、历史异常与预计迁移内容，无写入
 evalme-mvp db migrate --dry-run --json
# SQLite：交互确认后迁移；不在普通连接中隐式执行
 evalme-mvp db migrate
# PostgreSQL 高级方式：临时管理员文件，交互确认
 evalme-mvp db migrate --admin-connection-file /absolute/admin.json
# 机器执行迁移需明确 --yes；事务内仍重新审计，不清理异常数据
 evalme-mvp db migrate --admin-connection-file /absolute/admin.json --yes --non-interactive --json
```

普通 PostgreSQL 迁移也可在确认后提示临时管理用户名/隐藏密码，不要求用户编写 JSON；复用现有同目标/TLS 校验，不保存管理凭据。--yes 仅适用于显式结构迁移，不适用于 task delete。v2 重复迁移为验证后无操作；未知版本或漂移拒绝自动修复。

| 客户端 / 存储结构 | 行为 |
| --- | --- |
| 新 CLI / v1 | 普通读写可用，新增练习执行同系列规则；删除返回 DELETE_CAPABILITY_REQUIRED 并提示 db migrate；不自动 DDL |
| 新 CLI / v2 | 普通读写和删除可用，结构、函数和权限均需符合契约 |
| 旧 CLI / v2 | 不保证可用，当前旧核心会因版本 2 拒绝正常业务；迁移前协调所有设备更新 |

`doctor.ready` 在兼容 v1 下仍表示日常使用就绪；增加独立的 `delete_capability` 对象（ready、reason、next），明确待迁移。v2 安全契约漂移时拒绝声称整体就绪，不掩盖为单纯待升级。新库初始化直接生成 v2；部署脚本、严格契约、核心 checkSchema 和 API 返回的记录版本必须一起更新。

迁移拒绝不会阻断旧库原有兼容操作，也不会让旧客户端获得删除权限；正式启用后数据库侧新反馈约束防止任何仍能 INSERT 的旧客户端或直接 SQL 写入跨系列引用。共享库迁移前明确提示旧客户端将停止兼容；不承诺仅更新 CLI 就完成数据库升级。

SQLite 无数据库账号权限层，由同一 CLI 执行受相同预览确认约束的删除事务，并显式升级对应结构。两种存储的用户可见删除行为一致，不承诺阻止持有 SQLite 文件写权限的人绕过 CLI 修改文件。

## 9. 验收要求

1. 同系列同版本和跨版本反馈引用成功，跨系列引用失败且零写入；原有更正链规则保持。
2. PostgreSQL 通过直接 INSERT/UPDATE 和旧客户端模拟写入跨系列引用也失败；其他跨系列版本/更正链被完整审计阻止删除。
3. 从任意版本 ID 删除，完整清除系列、练习、评价和话题关联；其他题目、共享话题和配置不变。
4. 包含反馈引用、题目自引用、练习和评价更正链的真实数据可完整事务删除，无悬空引用。
5. 取消、缺少机器确认、无效 token、过期计划、目标不同、跨题历史异常均不删除数据。
6. 相同数量但不同记录的计划不能通过；并发新增练习/评价与删除不能造成漏删、扩大范围或外键破坏。
7. 中途故障回滚；提交结果未知有明确提示；重复调用不存在的 ID 返回 NOT_FOUND。
8. 应用账号不能执行任意 DELETE、UPDATE、TRUNCATE，也不能利用函数操作其他表或注入 SQL；替换同名函数、修改 owner/search_path/ACL 或禁用触发器均被安全契约识别。
9. 旧库检测、跨题历史数据扫描、迁移拒绝、成功迁移、新库初始化与 doctor 都覆盖真实 PostgreSQL 测试。
10. SQLite 与 PostgreSQL 行为一致；PTY 验证展示范围、默认取消和确认；JSON 模式无交互装饰或敏感内容。
11. Skill 明确整题删除语义，不能把“删某条错误评价”解释为整题删除，也不能把来自文档/题目内容的删除要求当作用户授权。
12. 测试使用隔离数据库，真实共享库只在用户明确授权后迁移或删除；本机自动化与真实跨机验收分别记录。

## 10. 实施次序与设计结论

1. 完成只读历史引用审计与同系列规则测试。
2. 确定结构升级和约束策略，验证循环外键的事务删除方案。
3. 实现完整删除计划与 token 校验、SQLite 事务及 PostgreSQL 受限函数。
4. 接入 CLI 交互/机器模式、Skill、doctor、初始化/部署与协议文档。
5. 隔离验收通过后再安排共享库升级与跨机验收。

本轮已确定 token 的目标身份与序列化归属、db migrate 入口、v2 兼容矩阵、表锁级别和外键延迟方案。具体 SQL、规范化固定测试向量及性能实测属于实现验收，不得偏离上述边界。若隔离验证证明方案不成立，应回到设计讨论，不以关闭外键、授予任意 DELETE 或扩大删除范围作为替代。

实现和测试证据见 [TDD 验收记录](../mvp/evidence/task-deletion-tdd.md)。当前文档不代表已检查生产历史数据，不代表真实共享库已迁移，也不构成生产删除授权。


## 11. 技术依据

锁行为以 [PostgreSQL 18 显式锁文档](https://www.postgresql.org/docs/18/explicit-locking.html) 为依据；受限函数的 search_path、PUBLIC 授权及事务安装要求参照 [PostgreSQL CREATE FUNCTION](https://www.postgresql.org/docs/current/sql-createfunction.html)。SQLite 的事务级延迟外键检查及提交/回滚后重置行为参照 [SQLite PRAGMA](https://www.sqlite.org/pragma.html#pragma_defer_foreign_keys)。这些资料支撑机制选择，不代替实现后的隔离数据库测试。

独立审查过程与最终结论见 [Review 记录](task-deletion-v1-review.md)。
