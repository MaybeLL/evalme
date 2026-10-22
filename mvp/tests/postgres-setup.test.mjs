import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initialize,AppError,assertRuntimePrivileges} from '../src/config.mjs';
import {inspectPostgres,initializePostgres,withPg,structure,contractSource} from '../src/postgres-setup.mjs';
import {openStore} from '../src/core.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const port=Number(process.env.EVALME_SETUP_PG_PORT);
const quote=s=>'"'+s.replaceAll('"','""')+'"';
async function fixture(t,{user}={}) {
 const id=randomUUID().replaceAll('-','');const database='setup_'+id;const owner='owner_'+id;user ||= 'app_'+id;
 const root={provider:'postgres',host:'127.0.0.1',port,user:'postgres',database:'postgres',ssl:false};
 const c=new pg.Client(root);await c.connect();
 const dir=mkdtempSync(join(tmpdir(),'evalme-pg-init-'));
 await c.query(`CREATE ROLE ${quote(user)} LOGIN`);await c.query(`CREATE ROLE ${quote(owner)} LOGIN`);await c.query(`CREATE DATABASE ${quote(database)}`);
 t.after(async()=>{await c.query(`DROP DATABASE ${quote(database)} WITH (FORCE)`);await c.query(`DROP ROLE ${quote(user)}`);await c.query(`DROP ROLE ${quote(owner)}`);await c.end();rmSync(dir,{recursive:true,force:true});});
 const admin={...root,database};const runtime={...admin,user,password:'synthetic'};
 await withPg(admin,c=>c.query(`CREATE SCHEMA evalme AUTHORIZATION ${quote(owner)}`));
 const secret=join(dir,'secret');writeFileSync(secret,'synthetic',{mode:0o600});
 const cfg=join(dir,'config.json');const connection=join(dir,'connection.json');
 const saved={host:runtime.host,port,database,user,secret_file:secret,ssl:false};
 writeFileSync(connection,JSON.stringify(saved),{mode:0o600});
 const flags={provider:'postgres',config:cfg,'connection-file':connection};
 return {dir,owner,admin,runtime,cfg,flags,saved,sql:sql=>withPg(admin,c=>c.query(sql))};
}
test('PostgreSQL initialization state and transactional setup',{skip:!port},async t=>{
 await t.test('empty database requires explicit admin; concurrent initialization is complete and repeatable',async t=>{
  const f=await fixture(t);
  assert.equal(await inspectPostgres(f.runtime),'UNINITIALIZED');
  await assert.rejects(initialize(f.flags),{code:'SCHEMA_SETUP_REQUIRED'});
  const results=await Promise.all([initializePostgres(f.admin,f.runtime),initializePostgres(f.admin,f.runtime)]);
  assert.deepEqual(results.sort(),[false,true]);
  assert.equal(await inspectPostgres(f.runtime),'READY');
  await assertRuntimePrivileges(f.runtime,{requireTables:true});
  await initialize(f.flags);
  assert.equal(JSON.parse(readFileSync(f.cfg)).user,f.runtime.user);
  const expected=JSON.parse(readFileSync(new URL('../src/providers/postgres-schema-v2.json',import.meta.url)));
  assert.equal(expected.source,contractSource());
  assert.deepEqual(await withPg(f.admin,structure),expected.structure);
  assert.equal((await f.sql(`SELECT has_table_privilege('${f.runtime.user}','evalme.schema_meta','INSERT') AS ok`)).rows[0].ok,false);
  // Old deployment grants metadata INSERT; preserve compatibility without mutating it.
  await f.sql(`GRANT INSERT ON evalme.schema_meta TO ${quote(f.runtime.user)}`);
  await initialize(f.flags);
 });
 await t.test('advanced non-interactive file interface initializes explicitly and preserves JSON protocol',async t=>{
  const f=await fixture(t);const adminFile=join(f.dir,'admin.json');
  writeFileSync(adminFile,JSON.stringify({...f.saved,user:'postgres'}),{mode:0o600});
  const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
  const run=args=>spawnSync(process.execPath,[cli,'init','--provider','postgres','--config',f.cfg,'--connection-file',f.flags['connection-file'],'--json','--non-interactive',...args],{encoding:'utf8',timeout:15000});
  const missing=run([]);assert.equal(missing.status,5);assert.equal(JSON.parse(missing.stdout).error.code,'SCHEMA_SETUP_REQUIRED');
  const created=run(['--admin-connection-file',adminFile]);assert.equal(created.status,0,created.stdout+created.stderr);assert.equal(JSON.parse(created.stdout).ok,true);assert.equal(created.stderr,'');
  const ready=run([]);assert.equal(ready.status,0,ready.stdout);assert.equal(JSON.parse(ready.stdout).data.provider,'postgres');
 });
 await t.test('existing core-generated schema matches contract without migrations',async t=>{
  const f=await fixture(t);const store=await openStore(f.admin);try{await store.initialize();}finally{await store.close();}
  assert.equal(await inspectPostgres(f.admin),'READY');
 });
 await t.test('partial tables, unknown objects and structural drift never auto-repair',async t=>{
  const f=await fixture(t);
  await f.sql('CREATE TABLE evalme.unrelated(id int)');
  await assert.rejects(initializePostgres(f.admin,f.runtime),{code:'SCHEMA_INCOMPATIBLE'});
  await f.sql(`DROP SCHEMA evalme CASCADE; CREATE SCHEMA evalme AUTHORIZATION ${quote(f.owner)}`);await initializePostgres(f.admin,f.runtime);
  for(const [change,restore] of [
   ['DROP INDEX evalme.trials_task_order','CREATE INDEX trials_task_order ON evalme.trials(task_id,created_at,id)'],
   ['ALTER TABLE evalme.tasks DROP CONSTRAINT tasks_family_id_fkey','ALTER TABLE evalme.tasks ADD CONSTRAINT tasks_family_id_fkey FOREIGN KEY(family_id) REFERENCES evalme.tasks(id) DEFERRABLE INITIALLY IMMEDIATE'],
   ['ALTER TABLE evalme.topics ALTER COLUMN name TYPE varchar','ALTER TABLE evalme.topics ALTER COLUMN name TYPE text'],
   ['DELETE FROM evalme.schema_meta','INSERT INTO evalme.schema_meta VALUES(2)'],
   ['CREATE VIEW evalme.unknown AS SELECT 1','DROP VIEW evalme.unknown'],
  ]) {
   await f.sql(change);await assert.rejects(inspectPostgres(f.runtime),{code:'SCHEMA_INCOMPATIBLE'});
   await assert.rejects(initializePostgres(f.admin,f.runtime),{code:'SCHEMA_INCOMPATIBLE'});
   await f.sql(restore);assert.equal(await inspectPostgres(f.runtime),'READY');
  }
 });
 await t.test('invisible structure is permission failure, not an empty database',async t=>{
  const f=await fixture(t);await initializePostgres(f.admin,f.runtime);
  await f.sql(`REVOKE USAGE ON SCHEMA evalme FROM ${quote(f.runtime.user)}`);
  await assert.rejects(inspectPostgres(f.runtime),{code:'DB_PERMISSION_DENIED'});
 });
 await t.test('old configuration conflict precedes all remote writes, including credential updates',async t=>{
  const f=await fixture(t);writeFileSync(f.cfg,JSON.stringify({provider:'sqlite',path:join(f.dir,'old.sqlite')}),{mode:0o600});
  const before=readFileSync(f.cfg,'utf8');
  await assert.rejects(initialize({...f.flags,_admin:{user:'postgres',password:'synthetic'}}),{code:'CONFIG_CONFLICT'});
  assert.equal(await inspectPostgres(f.runtime),'UNINITIALIZED');assert.equal(readFileSync(f.cfg,'utf8'),before);
 });
 await t.test('initialization failure and cancellation roll back schema and grants',async t=>{
  const f=await fixture(t);let count=0;
  await assert.rejects(initializePostgres(f.admin,f.runtime,()=>{if(++count===5)throw new AppError('CANCELLED','cancel',130);}),{code:'CANCELLED'});
  assert.equal(await inspectPostgres(f.admin),'UNINITIALIZED');
  await assert.rejects(initializePostgres(f.runtime,f.runtime),{code:'DB_PERMISSION_DENIED'});
  assert.equal(await inspectPostgres(f.admin),'UNINITIALIZED');
 });
 await t.test('missing database, target mismatch and unsafe role have distinct errors',async t=>{
  const f=await fixture(t);
  await assert.rejects(inspectPostgres({...f.runtime,database:'absent_'+randomUUID()}),{code:'DB_NOT_FOUND'});
  await assert.rejects(initializePostgres({...f.admin,database:'postgres'},f.runtime),{code:'VALIDATION_ERROR'});
  await assert.rejects(initializePostgres({...f.admin,ssl:{rejectUnauthorized:true}},f.runtime),{code:'VALIDATION_ERROR'});
  await assert.rejects(assertRuntimePrivileges(f.admin),{code:'UNSAFE_RUNTIME_ROLE'});
 });
 await t.test('role identifiers are safely quoted and admin password never persisted',async t=>{
  const f=await fixture(t,{user:'app"; --'+randomUUID()});
  await initialize({...f.flags,_admin:{user:'postgres',password:'ADMIN_NEVER_SAVE'}});
  assert.equal(await inspectPostgres(f.runtime),'READY');
  assert.ok(!readFileSync(f.cfg,'utf8').includes('ADMIN_NEVER_SAVE'));
 });
 await t.test('post-commit application verification failure is explicit and preserves old configuration',async t=>{
  const f=await fixture(t);const before=JSON.stringify({provider:'sqlite',path:join(f.dir,'old.sqlite')});writeFileSync(f.cfg,before,{mode:0o600});
  // Simulate an administrator default privilege that makes the runtime unsafe after creation.

  await f.sql(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(f.owner)} IN SCHEMA evalme GRANT DELETE ON TABLES TO ${quote(f.runtime.user)}`);
  await assert.rejects(initialize({...f.flags,'replace-config':true,_admin:{user:'postgres',password:'synthetic'}}),{code:'INIT_VERIFICATION_FAILED'});
  assert.equal(readFileSync(f.cfg,'utf8'),before);assert.equal(await inspectPostgres(f.admin),'READY');
  await f.sql(`REVOKE DELETE ON ALL TABLES IN SCHEMA evalme FROM ${quote(f.runtime.user)}`);
  await initialize({...f.flags,'replace-config':true});
 });
 await t.test('post-commit local save failure cleans generated secret and supports recovery',async t=>{
  const f=await fixture(t);const bad=join(f.dir,'parent-file');writeFileSync(bad,'not a directory');
  const flags={provider:'postgres',config:join(bad,'config.json'),_password:'RUNTIME_ONLY',_connectionValues:{...f.saved},_admin:{user:'postgres',password:'ADMIN_ONLY'}};
  await assert.rejects(initialize(flags),{code:'INIT_CONFIG_SAVE_FAILED'});
  assert.equal(await inspectPostgres(f.runtime),'READY');
  assert.equal(readdirSync(f.dir).some(x=>x.startsWith('credential-')),false);
  await initialize({...flags,config:f.cfg,_admin:undefined});
  const saved=JSON.parse(readFileSync(f.cfg));assert.equal(readFileSync(saved.secret_file,'utf8'),'RUNTIME_ONLY');assert.ok(!JSON.stringify(saved).includes('ADMIN_ONLY'));
 });
});
