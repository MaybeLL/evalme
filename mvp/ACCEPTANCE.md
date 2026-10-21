# MVP 本机交付与验收记录

原始本机验收日期：2026-10-21（以下记录清理前验证）。实现版本：evalme-mvp-cli 0.1.0，已完成本机验证；随后用户明确授权公开、清理旧文件与旧数据，并以当前 MVP 重建 Git 历史。新实现仍位于 `mvp/`。

**本机实现、部署和自动验证已完成；六项产品验收并非全部通过。真实第二台机器验收由用户决定延期，尚未验证。** 合成场景不证明真实用户掌握，手动读取安装 Skill 不证明宿主新会话自动发现。

## 当前可用入口

- CLI：`/home/example/.local/bin/evalme-mvp`，独立本地 npm 包安装在 `~/.local/share/evalme-mvp/cli/`。
- Codex Skill：`~/.agents/skills/evalme-mvp/SKILL.md`，经已安装 CLI 安装并重复安装，第二次返回 replayed；官方 quick_validate 返回 `Skill is valid!`。
- 默认配置：`~/.config/evalme-mvp/config.json`，仅保存运行账号连接，正式数据库目前没有学习任务。
- PostgreSQL：`127.0.0.1:15432`，数据库/schema `evalme`，运行账号 `evalme_app`，仅 SELECT/INSERT。临时初始化使用 `evalme_admin`，未写入日常配置。
- 密码和部署配置位于用户私有目录 `~/.local/share/evalme-mvp/deploy/`，未纳入仓库或报告。

配置与命令使用 `evalme-mvp` 独立名称，避免覆盖旧 `evalme`；Node.js 24、pg 8.16.3。安装产物在本机打包，以离线缓存安装，未发布注册表。依赖安装禁用生命周期脚本。实际安装的命令在独立临时目录完成 SQLite 初始化，并由新的 CLI 进程查回空列表；不依赖工作区源码入口。

## 六项实际状态

| 项目 | 本轮结果 | 边界及证据 |
|---|---|---|
| A1 安装与初始化 | CLI/Skill 安装、重复安装、两库真实 TTY 与非交互初始化通过 | 已安装 Skill 可手动加载调用；新宿主会话自动发现尚未验证。见 cli-tdd、skill-tdd、skill-smoke |
| A2 学习后沉淀 | CLI 流程通过；Agent 合成场景见 skill-smoke | 合成材料，不冒充真实学习对话验收 |
| A3 按话题练习 | CLI 保存/引用校验通过；Agent 合成评价见 skill-smoke | 真实用户作答及主观评价质量验收尚未完成 |
| A4 进程退出与历史 | 通过 | SQLite/真实 PG 子进程、新练习 ID、冻结版本与历史查询；不是整机重启 |
| A5 双库完整契约 | 自动真实集成通过 | 最终 54/54，无失败、无跳过；语义质量仍受 A2/A3 边界约束 |
| A6 Mac 服务与跨机 | 本机部署/重复执行/持久化/备份恢复通过；跨机延期 | 未新增 tailnet 转发，未验证双机共享或未授权设备拒绝；不得判 A6 全部通过 |

## 自动测试和运行环境

macOS 15.8.1 arm64，Node 24.21.0；内置 SQLite 3.53.4。复用已存在的 Colima VZ/Docker 环境。PostgreSQL 镜像 `postgres:18`，实际 digest：

`sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336`

完整测试使用独立 `evalme-mvp-test-postgres` 与端口 15433；没有用 SQLite 或 mock 替代 PostgreSQL：

```sh
EVALME_TEST_PG_CONFIG=/home/example/.local/share/evalme-mvp/deploy-test/app.json \
EVALME_TEST_PG_ADMIN_CONFIG=/home/example/.local/share/evalme-mvp/deploy-test/admin.json \
npm --prefix mvp run test:pg
```

结果：54 tests，54 pass，0 fail，0 skipped。覆盖不可变历史、更正链、幂等冲突、真实进程恢复、并发/锁、事务失败回滚、证据引用、分页搜索、配置保护、权限、Skill 安装及真实 PTY。缺 PG 配置的 test:pg 明确失败；普通 npm test 的跳过不能证明双库。旧根目录 `npm run check` 也通过。

证据：[完整测试输出](evidence/full-suite.log)、[Core 红绿记录](evidence/core-tdd.md)、[CLI 与 TTY](evidence/cli-tdd.md)、[Skill 安装](evidence/skill-tdd.md)、[部署测试](evidence/deploy-tdd.md)、[Agent 合成场景](evidence/skill-smoke.md)。

## 实际部署、持久化与恢复

正式容器 `evalme-mvp-postgres` 仅绑定 `127.0.0.1:15432`，卷 `evalme-mvp-postgres-data`。重复 apply 和权限审计通过；已安装 CLI 经默认配置查询返回空任务列表。没有在正式库写入测试题。

独立测试库备份时各表行数：topics 3、tasks 12、task_topics 7、trials 7、grades 5、schema_meta 1。backup 返回 snapshot_consistent:true；restore-test 在自己的随机临时库恢复后返回 restored:true、matched:true，六表行数及完整内容 SHA-256 均匹配。临时库随后由脚本清理，正式库未覆盖。

随后对测试服务执行 stop → apply → backup；六表哈希与停止前逐一一致。原备份及清单位于 `~/.local/share/evalme-mvp/deploy-test/acceptance-backup.sql` 和同名 `.manifest.json`；停止恢复后的对应文件为 `acceptance-after-restart.sql`。文件为0600，不入库。此证据只证明服务停止恢复，不证明 Mac 整机重启、Colima 开机或睡眠恢复。

全部测试和合成场景完成后，独立测试容器已停止、卷保留。重新运行真实 PG 测试前须对 deploy-test 配置执行 apply；正式容器保持运行，最终 status 返回 running:true、ready:true、permissions_checked:true。

既有本机服务及 Tailscale Serve 规则保持不变，没有启用 Funnel 或新的 PG 转发。当前交付仅本机连接，不能把 loopback 地址用作另一台机器连接地址。

## 后续边界

用户已延期真实第二台机器验证，本轮停止远程尝试。以后按 [部署说明](DEPLOYMENT.md) 核验 tailnet 授权边界、配置私有通道，再完成双向 CLI/Skill 读写和拒绝访问检查。无需现在提供第二台机器信息。

真实用户学习/作答验收和新宿主会话发现仍待实际使用确认。后续变更：用户已明确授权公开并清理仓库；旧实现、旧插件、旧文档与仓库内示例数据已移除；远端 Git 历史已按用户授权重建，不再保留旧提交链。仓库外数据库、凭据及已安装服务未删除或迁移。此授权不改变上述验收结果。

公开版本说明：用户名、工作区及临时目录路径已脱敏；示例路径须替换为本机实际路径。

清理后复验（2026-10-21）：真实 SQLite + PostgreSQL 再次 54/54 通过、无跳过；测试服务完成后停止并保留卷。新 CI 验证 SQLite/CLI/Skill/打包，不声称其执行了 PostgreSQL 集成。
