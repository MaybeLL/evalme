import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const python = String.raw`
import os,sys,json,pty,select,time,re,signal,fcntl,termios,struct
spec=json.loads(sys.argv[1]); pid,fd=pty.fork()
if pid==0:
 fcntl.ioctl(0,termios.TIOCSWINSZ,struct.pack('HHHH',40,120,0,0))
 os.environ['HOME']=os.path.dirname(spec['config'])
 os.execv(spec['node'],[spec['node'],spec['cli']]+spec.get('command',['init'])+['--config',spec['config']]+spec.get('args',[]))
output=''; cursor=0; error=None; status=None; skill_skipped=False
def receive(deadline):
 global output,status,skill_skipped
 while time.monotonic()<deadline:
  ready,_,_=select.select([fd],[],[],0.05)
  if ready:
   try: data=os.read(fd,65536)
   except OSError: return False
   if not data:return False
   output+=re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', data.decode('utf-8','replace'))
   if spec.get('autoSkill',True) and not skill_skipped and ('是否安装 Agent Skill' in output or '是否更新 Agent Skill' in output):
    os.write(fd,b'n\r');skill_skipped=True
   return True
 return False
try:
 for step in spec['steps']:
  deadline=time.monotonic()+4
  while True:
   found=re.search(step['expect'],output[cursor:],re.I)
   if found:
    cursor+=found.end();os.write(fd,step['send'].replace('\n','\r').encode());break
   if not receive(deadline):raise RuntimeError('Missing prompt: '+step['expect'])
 deadline=time.monotonic()+8
 while receive(deadline):pass
 waited,status=os.waitpid(pid,os.WNOHANG)
 while not waited and time.monotonic()<deadline:
  time.sleep(0.01);waited,status=os.waitpid(pid,os.WNOHANG)
 if not waited:raise RuntimeError('CLI did not terminate')
except Exception as e:
 error=str(e)
 try:os.kill(pid,signal.SIGKILL);_,status=os.waitpid(pid,0)
 except ProcessLookupError:pass
finally:
 os.close(fd)
print(json.dumps({'output':output,'error':error,'status':os.waitstatus_to_exitcode(status) if status is not None else None}))
`;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "evalme-tty-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, config: join(dir, "config.json") };
}
function tty(config, steps, args = [], command = ['init'], autoSkill = true) {
  const r = spawnSync(
    "python3",
    [
      "-c",
      python,
      JSON.stringify({ node: process.execPath, cli, config, steps, args, command, autoSkill }),
    ],
    { encoding: "utf8", timeout: 25000 },
  );
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const selectSQLite = [
  { expect: "● 在这台电脑上保存", send: "\x1b[B" },
  { expect: "● 连接 PostgreSQL", send: "\x1b[A" },
  { expect: "● 在这台电脑上保存", send: "\r" },
];
const selectPG = [
  { expect: "● 在这台电脑上保存", send: "\x1b[B" },
  { expect: "● 连接 PostgreSQL", send: "\r" },
];
function initOld(config, path) {
  const r = spawnSync(
    process.execPath,
    [
      cli,
      "init",
      "--provider",
      "sqlite",
      "--path",
      path,
      "--config",
      config,
      "--non-interactive",
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
}
test("real PTY arrow menu chooses SQLite and persists initialized target", (t) => {
  const { dir, config } = fixture(t),
    db = join(dir, "new.sqlite");
  const r = tty(config, [
    ...selectSQLite,
    { expect: "SQLite 文件绝对路径", send: db + "\n" },
  ]);
  assert.equal(r.error, null, r.output);
  assert.equal(r.status, 0, r.output);
  assert.equal(JSON.parse(readFileSync(config)).path, db);
  assert.ok(existsSync(db));
});
test("real PTY PostgreSQL missing connection file preserves old configuration", (t) => {
  const { dir, config } = fixture(t);
  initOld(config, join(dir, "old.sqlite"));
  const before = readFileSync(config, "utf8");
  const r = tty(config, [
  ], ['--provider','postgres','--connection-file',join(dir,'missing.json')]);
  assert.equal(r.error, null, r.output);
  assert.equal(r.status, 5, r.output);
  assert.equal(readFileSync(config, "utf8"), before);
});
test("real PTY PostgreSQL unsafe secret permissions preserve old configuration", (t) => {
  const { dir, config } = fixture(t);
  initOld(config, join(dir, "old.sqlite"));
  const before = readFileSync(config, "utf8"),
    secret = join(dir, "secret"),
    connection = join(dir, "pg.json");
  writeFileSync(secret, "never-print-this", { mode: 0o644 });
  writeFileSync(
    connection,
    JSON.stringify({
      host: "127.0.0.1",
      port: 5432,
      database: "evalme",
      user: "runtime",
      secret_file: secret,
      ssl: false,
    }),
    { mode: 0o600 },
  );
  const r = tty(config, [
  ], ['--provider','postgres','--connection-file',connection]);
  assert.equal(r.error, null, r.output);
  assert.equal(r.status, 5, r.output);
  assert.equal(readFileSync(config, "utf8"), before);
  assert.ok(!r.output.includes("never-print-this"));
});
test("real PTY switching SQLite target requires displayed target and explicit confirmation", (t) => {
  const { dir, config } = fixture(t),
    old = join(dir, "old.sqlite"),
    next = join(dir, "next.sqlite");
  initOld(config, old);
  const before = readFileSync(config, "utf8");
  const steps = [
    {expect:"是否重新配置连接",send:"y\r"},
    ...selectSQLite,
    { expect: "SQLite 文件绝对路径", send: next + "\n" },
  ];
  const no = tty(config, [
    ...steps,
    { expect: "将连接配置替换为", send: "\r" },
  ]);
  assert.equal(no.error, null, no.output);
  assert.equal(readFileSync(config, "utf8"), before);
  assert.equal(existsSync(next), false);
  const yes = tty(config, [
    ...steps,
    { expect: "将连接配置替换为", send: "y\r" },
  ]);
  assert.equal(yes.error, null, yes.output);
  assert.equal(yes.status, 0, yes.output);
  assert.ok(
    yes.output.split(next).length >= 3,
    "Target must appear in confirmation as well as input echo",
  );
  assert.equal(JSON.parse(readFileSync(config)).path, next);
  assert.ok(existsSync(old));
});
test('real PTY PostgreSQL menu initializes against live PG and saves only runtime identity',{skip:!process.env.EVALME_TEST_PG_CONFIG},t=>{
 const {config}=fixture(t),connectionPath=process.env.EVALME_TEST_PG_CONFIG;
 const expected=JSON.parse(readFileSync(connectionPath,'utf8'));
 const r=tty(config,[],['--provider','postgres','--connection-file',connectionPath]);
 assert.equal(r.error,null,r.output);assert.equal(r.status,0,r.output);
 const saved=JSON.parse(readFileSync(config,'utf8'));
 assert.equal(saved.provider,'postgres');assert.equal(saved.host,expected.host);assert.equal(saved.port,expected.port);assert.equal(saved.database,expected.database);assert.equal(saved.user,expected.user);assert.equal(saved.secret_file,expected.secret_file);
 assert.equal(Object.hasOwn(saved,'password'),false);assert.equal(Object.hasOwn(saved,'admin-connection-file'),false);
 const secret=readFileSync(expected.secret_file,'utf8').replace(/\r?\n$/,'');assert.ok(!r.output.includes(secret),'TTY must not print password');
 const query=spawnSync(process.execPath,[cli,'task','list','--config',config,'--json','--non-interactive'],{encoding:'utf8'});assert.equal(query.status,0,query.stdout+query.stderr);assert.equal(JSON.parse(query.stdout).ok,true);
});

test('guided PostgreSQL hides password and saves managed credentials',{skip:!process.env.EVALME_TEST_PG_CONFIG},t=>{
 const {dir,config}=fixture(t);
 const c=JSON.parse(readFileSync(process.env.EVALME_TEST_PG_CONFIG,'utf8'));
 const password=readFileSync(c.secret_file,'utf8').replace(/\r?\n$/,'');
 const steps=[...selectPG,
 {expect:'PostgreSQL 地址',send:c.host+'\n'},
 {expect:'端口',send:String(c.port)+'\n'},
 {expect:'数据库名称',send:c.database+'\n'},
 {expect:'应用用户名',send:c.user+'\n'},
 {expect:'数据库密码',send:password+'\n'},
 {expect:'TLS 连接方式',send:'\x1b[B\r'},
];
 const r=tty(config,steps);
 assert.ok(!r.output.includes(password),'Password must not appear in terminal output');
 assert.equal(r.error,null);assert.equal(r.status,0);
 const saved=JSON.parse(readFileSync(config));assert.equal(saved.user,c.user);
 assert.ok(saved.secret_file.startsWith(dir+'/credential-'));
 assert.equal(readFileSync(saved.secret_file,'utf8'),password);
 const check=spawnSync(process.execPath,[cli,'task','list','--config',config,'--json'],{encoding:'utf8'});
 assert.equal(check.status,0);
});
test('guided PostgreSQL cancellation never persists or echoes password',t=>{
 const {dir,config}=fixture(t);const password='synthetic-private-password';
 const r=tty(config,[...selectPG,
 {expect:'PostgreSQL 地址',send:'127.0.0.1\n'},{expect:'端口',send:'1\n'},
 {expect:'数据库名称',send:'\n'},{expect:'应用用户名',send:'\n'},
 {expect:'数据库密码',send:password+'\n'},{expect:'TLS 连接方式',send:'\x03'}]);
 assert.ok(!r.output.includes(password));assert.equal(r.error,null);assert.notEqual(r.status,0);assert.equal(existsSync(config),false);
});

test('Clack renders vertical radio choices and cancels without saving', t => {
 const {config}=fixture(t);
 const r=tty(config,[{expect:'○ 连接 PostgreSQL',send:'\x03'}]);
 assert.equal(r.error,null,r.output);
 assert.match(r.output,/● 在这台电脑上保存[^\n]*\n[^\n]*○ 连接 PostgreSQL/);
 assert.match(r.output,/已取消/);
 assert.equal(r.status,130);
 assert.equal(existsSync(config),false);
});
test('Clack validates PostgreSQL port before continuing', t => {
 const {config}=fixture(t);
 const r=tty(config,[...selectPG,
 {expect:'PostgreSQL 地址',send:'127.0.0.1\r'},
 {expect:'端口',send:'70000\r'},
 {expect:'端口必须是',send:'\x03'}]);
 assert.equal(r.error,null,r.output);
 assert.equal(r.status,130);
 assert.equal(existsSync(config),false);
});

test('guided empty PostgreSQL needs consent, transient admin, and preserves config on refusal',{skip:!process.env.EVALME_SETUP_PG_PORT},async t=>{
 const {default:pg}=await import('pg');const {randomUUID}=await import('node:crypto');
 const {dir,config}=fixture(t);const id=randomUUID().replaceAll('-','');const database='tty_'+id,user='ttyapp_'+id,owner='ttyowner_'+id;
 const port=Number(process.env.EVALME_SETUP_PG_PORT);
 const root=new pg.Client({host:'127.0.0.1',port,user:'postgres',database:'postgres'});await root.connect();
 await root.query(`CREATE ROLE "${owner}" LOGIN`);await root.query(`CREATE ROLE "${user}" LOGIN`);await root.query(`CREATE DATABASE "${database}"`);
 t.after(async()=>{await root.query(`DROP DATABASE "${database}" WITH (FORCE)`);await root.query(`DROP ROLE "${user}"`);await root.query(`DROP ROLE "${owner}"`);await root.end();});
 initOld(config,join(dir,'old.sqlite'));const before=readFileSync(config,'utf8');
 const steps=[{expect:'是否重新配置连接',send:'y\r'},...selectPG,{expect:'PostgreSQL 地址',send:'127.0.0.1\r'},{expect:'端口',send:String(port)+'\r'},
 {expect:'数据库名称',send:database+'\r'},{expect:'应用用户名',send:user+'\r'},
 {expect:'数据库密码',send:'RUNTIME_SYNTHETIC\r'},{expect:'TLS 连接方式',send:'\x1b[B\r'}];
 // Reject replacing the old local connection, before any initialization prompt.
 const reject=tty(config,[...steps,{expect:'将连接配置替换为',send:'\r'}]);
 assert.equal(reject.error,null,reject.output);assert.equal(reject.status,4);assert.equal(readFileSync(config,'utf8'),before);
 const refused=tty(config,[...steps,{expect:'将连接配置替换为',send:'y\r'},{expect:'暂不初始化',send:'\r'}]);
 assert.equal(refused.error,null,refused.output);assert.equal(refused.status,130);assert.equal(readFileSync(config,'utf8'),before);
 const check=new pg.Client({host:'127.0.0.1',port,user:'postgres',database});await check.connect();
 assert.equal((await check.query("SELECT 1 FROM pg_namespace WHERE nspname='evalme'")).rowCount,0);await check.query(`CREATE SCHEMA evalme AUTHORIZATION "${owner}"`);await check.end();
 const accepted=tty(config,[...steps,{expect:'将连接配置替换为',send:'y\r'},
 {expect:'暂不初始化',send:'y\r'}, {expect:'临时管理用户名',send:'postgres\r'},
 {expect:'临时管理密码',send:'ADMIN_SYNTHETIC\r'}]);
 assert.equal(accepted.error,null,accepted.output);assert.equal(accepted.status,0,accepted.output);
 assert.ok(!accepted.output.includes('ADMIN_SYNTHETIC'));assert.ok(!accepted.output.includes('RUNTIME_SYNTHETIC'));
 assert.ok(!readFileSync(config,'utf8').includes('ADMIN_SYNTHETIC'));
 const saved=JSON.parse(readFileSync(config));assert.equal(saved.user,user);
 const ready=tty(config,[...steps,{expect:'更新此连接的凭据与设置',send:'y\r'}]);
 assert.equal(ready.error,null,ready.output);assert.equal(ready.status,0,ready.output);
 assert.ok(!ready.output.includes('将连接配置替换为'));
 assert.ok(!ready.output.includes('临时管理'));assert.ok(!ready.output.includes('JSON 路径'));
});

test('deletion PTY shows family scope, defaults to cancel, Ctrl-C preserves data, accepts explicit choice',async t=>{
 const {dir,config}=fixture(t);const runtime={provider:'sqlite',path:join(dir,'delete.sqlite')};
 const {openStore}=await import('../src/core.mjs');const {records}=await import('./helpers/deletion-records.mjs');const {migrateDatabase}=await import('../src/database.mjs');
 const s=await openStore(runtime,{initialize:true});const r=await records(s);await s.close();await migrateDatabase(runtime);
 writeFileSync(config,JSON.stringify(runtime),{mode:0o600});
 for(const send of ['\r','\x03']) {
  const p=tty(config,[{expect:'是否删除题目及全部关联记录',send}],[],['task','delete',r.a2]);
  assert.equal(p.error,null,p.output);assert.equal(p.status,130,p.output);assert.match(p.output,/题目版本：2 个/);assert.match(p.output,/练习记录：2 条/);
  const check=await openStore(runtime);assert.equal((await check.query('SELECT * FROM tasks')).length,3);await check.close();
 }
 const p=tty(config,[{expect:'是否删除题目及全部关联记录',send:'y\r'}],[],['task','delete',r.a2]);
 assert.equal(p.error,null,p.output);assert.equal(p.status,0,p.output);
 const check=await openStore(runtime);assert.equal((await check.query('SELECT * FROM tasks')).length,1);await check.close();
});

test('existing init defaults to keeping config and Ctrl-C never opens the wizard',t=>{
 const {dir,config}=fixture(t);initOld(config,join(dir,'old.sqlite'));const before=readFileSync(config);
 for(const [send,status] of [['\r',0],['\x03',130]]) {
  const r=tty(config,[{expect:'是否重新配置连接',send}]);
  assert.equal(r.error,null,r.output);assert.equal(r.status,status,r.output);
  assert.match(r.output,/检测到已有 EvalMe 配置/);assert.ok(!r.output.includes('你想如何保存学习数据'));
  assert.deepEqual(readFileSync(config),before);
 }
});
test('existing offline PostgreSQL summary does not read credentials or connect',t=>{
 const {dir,config}=fixture(t);writeFileSync(config,JSON.stringify({provider:'postgres',host:'127.0.0.1',port:1,database:'offline',user:'app',secret_file:join(dir,'absent-secret'),ssl:false}),{mode:0o600});
 const r=tty(config,[{expect:'是否重新配置连接',send:'\r'}]);
 assert.equal(r.error,null,r.output);assert.equal(r.status,0,r.output);assert.match(r.output,/127\.0\.0\.1:1\/offline/);assert.ok(!r.output.includes('无法读取'));
});
test('malformed existing config can be kept or explicitly repaired',t=>{
 const {dir,config}=fixture(t);writeFileSync(config,'{broken PRIVATE_TEXT',{mode:0o600});const before=readFileSync(config);
 const no=tty(config,[{expect:'是否重新配置连接',send:'\r'}]);assert.equal(no.error,null,no.output);assert.equal(no.status,0);assert.match(no.output,/已有配置无法读取/);assert.ok(!no.output.includes('PRIVATE_TEXT'));assert.deepEqual(readFileSync(config),before);
 const yes=tty(config,[{expect:'是否重新配置连接',send:'y\r'},...selectSQLite,{expect:'SQLite 文件绝对路径',send:join(dir,'new.sqlite')+'\r'},{expect:'将连接配置替换为',send:'y\r'}]);
 assert.equal(yes.error,null,yes.output);assert.equal(yes.status,0,yes.output);assert.equal(JSON.parse(readFileSync(config)).provider,'sqlite');
});

test('JSON init stays noninteractive and does not implicitly replace malformed config',t=>{
 const {dir,config}=fixture(t);writeFileSync(config,'{broken',{mode:0o600});const before=readFileSync(config);
 const r=spawnSync(process.execPath,[cli,'init','--provider','sqlite','--path',join(dir,'new.sqlite'),'--replace-config','--config',config,'--json','--non-interactive'],{encoding:'utf8',timeout:5000});
 assert.equal(r.status,5,r.stdout+r.stderr);assert.equal(JSON.parse(r.stdout).error.code,'CONFIG_INVALID');assert.equal(r.stderr,'');assert.deepEqual(readFileSync(config),before);assert.equal(existsSync(join(dir,'new.sqlite')),false);
});

test('init installs Skill to custom root after saving database and later shows recorded path',t=>{
 const {dir,config}=fixture(t);const root=join(dir,'My Skills');
 const r=tty(config,[...selectSQLite,{expect:'SQLite 文件绝对路径',send:join(dir,'db.sqlite')+'\r'},
 {expect:'是否安装 Agent Skill',send:'\r'},{expect:'将 Skill 安装到哪里',send:'\x1b[B\x1b[B\x1b[B\r'},
 {expect:'Skills 根目录',send:'~/My Skills\r'},{expect:'安装或更新到',send:'\r'}],[],['init'],false);
 assert.equal(r.error,null,r.output);assert.equal(r.status,0,r.output);assert.ok(existsSync(config));assert.ok(existsSync(join(root,'evalme-mvp/SKILL.md')));
 const before=readFileSync(config);const again=tty(config,[{expect:'是否重新配置连接',send:'\r'}],[],['init'],false);
 assert.equal(again.error,null,again.output);assert.equal(again.status,0,again.output);assert.ok(again.output.includes(root));assert.match(again.output,/Skill 已就绪/);assert.ok(!again.output.includes('是否安装 Agent Skill'));assert.deepEqual(readFileSync(config),before);
});
test('keeping existing connection can install to Claude; cancellation leaves database intact',t=>{
 const {dir,config}=fixture(t);initOld(config,join(dir,'db.sqlite'));const before=readFileSync(config);
 const cancelled=tty(config,[{expect:'是否重新配置连接',send:'\r'},{expect:'是否安装 Agent Skill',send:'\x03'}],[],['init'],false);
 assert.equal(cancelled.error,null,cancelled.output);assert.equal(cancelled.status,0,cancelled.output);assert.deepEqual(readFileSync(config),before);
 const r=tty(config,[{expect:'是否重新配置连接',send:'\r'},{expect:'是否安装 Agent Skill',send:'\r'},{expect:'将 Skill 安装到哪里',send:'\x1b[B\r'},{expect:'安装或更新到',send:'\r'}],[],['init'],false);
 assert.equal(r.error,null,r.output);assert.equal(r.status,0,r.output);assert.ok(existsSync(join(dir,'.claude/skills/evalme-mvp/SKILL.md')));assert.deepEqual(readFileSync(config),before);
});
test('init updates pristine old Skill at selected path; modified Skill failure preserves configuration',async t=>{
 const {dir,config}=fixture(t);const {installSkill}=await import('../src/skill-install.mjs');initOld(config,join(dir,'db.sqlite'));const before=readFileSync(config);
 const installed=await installSkill({home:dir,cliPath:cli,skillsDir:'~/.codex/skills'});const marker=join(installed.path,'.evalme-install.json');const m=JSON.parse(readFileSync(marker));m.version='0.0.0';writeFileSync(marker,JSON.stringify(m));
 const updated=tty(config,[{expect:'是否重新配置连接',send:'\r'},{expect:'是否更新 Agent Skill',send:'\r'},{expect:'将 Skill 安装到哪里',send:'\r'},{expect:'安装或更新到',send:'\r'}],[],['init'],false);
 assert.equal(updated.error,null,updated.output);assert.equal(updated.status,0,updated.output);assert.notEqual(JSON.parse(readFileSync(marker)).version,'0.0.0');
 writeFileSync(join(installed.path,'SKILL.md'),'my edits');
 const failed=tty(config,[{expect:'是否重新配置连接',send:'\r'},{expect:'是否安装 Agent Skill',send:'\r'},{expect:'将 Skill 安装到哪里',send:'\x1b[B\x1b[B\r'},{expect:'安装或更新到',send:'\r'}],[],['init'],false);
 assert.equal(failed.error,null,failed.output);assert.equal(failed.status,0,failed.output);assert.match(failed.output,/Skill 配置未完成/);assert.equal(readFileSync(join(installed.path,'SKILL.md'),'utf8'),'my edits');assert.deepEqual(readFileSync(config),before);
});
