import {
  readFile,
  writeFile,
  mkdir,
  lstat,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
const version = "0.1.0";
const files = ["SKILL.md", "references/inputs.md"];
const hash = (x) => createHash("sha256").update(x).digest("hex");
const fail = (code, message) => Object.assign(new Error(message), { code });
async function stat(path) {
  try {
    return await lstat(path);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export async function installSkill({
  agent,
  scope,
  home = homedir(),
  cliPath,
}) {
  if (
    agent !== "codex" ||
    scope !== "user" ||
    !isAbsolute(home) ||
    typeof cliPath !== "string" ||
    !isAbsolute(cliPath) ||
    /[\r\n\x00]/.test(cliPath)
  )
    throw fail(
      "VALIDATION_ERROR",
      "Expected codex/user and absolute home/CLI paths",
    );
  const parent = join(home, ".agents", "skills");
  for (const p of [join(home, ".agents"), parent]) {
    const s = await stat(p);
    if (s && (!s.isDirectory() || s.isSymbolicLink()))
      throw fail("CONFLICT", "Skill parent must be a real directory");
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const path = join(parent, "evalme-mvp"),
    lock = join(parent, ".evalme-mvp-install.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (e) {
    if (e.code === "EEXIST")
      throw fail(
        "CONFLICT",
        "Another installation may be running; inspect installation lock",
      );
    throw e;
  }
  try {
    const contents = {};
    for (const file of files)
      contents[file] = (
        await readFile(
          new URL(`../skills/evalme-mvp/${file}`, import.meta.url),
          "utf8",
        )
      ).replaceAll("{{CLI_PATH_JSON}}", JSON.stringify(cliPath));
    const existing = await stat(path);
    let previous;
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink())
        throw fail("CONFLICT", "Skill destination is not an owned directory");
      try {
        const ms = await lstat(join(path, ".evalme-install.json"));
        if (ms.isSymbolicLink()) throw Error();
        previous = JSON.parse(
          await readFile(join(path, ".evalme-install.json"), "utf8"),
        );
      } catch {
        throw fail(
          "CONFLICT",
          "Unknown skill directory; preserve it and choose a backup before retrying",
        );
      }
      if (previous.owner !== "evalme-mvp" || !previous.hashes)
        throw fail("CONFLICT", "Unknown skill owner");
      for (const file of files) {
        const s = await stat(join(path, file));
        if (
          !s ||
          !s.isFile() ||
          s.isSymbolicLink() ||
          hash(await readFile(join(path, file))) !== previous.hashes[file]
        )
          throw fail(
            "CONFLICT",
            "Skill was modified; preserve changes before reinstalling",
          );
      }
      const refs = await stat(join(path, "references"));
      if (!refs?.isDirectory() || refs.isSymbolicLink())
        throw fail("CONFLICT", "References must be an owned directory");
      if (files.every((f) => hash(contents[f]) === previous.hashes[f]))
        return { path, version, replayed: true };
    }
    await mkdir(join(path, "references"), { recursive: true, mode: 0o700 });
    // Stage each managed file before replacement; unknown user files are never removed.
    for (const file of files) {
      const target = join(path, file),
        temp = `${target}.${randomUUID()}.tmp`;
      await writeFile(temp, contents[file], { mode: 0o600, flag: "wx" });
      await rename(temp, target);
    }
    const manifest = {
      owner: "evalme-mvp",
      version,
      hashes: Object.fromEntries(files.map((f) => [f, hash(contents[f])])),
    };
    const temp = join(path, `.manifest-${randomUUID()}`);
    await writeFile(temp, JSON.stringify(manifest), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, join(path, ".evalme-install.json"));
    return { path, version, replayed: false };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
