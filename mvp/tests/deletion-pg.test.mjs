import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {openStore} from '../src/core.mjs';
import {records} from './helpers/deletion-records.mjs';
import {previewDeletion,deleteTask,migrateDatabase} from '../src/database.mjs';
const q=x=>'"'+x.replaceAll('"','""')+'"';
const port=Number(process.env.EVALME_SETUP_PG_PORT);
export async function fixture(t,{seed=true,databaseName}={}) {
 const x=randomUUID().replaceAll('-','');const database=databaseName||'delete_'+x,owner='owner_'+x,user='app_'+x;
 const base={provider:'postgres',host:'127.0.0.1',port,user:'postgres',database:'postgres',ssl:false};
 const root=new pg.Client(base);await root.connect();
 await root.query(`CREATE ROLE ${q(owner)} LOGIN`);await root.query(`CREATE ROLE ${q(user)} LOGIN`);await root.query(`CREATE DATABASE ${q(database)}`);
 const admin={...base,database,user:owner},runtime={...base,database,user};
 const bootstrap=new pg.Client({...base,database});await bootstrap.connect();
 await bootstrap.query(`REVOKE CREATE ON DATABASE ${q(database)} FROM PUBLIC;CREATE SCHEMA evalme AUTHORIZATION ${q(owner)}`);
 const s=await openStore(admin,{initialize:true});
 await bootstrap.query(`GRANT USAGE ON SCHEMA evalme TO ${q(user)}; GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA evalme TO ${q(user)}`);
 t.after(async()=>{await s.close();await bootstrap.end();await root.query(`DROP DATABASE ${q(database)} WITH (FORCE)`);await root.query(`DROP ROLE ${q(owner)};DROP ROLE ${q(user)}`);await root.end();});
 return {admin,runtime,s,bootstrap,...(seed?await records(s):{})};
}
test('PostgreSQL least-privilege deletion and migration',{skip:!port},async t=>{
 const f=await fixture(t);
 await assert.rejects(previewDeletion(f.runtime,f.a),{code:'DELETE_CAPABILITY_REQUIRED'});
 assert.equal((await migrateDatabase(f.runtime,{admin:f.admin,dryRun:true})).can_migrate,true);
 assert.equal((await migrateDatabase(f.runtime,{admin:f.admin})).version,2);
 const client=await openStore(f.runtime);t.after(()=>client.close());
 await assert.rejects(client.query('DELETE FROM tasks'));
 const p=await previewDeletion(f.runtime,f.a2);assert.equal(p.can_delete,true);
 await assert.rejects(deleteTask(f.runtime,f.a,'invalid'),{code:'DELETE_PLAN_CHANGED'});
 assert.equal((await deleteTask(f.runtime,f.a,p.plan_token)).deleted,true);
 assert.equal((await client.query('SELECT * FROM tasks')).length,1);
 assert.equal((await client.query('SELECT * FROM topics')).length,1);
});
test('PostgreSQL rejects legacy cross-family data and raw INSERT after migration',{skip:!port},async t=>{
 const f=await fixture(t);await f.s.query('UPDATE trials SET task_id=? WHERE id=?',[f.b,f.repeat]);
 await assert.rejects(migrateDatabase(f.runtime,{admin:f.admin}),{code:'MIGRATION_BLOCKED'});
 await f.s.query('UPDATE trials SET task_id=? WHERE id=?',[f.a2,f.repeat]);await migrateDatabase(f.runtime,{admin:f.admin});
 const client=await openStore(f.runtime);t.after(()=>client.close());
 await assert.rejects(client.query('INSERT INTO trials SELECT ?,schema_version,payload_hash,created_at,?,occurred_at,answer,answer_kind,process,conditions,source,based_on_grade_id,NULL,NULL FROM trials WHERE id=?',[randomUUID(),f.b,f.repeat]));
});

