import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile, readFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
const fixture=async t=>{const home=await mkdtemp(join(tmpdir(),'evalme-setup-'));t.after(()=>rm(home,{recursive:true,force:true}));return home;};
function run(home,args){const r=spawnSync(process.execPath,[cli,...args,'--json'],{env:{...process.env,HOME:home,EVALME_CONFIG:''},encoding:'utf8'});return {...r,body:JSON.parse(r.stdout)};}
test('doctor diagnoses missing configuration without secrets, then healthy SQLite',async t=>{
 const home=await fixture(t);
 const missing=run(home,['doctor']);assert.equal(missing.status,5);assert.equal(missing.body.data.ready,false);
 assert.equal(run(home,['init','--provider','sqlite','--non-interactive']).status,0);
 assert.equal(run(home,['skill','install']).status,0);
 const checked=run(home,['doctor']);assert.equal(checked.status,0,checked.stdout);assert.equal(checked.body.data.ready,true);
});
test('guided password failure preserves previous config and removes temporary credential',async t=>{
 const home=await fixture(t);const config=join(home,'config.json');
 await writeFile(config,JSON.stringify({provider:'sqlite',path:join(home,'old.sqlite')}),{mode:0o600});
 const before=await readFile(config,'utf8');
 const {initialize}=await import('../src/config.mjs');
 await assert.rejects(initialize({config,provider:'postgres',_password:'never-print-this',_connectionValues:{host:'127.0.0.1',port:1,database:'evalme',user:'evalme_app',ssl:false},'replace-config':true}));
 assert.equal(await readFile(config,'utf8'),before);
 const {readdir}=await import('node:fs/promises');
 assert.equal((await readdir(home)).some(x=>x.startsWith('credential-')),false);
});

test('doctor classifies unreachable PostgreSQL separately from authentication',async t=>{
 const home=await fixture(t);const dir=join(home,'.config/evalme-mvp');await mkdir(dir,{recursive:true});
 const secret=join(dir,'app.secret');await writeFile(secret,'synthetic-never-print-password',{mode:0o600});
 const config={provider:'postgres',host:'127.0.0.1',port:1,database:'evalme',user:'evalme_app',secret_file:secret,ssl:false};
 await writeFile(join(dir,'config.json'),JSON.stringify(config),{mode:0o600});
 const r=run(home,['doctor']);assert.equal(r.status,5);
 assert.equal(r.body.data.checks.find(c=>c.code)?.code,'DB_CONNECTION_FAILED');assert.ok(!r.stdout.includes('synthetic-never-print-password'));
});
test('doctor identifies bad authentication against live PostgreSQL',{skip:!process.env.EVALME_TEST_PG_CONFIG},async t=>{
 const home=await fixture(t);const dir=join(home,'.config/evalme-mvp');await mkdir(dir,{recursive:true});
 const c=JSON.parse(await readFile(process.env.EVALME_TEST_PG_CONFIG,'utf8'));const secret=join(dir,'bad.secret');
 await writeFile(secret,'synthetic-wrong-password',{mode:0o600});
 await writeFile(join(dir,'config.json'),JSON.stringify({...c,provider:'postgres',secret_file:secret}),{mode:0o600});
 const r=run(home,['doctor']);assert.equal(r.status,5);
 assert.equal(r.body.data.checks.find(c=>c.code)?.code,'CONFIG_AUTH_FAILED');assert.ok(!r.stdout.includes('synthetic-wrong-password'));
});
