import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { openStore } from "../src/core.mjs";
const uuid = () => randomUUID();
const trial = (task_id) => ({
  id: uuid(),
  task_id,
  answer: "耗时计算仍会阻塞",
  answer_kind: "verbatim",
  conditions: { hint_status: "none", hints: [] },
  occurred_at: null,
});
const grade = (trial_id) => ({
  id: uuid(),
  trial_id,
  basis: { mode: "task_only", reasoning: "根据回答判断" },
  feedback: "正确指出计算阻塞",
  findings: [
    {
      id: "f1",
      kind: "correct",
      statement: "指出阻塞",
      evidence: [{ target: "answer", quote: "计算" }],
    },
  ],
  uncertainties: [],
  evaluator: { name: "test-agent", version: "1" },
});
async function readConfig(path) {
  const c = JSON.parse(await readFile(path, "utf8"));
  c.provider ??= "postgres";
  if (c.secret_file) {
    c.password = (await readFile(c.secret_file, "utf8")).trimEnd();
    delete c.secret_file;
  }
  return c;
}
async function worker(config, operation, input, { silent = false } = {}) {
  const moduleURL = new URL("../src/core.mjs", import.meta.url).href;
  const code = `import {openStore} from ${JSON.stringify(moduleURL)};let data='';for await(const b of process.stdin)data+=b;const p=JSON.parse(data);const s=await openStore(p.config);try{const result=await s[p.operation](p.input);if(!p.silent)process.stdout.write(JSON.stringify(result));}catch(e){process.stdout.write(JSON.stringify({error:e.code}));process.exitCode=4;}finally{await s.close();}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && code !== 4)
        reject(new Error(`worker exited ${code}: ${err}`));
      else resolve(out ? JSON.parse(out) : null);
    });
    child.stdin.end(JSON.stringify({ config, operation, input, silent }));
  });
}
const configs = [{ name: "sqlite" }];
if (process.env.EVALME_TEST_PG_CONFIG)
  configs.push({
    name: "postgres",
    config: await readConfig(process.env.EVALME_TEST_PG_CONFIG),
    admin: process.env.EVALME_TEST_PG_ADMIN_CONFIG
      ? await readConfig(process.env.EVALME_TEST_PG_ADMIN_CONFIG)
      : null,
  });
for (const entry of configs)
  test(`${entry.name}: shared provider contract`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "evalme-core-"));
    const config = entry.config ?? {
      provider: "sqlite",
      path: join(dir, "store.sqlite3"),
    };
    let s;
    t.after(async () => {
      await s?.close();
      await rm(dir, { recursive: true, force: true });
    });
    if (entry.admin) {
      const admin = await openStore(entry.admin, { initialize: true });
      await admin.close();
    }
    s = await openStore(config, { initialize: !entry.admin });
    await t.test("schema checks and initialize are repeatable", async () => {
      await s.checkSchema();
      if (entry.admin) {
        const admin = await openStore(entry.admin, { initialize: true });
        await admin.close();
      } else await s.initialize();
    });
    let topic, task, attempt, evaluation;
    await t.test(
      "optional standards, topic normalization, idempotence, unknown fields",
      async () => {
        const p = { id: uuid(), name: `ＡSync  ${uuid()}` };
        topic = (await s.createTopic(p)).data;
        assert.equal((await s.createTopic(p)).replayed, true);
        await assert.rejects(
          s.createTopic({ ...p, id: uuid(), name: p.name.replace("Ａ", "a") }),
          { code: "TOPIC_EXISTS" },
        );
        const q = {
          id: uuid(),
          prompt: "为什么异步仍阻塞？",
          topic_ids: [topic.id],
        };
        task = (await s.createTask(q)).data;
        assert.equal(task.reference_answer, null);
        assert.equal(task.rubric, null);
        assert.equal(task.version, 1);
        assert.equal((await s.createTask(q)).replayed, true);
        await assert.rejects(s.createTask({ ...q, prompt: "different" }), {
          code: "IDEMPOTENCY_CONFLICT",
        });
        await assert.rejects(
          s.createTask({ id: uuid(), prompt: "x", typo: true }),
          { code: "VALIDATION_ERROR" },
        );
      },
    );
    await t.test("invalid labels roll back entire task", async () => {
      const id = uuid();
      await assert.rejects(
        s.createTask({ id, prompt: "bad", topic_ids: [topic.id, uuid()] }),
        { code: "NOT_FOUND" },
      );
      await assert.rejects(s.getTask(id), { code: "NOT_FOUND" });
    });
    await t.test(
      "trial preserves answers, unknown time, independent repeat, hints",
      async () => {
        const p = trial(task.id);
        p.answer = "  耗时计算仍会阻塞\n";
        attempt = (await s.recordTrial(p)).data;
        assert.equal(attempt.answer, p.answer);
        assert.equal(attempt.occurred_at, null);
        assert.equal((await s.recordTrial(p)).replayed, true);
        const repeat = (await s.recordTrial({ ...p, id: uuid() })).data;
        assert.notEqual(repeat.id, attempt.id);
        await assert.rejects(
          s.recordTrial({
            ...trial(task.id),
            conditions: { hint_status: "none", hints: ["有提示"] },
          }),
          { code: "VALIDATION_ERROR" },
        );
        await assert.rejects(
          s.recordTrial({
            ...trial(task.id),
            conditions: { hint_status: "unknown", hints: [] },
          }),
          { code: "VALIDATION_ERROR" },
        );
      },
    );
    await t.test(
      "evidence validation and grade failure preserves trial",
      async () => {
        const p = grade(attempt.id);
        evaluation = (await s.submitGrade(p)).data;
        const minimalEvaluator = await s.submitGrade({
          ...grade(attempt.id),
          evaluator: { name: "fixture" },
        });
        assert.equal(minimalEvaluator.data.evaluator.version, null);
        assert.equal(evaluation.basis.task_id, task.id);
        assert.equal((await s.submitGrade(p)).replayed, true);
        const bad = grade(attempt.id);
        bad.findings[0].evidence[0].quote = "不存在";
        await assert.rejects(s.submitGrade(bad), { code: "VALIDATION_ERROR" });
        assert.equal((await s.getTrial(attempt.id)).id, attempt.id);
        await assert.rejects(
          s.submitGrade({
            ...grade(attempt.id),
            basis: { mode: "task_rubric", reasoning: "x" },
          }),
          { code: "VALIDATION_ERROR" },
        );
        const ai = (
          await s.recordTrial({
            ...trial(task.id),
            process: [
              { id: "a", role: "assistant", text: "计算", kind: "verbatim" },
            ],
          })
        ).data;
        const onlyAI = grade(ai.id);
        onlyAI.findings[0].evidence = [{ target: "process:a", quote: "计算" }];
        await assert.rejects(s.submitGrade(onlyAI), {
          code: "VALIDATION_ERROR",
        });
      },
    );
    await t.test(
      "immutable versions, full revision, replay before tip checks",
      async () => {
        await assert.rejects(
          s.reviseTask({ id: uuid(), previous_task_id: task.id, prompt: "x" }),
          { code: "VALIDATION_ERROR" },
        );
        const p = {
          id: uuid(),
          previous_task_id: task.id,
          title: "新版",
          prompt: "如何分析阻塞？",
          reference_answer: null,
          rubric: null,
          background: null,
          source: null,
          topic_ids: [topic.id],
        };
        const next = (await s.reviseTask(p)).data;
        assert.equal(next.version, 2);
        assert.equal(next.family_id, task.id);
        assert.equal((await s.reviseTask(p)).replayed, true);
        await assert.rejects(s.reviseTask({ ...p, id: uuid() }), {
          code: "CONFLICT",
        });
        assert.equal((await s.getTrial(attempt.id)).task_id, task.id);
        assert.equal((await s.getTask(task.id)).prompt, task.prompt);
        const current = await s.listTasks({ topic: topic.id });
        assert.deepEqual(
          current.data.map((x) => x.id),
          [next.id],
        );
        assert.equal(
          (await s.listTasks({ topic: topic.id, allVersions: true })).data
            .length,
          2,
        );
      },
    );
    await t.test(
      "correction chains, independent regrade, clock skew, no self feedback",
      async () => {
        const p = {
          ...trial(task.id),
          supersedes_trial_id: attempt.id,
          correction_reason: "修正转录",
        };
        const fixed = (await s.recordTrial(p)).data;
        assert.equal((await s.getTrial(attempt.id)).superseded_by, fixed.id);
        await assert.rejects(s.recordTrial({ ...p, id: uuid() }), {
          code: "CONFLICT",
        });
        assert.equal((await s.getGrade(evaluation.id)).trial_id, attempt.id);
        await assert.rejects(
          s.recordTrial({
            ...trial(task.id),
            supersedes_trial_id: fixed.id,
            correction_reason: "x",
            based_on_grade_id: evaluation.id,
          }),
          { code: "VALIDATION_ERROR" },
        );
        const linked = await s.recordTrial({
          ...trial(task.id),
          based_on_grade_id: evaluation.id,
          occurred_at: "2000-01-01T00:00:00+08:00",
        });
        assert.equal(linked.data.occurred_at, "1999-12-31T16:00:00.000Z");
        const correction = {
          ...grade(attempt.id),
          supersedes_grade_id: evaluation.id,
          correction_reason: "补充说明",
        };
        const g2 = (await s.submitGrade(correction)).data;
        assert.equal((await s.getGrade(evaluation.id)).superseded_by, g2.id);
        assert.equal((await s.submitGrade(correction)).replayed, true);
        await assert.rejects(s.submitGrade({ ...correction, id: uuid() }), {
          code: "CONFLICT",
        });
        await s.submitGrade(grade(attempt.id));
        assert.equal(
          (await s.listGrades({ trial: attempt.id })).data.length,
          4,
        );
      },
    );
    await t.test(
      "literal unicode search, no field boundary match, cursors bound to filters",
      async () => {
        const marker = uuid();
        const searchTopic = (
          await s.createTopic({ id: uuid(), name: `search-${marker}` })
        ).data;
        for (let i = 0; i < 4; i++)
          await s.createTask({
            id: uuid(),
            title: `${marker}-A`,
            prompt: `B １００%_ ${i}`,
            topic_ids: [searchTopic.id],
          });
        assert.equal(
          (await s.listTasks({ query: "100%_", topic: searchTopic.id })).data
            .length,
          4,
        );
        assert.equal(
          (await s.listTasks({ query: `${marker}-AB` })).data.length,
          0,
        );
        const first = await s.listTasks({ query: marker, limit: 2 });
        assert.equal(first.data.length, 2);
        assert.ok(first.next_cursor);
        const second = await s.listTasks({
          query: marker,
          limit: 2,
          cursor: first.next_cursor,
        });
        assert.equal(second.data.length, 2);
        assert.equal(second.next_cursor, null);
        assert.equal(
          new Set([...first.data, ...second.data].map((x) => x.id)).size,
          4,
        );
        await assert.rejects(
          s.listTasks({ query: "other", cursor: first.next_cursor }),
          { code: "INVALID_CURSOR" },
        );
        await assert.rejects(s.listTasks({ cursor: "broken" }), {
          code: "INVALID_CURSOR",
        });
      },
    );
    await t.test(
      "two connections same request and competing revisions",
      async () => {
        const other = await openStore(config);
        try {
          const p = { id: uuid(), prompt: "concurrent" };
          const results = await Promise.all([
            s.createTask(p),
            other.createTask(p),
          ]);
          assert.deepEqual(results.map((x) => x.replayed).sort(), [
            false,
            true,
          ]);
          const v = {
            previous_task_id: p.id,
            title: "changed",
            prompt: "changed",
            reference_answer: null,
            rubric: null,
            background: null,
            source: null,
            topic_ids: [],
          };
          const r = await Promise.allSettled([
            s.reviseTask({ ...v, id: uuid() }),
            other.reviseTask({ ...v, id: uuid() }),
          ]);
          assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
          assert.equal(
            r.find((x) => x.status === "rejected").reason.code,
            "CONFLICT",
          );
        } finally {
          await other.close();
        }
      },
    );
    await t.test(
      "actual independent processes preserve idempotency, conflicts, and lost responses",
      async () => {
        const p = { id: uuid(), prompt: "two real processes" };
        const results = await Promise.all([
          worker(config, "createTask", p),
          worker(config, "createTask", p),
        ]);
        assert.deepEqual(results.map((x) => x.replayed).sort(), [false, true]);
        const id = uuid();
        const conflict = await Promise.all([
          worker(config, "createTask", { id, prompt: "one" }),
          worker(config, "createTask", { id, prompt: "two" }),
        ]);
        assert.equal(
          conflict.filter((x) => x.error === "IDEMPOTENCY_CONFLICT").length,
          1,
        );
        const lost = { id: uuid(), prompt: "committed response discarded" };
        assert.equal(
          await worker(config, "createTask", lost, { silent: true }),
          null,
        );
        assert.equal((await s.createTask(lost)).replayed, true);
      },
    );
    await t.test("close and reopen preserves records", async () => {
      await s.close();
      s = await openStore(config);
      assert.equal((await s.getTask(task.id)).id, task.id);
      assert.equal((await s.getGrade(evaluation.id)).id, evaluation.id);
    });
  });

test("SQLite: real transaction failure rolls back task and labels", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await mkdtemp(join(tmpdir(), "evalme-rollback-"));
  const config = { provider: "sqlite", path: join(dir, "db.sqlite3") };
  const s = await openStore(config, { initialize: true });
  t.after(async () => {
    await s.close();
    await rm(dir, { recursive: true, force: true });
  });
  const topic = (await s.createTopic({ id: uuid(), name: "rollback" })).data;
  const raw = new DatabaseSync(config.path);
  raw.exec(
    "CREATE TRIGGER simulate_failure BEFORE INSERT ON task_topics BEGIN SELECT RAISE(ABORT,'injected'); END",
  );
  raw.close();
  const id = uuid();
  await assert.rejects(
    s.createTask({ id, prompt: "atomic", topic_ids: [topic.id] }),
  );
  await assert.rejects(s.getTask(id), { code: "NOT_FOUND" });
});

test("SQLite: unknown schema and missing database are not silently initialized", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await mkdtemp(join(tmpdir(), "evalme-schema-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { provider: "sqlite", path: join(dir, "unknown.sqlite3") };
  await assert.rejects(openStore(config), { code: "SCHEMA_SETUP_REQUIRED" });
  const raw = new DatabaseSync(config.path);
  raw.exec(
    "CREATE TABLE schema_meta(version INTEGER); INSERT INTO schema_meta VALUES(99)",
  );
  raw.close();
  const s = await openStore(config);
  try {
    await assert.rejects(s.checkSchema(), { code: "SCHEMA_INCOMPATIBLE" });
    await assert.rejects(
      s.createTopic({ id: uuid(), name: "must not write" }),
      { code: "SCHEMA_INCOMPATIBLE" },
    );
    await assert.rejects(s.initialize(), { code: "SCHEMA_INCOMPATIBLE" });
  } finally {
    await s.close();
  }
});

test("validation rejects impossible timestamps and oversized prompt", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "evalme-validate-"));
  const s = await openStore(
    { provider: "sqlite", path: join(dir, "db.sqlite3") },
    { initialize: true },
  );
  t.after(async () => {
    await s.close();
    await rm(dir, { recursive: true, force: true });
  });
  const task = (await s.createTask({ id: uuid(), prompt: "date" })).data;
  await assert.rejects(
    s.recordTrial({ ...trial(task.id), occurred_at: "2026-02-30T00:00:00Z" }),
    { code: "VALIDATION_ERROR" },
  );
  await assert.rejects(
    s.createTask({ id: uuid(), prompt: "题".repeat(22000) }),
    { code: "VALIDATION_ERROR" },
  );
  await assert.rejects(s.createTask({ id: uuid(), prompt: "bad \ud800" }), {
    code: "VALIDATION_ERROR",
  });
});

test("SQLite: a transient writer lock retries the original request", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await mkdtemp(join(tmpdir(), "evalme-lock-"));
  const config = { provider: "sqlite", path: join(dir, "db.sqlite3") };
  const s = await openStore(config, { initialize: true });
  const raw = new DatabaseSync(config.path);
  t.after(async () => {
    raw.close();
    await s.close();
    await rm(dir, { recursive: true, force: true });
  });
  raw.exec("BEGIN IMMEDIATE");
  const release = setTimeout(() => raw.exec("ROLLBACK"), 70);
  t.after(() => clearTimeout(release));
  const input = { id: uuid(), prompt: "retry same request" };
  const result = await s.createTask(input);
  assert.equal(result.data.id, input.id);
  assert.equal(result.replayed, false);
  assert.equal((await s.createTask(input)).replayed, true);
});

test("SQLite: initialize refuses a nonempty foreign database without ownership marker", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await mkdtemp(join(tmpdir(), "evalme-foreign-"));
  const path = join(dir, "foreign.sqlite3");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const raw = new DatabaseSync(path);
  raw.exec(
    "CREATE TABLE private_records (note TEXT); INSERT INTO private_records VALUES ('keep me')",
  );
  raw.close();
  const before = await readFile(path);
  await assert.rejects(
    openStore({ provider: "sqlite", path }, { initialize: true }),
    { code: "SCHEMA_INCOMPATIBLE" },
  );
  assert.deepEqual(await readFile(path), before);
  const check = new DatabaseSync(path);
  assert.deepEqual(
    check
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((x) => x.name),
    ["private_records"],
  );
  assert.equal(
    check.prepare("SELECT note FROM private_records").get().note,
    "keep me",
  );
  check.close();
});
