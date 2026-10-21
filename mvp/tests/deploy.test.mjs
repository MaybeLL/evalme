import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlan,
  assertOwned,
  redact,
  roleSQL,
} from "../scripts/deploy/postgres-mac.mjs";
test("plan restricts Docker to loopback and owned resources", () => {
  const p = buildPlan({
    secret_file: "/tmp/root",
    admin_secret_file: "/tmp/admin",
    app_secret_file: "/tmp/app",
  });
  assert.equal(p.host, "127.0.0.1");
  assert.equal(p.port, 15432);
  assert.equal(p.container, "evalme-mvp-postgres");
  assert.throws(() => buildPlan({ host: "0.0.0.0" }), /loopback/);
});
test("unknown or mismatched resources cannot be adopted", () => {
  assert.throws(() => assertOwned({ Labels: {} }, "abc"), /ownership/);
  assert.throws(
    () =>
      assertOwned(
        { Labels: { "evalme.owner": "mvp", "evalme.config": "other" } },
        "abc",
      ),
    /configuration/,
  );
  assertOwned(
    { Labels: { "evalme.owner": "mvp", "evalme.config": "abc" } },
    "abc",
  );
});
test("secrets are SQL escaped and application role receives no DDL", () => {
  const s = roleSQL("root", "a'b", "app-secret");
  assert.match(s, /a''b/);
  assert.match(s, /GRANT SELECT, INSERT/);
  assert.match(s, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/);
  assert.doesNotMatch(s, /GRANT ALL.*evalme_app/);
  assert.equal(
    redact("password=secret-value", ["secret-value"]),
    "password=[REDACTED]",
  );
});
test("secret values are never part of public deployment plan", () => {
  assert.throws(() => buildPlan({ password: "hidden" }), /Unknown/);
});
test("runtime drift cannot hide behind copied ownership labels", async () => {
  const { assertRuntime } = await import("../scripts/deploy/postgres-mac.mjs");
  const p = buildPlan({ secret_file: "/tmp/root" });
  const c = {
    Config: { Image: p.image },
    HostConfig: {
      PortBindings: {
        "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "15432" }],
      },
      Privileged: false,
      NetworkMode: "bridge",
      RestartPolicy: { Name: "unless-stopped" },
    },
    Mounts: [
      { Type: "volume", Name: p.volume, Destination: "/var/lib/postgresql" },
      {
        Type: "bind",
        Source: p.secret_file,
        Destination: "/run/secrets/postgres",
        RW: false,
      },
    ],
  };
  assertRuntime(c, p);
  c.HostConfig.PortBindings["5432/tcp"][0].HostIp = "0.0.0.0";
  assert.throws(() => assertRuntime(c, p), /drift/);
  c.HostConfig.PortBindings["5432/tcp"][0].HostIp = "127.0.0.1";
  c.Mounts[0].Name = "other-data";
  assert.throws(() => assertRuntime(c, p), /drift/);
});
test("privilege audit detects inherited or mutated write grants", async () => {
  const { privilegeAuditSQL } = await import(
    "../scripts/deploy/postgres-mac.mjs"
  );
  assert.match(privilegeAuditSQL, /pg_auth_members/);
  assert.match(privilegeAuditSQL, /UPDATE,DELETE,TRUNCATE/);
  assert.match(privilegeAuditSQL, /nspowner/);
});
test('manifest comparison detects content changes even when row counts match',async()=>{
 const {compareSnapshots}=await import('../scripts/deploy/postgres-mac.mjs');
 const a=Object.fromEntries(['topics','tasks','task_topics','trials','grades','schema_meta'].map(k=>[k,{count:1,sha256:'a'.repeat(64)}]));
 assert.equal(compareSnapshots(a,structuredClone(a)),true);
 const changed=structuredClone(a);changed.trials.sha256='b'.repeat(64);
 assert.throws(()=>compareSnapshots(a,changed),/trials/);
 const count=structuredClone(a);count.tasks.count=2;assert.throws(()=>compareSnapshots(a,count),/tasks/);
 const missing=structuredClone(a);delete missing.grades;assert.throws(()=>compareSnapshots(a,missing),/tables/);
});
