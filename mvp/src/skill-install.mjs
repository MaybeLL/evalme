import {
  readFile,
  writeFile,
  mkdir,
  lstat,
  rename,
  rm,
  cp,
  rmdir,
  realpath,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, isAbsolute, resolve, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { VERSION as version } from "./runtime.mjs";
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
async function installAt({
  agent = "shared",
  scope = "user",
  force = false,
  uninstall = false,
  home = homedir(),
  cliPath,
  skillsDir,
}) {
  if (
    !["shared", "codex", "pi"].includes(agent) ||
    scope !== "user" ||
    !isAbsolute(home) ||
    typeof cliPath !== "string" ||
    !isAbsolute(cliPath) ||
    /[\r\n\x00]/.test(cliPath)
  )
    throw fail(
      "VALIDATION_ERROR",
      "Expected shared/codex/pi, user scope and absolute home/CLI paths",
    );
  const parent = resolveSkillsDir(skillsDir,home);
  await safeParents(parent,home);
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
    let previous, backup;
    if (!existing && uninstall) return {path, removed: false, replayed: true};
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
      const refs = await stat(join(path, "references"));
      if (!refs?.isDirectory() || refs.isSymbolicLink())
        throw fail("CONFLICT", "References must be an owned directory");
      for (const file of files) {
        const s = await stat(join(path, file));
        if (
          !s ||
          !s.isFile() ||
          s.isSymbolicLink() ||
          (!force && hash(await readFile(join(path, file))) !== previous.hashes[file])
        )
          throw fail(
            "CONFLICT",
            "Skill was modified; preserve changes before reinstalling",
          );
      }
      if (force) {
        const backups = join(home, ".local", "share", "evalme-mvp", "skill-backups");
        await safeParents(backups,home);
        await mkdir(backups, {recursive: true, mode: 0o700});
        backup = join(backups, randomUUID());
        await cp(path, backup, {recursive: true, dereference: false});
      }
      if (uninstall) {
        for (const file of [...files, ".evalme-install.json"]) await rm(join(path, file));
        for (const dir of [join(path, "references"), path]) {
          try {await rmdir(dir);} catch (e) {if (e.code !== "ENOTEMPTY") throw e;}
        }
        return {path, removed: true, replayed: false, ...(backup ? {backup} : {})};
      }
      if (!force && previous.cliPath === cliPath && previous.version === version && files.every((f) => hash(contents[f]) === previous.hashes[f]))
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
      cliPath,
      version,
      hashes: Object.fromEntries(files.map((f) => [f, hash(contents[f])])),
    };
    const temp = join(path, `.manifest-${randomUUID()}`);
    await writeFile(temp, JSON.stringify(manifest), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, join(path, ".evalme-install.json"));
    return { path, version, replayed: false, ...(backup ? {backup} : {}) };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export function uninstallSkill(options = {}) {
  return installSkill({...options, cliPath: options.cliPath || process.execPath, uninstall: true});
}

export function resolveSkillsDir(input,home=homedir()) {
 const value=input===undefined?join(home,'.agents','skills'):input;
 if(typeof value!=='string'||!value.trim()||/[\r\n\x00]/.test(value))throw fail('VALIDATION_ERROR','Skills directory must be an absolute path or ~/path.');
 const expanded=value==='~'?home:value.startsWith('~/')?join(home,value.slice(2)):value;
 if(!isAbsolute(expanded))throw fail('VALIDATION_ERROR','Skills directory must be absolute.');
 return resolve(expanded);
}
async function safeParents(path,home) {
 // Check all user-controlled ancestors; stop at the real home boundary. Outside
 // home, resolve system aliases (e.g. macOS /tmp) before checking the target.
 const boundary=resolve(home);
 for(let cur=path;;cur=dirname(cur)) {
  const s=await stat(cur);
  if(s&&(!s.isDirectory()||s.isSymbolicLink())) {
   if(cur!==path&&!path.startsWith(boundary+'/')&&['/tmp','/var'].includes(cur)&&s.isSymbolicLink())continue;
   throw fail('CONFLICT','Skill directory ancestors must be real directories.');
  }
  if(cur===boundary||dirname(cur)===cur)break;
 }
}
const registryPath=home=>join(home,'.local/share/evalme-mvp/skill-locations.json');
async function registry(home) {
 const path=registryPath(home),s=await stat(path);if(!s)return [];
 if(!s.isFile()||s.isSymbolicLink())throw fail('CONFLICT','Skill locations registry must be a regular file.');
 try {
  const m=JSON.parse(await readFile(path,'utf8'));
  if(m.owner!=='evalme-mvp'||!Array.isArray(m.directories)||m.directories.some(d=>resolveSkillsDir(d,home)!==d))throw Error();
  return m.directories;
 }catch{throw fail('CONFLICT','Skill locations registry is invalid; preserve it before repair.');}
}
export async function installSkill(options={}) {
 const home=options.home||homedir();
 if(typeof home!=='string'||!isAbsolute(home))throw fail('VALIDATION_ERROR','Home must be absolute.');
 const parent=resolveSkillsDir(options.skillsDir,home);
 await safeParents(parent,home);
 const data=dirname(registryPath(home));await safeParents(data,home);await mkdir(data,{recursive:true,mode:0o700});
 const lock=join(data,'.skill-locations.lock');
 try{await mkdir(lock,{mode:0o700});}catch{throw fail('CONFLICT','Another Skill operation may be running.');}
 try {
  const dirs=await registry(home);
  const result=await installAt({...options,home,skillsDir:parent});
  if(!dirs.includes(parent)) {
   const tmp=registryPath(home)+'.'+randomUUID()+'.tmp';
   try{await writeFile(tmp,JSON.stringify({owner:'evalme-mvp',directories:[...dirs,parent]}),{mode:0o600,flag:'wx'});await rename(tmp,registryPath(home));}
   finally{await rm(tmp,{force:true});}
  }
  return result;
 }finally{await rm(lock,{recursive:true,force:true});}
}
export async function scanSkills({home=homedir(),cliPath}={}) {
 const dirs=[...new Set([join(home,'.agents/skills'),join(home,'.claude/skills'),join(home,'.codex/skills'),...await registry(home)])];
 const entries=[],seen=new Map();
 for(const directory of dirs) {
  const path=join(directory,'evalme-mvp');let resolved;
  try{resolved=await realpath(path);}catch{}
  if(resolved&&seen.has(resolved)){seen.get(resolved).aliases.push(path);continue;}
  const entry={directory,path,real_path:resolved||null,aliases:[],status:'missing'};
  entries.push(entry);if(resolved)seen.set(resolved,entry);
  let s;try{s=await stat(path);}catch{entry.status='unknown';continue;}if(!s)continue;
  entry.status='unknown';
  try {
   const marker=await stat(join(path,'.evalme-install.json'));if(!marker?.isFile()||marker.isSymbolicLink())continue;
   const m=JSON.parse(await readFile(join(path,'.evalme-install.json'),'utf8'));
   if(m.owner!=='evalme-mvp'||!m.hashes||typeof m.cliPath!=='string')continue;
   entry.version=m.version;entry.cli_path=m.cliPath;
   let modified=false,current=true;
   for(const file of files){
    const f=await stat(join(path,file));
    if(!f?.isFile()||f.isSymbolicLink()){modified=true;break;}
    const actual=hash(await readFile(join(path,file)));if(actual!==m.hashes[file])modified=true;
    const desired=(await readFile(new URL(`../skills/evalme-mvp/${file}`,import.meta.url),'utf8')).replaceAll('{{CLI_PATH_JSON}}',JSON.stringify(cliPath||m.cliPath));
    if(actual!==hash(desired))current=false;
   }
   entry.status=modified?'modified':current&&m.version===version&&(!cliPath||m.cliPath===cliPath)?'current':'outdated';
  }catch{entry.status='unknown';}
 }
 return entries;
}
