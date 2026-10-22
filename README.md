# EvalMe

把学习对话沉淀为题目，按话题练习，保存真实作答和有依据的评价。Agent 负责理解和评价，CLI 负责校验与保存。支持 SQLite 和 PostgreSQL。

## 安装与开始

支持 macOS、Linux，需已有 Node **22.16+（22.x）或 24.x**、npm、curl、tar。不更改默认 Node，不要求安装 Docker。Windows 原生尚未验证。

新电脑只需：

```sh
curl -fsSL https://raw.githubusercontent.com/MaybeLL/evalme/main/mvp/scripts/install.sh | sh
"$HOME/.local/bin/evalme-mvp" init
```

安装器固定使用当前兼容的 Node 绝对路径，安装 CLI，并调用 CLI 的共享 Skill 安装逻辑，将 Skill 安装到 `~/.agents/skills/evalme-mvp`。不改 shell 配置或系统默认 Node。已有 `~/.local/bin` 在 PATH 中时可直接使用 `evalme-mvp`；否则使用上面的绝对路径。Node 被移动或删除后需重新运行安装器。

初始化选择：

- **SQLite**：本机保存，直接使用默认位置即可。
- **PostgreSQL**：填写地址、端口、数据库名、应用用户名和密码（输入隐藏）。自动生成权限为 0600 的凭据及配置，验证成功才保存。服务端需提前完成部署和 schema 初始化。

公司电脑连接个人服务器时，先连同一 Tailscale 网络。仅当网络确实为私有 tailnet/loopback 时选择 TLS `none`；默认 `verify-full` 验证数据库证书。无需手写 JSON、传凭据文件或执行 chmod。不要在聊天里提交密码。

新开 Pi/Codex 会话即可让宿主扫描 Skill，Pi 也可 `/reload`，然后 `/skill:evalme-mvp`。自动发现是否成功仍取决于宿主版本和配置。

## 常用维护命令

```sh
"$HOME/.local/bin/evalme-mvp" doctor
"$HOME/.local/bin/evalme-mvp" skill install
"$HOME/.local/bin/evalme-mvp" skill install --force
"$HOME/.local/bin/evalme-mvp" skill uninstall
"$HOME/.local/bin/evalme-mvp" upgrade
"$HOME/.local/bin/evalme-mvp" uninstall
```

`doctor` 检查实际 Node、Skill 文件和绑定路径、配置、数据库 schema/读取及账号权限，不输出密码，也不创建练习记录。不代替宿主实际发现或跨机验证。

`upgrade` 下载当前 main 并暂存新安装，成功后切换；保留配置、数据和旧安装代次。正式发布前不可用它获取本地未发布修改。

`uninstall` 先展示范围并要求确认；自动化可加 `--yes`。默认卸载受管理的 CLI 和 Skill，保留配置、凭据和学习数据。加 `--purge-config` 同时移除默认配置及其引用的本工具生成的密码文件；外部手工提供的密码、额外用户文件、历史备份和所有学习数据库保留。不会卸载 Node、Tailscale 或其他工具。

## 开发者与验收

本地源码安装（可在任意目录执行绝对路径）：

```sh
sh /absolute/evalme/mvp/scripts/install.sh --source /absolute/evalme
```

安装器使用 npm 锁定依赖，不执行生命周期脚本。升级失败不会删除原配置或数据库；旧版手工安装且无所有权标记的入口会拒绝覆盖，需先按原安装方式卸载。

- [CLI 输入、配置与开发测试](mvp/README.md)
- [PostgreSQL 服务端部署](mvp/DEPLOYMENT.md)
- [0.2.0 安装改造与验收](mvp/INSTALLATION-ACCEPTANCE.md)
- [原始本机验收与证据](mvp/ACCEPTANCE.md)
