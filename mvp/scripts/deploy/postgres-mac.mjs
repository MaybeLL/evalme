#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
export function buildPlan(c = {}) {
  for (const k of Object.keys(c))
    if (
      ![
        "image",
        "container",
        "volume",
        "host",
        "port",
        "secret_file",
        "admin_secret_file",
        "app_secret_file",
      ].includes(k)
    )
      throw Error("Unknown configuration key");
  const p = {
    image: "postgres:18",
    container: "evalme-mvp-postgres",
    volume: "evalme-mvp-postgres-data",
    host: "127.0.0.1",
    port: 15432,
    ...c,
  };
  if (p.host !== "127.0.0.1") throw Error("Only loopback binding allowed");
  if (!Number.isInteger(p.port) || p.port < 1024 || p.port > 65535)
    throw Error("Invalid port");
  for (const k of ["container", "volume"])
    if (!/^evalme-mvp-[a-z0-9-]+$/.test(p[k]))
      throw Error("Invalid owned resource name");
  if (!/^postgres:18(?:\.\d+)?$/.test(p.image))
    throw Error("Only PostgreSQL 18 image permitted");
  return p;
}
export function assertOwned(r, hash) {
  const l = r.Labels ?? r.Config?.Labels ?? {};
  if (l["evalme.owner"] !== "mvp") throw Error("Resource ownership conflict");
  if (l["evalme.config"] !== hash)
    throw Error("Resource configuration conflict");
}
export function assertRuntime(c, p) {
  const h = c.HostConfig ?? {},
    b = h.PortBindings ?? {},
    m = c.Mounts ?? [];
  if (
    c.Config?.Image !== p.image ||
    h.Privileged ||
    !["default", "bridge"].includes(h.NetworkMode) ||
    h.RestartPolicy?.Name !== "unless-stopped"
  )
    throw Error("Container runtime drift");
  if (
    Object.keys(b).length !== 1 ||
    b["5432/tcp"]?.length !== 1 ||
    b["5432/tcp"][0].HostIp !== "127.0.0.1" ||
    b["5432/tcp"][0].HostPort !== String(p.port)
  )
    throw Error("Container port mapping drift");
  if (
    m.length !== 2 ||
    !m.some(
      (x) =>
        x.Type === "volume" &&
        x.Name === p.volume &&
        x.Destination === "/var/lib/postgresql",
    ) ||
    !m.some(
      (x) =>
        x.Type === "bind" &&
        x.Source === p.secret_file &&
        x.Destination === "/run/secrets/postgres" &&
        x.RW === false,
    )
  )
    throw Error("Container data/secret mount drift");
}
export function redact(s, secrets) {
  for (const v of secrets) if (v) s = s.split(v).join("[REDACTED]");
  return s;
}
const literal = (s) => "'" + s.replaceAll("'", "''") + "'";
export function roleSQL(root, admin, app) {
  return `BEGIN;
SET password_encryption='scram-sha-256';
DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='evalme_admin') THEN CREATE ROLE evalme_admin LOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='evalme_app') THEN CREATE ROLE evalme_app LOGIN; END IF; END $$;
ALTER ROLE evalme_admin NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${literal(admin)};
ALTER ROLE evalme_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${literal(app)};
REVOKE ALL ON DATABASE evalme FROM PUBLIC;
GRANT CONNECT ON DATABASE evalme TO evalme_admin,evalme_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS evalme AUTHORIZATION evalme_admin;
REVOKE ALL ON SCHEMA evalme FROM PUBLIC;
GRANT USAGE ON SCHEMA evalme TO evalme_app;
ALTER ROLE evalme_admin IN DATABASE evalme SET search_path=evalme;
ALTER ROLE evalme_app IN DATABASE evalme SET search_path=evalme;
ALTER DEFAULT PRIVILEGES FOR ROLE evalme_admin IN SCHEMA evalme GRANT SELECT, INSERT ON TABLES TO evalme_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA evalme TO evalme_app;
COMMIT;
`;
}
export const privilegeAuditSQL = `SELECT
 (SELECT count(*)=2 FROM pg_roles WHERE rolname IN ('evalme_admin','evalme_app') AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
 AND NOT EXISTS(SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname IN ('evalme_admin','evalme_app'))
 AND EXISTS(SELECT FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname='evalme' AND r.rolname='evalme_admin')
 AND NOT has_schema_privilege('evalme_app','evalme','CREATE')
 AND NOT has_schema_privilege('evalme_app','public','CREATE')
 AND NOT EXISTS(SELECT FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname='evalme' AND r.rolname IN ('evalme_admin','evalme_app'))
 AND NOT EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='evalme' AND c.relkind IN ('r','p') AND has_table_privilege('evalme_app',c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));`;
