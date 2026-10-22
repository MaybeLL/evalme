import {existsSync,readFileSync,writeFileSync,mkdirSync,lstatSync,renameSync,rmSync} from 'node:fs';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {AppError,privateJson} from './config.mjs';
import {compatibleNode,runtimeHint} from './runtime.mjs';
import {uninstallSkill} from './skill-install.mjs';
const digest=x=>createHash('sha256').update(x).digest('hex');
const quote=x=>"'"+x.replaceAll("'", "'\\''")+"'";
const root=()=>join(homedir(),'.local/share/evalme-mvp/installation');
const command=()=>join(homedir(),'.local/bin/evalme-mvp');
function realDir(path) {
  if(path!==homedir() && dirname(path)!==path) realDir(dirname(path));
  if(lstatIf(path)) {const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink()) throw new AppError('INSTALL_CONFLICT','Expected a real installation directory.');}
  else {mkdirSync(path,{mode:0o700});}
}
function manifest() {
  const p=join(root(),'manifest.json');
  if(!existsSync(p)) return null;
  const m=privateJson(p);
  if(m.owner!=='evalme-mvp-installer' || !Array.isArray(m.generations) || m.generations.some(x=>!/^release-[a-f0-9-]+$/.test(x))) throw new AppError('INSTALL_CONFLICT','Unknown installation ownership.');
  return m;
}
function checkLauncher(m) {
  if(!existsSync(command()) && !lstatIf(command())) return;
  const s=lstatSync(command());
  if(!m||!s.isFile()||s.isSymbolicLink()||digest(readFileSync(command()))!==m.launcherHash) throw new AppError('INSTALL_CONFLICT','Existing evalme-mvp command is not managed or was modified; preserve it before installing.');
}
function lstatIf(p){try{return lstatSync(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function runNpm(args,cwd) {
  try {return execFileSync('npm',args,{cwd,env:{...process.env,PATH:dirname(process.execPath)+':'+process.env.PATH},encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000});}
  catch {throw new AppError('INSTALL_FAILED','Package installation failed. Check npm/network availability; existing installation is retained.');}
}
export async function install(source) {
  if(!compatibleNode()) throw new AppError('RUNTIME_UNSUPPORTED',runtimeHint);
  if(!isAbsolute(source)) throw new AppError('VALIDATION_ERROR','Source path must be absolute.');
  source=resolve(source);if(existsSync(join(source,'mvp/package.json')))source=join(source,'mvp');
  const pkg=JSON.parse(readFileSync(join(source,'package.json')));
  if(pkg.name!=='evalme-mvp-cli')throw new AppError('INSTALL_FAILED','Not an EvalMe package.');
  realDir(root());realDir(dirname(command()));
  const lock=join(root(),'.lock');try{mkdirSync(lock);}catch{throw new AppError('INSTALL_CONFLICT','Another installer may be running.');}
  let generation,activated=false;
  try {
    const before=manifest();checkLauncher(before);
    generation='release-'+randomUUID();const stage=join(root(),generation);mkdirSync(stage,{mode:0o700});
    const packed=JSON.parse(runNpm(['pack','--ignore-scripts','--json','--pack-destination',stage],source));
    const tarball=join(stage,packed[0].filename);
    const app=join(stage,'app');mkdirSync(app,{mode:0o700});
    execFileSync('tar',['-xzf',tarball,'--strip-components=1','-C',app]);
    runNpm(['ci','--prefer-offline','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],app);
    rmSync(tarball);
    const cli=join(app,'src/cli.mjs');
    const result=JSON.parse(execFileSync(process.execPath,[cli,'--version','--json'],{encoding:'utf8'}));
    if(!result.ok)throw new AppError('INSTALL_FAILED','Installed CLI smoke test failed.');
    // Keep the stable wrapper path in the Skill so upgrades need no host-specific adaptation.
    try {
      execFileSync(process.execPath,[cli,'skill','install','--cli-path',command(),'--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
    } catch(e) {
      let error;try {error=JSON.parse(String(e.stdout)).error;} catch {}
      throw new AppError(error?.code || 'INSTALL_FAILED',error?.message || 'Skill installation failed; previous program retained.',error?.code === 'CONFLICT' ? 4 : 5);
    }
    const wrapper=`#!/bin/sh\n# Managed by evalme-mvp-installer\nexport EVALME_LAUNCHER=${quote(command())}\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`;
    const tmp=command()+'.'+randomUUID()+'.tmp';writeFileSync(tmp,wrapper,{mode:0o700,flag:'wx'});
    const next={owner:'evalme-mvp-installer',version:pkg.version,runtime:process.execPath,launcherHash:digest(wrapper),generations:[...(before?.generations||[]),generation]};
    const mp=join(root(),'manifest.json');
    const mt=mp+'.tmp';writeFileSync(mt,JSON.stringify(next),{mode:0o600});
    const oldWrapper=existsSync(command())?readFileSync(command()):null;
    try {renameSync(tmp,command());renameSync(mt,mp);activated=true;}
    catch(e){
      if(oldWrapper)writeFileSync(command(),oldWrapper,{mode:0o700});else if(existsSync(command()))rmSync(command());
      if(existsSync(tmp))rmSync(tmp);if(existsSync(mt))rmSync(mt);throw e;
    }
    return {version:pkg.version,command:command(),onPath:(process.env.PATH||'').split(':').includes(dirname(command()))};
  } finally {
    if(generation&&!activated)rmSync(join(root(),generation),{recursive:true,force:true});
    rmSync(lock,{recursive:true,force:true});
  }
}
export async function upgrade(flags={}) {
  if(flags.source) return install(resolve(flags.source));
  if(!manifest())throw new AppError('INSTALL_CONFLICT','Use the installer first; this CLI is not managed.');
  const script=fileURLToPath(new URL('../scripts/install.sh',import.meta.url));
  try {execFileSync('sh',[script],{env:{...process.env,EVALME_NODE:process.execPath},stdio:['ignore','pipe','pipe'],timeout:300000});}
  catch{throw new AppError('UPGRADE_FAILED','Upgrade failed; check network or use the installer again.');}
  return {upgraded:true,version:manifest().version};
}
export async function uninstall(flags={}) {
  const m=manifest();if(!m)throw new AppError('INSTALL_CONFLICT','No managed installation. npm-installed copies must be removed with npm.');
  checkLauncher(m);
  const plan={command:command(),program:root(),skill:join(homedir(),'.agents/skills/evalme-mvp'),purge_config:Boolean(flags['purge-config']),data:'All SQLite files and remote learning records are retained.'};
  if(!flags.yes) {
    if(flags.json||flags['non-interactive']||!process.stdin.isTTY)return {removed:false,plan,next:'Repeat with --yes to execute this plan.'};
    process.stderr.write(JSON.stringify(plan,null,2)+'\n');
    const rl=createInterface({input:process.stdin,output:process.stderr});
    let answer;try{answer=await rl.question('Uninstall these managed files? [y/N] ');}finally{rl.close();}
    if(!/^y(es)?$/i.test(answer.trim()))return {removed:false,plan};
  }
  realDir(root());const lock=join(root(),'.lock');try{mkdirSync(lock);}catch{throw new AppError('INSTALL_CONFLICT','Another installation may be running.');}
  try {
    await uninstallSkill();
    if(flags['purge-config']) {
      const p=join(homedir(),'.config/evalme-mvp/config.json');
      if(existsSync(p)) {
        const c=privateJson(p);
        if(c.provider==='sqlite' && resolve(c.path)===resolve(p))throw new AppError('CONFIG_CONFLICT','Refusing to remove a data path.');
        // Only installer/init-generated secrets; never delete externally supplied files.
        if(c.secret_file && dirname(c.secret_file)===dirname(p) && /^credential-[a-f0-9-]+\.secret$/.test(c.secret_file.split('/').pop())) {
          const s=lstatIf(c.secret_file);if(s?.isFile()&&!s.isSymbolicLink())rmSync(c.secret_file);
        }
        rmSync(p);
      }
    }
    if(existsSync(command()))rmSync(command());
    for(const g of m.generations)rmSync(join(root(),g),{recursive:true,force:true});
    rmSync(join(root(),'manifest.json'));
    return {removed:true,...plan};
  } finally {rmSync(lock,{recursive:true,force:true});}
}
