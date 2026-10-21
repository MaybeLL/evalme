import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
const cli = resolve("mvp/src/cli.mjs").includes("/mvp/mvp/")
  ? resolve("src/cli.mjs")
  : resolve("mvp/src/cli.mjs");
const home = mkdtempSync(join(tmpdir(), "evalme-cli-"));
const config = join(home, "config.json");
function run(args, input) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      EVALME_CONFIG: config,
      EVALME_HOME: join(home, "legacy"),
    },
  });
  let body;
  try {
    body = JSON.parse(r.stdout);
  } catch {}
  return { ...r, body };
}
function ok(args, input) {
  const r = run([...args, "--json"], input);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(r.body.ok, true);
  return r.body;
}
test("CLI no-config utility, JSON errors and protocol gate", () => {
  const r = ok(["id", "new"]);
  assert.match(r.data.id, /^[0-9a-f-]{36}$/);
  assert.equal(existsSync(config), false);
  assert.equal(run(["task", "list", "--json"]).status, 5);
  const bad = run(
    ["task", "create", "--input", "-", "--expect-api-version", "99", "--json"],
    "{}",
  );
  assert.equal(bad.status, 5);
  assert.equal(bad.body.error.code, "API_VERSION_UNSUPPORTED");
  assert.equal(run(["id", "new", "--surprise", "x", "--json"]).status, 2);
  assert.equal(run(["init", "--json"]).status, 2);
});
test("SQLite initialize and complete process-restart flow without standards", () => {
  const db = join(home, "data.sqlite");
  ok(["init", "--provider", "sqlite", "--path", db, "--non-interactive"]);
  assert.equal(statSync(config).mode & 0o777, 0o600);
  assert.equal(statSync(db).mode & 0o777, 0o600);
  ok(["init", "--provider", "sqlite", "--path", db, "--non-interactive"]);
  const topic = { id: randomUUID(), name: "异步" };
  ok(["topic", "create", "--input", "-"], JSON.stringify(topic));
  const task = {
    id: randomUUID(),
    prompt: "为什么异步仍可能阻塞？",
    topic_ids: [topic.id],
  };
  ok(["task", "create", "--input", "-"], JSON.stringify(task));
  assert.equal(
    ok(["task", "create", "--input", "-"], JSON.stringify(task)).meta.replayed,
    true,
  );
  assert.equal(ok(["task", "list", "--topic", topic.id]).data.length, 1);
  assert.equal(
    ok(["task", "get", task.id, "--prompt-only"]).data.reference_answer,
    undefined,
  );
  const tr = {
    id: randomUUID(),
    task_id: task.id,
    answer: "耗时计算会阻塞事件循环。",
    answer_kind: "verbatim",
    conditions: { hint_status: "none", hints: [] },
  };
  ok(["trial", "record", "--input", "-"], JSON.stringify(tr));
  const grade = {
    id: randomUUID(),
    trial_id: tr.id,
    basis: { mode: "task_only", reasoning: "根据题目和回答" },
    feedback: "正确识别了阻塞风险。",
    findings: [
      {
        id: "f1",
        kind: "correct",
        statement: "识别耗时计算",
        evidence: [{ target: "answer", quote: "耗时计算" }],
      },
    ],
    uncertainties: [],
    evaluator: { name: "fixture" },
  };
  ok(["grade", "submit", "--input", "-"], JSON.stringify(grade));
  assert.equal(ok(["grade", "get", grade.id]).data.trial_id, tr.id);
  ok(
    ["trial", "record", "--input", "-"],
    JSON.stringify({ ...tr, id: randomUUID() }),
  );
  assert.equal(ok(["trial", "list", "--task", task.id]).data.length, 2);
  assert.equal(existsSync(join(home, "legacy")), false);
  const before = readFileSync(config, "utf8");
  const failed = run([
    "init",
    "--provider",
    "sqlite",
    "--path",
    "relative",
    "--replace-config",
    "--non-interactive",
    "--json",
  ]);
  assert.equal(failed.status, 2);
  assert.equal(readFileSync(config, "utf8"), before);
});
test("CLI refuses invalid JSON, unknown fields, overlarge stdin, and leaked inputs", () => {
  const r = run(
    ["task", "create", "--input", "-", "--json"],
    '{"prompt":"secret-example", "extra": 1}',
  );
  assert.equal(r.status, 2);
  assert.ok(!r.stdout.includes("secret-example"));
  assert.equal(
    run(["task", "create", "--input", "-", "--json"], "broken").status,
    2,
  );
  assert.equal(
    run(["task", "create", "--input", "-", "--json"], "x".repeat(1048577))
      .status,
    2,
  );
  assert.equal(run(["task", "list", "--limit", "0", "--json"]).status, 2);
});
