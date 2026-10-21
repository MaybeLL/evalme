# Skill 安装 TDD 记录

2026-10-21；只在测试临时用户目录运行，未安装到真实用户目录。

官方目录核验：[Build skills](https://learn.chatgpt.com/docs/build-skills)，Where Codex loads local skills 表确认 USER 为 `$HOME/.agents/skills`。安装目标独立命名 `evalme-mvp`。

先编写四项测试，然后在安装模块尚不存在时执行 `node --test mvp/tests/skill-install.test.mjs`：

```text
node:internal/modules/esm/resolve:272
    throw new ERR_MODULE_NOT_FOUND(
          ^

Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/workspace/evalme/mvp/src/skill-install.mjs' imported from /workspace/evalme/mvp/tests/skill-install.test.mjs
    at finalizeResolution (node:internal/modules/esm/resolve:272:11)
    at moduleResolve (node:internal/modules/esm/resolve:879:10)
    at defaultResolve (node:internal/modules/esm/resolve:1006:11)
    at #cachedDefaultResolve (node:internal/modules/esm/loader:705:20)
    at #resolveAndMaybeBlockOnLoaderThread (node:internal/modules/esm/loader:725:38)
    at ModuleLoader.resolveSync (node:internal/modules/esm/loader:763:56)
    at #resolve (node:internal/modules/esm/loader:687:17)
    at ModuleLoader.getOrCreateModuleJob (node:internal/modules/esm/loader:607:35)
    at ModuleJob.syncLink (node:internal/modules/esm/module_job:276:33)
    at ModuleJob.link (node:internal/modules/esm/module_job:381:17) {
  code: 'ERR_MODULE_NOT_FOUND',
  url: 'file:///workspace/evalme/mvp/src/skill-install.mjs'
}

Node.js v24.21.0
✖ mvp/tests/skill-install.test.mjs (25.211208ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 29.207583

✖ failing tests:

test at mvp/tests/skill-install.test.mjs:1:1
✖ mvp/tests/skill-install.test.mjs (25.211208ms)
  'test failed'
```

实现后同命令：

```text
✔ installs user skill with absolute CLI and repeats without duplicates (6.748209ms)
✔ preserves user modifications and unknown directories (3.406833ms)
✔ rejects invalid adapter, scope, relative executable and symlink destination (1.614292ms)
✔ updates owned pristine files when executable changes, preserves unknown files (4.160917ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 52.524584
```

覆盖首次安装、绝对 CLI 绑定、同版本重放、用户修改保留、错误适配器/范围/相对路径、符号链接冲突、已归属文件更新及未知文件保留。没有修改根包或真实用户配置。

Skill 已按 skill-creator 检查名称、frontmatter、两条流程与引用资源。其 quick_validate.py 在本机 Python 缺少 PyYAML，未运行成功；不将该检查标为通过。安装测试不证明真实宿主发现、学习场景或语义评价质量通过，需主集成验收。

随后增加已存在保护行为的独立回归案例（未知同名目录、符号链接父目录）；同一测试命令 5/5 通过。这项属于现有实现的回归覆盖，不记为新增行为的 RED/GREEN。`node --check mvp/src/skill-install.mjs` 通过。

补充：随后在临时 `/tmp/evalme-skill-validator-venv` 安装 PyYAML，执行官方 `quick_validate.py mvp/skills/evalme-mvp`，输出 `Skill is valid!`、退出码 0。未修改全局 Python。
