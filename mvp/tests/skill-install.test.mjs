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

test('shared install needs no adapter; pi uses the same directory', async (t) => {
  const args = await setup(t);
  assert.equal((await installSkill({...args, agent: undefined})).replayed, false);
  assert.equal((await installSkill({...args, agent: 'pi'})).replayed, true);
});
test('force reinstall backs up modified skill; uninstall preserves unrelated files', async (t) => {
  const args = await setup(t);
  const first = await installSkill(args);
  await writeFile(join(first.path, 'SKILL.md'), 'custom');
  const updated = await installSkill({...args, force: true});
  assert.equal(await readFile(join(updated.backup, 'SKILL.md'), 'utf8'), 'custom');
  await writeFile(join(first.path, 'personal.txt'), 'keep');
  const {uninstallSkill} = await import('../src/skill-install.mjs');
  assert.equal((await uninstallSkill(args)).removed, true);
  assert.equal(await readFile(join(first.path, 'personal.txt'), 'utf8'), 'keep');
});

test('uninstall is idempotent and protects modified skill', async (t) => {
  const args = await setup(t);
  const {uninstallSkill} = await import('../src/skill-install.mjs');
  assert.equal((await uninstallSkill(args)).replayed, true);
  const first = await installSkill(args);
  await writeFile(join(first.path, 'SKILL.md'), 'custom');
  await assert.rejects(uninstallSkill(args), {code: 'CONFLICT'});
  const result = await uninstallSkill({...args, force: true});
  assert.equal(await readFile(join(result.backup, 'SKILL.md'), 'utf8'), 'custom');
  assert.equal((await uninstallSkill(args)).replayed, true);
});
test('CLI shared skill lifecycle needs no database config', async (t) => {
  const {spawnSync} = await import('node:child_process');
  const {fileURLToPath} = await import('node:url');
  const args = await setup(t);
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const run = (...flags) => {
    const r = spawnSync(process.execPath, [cli, ...flags, '--json'], {env: {...process.env, HOME: args.home}, encoding:'utf8'});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return JSON.parse(r.stdout).data;
  };
  const installed = run('skill', 'install', '--cli-path', args.cliPath);
  assert.ok((await readFile(join(installed.path, 'SKILL.md'), 'utf8')).includes(args.cliPath));
  await writeFile(join(installed.path, 'SKILL.md'), 'custom');
  assert.ok(run('skill', 'install', '--force').backup);
  assert.equal(run('skill', 'uninstall').removed, true);
  assert.equal(run('skill', 'uninstall').replayed, true);
});

test('installs and removes only selected preset or custom root; scans remembered locations',async t=>{
 const args=await setup(t);const {scanSkills,uninstallSkill}=await import('../src/skill-install.mjs');
 const roots=['~/.agents/skills','~/.claude/skills','~/.codex/skills','~/My Skills'];
 for(const skillsDir of roots){const r=await installSkill({...args,skillsDir});assert.equal(r.path,join(args.home,skillsDir.slice(2),'evalme-mvp'));}
 const entries=await scanSkills(args);assert.equal(entries.filter(x=>x.status==='current').length,4);
 await uninstallSkill({...args,skillsDir:'~/.claude/skills'});
 assert.equal((await scanSkills(args)).find(x=>x.path===join(args.home,'.claude/skills/evalme-mvp')).status,'missing');
 assert.ok(await readFile(join(args.home,'My Skills/evalme-mvp/SKILL.md')));
});
test('scan distinguishes outdated, modified, unknown and symlink aliases without writing',async t=>{
 const args=await setup(t);const {scanSkills}=await import('../src/skill-install.mjs');
 const a=await installSkill(args);const manifest=join(a.path,'.evalme-install.json');const m=JSON.parse(await readFile(manifest));m.version='0.0.0';await writeFile(manifest,JSON.stringify(m));
 const b=await installSkill({...args,skillsDir:'~/.claude/skills'});await writeFile(join(b.path,'SKILL.md'),'personal');
 await mkdir(join(args.home,'.codex/skills'),{recursive:true});await symlink(a.path,join(args.home,'.codex/skills/evalme-mvp'));
 const list=await scanSkills(args);assert.equal(list.filter(x=>x.status==='outdated').length,1);assert.equal(list.find(x=>x.status==='outdated').aliases.length,1);assert.equal(list.find(x=>x.path===b.path).status,'modified');
 const unknown=join(args.home,'Custom/evalme-mvp');await mkdir(unknown,{recursive:true});await writeFile(join(unknown,'SKILL.md'),'unknown');
 await assert.rejects(installSkill({...args,skillsDir:join(args.home,'Custom'),force:true}),{code:'CONFLICT'});
});
test('custom paths reject relative paths and symlink ancestors',async t=>{
 const args=await setup(t);
 await assert.rejects(installSkill({...args,skillsDir:'relative'}),{code:'VALIDATION_ERROR'});
 await symlink(args.home,join(args.home,'alias'));
 await assert.rejects(installSkill({...args,skillsDir:join(args.home,'alias/deep/skills')}),{code:'CONFLICT'});
});

test('CLI --skills-dir supports tilde, list and targeted uninstall without database',async t=>{
 const {spawnSync}=await import('node:child_process');const {fileURLToPath}=await import('node:url');const args=await setup(t);const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
 const run=(...flags)=>{const r=spawnSync(process.execPath,[cli,...flags,'--json'],{env:{...process.env,HOME:args.home},encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);return JSON.parse(r.stdout).data;};
 assert.equal(run('skill','install','--skills-dir','~/custom skills').path,join(args.home,'custom skills/evalme-mvp'));
 assert.ok(run('skill','list').some(e=>e.path===join(args.home,'custom skills/evalme-mvp')&&e.status==='current'));
 assert.equal(run('skill','uninstall','--skills-dir','~/custom skills').removed,true);
});

test('scan is read-only, detects unknown copies, and registry survives targeted removal',async t=>{
 const args=await setup(t);const {scanSkills,uninstallSkill}=await import('../src/skill-install.mjs');const {readdir}=await import('node:fs/promises');
 assert.equal((await scanSkills(args)).every(e=>e.status==='missing'),true);assert.deepEqual(await readdir(args.home),[]);
 const root=join(args.home,'custom');await installSkill({...args,skillsDir:root});const marker=join(args.home,'.local/share/evalme-mvp/skill-locations.json');const before=await readFile(marker);
 await scanSkills(args);assert.deepEqual(await readFile(marker),before);
 await uninstallSkill({...args,skillsDir:root});assert.equal((await scanSkills(args)).find(x=>x.directory===root).status,'missing');
 const unknown=join(args.home,'.claude/skills/evalme-mvp');await mkdir(unknown,{recursive:true});await writeFile(join(unknown,'SKILL.md'),'custom unknown');
 assert.equal((await scanSkills(args)).find(x=>x.path===unknown).status,'unknown');
});
