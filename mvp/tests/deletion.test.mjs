import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../src/core.mjs';
const id=()=>randomUUID();
import {records} from './helpers/deletion-records.mjs';
async function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'evalme-delete-'));const runtime={provider:'sqlite',path:join(dir,'db.sqlite')};
 const s=await openStore(runtime,{initialize:true});
 t.after(async()=>{await s.close();rmSync(dir,{recursive:true,force:true});});
 return {runtime,s,...await records(s)};
}
test('feedback may cross task versions but never families',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.s.recordTrial({id:id(),task_id:f.b,answer:'wrong family',answer_kind:'verbatim',based_on_grade_id:f.grade,conditions:{hint_status:'provided',hints:['feedback']}}),{code:'VALIDATION_ERROR'});
});
test('SQLite explicit migration, complete family deletion and retained topic',async t=>{
 const f=await fixture(t);const api=await import('../src/database.mjs');
 await assert.rejects(api.previewDeletion(f.runtime,f.a),{code:'DELETE_CAPABILITY_REQUIRED'});
 const migration=await api.migrateDatabase(f.runtime,{dryRun:true});assert.equal(migration.from,1);assert.equal(migration.can_migrate,true);
 assert.equal((await api.migrateDatabase(f.runtime)).version,2);
 assert.equal((await api.migrateDatabase(f.runtime)).changed,false);
 const p=await api.previewDeletion(f.runtime,f.a2);assert.equal(p.family_id,f.a);assert.equal(p.can_delete,true);
 assert.deepEqual(p.counts,{tasks:2,trials:2,grades:1,task_topics:2});
 await assert.rejects(api.deleteTask(f.runtime,f.a2,'bad-token'),{code:'DELETE_PLAN_CHANGED'});
 assert.equal((await api.deleteTask(f.runtime,f.a2,p.plan_token)).deleted,true);
 assert.equal((await f.s.query('SELECT * FROM topics')).length,1);
 assert.equal((await f.s.query('SELECT * FROM tasks')).length,1);
 assert.equal((await f.s.query('SELECT * FROM trials')).length,0);
 assert.equal((await f.s.query('PRAGMA foreign_key_check')).length,0);
 await assert.rejects(api.previewDeletion(f.runtime,f.a),{code:'NOT_FOUND'});
});
test('SQLite stale full-content plan, blockers, and rollback',async t=>{
 const f=await fixture(t);const api=await import('../src/database.mjs');await api.migrateDatabase(f.runtime);
 const p=await api.previewDeletion(f.runtime,f.a);
 await f.s.query('UPDATE tasks SET title=? WHERE id=?',['changed without payload hash',f.a]);
 await assert.rejects(api.deleteTask(f.runtime,f.a,p.plan_token),{code:'DELETE_PLAN_CHANGED'});
 const q=await api.previewDeletion(f.runtime,f.a);
 await f.s.db.exec("CREATE TRIGGER abort_delete BEFORE DELETE ON trials BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
 await assert.rejects(api.deleteTask(f.runtime,f.a,q.plan_token));
 assert.equal((await f.s.query('SELECT * FROM grades')).length,1);
 assert.equal((await f.s.query('PRAGMA foreign_keys'))[0].foreign_keys,1);
 await f.s.db.exec('DROP TRIGGER abort_delete');
 await f.s.query('UPDATE tasks SET previous_task_id=? WHERE id=?',[f.a2,f.b]);
 const blocked=await api.previewDeletion(f.runtime,f.a);assert.equal(blocked.can_delete,false);assert.equal(blocked.plan_token,undefined);
 await assert.rejects(api.deleteTask(f.runtime,f.a,q.plan_token),{code:'DELETE_BLOCKED_REFERENCES'});
});
test('SQLite migration refuses legacy cross-family feedback without changing records',async t=>{
 const f=await fixture(t);await f.s.query('UPDATE trials SET task_id=? WHERE id=?',[f.b,f.repeat]);
 const api=await import('../src/database.mjs');const p=await api.migrateDatabase(f.runtime,{dryRun:true});assert.equal(p.can_migrate,false);
 await assert.rejects(api.migrateDatabase(f.runtime),{code:'MIGRATION_BLOCKED'});
 assert.equal((await f.s.query('SELECT version FROM schema_meta'))[0].version,1);
});

test('SQLite rejects drifted capability and legacy dangling foreign keys',async t=>{
 const f=await fixture(t);const api=await import('../src/database.mjs');
 await f.s.db.exec('PRAGMA foreign_keys=OFF');await f.s.query('DELETE FROM topics');await f.s.db.exec('PRAGMA foreign_keys=ON');
 await assert.rejects(api.migrateDatabase(f.runtime),{code:'SCHEMA_INCOMPATIBLE'});
 assert.equal((await f.s.query('SELECT version FROM schema_meta'))[0].version,1);
});
test('SQLite v2 verifies trigger body and identity on repeat migration and preview',async t=>{
 const f=await fixture(t);const api=await import('../src/database.mjs');await api.migrateDatabase(f.runtime);
 await f.s.db.exec('DROP TRIGGER evalme_feedback_insert');
 await assert.rejects(api.migrateDatabase(f.runtime,{dryRun:true}),{code:'SCHEMA_INCOMPATIBLE'});
 await assert.rejects(api.previewDeletion(f.runtime,f.a),{code:'SCHEMA_INCOMPATIBLE'});
});

test('SQLite deletes feedback and correction cycles while preserving other records; token binds file',async t=>{
 const f=await fixture(t);const {corrections}=await import('./helpers/deletion-records.mjs');await corrections(f.s,f);
 const api=await import('../src/database.mjs');await api.migrateDatabase(f.runtime);
 const p=await api.previewDeletion(f.runtime,f.a2);assert.deepEqual(p.counts,{tasks:2,trials:3,grades:3,task_topics:2});
 const before=await f.s.query('SELECT * FROM tasks WHERE id=?',[f.b]);
 const {DatabaseSync}=await import('node:sqlite');
 const other={...f.runtime,path:join(f.runtime.path,'..','copy.sqlite')};
 // VACUUM INTO makes a consistent copy, including its logical UUID.
 const db=new DatabaseSync(f.runtime.path);db.exec(`VACUUM INTO '${other.path.replaceAll("'","''")}'`);db.close();
 await assert.rejects(api.deleteTask(other,f.a,p.plan_token),{code:'DELETE_PLAN_CHANGED'});
 await api.deleteTask(f.runtime,f.a2,p.plan_token);
 assert.deepEqual(await f.s.query('SELECT * FROM tasks WHERE id=?',[f.b]),before);
 assert.equal((await f.s.query('SELECT * FROM trials')).length,0);assert.equal((await f.s.query('SELECT * FROM grades')).length,0);
});

test('SQLite canonical plan has a fixed Unicode, JSON, null and timestamp vector',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'evalme-vector-'));const s=await openStore({provider:'sqlite',path:join(dir,'db')},{initialize:true});t.after(async()=>{await s.close();rmSync(dir,{recursive:true,force:true});});
 const {fixedRecords}=await import('./helpers/deletion-records.mjs');const a=await fixedRecords(s);const {graph}=await import('../src/database.mjs');const {makePlan}=await import('../src/deletion-graph.mjs');
 const p=makePlan(await graph(s),a,'44444444-4444-4444-8444-444444444444','/fixed/evalme.sqlite');
 assert.equal(p.plan_token,'sqlite-delete-v1:0dcdc3a25e7280a99b20abb591a702534ba47f660f35de3600b16f18c856db55');
});
