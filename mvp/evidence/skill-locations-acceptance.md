# init Skill 安装与多位置验收

日期：2026-10-23。以下为实现阶段的验收记录，发布版本为 v0.4.0。本轮仅使用隔离配置、用户目录和数据库测试，未修改生产连接或用户实际安装的 Skill。

## 行为

- 交互 init 保存连接后，或选择保留现有连接后，检查 Skill；当前版本显示位置并跳过安装提问，缺失和未修改旧版分别建议安装或更新。
- 可选择 `.agents/skills`、`.claude/skills`、`.codex/skills` 或自定义根目录，最终目标为根目录下的 `evalme-mvp`，安装前展示完整路径。
- `skill install/uninstall --skills-dir` 只操作所选目录；省略时保留共享目录默认行为，兼容旧 `--agent codex/pi` 参数。
- `skill list` 和 doctor 识别预设位置及登记的自定义位置，展示 current/outdated/modified/unknown/missing；实际路径相同的副本合并别名，扫描不写文件。
- 修改版、未知目录和符号链接不会被自动覆盖。受管理修改版只有显式 force 才备份后覆盖。Skill 操作失败或取消不撤销数据库配置。
- JSON/非交互 init 不增加提问或安装。CLI 安装器继续管理默认共享副本，额外位置需定向管理。

## 测试过程

先补多目录安装/卸载、位置扫描和路径保护测试；原实现忽略 skillsDir、缺少 scanSkills，测试失败。实现后转绿。随后补 CLI list（原命令不支持）、真实 PTY、只读扫描和自定义位置 doctor 验收。

| 环境 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| Node 24.21.0，SQLite + PostgreSQL 18 | 120 | 0 | 0 |
| Node 22.16.0，SQLite + PostgreSQL 18 | 120 | 0 | 0 |

关键覆盖：

- 三个预设目录及带空格的自定义目录；`~` 展开；相对路径和符号链接祖先拒绝。
- 原目录兼容、重复安装、旧版更新、修改保护、force 备份、定向卸载以及用户额外文件保留。
- 自定义位置登记和重新发现、只读扫描、未知副本、实际目录去重。
- PTY 初次 init 安装自定义 Skill；保留连接后补装 Claude Skill；Codex 旧版更新；当前版本显示位置且不再询问；取消及修改版冲突后数据库配置不变。
- doctor 识别自定义位置；JSON init 不安装；安装器升级/卸载回归；既有数据库和删除功能全量回归。

另通过 Skill quick_validate、npm pack 内容检查、git diff --check。测试中的 HOME 均隔离；本轮新建 PG 容器已删除，既有测试容器恢复停止状态。结果不代表 Pi、Claude 或 Codex 已在真实会话中加载新 Skill。

复现全量测试需要专用 PostgreSQL 服务及测试账号：

```sh
EVALME_SETUP_PG_PORT=<测试端口> \
EVALME_SETUP_PG_CONTAINER=<测试容器> \
EVALME_TEST_PG_CONFIG=<测试应用配置> \
EVALME_TEST_PG_ADMIN_CONFIG=<测试管理配置> \
node --test mvp/tests/*.test.mjs
```
