# Mac 私有 PostgreSQL 部署

状态：已提供脚本；本文件不是部署成功或跨机器验收证据。执行部署由主负责人协调，勿与其他部署进程并行。仅操作带本工具所有权标签的独立容器和卷；不修改 Tailscale、ACL、Serve 或旧服务。

## 前置检查与配置

执行 `sh mvp/scripts/deploy/postgres-mac.sh inspect`，再检查可用磁盘/内存、`docker ps`、监听端口、Tailscale Serve/Funnel 规则。脚本只简要检查系统/运行时/自身节点，不替代完整环境审核。已报告的 Colima 环境应再次确认；不安装或重置运行时。

在仓库外用户私有目录（0700）创建三个不同的随机密码文件（0600、当前用户所有、至少16字符、单行），分别用于 bootstrap postgres、schema 管理员和日常应用。不要用真实密码作为命令参数或记录终端输出。部署配置仅保存引用：

```json
{
  "secret_file": "/absolute/private/postgres-password",
  "admin_secret_file": "/absolute/private/admin-password",
  "app_secret_file": "/absolute/private/app-password"
}
```

默认 postgres:18、容器 evalme-mvp-postgres、卷 evalme-mvp-postgres-data、127.0.0.1:15432→5432。PG18数据卷挂载 /var/lib/postgresql。允许显式配置 image/container/volume/host/port；拒绝未知键，host仅允许127.0.0.1。不依赖现有 home-server-smoke 服务，不接管同名未知资源。

```sh
sh mvp/scripts/deploy/postgres-mac.sh plan --config /absolute/private/deploy.json
sh mvp/scripts/deploy/postgres-mac.sh apply --config /absolute/private/deploy.json
sh mvp/scripts/deploy/postgres-mac.sh status --config /absolute/private/deploy.json
```

apply 先检查已有容器/卷的所有权和配置摘要。首次拉取官方PG18镜像，初始化 evalme 数据库，创建 evalme_admin / evalme_app。管理员拥有 evalme schema；应用只有 CONNECT、USAGE、SELECT/INSERT；两者默认 search_path=evalme。CLI以admin临时迁移，日常配置只用app。密码通过只读文件挂载或psql stdin传入，不放argv。密码改变时拒绝重跑，需另行明确轮换程序；重跑不改既有业务数据。脚本不承担应用schema迁移。镜像实际digest须记入验收报告；已有容器不会因重跑自动升级。

配置/卷归属冲突停止，不自动清空。失败可能留下带所有权标签的卷/容器，修正问题后同配置重跑。服务由Docker restart策略管理，Colima本身的启动/睡眠条件需要单独确认，不承诺整机重启恢复。

## 私有 Tailscale 接入

脚本仅监听loopback，不自动创建任何转发。负责人单独选择未占用的私有TCP端口，确认当前客户端支持的TCP Serve语法及ACL/grants，使其仅向授权设备转发127.0.0.1:15432；保留既有规则。不得使用Funnel、公网或LAN通配监听。确认来源在PG侧可能表现为本地代理，因此须同时核验tailnet身份规则与PG SCRAM认证；不能把pg_hba来源地址当作原始客户端身份。

apply将pg_hba限制为：容器内Unix socket仅postgres可用（用于工具管理），TCP只允许evalme数据库及admin/app角色并要求SCRAM，其他角色/数据库拒绝；TCP来源范围覆盖容器代理网络，而主机映射仅loopback。在启用远端通道前进一步核验实际代理来源和tailnet规则，验证拒绝无关数据库/角色。不要仅凭密码设置就宣布网络验收通过。PG TLS默认未配置；若仅使用Tailscale加密，需在部署计划明确客户端到Tailscale端点的加密边界、端点到loopback/容器的本机路径，不声称端到端PG TLS已验证。

## 备份、恢复与停止

