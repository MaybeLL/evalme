import {existsSync, readFileSync, lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {configPath, readConfig, assertRuntimePrivileges} from './config.mjs';
import {compatibleNode, runtimeHint} from './runtime.mjs';
export async function doctor(flags = {}) {
  const checks = [];
  checks.push({name:'runtime',ok:compatibleNode(),version:process.versions.node,path:process.execPath,fix:runtimeHint});
  const skill = join(homedir(),'.agents/skills/evalme-mvp');
  let skillOK=false;
  try {
    const m=JSON.parse(readFileSync(join(skill,'.evalme-install.json'),'utf8'));
    skillOK=m.owner==='evalme-mvp' && ['SKILL.md','references/inputs.md'].every(f=>{
      const s=lstatSync(join(skill,f));return s.isFile()&&!s.isSymbolicLink()&&createHash('sha256').update(readFileSync(join(skill,f))).digest('hex')===m.hashes[f];
    }) && Boolean(m.cliPath&&existsSync(m.cliPath));
  } catch {}
  checks.push({name:'skill',ok:skillOK,path:skill,fix:'运行 evalme-mvp skill install；Pi /reload 或新开 Agent 会话。文件检查不证明宿主已加载。'});
  const wrapper=join(homedir(),'.local/bin/evalme-mvp');
  checks.push({name:'command',ok:existsSync(wrapper),path:wrapper,optional:true,fix:'通过正式安装器安装；也可使用当前 CLI 的绝对路径。'});
  let store;
  try {
    const runtime=readConfig(configPath(flags));
    checks.push({name:'config',ok:true,path:configPath(flags),provider:runtime.provider});
    if(runtime.provider==='postgres') await assertRuntimePrivileges(runtime);
    const {openStore}=await import('./core.mjs');
    store=await openStore(runtime);await store.checkSchema();
    await store.listTasks({limit:1});
    if(runtime.provider==='postgres') await assertRuntimePrivileges(runtime,{requireTables:true});
    checks.push({name:'database',ok:true,check:'schema/read/role grants; no learning records written'});
  } catch(e) {
    const fixes={CONFIG_NOT_FOUND:'运行 evalme-mvp init。',CONFIG_PERMISSIONS:'配置文件需属于当前用户，权限为 0600。',DB_CONNECTION_FAILED:'检查服务器、端口及 Tailscale 网络。',DB_TLS_FAILED:'检查服务器证书、主机名与 CA 配置。',CONFIG_AUTH_FAILED:'运行 init 重新输入正确的账号密码。',DB_PERMISSION_DENIED:'请服务端管理员授予应用账号所需 SELECT/INSERT 权限。',UNSAFE_RUNTIME_ROLE:'使用专用应用账号，不要使用数据库管理员。',SCHEMA_SETUP_REQUIRED:'请管理员初始化服务端 schema。'};
    checks.push({name:'database',ok:false,code:e.code||'CHECK_FAILED',fix:fixes[e.code]||'检查配置或运行 init；错误详情不会输出凭据。'});
  } finally {await store?.close().catch(()=>{});}
  return {ready:checks.every(c=>c.ok||c.optional),checks};
}
