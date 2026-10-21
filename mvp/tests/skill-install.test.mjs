import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill } from "../src/skill-install.mjs";
const setup = async (t) => {
  const home = await mkdtemp(join(tmpdir(), "evalme-skill-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return {
    home,
    agent: "codex",
    scope: "user",
    cliPath: "/opt/Eval Me/bin/evalme-mvp",
  };
};
test("installs user skill with absolute CLI and repeats without duplicates", async (t) => {
  const args = await setup(t);
  const first = await installSkill(args);
  assert.equal(first.path, join(args.home, ".agents/skills/evalme-mvp"));
  assert.equal(first.replayed, false);
  assert.ok(
    (await readFile(join(first.path, "SKILL.md"), "utf8")).includes(
      args.cliPath,
    ),
  );
  assert.equal((await installSkill(args)).replayed, true);
  assert.ok(await readFile(join(first.path, "references/inputs.md"), "utf8"));
});
test("preserves user modifications and unknown directories", async (t) => {
  const args = await setup(t);
  const first = await installSkill(args);
  await writeFile(join(first.path, "SKILL.md"), "user content");
  await assert.rejects(installSkill(args), { code: "CONFLICT" });
  assert.equal(
    await readFile(join(first.path, "SKILL.md"), "utf8"),
    "user content",
  );
});
test("rejects invalid adapter, scope, relative executable and symlink destination", async (t) => {
  const args = await setup(t);
  for (const change of [
    { agent: "../bad" },
    { scope: "project" },
    { cliPath: "evalme" },
  ])
    await assert.rejects(installSkill({ ...args, ...change }), {
      code: "VALIDATION_ERROR",
    });
  const parent = join(args.home, ".agents/skills");
  await mkdir(parent, { recursive: true });
  await symlink(args.home, join(parent, "evalme-mvp"));
  await assert.rejects(installSkill(args), { code: "CONFLICT" });
});
test("updates owned pristine files when executable changes, preserves unknown files", async (t) => {
  const args = await setup(t);
  const first = await installSkill(args);
  await writeFile(join(first.path, "personal.txt"), "keep");
  const second = await installSkill({
    ...args,
    cliPath: "/new/bin/evalme-mvp",
  });
  assert.equal(second.replayed, false);
  assert.equal(
    await readFile(join(first.path, "personal.txt"), "utf8"),
    "keep",
  );
  assert.ok(
    (await readFile(join(first.path, "SKILL.md"), "utf8")).includes(
      "/new/bin/evalme-mvp",
    ),
  );
});
test("unknown same-name directory and symlinked parents are preserved", async (t) => {
  const args = await setup(t);
  const dest = join(args.home, ".agents/skills/evalme-mvp");
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, "notes.txt"), "private");
  await assert.rejects(installSkill(args), { code: "CONFLICT" });
  assert.equal(await readFile(join(dest, "notes.txt"), "utf8"), "private");
  const other = await setup(t);
  await symlink(args.home, join(other.home, ".agents"));
  await assert.rejects(installSkill(other), { code: "CONFLICT" });
});