test('PostgreSQL security contract rejects function, ACL and trigger tampering',{skip:!port},async t=>{
 const f=await fixture(t);await migrateDatabase(f.runtime,{admin:f.admin});
 await f.s.db.exec('GRANT EXECUTE ON FUNCTION evalme.delete_task_family(uuid,text) TO PUBLIC');
 await assert.rejects(previewDeletion(f.runtime,f.a),{code:'DELETE_CAPABILITY_UNSAFE'});
 await f.s.db.exec('REVOKE EXECUTE ON FUNCTION evalme.delete_task_family(uuid,text) FROM PUBLIC');
 await f.s.db.exec('ALTER TABLE trials DISABLE TRIGGER evalme_feedback_family');
 await assert.rejects(previewDeletion(f.runtime,f.a),{code:'DELETE_CAPABILITY_UNSAFE'});
 await f.s.db.exec('ALTER TABLE trials ENABLE TRIGGER evalme_feedback_family');
 await f.s.db.exec("ALTER FUNCTION evalme.delete_task_family(uuid,text) SET search_path=public");
 await assert.rejects(previewDeletion(f.runtime,f.a),{code:'DELETE_CAPABILITY_UNSAFE'});
});
test('PostgreSQL stale plans, external links and transactional failure preserve all records',{skip:!port},async t=>{
 const f=await fixture(t);await migrateDatabase(f.runtime,{admin:f.admin});const p=await previewDeletion(f.runtime,f.a);
 await f.s.query('UPDATE tasks SET title=? WHERE id=?',['edited',f.a]);
 await assert.rejects(deleteTask(f.runtime,f.a,p.plan_token),{code:'DELETE_PLAN_CHANGED'});
 await f.s.query('UPDATE tasks SET previous_task_id=? WHERE id=?',[f.a2,f.b]);
 const blocked=await previewDeletion(f.runtime,f.a);assert.equal(blocked.can_delete,false);assert.ok(blocked.blockers.length);assert.equal(blocked.plan_token,undefined);
 await assert.rejects(deleteTask(f.runtime,f.a,p.plan_token),{code:'DELETE_BLOCKED_REFERENCES'});
 await f.s.query('UPDATE tasks SET previous_task_id=NULL WHERE id=?',[f.b]);
 const fresh=await previewDeletion(f.runtime,f.a);
 // statement failure inside the function must roll back preceding DELETE statements.
 await f.s.db.exec("CREATE FUNCTION evalme.test_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$;CREATE TRIGGER test_abort BEFORE DELETE ON evalme.trials FOR EACH ROW EXECUTE FUNCTION evalme.test_abort()");
 const app=await openStore(f.runtime);t.after(()=>app.close());
 await assert.rejects(app.query('SELECT evalme.delete_task_family(?,?)',[f.a,fresh.plan_token]));
 assert.equal((await app.query('SELECT * FROM grades')).length,1);
 assert.equal((await app.query('SELECT * FROM tasks')).length,3);
});
test('PostgreSQL concurrent insertion cannot silently enlarge an approved delete',{skip:!port},async t=>{
 const f=await fixture(t);await migrateDatabase(f.runtime,{admin:f.admin});const p=await previewDeletion(f.runtime,f.a);
 const writer=new pg.Client(f.admin);writer.on("error",()=>{});await writer.connect();t.after(()=>writer.end());await writer.query('BEGIN');
 await writer.query('UPDATE evalme.tasks SET title=$1 WHERE id=$2',['changed while deleting',f.a]);
 const deletion=deleteTask(f.runtime,f.a,p.plan_token);const rejected=assert.rejects(deletion,{code:'DELETE_PLAN_CHANGED'});
 await new Promise(r=>setTimeout(r,80));await writer.query('COMMIT');await rejected;
 assert.equal((await f.s.query('SELECT * FROM tasks')).length,3);
 const latest=await previewDeletion(f.runtime,f.a);
 const results=await Promise.allSettled([deleteTask(f.runtime,f.a,latest.plan_token),deleteTask(f.runtime,f.a,latest.plan_token)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.filter(r=>r.status==='rejected')[0].reason.code,'NOT_FOUND');
});

test('fresh PostgreSQL init creates v2 without storing or broadening admin identity',{skip:!port},async t=>{
 const f=await fixture(t);await f.bootstrap.query(`DROP SCHEMA evalme CASCADE; CREATE SCHEMA evalme AUTHORIZATION ${q(f.admin.user)}`);
 const {initializePostgres,inspectPostgres}=await import('../src/postgres-setup.mjs');
 await initializePostgres(f.admin,f.runtime);
 assert.equal((await f.s.query('SELECT version FROM schema_meta'))[0].version,2);
 assert.equal(await inspectPostgres(f.runtime),'READY');
});

test('PostgreSQL rejects column-level identity writes',{skip:!port},async t=>{
 const f=await fixture(t);await migrateDatabase(f.runtime,{admin:f.admin});
 await f.s.db.exec(`GRANT UPDATE(database_uuid) ON evalme.database_identity TO ${q(f.runtime.user)}`);
 const {inspectPostgres}=await import('../src/postgres-setup.mjs');
 await assert.rejects(inspectPostgres(f.runtime),{code:'DELETE_CAPABILITY_UNSAFE'});
 await assert.rejects(previewDeletion(f.runtime,f.a),{code:'UNSAFE_RUNTIME_ROLE'});
});

test('PostgreSQL deletes correction chains and rejects different database identity',{skip:!port},async t=>{
 const f=await fixture(t);const {corrections}=await import('./helpers/deletion-records.mjs');await corrections(f.s,f);await migrateDatabase(f.runtime,{admin:f.admin});
 const p=await previewDeletion(f.runtime,f.a2);assert.deepEqual(p.counts,{tasks:2,trials:3,grades:3,task_topics:2});
 await f.s.query('UPDATE database_identity SET database_uuid=?',[randomUUID()]);
 await assert.rejects(deleteTask(f.runtime,f.a,p.plan_token),{code:'DELETE_PLAN_CHANGED'});
 const fresh=await previewDeletion(f.runtime,f.a);await deleteTask(f.runtime,f.a2,fresh.plan_token);
 assert.equal((await f.s.query('SELECT * FROM tasks')).length,1);assert.equal((await f.s.query('SELECT * FROM grades')).length,0);
});

test('PostgreSQL lock timeout and unsupported isolation roll back without deletion',{skip:!port},async t=>{
 const f=await fixture(t);await migrateDatabase(f.runtime,{admin:f.admin});const p=await previewDeletion(f.runtime,f.a);
 const writer=new pg.Client(f.admin);writer.on('error',()=>{});await writer.connect();
 try {
  await writer.query('BEGIN');await writer.query('LOCK TABLE evalme.trials IN ROW EXCLUSIVE MODE');
  await assert.rejects(deleteTask(f.runtime,f.a,p.plan_token),{code:'DB_BUSY'});
  await writer.query('ROLLBACK');
  await writer.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await assert.rejects(writer.query('SELECT evalme.delete_task_family($1,$2)',[f.a,p.plan_token]),{message:'DELETE_ISOLATION_REQUIRED'});
  await writer.query('ROLLBACK');assert.equal((await f.s.query('SELECT * FROM tasks')).length,3);
 }finally{await writer.end();}
});
test('PostgreSQL lost COMMIT acknowledgement reports unknown even when deletion committed',{skip:!port},async t=>{
 const f=await fixture(t);await migrateDatabase(f.runtime,{admin:f.admin});const p=await previewDeletion(f.runtime,f.a);
 const original=pg.Client.prototype.query;
 try {
  pg.Client.prototype.query=async function(sql,...args){const r=await original.call(this,sql,...args);if(sql==='COMMIT')throw Object.assign(new Error('synthetic lost acknowledgement'),{code:'ECONNRESET'});return r;};
  await assert.rejects(deleteTask(f.runtime,f.a,p.plan_token),{code:'COMMIT_UNKNOWN',exitCode:6});
 }finally{pg.Client.prototype.query=original;}
 assert.equal((await f.s.query('SELECT * FROM tasks')).length,1);
 await assert.rejects(previewDeletion(f.runtime,f.a),{code:'NOT_FOUND'});
});
test('PostgreSQL SIGINT while waiting for locks rolls back before commit',{skip:!port},async t=>{
 const f=await fixture(t);await migrateDatabase(f.runtime,{admin:f.admin});const p=await previewDeletion(f.runtime,f.a);
 const writer=new pg.Client(f.admin);writer.on('error',()=>{});await writer.connect();
 const {spawn}=await import('node:child_process');
 const code=`import {deleteTask} from ${JSON.stringify(new URL('../src/database.mjs',import.meta.url).href)};let text='';for await(const b of process.stdin)text+=b;const x=JSON.parse(text);try{console.log(JSON.stringify(await deleteTask(x.runtime,x.id,x.token)));}catch(e){console.log(JSON.stringify({code:e.code}));process.exitCode=e.exitCode||1;}`;
 let child;
 try {
  await writer.query('BEGIN');await writer.query('LOCK TABLE evalme.trials IN ROW EXCLUSIVE MODE');
  child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['pipe','pipe','pipe']});
  let out='';child.stdout.on('data',b=>{out+=b;});const exited=new Promise(resolve=>child.on('exit',resolve));
  child.stdin.end(JSON.stringify({runtime:f.runtime,id:f.a,token:p.plan_token}));
  let waiting=false;
  for(let i=0;i<100;i++) {
   const r=await f.bootstrap.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND wait_event_type='Lock' AND query LIKE '%delete_task_family%'",[f.runtime.user]);
   if(r.rowCount){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(waiting,true,'delete must be waiting for the writer');child.kill('SIGINT');
  await new Promise(resolve=>setTimeout(resolve,30));await writer.query('ROLLBACK');
  assert.equal(await exited,130,out);assert.equal(JSON.parse(out).code,'CANCELLED');
  assert.equal((await f.s.query('SELECT * FROM tasks')).length,3);assert.equal((await f.s.query('SELECT * FROM grades')).length,1);
 }finally{child?.kill('SIGKILL');await writer.end();}
});

test('deployment snapshot captures v1 and v2 identity with real psql',{skip:!port||!process.env.EVALME_SETUP_PG_CONTAINER},async t=>{
 const f=await fixture(t);const {snapshot,compareSnapshots}=await import('../scripts/deploy/postgres-mac.mjs');
 const p={container:process.env.EVALME_SETUP_PG_CONTAINER};const before=snapshot(p,f.admin.database);assert.equal(before.database_identity,undefined);
 await migrateDatabase(f.runtime,{admin:f.admin});const after=snapshot(p,f.admin.database);assert.equal(after.database_identity.count,1);
 assert.equal(compareSnapshots(after,snapshot(p,f.admin.database)),true);
 assert.deepEqual(after.tasks,before.tasks);assert.deepEqual(after.trials,before.trials);
});

test('PostgreSQL canonical plan has a fixed vector independent of session timezone',{skip:!port},async t=>{
 const f=await fixture(t,{seed:false,databaseName:'delete_fixed_vector'});const {fixedRecords}=await import('./helpers/deletion-records.mjs');const a=await fixedRecords(f.s);await migrateDatabase(f.runtime,{admin:f.admin});
 await f.s.query('UPDATE database_identity SET database_uuid=?',['44444444-4444-4444-8444-444444444444']);
 const p=await previewDeletion(f.runtime,a);assert.equal(p.plan_token,'pg-delete-v1:53ed9cff51eb062d24951f3ac0351f82036bde1117a1d956007036b7eec38c3a');
 await f.s.db.exec("SET TimeZone='Asia/Shanghai';SET DateStyle='SQL,DMY'");
 assert.equal((await f.s.query('SELECT evalme.preview_task_delete(?) AS plan',[a]))[0].plan.plan_token,p.plan_token);
});

test('PostgreSQL audits dangling topic edges even after privileged FK bypass',{skip:!port},async t=>{
 const f=await fixture(t);
 await f.bootstrap.query('SET session_replication_role=replica;DELETE FROM evalme.topics;SET session_replication_role=origin');
 const p=await migrateDatabase(f.runtime,{dryRun:true});assert.equal(p.can_migrate,false);assert.ok(p.blockers.some(b=>b.relation==='task_topics.topic_id'));
 await assert.rejects(migrateDatabase(f.runtime,{admin:f.admin}),{code:'MIGRATION_BLOCKED'});
 assert.equal((await f.s.query('SELECT version FROM schema_meta'))[0].version,1);
});
