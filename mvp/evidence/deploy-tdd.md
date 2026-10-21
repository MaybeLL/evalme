# 部署工具 TDD 记录

2026-10-21，仅本地单元测试；未由本审阅/实现Agent执行部署。

1. 先建立 deploy.test.mjs 的3条行为测试，运行 `node --test mvp/tests/deploy.test.mjs`，因缺少 postgres-mac.mjs 模块失败（ERR_MODULE_NOT_FOUND）。
2. 最小实现loopback计划、资源所有权检查、SQL角色权限/引用转义与脱敏；同命令3/3通过。
3. 新增未知配置键（秘密值不得混入公开plan）的失败测试，实际因未抛错失败。
4. 加配置白名单，4/4通过。脚本语法随后检查。

自动证据仅覆盖计划验证、资源所有权/配置冲突、SQL文字约束和脱敏，不证明真实Docker重入、PostgreSQL权限、服务恢复、备份完整性、Tailscale或跨机访问。真实集成由负责人后续运行并另记结果，不可引用本记录宣称A6通过。

## 冷静复核补充

5. 新增容器运行实态漂移测试，实际因缺少assertRuntime失败；实现对端口/镜像/挂载/网络/restart/privileged核验后5/5通过。不改变默认配置或现有配置摘要算法。
6. 新增权限审计测试，实际因缺少审计SQL失败；加入角色属性、继承成员、schema所有权、应用DDL和UPDATE/DELETE等授权检查后6/6通过。此测试仅证明审计SQL包含断言；SQL实际运行结果由负责人真实部署取得。
7. 启动检查改为容器内TCP pg_isready（60秒预算），避免官方镜像临时Unix初始化服务器造成提前就绪；角色设置使用事务。pg_isready仍只证明服务器响应，apply/status额外执行权限审计。
8. 尝试只读docker inspect被当前沙箱拒绝访问Docker socket；未进行任何Docker写操作。实际部署和读回审计留给持有相应访问权限的主负责人。

用户最新决定：本轮只交付本机，真实第二台机器远程验收延期且尚未验证；不尝试远程登录。

## 备份完整性闭环

9. 新增manifest比较测试，覆盖相同行数但内容hash变化、行数变化、缺表；首次实际失败 `compareSnapshots is not a function`。
10. 实现六表快照比较后7/7通过。backup记录前后稳定快照、备份文件hash和0600 manifest；并发变化拒绝成功并清理本次失败产物。restore-test核验备份hash并逐表比对临时恢复库，匹配才报告matched:true。仅输出行数/hash，不输出学习内容。默认部署配置/hash未修改。
11. 本Agent未执行容器写操作；真实非空备份恢复由负责人运行，结果应单独记录。
