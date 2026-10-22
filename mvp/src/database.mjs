import {mutationSignal} from './mutation-signal.mjs';
import {randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {AppError} from './config.mjs';
import {openStore} from './core.mjs';
import {auditGraph,makePlan} from './deletion-graph.mjs';
import {assertSQLite,metadataV2,identityDDL,feedbackTriggers} from './providers/sqlite-contract.mjs';
import {uuid} from './core-validation.mjs';
const fail=(code,message,details={})=>{throw new AppError(code,message,5,details);};
export async function graph(s) {const g={};for(const table of ['topics','tasks','trials','grades','task_topics'])g[table]=await s.query(`SELECT * FROM ${table}`);return g;}
async function sqlite(runtime,fn,write=false) {
 const s=await openStore(runtime);let commit=false;const signal=write?mutationSignal():null;
 try {
  await s.db.exec('PRAGMA busy_timeout=5000');await s.db.exec(write?'BEGIN IMMEDIATE':'BEGIN');
  const result=await fn(s);await signal?.checkpoint();commit=true;await s.db.exec('COMMIT');return result;
 } catch(e) {
  await s.db.exec('ROLLBACK').catch(()=>{});
  if(commit)throw new AppError('COMMIT_UNKNOWN','提交结果未知，请重新读取状态并预览，勿直接重试删除。',6);
  if(e.errcode===5 || /database is locked/.test(e.message))throw new AppError('DB_BUSY','数据库忙，请稍后重试。',6);
  throw e;
 } finally {signal?.close();await s.close();}
}
async function version(s) {const rows=await s.query('SELECT version FROM schema_meta');if(rows.length!==1||![1,2].includes(rows[0].version))fail('SCHEMA_INCOMPATIBLE','数据库版本不兼容。');return rows[0].version;}
async function sqlitePlan(s,runtime,id) {
 if(await version(s)!==2)fail('DELETE_CAPABILITY_REQUIRED','请先运行 evalme-mvp db migrate 升级删除能力。');
 await assertSQLite(s,2);
 const rows=await s.query('SELECT database_uuid FROM database_identity');if(rows.length!==1)fail('SCHEMA_INCOMPATIBLE','数据库身份无效。');
 return makePlan(await graph(s),id,rows[0].database_uuid,realpathSync(runtime.path));
}
export async function migrateDatabase(runtime,options={}) {
 if(runtime.provider==='postgres')return (await import('./postgres-delete.mjs')).migrate(runtime,options);
 return sqlite(runtime,async s=>{
  const from=await version(s);await assertSQLite(s,from);const blockers=auditGraph(await graph(s));
  const plan={from,version:2,changed:from!==2,can_migrate:!blockers.length,blockers};
  if(options.dryRun)return plan;
  if(blockers.length)fail('MIGRATION_BLOCKED','历史引用或版本链异常，迁移未执行。',{blockers});
  if(from===2)return plan;
  await s.db.exec(metadataV2);
  await s.db.exec(identityDDL);
  await s.query('INSERT INTO database_identity VALUES(1,?)',[randomUUID()]);
  for(const ddl of feedbackTriggers)await s.db.exec(ddl);
  await assertSQLite(s,2);
  return plan;
 },!options.dryRun);
}
export async function previewDeletion(runtime,id) {
 uuid(id);
 if(runtime.provider==='postgres')return (await import('./postgres-delete.mjs')).preview(runtime,id);
 return sqlite(runtime,s=>sqlitePlan(s,runtime,id));
}
export async function deleteTask(runtime,id,token) {
 uuid(id);if(typeof token!=='string'||token.length>256)fail('DELETE_CONFIRMATION_REQUIRED','请先预览并提供 --confirm <plan-token>。');
 if(runtime.provider==='postgres')return (await import('./postgres-delete.mjs')).remove(runtime,id,token);
 return sqlite(runtime,async s=>{
  const p=await sqlitePlan(s,runtime,id);
  if(!p.can_delete)fail('DELETE_BLOCKED_REFERENCES','存在异常引用，删除被阻止。',{blockers:p.blockers});
  if(token!==p.plan_token)fail('DELETE_PLAN_CHANGED','删除范围已变化，请重新预览确认。');
  await s.db.exec('PRAGMA defer_foreign_keys=ON');
  await s.query('DELETE FROM task_topics WHERE task_id IN (SELECT id FROM tasks WHERE family_id=?)',[p.family_id]);
  await s.query('DELETE FROM grades WHERE trial_id IN (SELECT id FROM trials WHERE task_id IN (SELECT id FROM tasks WHERE family_id=?))',[p.family_id]);
  await s.query('DELETE FROM trials WHERE task_id IN (SELECT id FROM tasks WHERE family_id=?)',[p.family_id]);
  await s.query('DELETE FROM tasks WHERE family_id=?',[p.family_id]);
  if((await s.query('PRAGMA foreign_key_check')).length)fail('DELETE_BLOCKED_REFERENCES','外键检查失败，删除已回滚。');
  return {deleted:true,family_id:p.family_id,counts:p.counts};
 },true);
}
