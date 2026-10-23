import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {configPath, readConfig, assertRuntimePrivileges} from './config.mjs';
import {compatibleNode, runtimeHint} from './runtime.mjs';
export async function doctor(flags = {}) {
  const checks = [];
  checks.push({name:'runtime',ok:compatibleNode(),version:process.versions.node,path:process.execPath,fix:runtimeHint});
  let locations=[];
  try{locations=await (await import('./skill-install.mjs')).scanSkills();}catch{}
  const readySkills=locations.filter(e=>e.status==='current'&&e.cli_path&&existsSync(e.cli_path));
  checks.push({name:'skill',ok:readySkills.length>0,path:readySkills[0]?.path||join(homedir(),'.agents/skills/evalme-mvp'),locations,fix:'运行 evalme-mvp skill install --skills-dir <目录>；Pi /reload 或新开 Agent 会话。文件检查不证明宿主已加载。'});
  const wrapper=join(homedir(),'.local/bin/evalme-mvp');
  checks.push({name:'command',ok:existsSync(wrapper),path:wrapper,optional:true,fix:'通过正式安装器安装；也可使用当前 CLI 的绝对路径。'});
  let store;
  let deleteCapability={ready:false,reason:"NOT_CHECKED",next:"先完成连接检查。"};
  try {
    const runtime=readConfig(configPath(flags));
    checks.push({name:'config',ok:true,path:configPath(flags),provider:runtime.provider});
    if(runtime.provider==='postgres') {
      await assertRuntimePrivileges(runtime);
      const {inspectPostgres}=await import('./postgres-setup.mjs');
      if(await inspectPostgres(runtime)!=='READY') throw {code:'SCHEMA_SETUP_REQUIRED'};
    }
    const {openStore}=await import('./core.mjs');
    store=await openStore(runtime);const state=await store.checkSchema();
    if(runtime.provider==='sqlite')await (await import('./providers/sqlite-contract.mjs')).assertSQLite(store,state.schema_version);
    deleteCapability=state.schema_version===2?{ready:true}:{ready:false,reason:"DELETE_CAPABILITY_REQUIRED",next:"运行 evalme-mvp db migrate。"};
    await store.listTasks({limit:1});
    if(runtime.provider==='postgres') await assertRuntimePrivileges(runtime,{requireTables:true});
    checks.push({name:'database',ok:true,check:'schema/read/role grants; no learning records written'});
  } catch(e) {
    const fixes={CONFIG_NOT_FOUND:'运行 evalme-mvp init。',CONFIG_PERMISSIONS:'配置文件需属于当前用户，权限为 0600。',DB_CONNECTION_FAILED:'检查服务器、端口及 Tailscale 网络。',DB_TLS_FAILED:'检查服务器证书、主机名与 CA 配置。',CONFIG_AUTH_FAILED:'运行 init 重新输入正确的账号密码。',DB_PERMISSION_DENIED:'请服务端管理员授予应用账号所需 SELECT/INSERT 权限。',UNSAFE_RUNTIME_ROLE:'使用专用应用账号，不要使用数据库管理员。',SCHEMA_SETUP_REQUIRED:'运行 init，按提示初始化数据库。',DB_NOT_FOUND:'请管理员先创建目标数据库。',SCHEMA_INCOMPATIBLE:'现有结构不兼容，请管理员检查；不会自动补表或迁移。',SCHEMA_CHECK_FAILED:'无法可靠检查数据库结构，请管理员检查。'};
    checks.push({name:'database',ok:false,code:e.code||'CHECK_FAILED',fix:fixes[e.code]||'检查配置或运行 init；错误详情不会输出凭据。'});
  } finally {await store?.close().catch(()=>{});}
  return {ready:checks.every(c=>c.ok||c.optional),checks,delete_capability:deleteCapability};
}
