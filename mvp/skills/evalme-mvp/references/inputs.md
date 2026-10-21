# 请求示例（协议 1）

以下为完整可读示例。UUID 从 CLI id new 取得，关联 ID 来自已保存结果；所有 JSON 用文件传入，不将用户文本拼进 shell。每条创建请求独立保存并重试。未列出的可选字段可缺省，未知字段会拒绝。

## topic create

```json
{"id":"10000000-0000-4000-8000-000000000001","name":"JavaScript"}
```

## task create（可不含任何标准）

```json
{"id":"10000000-0000-4000-8000-000000000002","title":"异步与阻塞","prompt":"为什么异步代码仍可能阻塞事件循环？","reference_answer":null,"rubric":null,"background":"分析 JavaScript 中 CPU 密集计算的影响。","source":{"description":"本次学习对话的概括","excerpt_kind":"summary"},"topic_ids":["10000000-0000-4000-8000-000000000001"]}
```

## trial record

```json
{"id":"10000000-0000-4000-8000-000000000003","task_id":"10000000-0000-4000-8000-000000000002","occurred_at":null,"answer":"异步函数里的同步计算仍会占用主线程。","answer_kind":"verbatim","process":[],"conditions":{"hint_status":"none","hints":[],"context_note":null}}
```

occurred_at 为 null 表示时间未知；知道时用带时区 RFC3339。process 可记录 `{id,role,text,kind}`，role=user/assistant，kind=verbatim/summary。提示未知使用 unknown，提供过提示则 provided 并填 hints。基于旧评价的新练习可加 based_on_grade_id；不能给普通复练加 supersedes_trial_id。

## grade submit

```json
{"id":"10000000-0000-4000-8000-000000000004","trial_id":"10000000-0000-4000-8000-000000000003","basis":{"mode":"task_only","reasoning":"依据题目考察异步调度与同步执行的区别。"},"feedback":"你指出了同步计算仍占用主线程；还需用具体例子检验。","findings":[{"id":"f1","kind":"correct","statement":"识别了同步计算的阻塞可能。","evidence":[{"target":"answer","quote":"同步计算仍会占用主线程"}],"next_focus":"用一个耗时循环例子解释。"}],"uncertainties":["尚无具体代码分析证据。"],"evaluator":{"name":"Codex"}}
```

模型/版本信息未知就省略，不猜测。task_rubric 仅用于任务确有 rubric 或 reference_answer 且使用它评价的情况。missing/uncertain 可无 evidence，但 statement 必须说明缺什么证据。无可判断点保存 uncertain 条目。CLI 精确子串检查不证明语义判断正确。
