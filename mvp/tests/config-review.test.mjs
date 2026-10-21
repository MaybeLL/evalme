import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connection, readConfig } from "../src/config.mjs";
const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "evalme-config-review-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("PG secret preserves meaningful leading/trailing spaces", async (t) => {
  const dir = await fixture(t),
    secret = join(dir, "secret"),
    config = join(dir, "connection.json");
  await writeFile(secret, "  password with spaces  ", { mode: 0o600 });
  await writeFile(
    config,
    JSON.stringify({
      host: "localhost",
      port: 5432,
      database: "review",
      user: "runtime",
      secret_file: secret,
      ssl: false,
    }),
    { mode: 0o600 },
  );
  assert.equal(connection(config).runtime.password, "  password with spaces  ");
});
test("malformed config root receives a classified configuration error", async (t) => {
  const dir = await fixture(t),
    config = join(dir, "config.json");
  for (const value of ["null", "[]", "42"]) {
    await writeFile(config, value, { mode: 0o600 });
    assert.throws(
      () => readConfig(config),
      (e) => e.code === "CONFIG_INVALID",
    );
  }
});
test("missing input fails as input validation rather than unrelated missing configuration", async (t) => {
  const dir = await fixture(t);
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "task",
      "create",
      "--input",
      join(dir, "missing.json"),
      "--config",
      join(dir, "no-config.json"),
      "--json",
      "--non-interactive",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).error.code, "VALIDATION_ERROR");
});
test("provider-inapplicable init options fail before initializing SQLite", async (t) => {
  const dir = await fixture(t),
    config = join(dir, "config.json"),
    db = join(dir, "db.sqlite");
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "init",
      "--provider",
      "sqlite",
      "--path",
      db,
      "--connection-file",
      join(dir, "does-not-exist"),
      "--config",
      config,
      "--json",
      "--non-interactive",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).error.code, "VALIDATION_ERROR");
  await assert.rejects(readFile(config), { code: "ENOENT" });
});
