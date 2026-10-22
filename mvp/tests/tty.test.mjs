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
import os,sys,json,pty,select,time,re,signal
spec=json.loads(sys.argv[1]); pid,fd=pty.fork()
if pid==0:
 os.execv(spec['node'],[spec['node'],spec['cli'],'init','--config',spec['config']])
output=''; cursor=0; error=None; status=None
def receive(deadline):
 global output,status
 while time.monotonic()<deadline:
  ready,_,_=select.select([fd],[],[],0.05)
  if ready:
   try: data=os.read(fd,65536)
   except OSError: return False
   if not data:return False
   output+=data.decode('utf-8','replace'); return True
 return False
try:
 for step in spec['steps']:
  deadline=time.monotonic()+4
  while True:
   found=re.search(step['expect'],output[cursor:],re.I)
   if found:
    cursor+=found.end();os.write(fd,step['send'].encode());break
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
function tty(config, steps) {
  const r = spawnSync(
    "python3",
    [
      "-c",
      python,
      JSON.stringify({ node: process.execPath, cli, config, steps }),
    ],
    { encoding: "utf8", timeout: 25000 },
  );
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const selectSQLite = [
  { expect: "› SQLite", send: "\x1b[B" },
  { expect: "› PostgreSQL", send: "\x1b[A" },
  { expect: "› SQLite", send: "\r" },
];
const selectPG = [
  { expect: "› SQLite", send: "\x1b[B" },
  { expect: "› PostgreSQL", send: "\r" },
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
    { expect: "SQLite absolute path", send: db + "\n" },
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
    ...selectPG,
    {
      expect: "Runtime connection JSON path",
      send: join(dir, "missing.json") + "\n",
    },
    { expect: "admin connection JSON path", send: "\n" },
  ]);
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
    ...selectPG,
    { expect: "Runtime connection JSON path", send: connection + "\n" },
    { expect: "admin connection JSON path", send: "\n" },
  ]);
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
    ...selectSQLite,
    { expect: "SQLite absolute path", send: next + "\n" },
  ];
  const no = tty(config, [
    ...steps,
    { expect: String.raw`\[y/N\]`, send: "no\n" },
  ]);
  assert.equal(no.error, null, no.output);
  assert.equal(readFileSync(config, "utf8"), before);
  assert.equal(existsSync(next), false);
  const yes = tty(config, [
    ...steps,
    { expect: String.raw`\[y/N\]`, send: "yes\n" },
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
 const r=tty(config,[...selectPG,{expect:'Runtime connection JSON path',send:connectionPath+'\n'},{expect:'admin connection JSON path',send:(process.env.EVALME_TEST_PG_ADMIN_CONFIG||'')+'\n'}]);
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
 {expect:'Runtime connection JSON path',send:'\n'},
 {expect:'PostgreSQL host:',send:c.host+'\n'},
 {expect:'Port',send:String(c.port)+'\n'},
 {expect:'Database',send:c.database+'\n'},
 {expect:'Runtime user',send:c.user+'\n'},
 {expect:'Password \\(hidden\\)',send:password+'\n'},
 {expect:'TLS:',send:'none\n'},
 {expect:'admin connection JSON path',send:'\n'}];
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
 const r=tty(config,[...selectPG,{expect:'Runtime connection JSON path',send:'\n'},
 {expect:'PostgreSQL host:',send:'127.0.0.1\n'},{expect:'Port',send:'1\n'},
 {expect:'Database',send:'\n'},{expect:'Runtime user',send:'\n'},
 {expect:'Password \\(hidden\\)',send:password+'\n'},{expect:'TLS:',send:'invalid\n'}]);
 assert.ok(!r.output.includes(password));assert.equal(r.error,null);assert.notEqual(r.status,0);assert.equal(existsSync(config),false);
});