function auditPrivileges(p) {
  const r = run([
    "exec",
    p.container,
    "psql",
    "-U",
    "postgres",
    "-d",
    "evalme",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    privilegeAuditSQL,
  ]);
  if (r.stdout.trim() !== "t")
    throw Error(
      "Role/schema permission drift; inspect with administrator, no automatic privilege broadening",
    );
}
const snapshotKeys = {topics:'id',tasks:'id',task_topics:'task_id,topic_id',trials:'id',grades:'id',schema_meta:'version'};
export function compareSnapshots(a,b) {
 const keys=Object.keys(snapshotKeys).sort();
 for(const obj of [a,b]) {
  if(!obj||JSON.stringify(Object.keys(obj).sort())!==JSON.stringify(keys))throw Error('Snapshot tables mismatch');
  for(const k of keys)if(!Number.isSafeInteger(obj[k]?.count)||obj[k].count<0||! /^[a-f0-9]{64}$/.test(obj[k]?.sha256??''))throw Error('Invalid snapshot metadata');
 }
 for(const k of keys)if(a[k].count!==b[k].count||a[k].sha256!==b[k].sha256)throw Error(`Snapshot mismatch: ${k}`);
 return true;
}
function snapshot(p,db='evalme') {
 const selects=Object.entries(snapshotKeys).map(([table,key])=>`SELECT json_build_object('table','${table}','count',count(*),'sha256',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY ${key}),''),'UTF8')),'hex')) FROM evalme.${table} t;`).join('\n');
 const sql=`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL TIME ZONE 'UTC'; ${selects} COMMIT;`;
 const r=run(['exec','-i',p.container,'psql','-qAt','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],sql);
 const result={};for(const line of r.stdout.trim().split('\n')){const x=JSON.parse(line);result[x.table]={count:x.count,sha256:x.sha256};}
 compareSnapshots(result,result);return result;
}
function fileHash(file) {
 const h=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),buf=Buffer.alloc(65536);
 try {for(;;){const n=fs.readSync(fd,buf,0,buf.length,null);if(!n)break;h.update(buf.subarray(0,n));}}finally{fs.closeSync(fd);}return h.digest('hex');
}

let secrets = [];
function run(args, input, allow = false) {
  const r = spawnSync("docker", args, {
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allow)
    throw Error(redact(r.stderr || "Docker failed", secrets));
  return r;
}
function inspect(type, name) {
  const r = run([type, "inspect", name], undefined, true);
  if (r.status !== 0) {
    if (!/No such|not found/i.test(r.stderr)) throw Error(r.stderr);
    return null;
  }
  return JSON.parse(r.stdout)[0];
}
function secret(file) {
  if (!path.isAbsolute(file ?? "")) throw Error("Secret file must be absolute");
  const st = fs.lstatSync(file);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    (st.mode & 0o777) !== 0o600 ||
    st.uid !== process.getuid()
  )
    throw Error("Secret must be owned regular 0600 file");
  const s = fs.readFileSync(file, "utf8").trimEnd();
  if (s.length < 16 || /[\r\n\0]/.test(s))
    throw Error("Secret must be single line, at least 16 characters");
  secrets.push(s);
  return s;
}
export async function main(argv) {
  const [command, ...args] = argv;
  const opt = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith("--") || args[i + 1] === undefined)
      throw Error("Expected --option value");
    opt[args[i].slice(2)] = args[i + 1];
  }
  if (command === "inspect") {
    for (const [cmd, a] of [
      ["sw_vers", []],
      ["uname", ["-m"]],
      ["docker", ["info", "--format", "{{.Architecture}} {{.OSType}}"]],
      ["tailscale", ["status", "--json"]],
    ]) {
      const r = spawnSync(cmd, a, { encoding: "utf8" });
      if (cmd === "tailscale") {
        try {
          const j = JSON.parse(r.stdout);
          console.log(
            JSON.stringify({
              command: cmd,
              status: j.BackendState,
              self: j.Self?.TailscaleIPs,
            }),
          );
        } catch {
          console.log(JSON.stringify({ command: cmd, available: false }));
        }
      } else
        console.log(
          JSON.stringify({
            command: cmd,
            status: r.status,
            output: r.stdout?.trim(),
          }),
        );
    }
    return;
  }
  if (!opt.config) throw Error("--config required");
  const p = buildPlan(JSON.parse(fs.readFileSync(opt.config, "utf8")));
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(p))
    .digest("hex");
  if (command === "plan") {
    console.log(
      JSON.stringify(
        {
          plan: p,
          config_hash: hash,
          network: "loopback only; Tailscale requires separate explicit setup",
          mutates: false,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!["apply", "status", "stop", "backup", "restore-test"].includes(command))
    throw Error("Unknown command");
  const c = inspect("container", p.container),
    v = inspect("volume", p.volume);
  if (c) assertOwned(c, hash);
  if (v) assertOwned(v, hash);
  if (c && command !== "stop") assertRuntime(c, p);
  if (command === "status") {
    if (!c || !v) throw Error("Not deployed");
    const r = run([
      "exec",
      p.container,
      "pg_isready",
      "-h",
      "127.0.0.1",
      "-U",
      "evalme_app",
      "-d",
      "evalme",
    ]);
    auditPrivileges(p);
    console.log(
      JSON.stringify({
        permissions_checked: true,
        running: c.State.Running,
        ready: r.status === 0,
        ports: c.NetworkSettings.Ports,
      }),
    );
    return;
  }
  if (command === "stop") {
    if (c) run(["stop", p.container]);
    console.log(JSON.stringify({ stopped: !!c, data_preserved: true }));
    return;
  }
  if (command === "apply") {
    const root = secret(p.secret_file),
      admin = secret(p.admin_secret_file),
      app = secret(p.app_secret_file);
    const credentialHash = crypto
      .createHash("sha256")
      .update(JSON.stringify([root, admin, app]))
      .digest("hex");
    if (v && v.Labels?.["evalme.credentials"] !== credentialHash)
      throw Error(
        "Credential change refused; explicit rotation procedure required",
      );
    if (!v)
      run([
        "volume",
        "create",
        "--label",
        "evalme.owner=mvp",
        "--label",
        `evalme.config=${hash}`,
        "--label",
        `evalme.credentials=${credentialHash}`,
        p.volume,
      ]);
    if (!c)
      run([
        "run",
        "-d",
        "--name",
        p.container,
        "--label",
        "evalme.owner=mvp",
        "--label",
        `evalme.config=${hash}`,
        "--restart",
        "unless-stopped",
        "--publish",
        `127.0.0.1:${p.port}:5432`,
        "--mount",
        `type=volume,src=${p.volume},dst=/var/lib/postgresql`,
        "--mount",
        `type=bind,src=${p.secret_file},dst=/run/secrets/postgres,readonly`,
        "--env",
        "POSTGRES_PASSWORD_FILE=/run/secrets/postgres",
        "--env",
        "POSTGRES_DB=evalme",
        "--env",
        "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256",
        p.image,
      ]);
    else if (!c.State.Running) run(["start", p.container]);
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (
        run(
          [
            "exec",
            p.container,
            "pg_isready",
            "-h",
            "127.0.0.1",
            "-U",
            "evalme_app",
            "-d",
            "evalme",
          ],
          undefined,
          true,
        ).status === 0
      ) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!ready)
      throw Error("PostgreSQL not ready; owned resources retained for retry");
    assertRuntime(inspect("container", p.container), p);
    // Password SQL is sent via stdin, never process arguments or environment.
    const setup = run(
      [
        "exec",
        "-i",
        p.container,
        "psql",
        "-U",
        "postgres",
        "-d",
        "evalme",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      roleSQL(root, admin, app),
      true,
    );
    if (setup.status !== 0)
      throw Error(
        "Role setup failed; SQL diagnostic suppressed to protect credentials; owned resources retained",
      );
    run(
      ["exec", "-i", p.container, "sh", "-c", 'cat > "$PGDATA/pg_hba.conf"'],
      "local all postgres trust\nlocal all all reject\nhost evalme evalme_admin,evalme_app 0.0.0.0/0 scram-sha-256\nhost evalme evalme_admin,evalme_app ::/0 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::/0 reject\n",
    );
    run([
      "exec",
      p.container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "evalme",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "SELECT pg_reload_conf()",
    ]);
    auditPrivileges(p);
    console.log(
      JSON.stringify({
        permissions_checked: true,
        applied: true,
        container: p.container,
        endpoint: `127.0.0.1:${p.port}`,
        schema: "evalme",
      }),
    );
    return;
  }
  if (!c || !v) throw Error("Not deployed");
  if (command === 'backup') {
    if(!path.isAbsolute(opt.output??''))throw Error('--output absolute path required');
    const manifestPath=opt.output+'.manifest.json';const fd=fs.openSync(opt.output,'wx',0o600);let manifestFd,success=false;
    try {
      manifestFd=fs.openSync(manifestPath,'wx',0o600);
      const before=snapshot(p);
      const r=spawnSync('docker',['exec',p.container,'pg_dump','-U','postgres','-d','evalme','--no-owner','--no-acl'],{stdio:['ignore',fd,'pipe'],encoding:'utf8'});
      if(r.status!==0)throw Error('Backup failed; diagnostic suppressed to protect private data');
      const after=snapshot(p);try{compareSnapshots(before,after);}catch{throw Error('BACKUP_CONCURRENT_CHANGE: database changed during backup; retry when writers are idle');}
      const manifest={version:1,created_at:new Date().toISOString(),backup_sha256:fileHash(opt.output),tables:before};
      fs.writeFileSync(manifestFd,JSON.stringify(manifest,null,2)+'\n');success=true;
      console.log(JSON.stringify({backup:opt.output,manifest:manifestPath,snapshot_consistent:true,tables:before}));
    } finally {
      fs.closeSync(fd);if(manifestFd!==undefined)fs.closeSync(manifestFd);
      if(!success){fs.unlinkSync(opt.output);if(manifestFd!==undefined)fs.unlinkSync(manifestPath);}
    }
    return;
  }
  if(command==='restore-test') {
    if(!path.isAbsolute(opt.input??''))throw Error('--input absolute path required');
    const manifest=JSON.parse(fs.readFileSync(opt.input+'.manifest.json','utf8'));
    if(manifest.version!==1||manifest.backup_sha256!==fileHash(opt.input))throw Error('Backup checksum/manifest mismatch');
    compareSnapshots(manifest.tables,manifest.tables);
    const db='evalme_restore_'+crypto.randomBytes(8).toString('hex');run(['exec',p.container,'createdb','-U','postgres',db]);
    try {
      const restored=run(['exec','-i',p.container,'psql','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],fs.readFileSync(opt.input),true);
      if(restored.status!==0)throw Error('Restore failed; SQL diagnostic suppressed to protect private data');
      const actual=snapshot(p,db);compareSnapshots(manifest.tables,actual);
      console.log(JSON.stringify({restored:true,matched:true,temporary_database:db,tables:actual}));
    } finally {run(['exec',p.container,'dropdb','-U','postgres',db]);}
  }

}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch((e) => {
    console.error(
      JSON.stringify({ ok: false, error: redact(e.message, secrets) }),
    );
    process.exitCode = 1;
  });
