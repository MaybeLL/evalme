# 已安装 Skill 合成场景烟测

日期：2026-10-21（Asia/Shanghai）。执行者：Codex Agent。结果：A2/A3 的合成流程实际成功，**不等于真实用户验收**。

## 环境与证据边界

手动读取已安装 `/home/example/.agents/skills/evalme-mvp/SKILL.md` 及其 references/inputs.md，使用 `/home/example/.local/bin/evalme-mvp`。此符号链接指向安装包，Skill 绑定的是同包 CLI 的绝对路径。所有业务操作均经 CLI；未直接查询或写入数据库。

目标为本机端口 15433 的独立测试 PostgreSQL，使用已提供 app.json 的日常连接信息，通过 init 创建私有临时 CLI 配置。没有访问正式库或跨机器服务。连接文件本身不是 CLI config（缺 provider）；初次直接用作 --config 被 CONFIG_INVALID 拒绝，随后按正常 init --connection-file 流程成功，未改变原连接文件。

请求目录 `/private/tmp/evalme-skill-smoke-REDACTED` 权限 0700，请求 JSON 为 0600；ID 通过已安装 CLI id new 生成，写入都带 --expect-api-version 1 --json --non-interactive。命令/返回日志在该临时目录 stage-a2.json、stage-a3.json，仅包含合成学习数据；这里不记录凭据。

## A2：学习后沉淀

合成来源摘要：普通学习讲解指出 async 函数不使同步计算自动离开主线程，并讨论 I/O 等待与 CPU 计算的区别。本场景没有真实用户学习对话；source 明确标为合成 fixture/summary。

先 topic list 查询标签，无命中后创建，再逐题 task create：

| 对象 | ID | 实际内容/结果 |
| --- | --- | --- |
| 话题 | e92c184a-068d-4866-81bb-53ccf6fa3848 | Skill合成验收-异步练习 |
| 任务 1 | e5912913-23ce-48a2-b38a-e7e0a6480e6c | async 函数中运行长时间同步循环，是否仍可能阻塞事件循环？请解释。参考答案与 rubric 均缺省/null |
| 任务 2 | 2ba6cf4d-c367-4da4-b46b-6210c77046a7 | 解释等待网络响应和执行耗时同步计算对主线程占用的区别。含参考答案 |

两题创建后分别 trial list --task，返回均为空数组；此阶段未提交任何 trial/grade。按 grade 必须引用 trial 的关系约束，这两题没有关联 grade。不是全库记录数断言，其他测试 fixture 保留。

语义核对：两道题都忠于合成来源；题面独立可理解；未把讲解当作用户回答；无标准题成功保存；只存题无需补造练习。

## A3：话题练习、提示及有依据评价

topic 查询后 task list --topic 返回两题；task get 任务1 --prompt-only 返回题面且不含答案/标准，随后在当前 Agent 对话实际展示题面。模拟提示：“考虑同步循环实际在哪个线程执行。”模拟回答：

> 会阻塞，因为同步循环仍在主线程执行。只要加上 await 就一定不会阻塞。

这是测试 fixture，不是真实用户输入。trial 的 conditions.context_note 和 source 均明确标记合成；answer_kind=verbatim 仅代表精确保留上述模拟文本，未冒充真实用户逐字原话；occurred_at=null，未编造实际作答时间。hint_status=provided，提示保留，process 区分 assistant 提示和模拟 user 回答。

| 对象 | ID | 核验 |
| --- | --- | --- |
| trial | d3e8a021-4c5f-4fae-834a-86b0822b6a44 | 保存后 trial get 原文一致 |
| grade | 3f29fbd0-ec38-4122-9bd7-668d3c634f57 | task_only，无预设标准，grade get/list 查回成功 |

Agent 在提交前作出的评价：

- correct 引用回答“同步循环仍在主线程执行”，支持指出阻塞可能。
- incorrect 引用“只要加上 await 就一定不会阻塞”，解释 await 不会自动将同步计算移出主线程。
- 不确定性保留：模拟回答不能用于评价真实用户；已有提示且没有独立代码分析证据，不能断言迁移或全面掌握。

引用均为 answer 精确子串，没有用 assistant 提示充当用户掌握证据。无数字综合分数。grade submit 保存的是 Agent 已完成的评价。

查回确认任务1仅一条 trial、该 trial 一条 grade；任务2仍为零 trial。相同 trial ID 和原请求再次提交，返回 replayed=true，重新查询仍只有一条，验证保留请求的幂等重放。

实际命令序列（路径以占位符缩写；每项均使用已安装 CLI）：

```sh
evalme-mvp init --provider postgres --connection-file <private-app.json> --config <temporary-config.json> --json --non-interactive
evalme-mvp id new --json --non-interactive
evalme-mvp topic list --query Skill合成验收-异步练习 --config <temporary-config.json> --json --non-interactive
evalme-mvp topic create --input <private-request.json> --expect-api-version 1 --config <temporary-config.json> --json --non-interactive
evalme-mvp task create --input <private-request.json> --expect-api-version 1 --config <temporary-config.json> --json --non-interactive
evalme-mvp trial list --task <task-id> --config <temporary-config.json> --json --non-interactive
evalme-mvp task list --topic <topic-id> --config <temporary-config.json> --json --non-interactive
evalme-mvp task get <task-id> --prompt-only --config <temporary-config.json> --json --non-interactive
evalme-mvp trial record --input <private-request.json> --expect-api-version 1 --config <temporary-config.json> --json --non-interactive
evalme-mvp trial get <trial-id> --config <temporary-config.json> --json --non-interactive
evalme-mvp task get <task-id> --config <temporary-config.json> --json --non-interactive
evalme-mvp grade submit --input <private-request.json> --expect-api-version 1 --config <temporary-config.json> --json --non-interactive
evalme-mvp grade get <grade-id> --config <temporary-config.json> --json --non-interactive
evalme-mvp grade list --trial <trial-id> --config <temporary-config.json> --json --non-interactive
```

## 尚未证明

- 本次手动加载已安装 Skill，未证明宿主新会话自动发现或自动选中。
- 没有真实用户回答；没有用户主观反馈或独立质量抽查；不能将本烟测标为真实用户 A2/A3 验收通过。
- Agent 已知道合成来源，不声称盲评。可选标准题只验证了沉淀；本次练习选择的是无标准题。
- 没有跨机器验证、真实能力迁移证明或长期学习效果评价。跨机按用户最新要求延期。
