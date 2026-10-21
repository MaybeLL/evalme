import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {connection} from '../src/config.mjs';
const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
if(process.env.EVALME_TEST_PG_CONFIG&&process.env.EVALME_TEST_PG_ADMIN_CONFIG)test('real PostgreSQL CLI init, privileges and process-restart learning flow',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'evalme-pg-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const config=join(dir,'config.json');
 function run(args,input){const r=spawnSync(process.execPath,[cli,...args,'--config',config,'--json','--non-interactive'],{encoding:'utf8',input});return {...r,body:JSON.parse(r.stdout)};}
 function ok(args,input){const r=run(args,input);assert.equal(r.status,0,r.stdout+r.stderr);return r.body;}
 ok(['init','--provider','postgres','--connection-file',process.env.EVALME_TEST_PG_CONFIG,'--admin-connection-file',process.env.EVALME_TEST_PG_ADMIN_CONFIG]);
 const persisted=JSON.parse(readFileSync(config));assert.equal(persisted.user,'evalme_app');assert.equal(persisted.password,undefined);assert.ok(!readFileSync(config,'utf8').includes('evalme_admin'));
 const before=readFileSync(config,'utf8');const elevated=run(['init','--provider','postgres','--connection-file',process.env.EVALME_TEST_PG_ADMIN_CONFIG,'--replace-config']);assert.equal(elevated.status,5);assert.equal(elevated.body.error.code,'UNSAFE_RUNTIME_ROLE');assert.equal(readFileSync(config,'utf8'),before);
 const {default:pg}=await import('pg');const client=new pg.Client(connection(process.env.EVALME_TEST_PG_CONFIG).runtime);await client.connect();try{await assert.rejects(client.query('CREATE TABLE evalme.forbidden_probe(id integer)'),{code:'42501'});await assert.rejects(client.query('DELETE FROM evalme.tasks WHERE false'),{code:'42501'});}finally{await client.end();}
 const topic={id:randomUUID(),name:'PG '+randomUUID()};ok(['topic','create','--input','-'],JSON.stringify(topic));
 const task={id:randomUUID(),prompt:'Explain event-loop blocking.',topic_ids:[topic.id]};ok(['task','create','--input','-'],JSON.stringify(task));assert.equal(ok(['task','create','--input','-'],JSON.stringify(task)).meta.replayed,true);
 const tr={id:randomUUID(),task_id:task.id,answer:'CPU work blocks the event loop.',answer_kind:'verbatim',conditions:{hint_status:'none',hints:[]}};ok(['trial','record','--input','-'],JSON.stringify(tr));
 const gr={id:randomUUID(),trial_id:tr.id,basis:{mode:'task_only',reasoning:'Synthetic fixture review'},feedback:'Recognized CPU blocking.',findings:[{id:'f1',kind:'correct',statement:'CPU work can block',evidence:[{target:'answer',quote:'CPU work'}]}],uncertainties:['Synthetic fixture, not a real learner assessment.'],evaluator:{name:'integration-fixture'}};ok(['grade','submit','--input','-'],JSON.stringify(gr));
 assert.equal(ok(['grade','get',gr.id]).data.trial_id,tr.id);ok(['trial','record','--input','-'],JSON.stringify({...tr,id:randomUUID()}));assert.equal(ok(['trial','list','--task',task.id]).data.length,2);
 assert.equal(ok(['task','list','--topic',topic.id]).data[0].id,task.id);
 const broken=join(dir,'bad.json');const c=JSON.parse(readFileSync(process.env.EVALME_TEST_PG_CONFIG));const secret=join(dir,'bad.secret');writeFileSync(secret,'not-the-real-password',{mode:0o600});writeFileSync(broken,JSON.stringify({...c,secret_file:secret}),{mode:0o600});const auth=run(['init','--provider','postgres','--connection-file',broken,'--replace-config']);assert.equal(auth.status,5);assert.ok(!auth.stdout.includes('not-the-real-password'));assert.equal(readFileSync(config,'utf8'),before);
});
