import {mutationSignal} from './mutation-signal.mjs';
import {randomUUID} from 'node:crypto';
import {AppError,assertRuntimePrivileges} from './config.mjs';
import {withPg,inspectClient} from './postgres-setup.mjs';
import {auditGraph} from './deletion-graph.mjs';
import {functions,signature,createFunction,foreignKeys} from './providers/delete-functions.mjs';
const quote=x=>'"'+x.replaceAll('"','""')+'"';
const fail=(code,message,details={})=>{throw new AppError(code,message,5,details);};
async function audit(c) {const g={};for(const table of ['topics','tasks','trials','grades','task_topics'])g[table]=(await c.query(`SELECT * FROM evalme.${table}`)).rows;return auditGraph(g);}
async function version(c) {const {rows}=await c.query('SELECT version FROM evalme.schema_meta');if(rows.length!==1||![1,2].includes(rows[0].version))fail('SCHEMA_INCOMPATIBLE','数据库版本不兼容。');return rows[0].version;}
export async function installV2(c, runtimeRole) {
 const blockers=await audit(c);if(blockers.length)fail('MIGRATION_BLOCKED','历史引用或版本链异常，迁移未执行。',{blockers});
 const {rows:[owner]}=await c.query("SELECT r.oid,r.rolname,r.rolsuper,r.rolcreaterole,r.rolcreatedb FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname='evalme'");
 if(!owner||owner.rolsuper||owner.rolcreaterole||owner.rolcreatedb||owner.rolname===runtimeRole)fail('MIGRATION_OWNER_REQUIRED','需要受限的非应用、非超级用户 schema owner；请管理员先准备该身份。');
 const bad=await c.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='evalme' AND c.relkind='r' AND c.relowner<>$1",[owner.oid]);
 if(bad.rowCount)fail('MIGRATION_OWNER_REQUIRED','现有表应由受控 schema owner 拥有。');
 await c.query('ALTER TABLE evalme.schema_meta DROP CONSTRAINT schema_meta_version_check');
 await c.query('UPDATE evalme.schema_meta SET version=2');
 await c.query('ALTER TABLE evalme.schema_meta ADD CONSTRAINT schema_meta_version_check CHECK(version=2)');
 await c.query('CREATE TABLE evalme.database_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),database_uuid UUID NOT NULL UNIQUE,runtime_role TEXT NOT NULL)');
 await c.query('INSERT INTO evalme.database_identity VALUES(1,$1,$2)',[randomUUID(),runtimeRole]);
 await c.query(`ALTER TABLE evalme.database_identity OWNER TO ${quote(owner.rolname)}`);
 // Remove inherited default grants on identity; only the owner may write it.
 const identityACL=await c.query("SELECT DISTINCT x.grantee,r.rolname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x LEFT JOIN pg_roles r ON r.oid=x.grantee WHERE n.nspname='evalme' AND c.relname='database_identity' AND x.grantee<>c.relowner");
 for(const r of identityACL.rows)await c.query(`REVOKE ALL ON evalme.database_identity FROM ${r.grantee===0?'PUBLIC':quote(r.rolname)}`);
 await c.query(`GRANT SELECT ON evalme.database_identity TO ${quote(runtimeRole)}`);
 for(const [table,name]of foreignKeys)await c.query(`ALTER TABLE evalme.${table} ALTER CONSTRAINT ${name} DEFERRABLE INITIALLY IMMEDIATE`);
 for(const f of functions) {
  await c.query(createFunction(f));
  const sig=`evalme.${f.name}(${signature(f)})`;
  await c.query(`ALTER FUNCTION ${sig} OWNER TO ${quote(owner.rolname)}`);
  const a=await c.query("SELECT DISTINCT x.grantee,r.rolname FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x LEFT JOIN pg_roles r ON r.oid=x.grantee WHERE p.oid=$1::regprocedure AND x.grantee<>p.proowner",[sig]);
  for(const r of a.rows)await c.query(`REVOKE ALL ON FUNCTION ${sig} FROM ${r.grantee===0?'PUBLIC':quote(r.rolname)}`);
  if(f.public)await c.query(`GRANT EXECUTE ON FUNCTION ${sig} TO ${quote(runtimeRole)}`);
 }
 await c.query('CREATE TRIGGER evalme_feedback_family BEFORE INSERT OR UPDATE ON evalme.trials FOR EACH ROW EXECUTE FUNCTION evalme._feedback_family()');
}
export async function assertSecurity(c) {
 const id=await c.query('SELECT * FROM evalme.database_identity');if(id.rowCount!==1||id.rows[0].singleton!==1)fail('SCHEMA_INCOMPATIBLE','数据库身份不完整。');
 const runtimeRole=id.rows[0].runtime_role;
 const roles=await c.query("SELECT r.oid,r.rolname,r.rolsuper,r.rolcreaterole,r.rolcreatedb FROM pg_roles r WHERE r.oid=(SELECT nspowner FROM pg_namespace WHERE nspname='evalme')");const owner=roles.rows[0];
 if(!owner||owner.rolsuper||owner.rolcreaterole||owner.rolcreatedb||owner.rolname===runtimeRole)fail('DELETE_CAPABILITY_UNSAFE','删除函数 owner 不安全。');
 for(const f of functions) {
  const sig=`evalme.${f.name}(${signature(f)})`;const {rows:[p]}=await c.query(`SELECT oid,prosrc,prosecdef,proowner,provolatile,proconfig,pg_get_function_result(oid) AS result,prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AS language_ok FROM pg_proc WHERE oid=to_regprocedure($1)`,[sig]);
  if(!p||!p.language_ok||p.prosrc!==f.body||!p.prosecdef||p.proowner!==owner.oid||p.provolatile!==f.volatility||p.result!==f.returns||JSON.stringify([...(p.proconfig||[])].sort())!==JSON.stringify(['search_path=pg_catalog, pg_temp','TimeZone=UTC','DateStyle=ISO,YMD'].sort()))fail('DELETE_CAPABILITY_UNSAFE','删除函数定义或安全设置不匹配。');
  const excess=await c.query("SELECT 1 FROM pg_roles r WHERE NOT r.rolsuper AND r.oid<>$1 AND r.rolname<>$2 AND has_function_privilege(r.oid,$3::oid,'EXECUTE') UNION ALL SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$3::oid AND (a.grantee=0 OR (a.grantee<>$1 AND a.is_grantable))",[owner.oid,f.public?runtimeRole:owner.rolname,p.oid]);
  if(excess.rowCount)fail('DELETE_CAPABILITY_UNSAFE','删除函数存在未授权的执行权限。');
  if(f.public && !(await c.query("SELECT has_function_privilege($1::name,$2::oid,'EXECUTE') AS ok",[runtimeRole,p.oid])).rows[0].ok)fail('DELETE_CAPABILITY_UNSAFE','应用账号缺少删除函数权限。');
 }
 const trigger=await c.query("SELECT t.tgenabled,t.tgtype,t.tgfoid='evalme._feedback_family()'::regprocedure AS function_ok,t.tgqual IS NULL AS unconditional,t.tgnargs,t.tgattr::text AS attrs FROM pg_trigger t WHERE t.tgrelid='evalme.trials'::regclass AND t.tgname='evalme_feedback_family'");
 if(trigger.rowCount!==1||trigger.rows[0].tgenabled!=='O'||trigger.rows[0].tgtype!==23||!trigger.rows[0].function_ok||!trigger.rows[0].unconditional||trigger.rows[0].tgnargs!==0||trigger.rows[0].attrs!=='')fail('DELETE_CAPABILITY_UNSAFE','同题系列约束触发器不匹配或未启用。');
 const extra=await c.query("SELECT 1 FROM pg_roles r WHERE NOT r.rolsuper AND r.rolname !~ '^pg_' AND r.oid<>$1 AND (has_table_privilege(r.oid,'evalme.database_identity','INSERT,UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege(r.oid,'evalme.database_identity','INSERT,UPDATE'))",[owner.oid]);
 if(extra.rowCount)fail('DELETE_CAPABILITY_UNSAFE','数据库身份元数据有额外写权限。');
 return id.rows[0];
}
export async function migrate(runtime,{admin,dryRun=false}={}) {
 await assertRuntimePrivileges(runtime);
 if(!admin && !dryRun){const p=await migrate(runtime,{dryRun:true});if(p.from===2)return p;fail('MIGRATION_ADMIN_REQUIRED','需要临时管理身份。');}
 if(admin)for(const key of ['host','port','database','ssl'])if(JSON.stringify(admin[key])!==JSON.stringify(runtime[key]))fail('VALIDATION_ERROR','管理连接必须与应用连接目标和 TLS 一致。');
 return withPg(admin||runtime,async c=>{
  await c.query(dryRun?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');let committing=false;const signal=dryRun?null:mutationSignal();
  try {
   if(!dryRun){await c.query("SET LOCAL lock_timeout='5000ms'");await c.query('SELECT pg_advisory_xact_lock(109539641,1)');}
   const from=await version(c);
   if(!dryRun)await c.query(`LOCK TABLE evalme.schema_meta,${from===2?'evalme.database_identity,':''}evalme.topics,evalme.tasks,evalme.task_topics,evalme.trials,evalme.grades IN SHARE ROW EXCLUSIVE MODE`);
   await inspectClient(c);
   const blockers=await audit(c);const p={from,version:2,changed:from!==2,can_migrate:!blockers.length,blockers};
   if(dryRun){await c.query('ROLLBACK');return p;}
   if(blockers.length)fail('MIGRATION_BLOCKED','历史引用异常，迁移被阻止。',{blockers});
   if(from===1){if(!admin)fail('MIGRATION_ADMIN_REQUIRED','需要临时管理身份。');await installV2(c,runtime.user);await inspectClient(c);}
   await signal?.checkpoint();committing=true;await c.query('COMMIT');return p;
  }catch(e){await c.query('ROLLBACK').catch(()=>{});if(committing)throw new AppError('COMMIT_UNKNOWN','迁移提交结果未知，请运行 db migrate --dry-run 检查。',6);throw e;}finally{signal?.close();}
 });
}
async function ready(c) {if(await version(c)!==2)fail('DELETE_CAPABILITY_REQUIRED','请先运行 evalme-mvp db migrate 升级删除能力。');await inspectClient(c);}
export async function preview(runtime,id) {await assertRuntimePrivileges(runtime);return withPg(runtime,async c=>{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');try{await ready(c);return (await c.query('SELECT evalme.preview_task_delete($1) AS plan',[id])).rows[0].plan;}finally{await c.query('ROLLBACK');}});}
export async function remove(runtime,id,token) {await assertRuntimePrivileges(runtime);return withPg(runtime,async c=>{await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');let committing=false;const signal=mutationSignal();try{await ready(c);const p=(await c.query('SELECT evalme.delete_task_family($1,$2) AS result',[id,token])).rows[0].result;await signal.checkpoint();committing=true;await c.query('COMMIT');return p;}catch(e){await c.query('ROLLBACK').catch(()=>{});if(committing)throw new AppError('COMMIT_UNKNOWN','删除提交结果未知，请重新读取并预览。',6);throw e;}finally{signal.close();}});}