```sh
sh mvp/scripts/deploy/postgres-mac.sh backup --config /absolute/private/deploy.json --output /absolute/private/backup.sql
sh mvp/scripts/deploy/postgres-mac.sh restore-test --config /absolute/private/deploy.json --input /absolute/private/backup.sql
sh mvp/scripts/deploy/postgres-mac.sh stop --config /absolute/private/deploy.json
sh mvp/scripts/deploy/postgres-mac.sh apply --config /absolute/private/deploy.json
```

备份不覆盖已有文件，以0600创建，含私人学习数据，不能入库。backup同时创建0600的 `.manifest.json`，记录五张业务表与schema_meta按稳定主键排序的行数及行内容SHA-256、备份文件SHA-256。备份前后分别在只读一致事务中取快照；出现变化以BACKUP_CONCURRENT_CHANGE失败并删除本次创建的不完整文件，避免宣称成功。请在写入暂停窗口备份；该检测依赖应用只追加契约，不防有管理权限者在两次快照间改写又还原。restore-test验证备份文件哈希后，仅创建随机临时数据库、恢复并逐表比较行数/哈希，完全相同才输出matched:true，finally删除自身临时库；不覆盖正式库。不输出学习内容。输入只允许自己生成的可信备份，SQL备份不可作为不可信文件执行。stop保留卷。停止前后运行CLI查回并比较规范化数据哈希。

## 真实跨机器证据

A创建任务，B通过自己的CLI+Skill查询并保存真实trial/grade，A查回；B再创建任务，A练习，B查回。两端用相同run-id收集只读结果：

```sh
sh mvp/scripts/deploy/verify-shared-db.sh --cli /absolute/evalme-mvp --config /absolute/private/app.json --run-id unique-run --task-id UUID --trial-id UUID --grade-id UUID
```

工具只输出对象ID/哈希及脱敏机器标识，不捏造作答、不打印私人内容。报告额外记录真实机器/连接目标与Skill调用片段；两个同机进程不能算跨机。无第二台机器时A6待验证。工具本身不确认物理机器独立性或权限拒绝测试。

## 运行状态复核与当前验收边界

apply/status会核对实际端口绑定、数据卷和只读秘密挂载、镜像、网络模式、restart策略及非privileged状态，不能仅凭资源标签判断安全。角色审计检查schema归属、角色属性/继承和应用额外写权限；检测漂移时停止，不能默默扩大权限。stop只要求所有权匹配，允许停止已漂移的本工具实例。

bootstrap postgres是数据库超级用户，仅用于容器内Unix socket管理；容器宿主/Docker管理权限等价于可管理该数据库，不能将同机有Docker权限的账户当作不可信隔离租户。TCP拒绝postgres，只接受日常app或临时迁移admin；admin拥有应用schema，不能持久化为日常CLI连接。服务健康等待60秒，失败后保留归属明确资源供重试。

**用户最新决定：本轮本机交付，真实第二台机器验收延期，尚未验证。** 保留上面的跨机执行步骤供以后使用，本轮不远程登录或尝试连接第二台机器；本机测试不替代A6跨机证明。

## 存储结构 v2 与备份身份

新 CLI 的 `init` 只为新库创建 v2；已有 v1 必须由管理员显式执行 `evalme-mvp db migrate`，先只读 `--dry-run`，备份并更新所有设备后再确认。迁移不修复或删除历史异常数据。受限 schema owner 承担删除函数权限，应用角色不获得通用 DELETE。

v2 的备份/恢复清单增加 `database_identity` 内容校验。恢复保留 database_uuid，因此恢复副本视为同一逻辑数据库；PG 确认令牌还绑定数据库名称，SQLite 还绑定文件规范路径。需要把克隆库作为独立数据库使用时，管理员应在开放访问前更换其 UUID；仅换主机别名不保证确认令牌失效。始终核对交互界面显示的连接目标。

部署脚本重复设置角色授权时排除 database_identity 的 INSERT；权限审计包含列级 UPDATE 和身份 INSERT。备份中的删除函数与触发器由 pg_dump 保存，恢复后仍需用新版 `doctor` 验证完整安全契约。删除题目不会清理历史备份。
