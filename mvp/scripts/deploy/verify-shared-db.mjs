#!/usr/bin/env node
// Read-back evidence only: actual task/trial/grade creation must occur in each
// machine's CLI+Skill interaction; this tool never invents learner responses.
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
const opts = {};
for (let i = 2; i < process.argv.length; i += 2)
  opts[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
try {
  for (const k of ["cli", "config", "run-id", "task-id"])
    if (!opts[k]) throw Error(`--${k} required`);
  const records = {};
  for (const type of ["task", "trial", "grade"])
    if (opts[`${type}-id`]) {
      const r = spawnSync(
        opts.cli,
        [
          type,
          "get",
          opts[`${type}-id`],
          "--config",
          opts.config,
          "--json",
          "--non-interactive",
        ],
        { encoding: "utf8" },
      );
      if (r.status !== 0)
        throw Error(
          `${type} lookup failed (exit ${r.status}); inspect locally without publishing secrets`,
        );
      const j = JSON.parse(r.stdout);
      if (!j.ok) throw Error(`${type} lookup unsuccessful`);
      records[type] = {
        id: opts[`${type}-id`],
        sha256: crypto
          .createHash("sha256")
          .update(JSON.stringify(j.data))
          .digest("hex"),
      };
    }
  const version = spawnSync(opts.cli, ["--version"], { encoding: "utf8" });
  console.log(
    JSON.stringify(
      {
        run_id: opts["run-id"],
        machine_hash: crypto
          .createHash("sha256")
          .update(os.hostname())
          .digest("hex")
          .slice(0, 16),
        platform: `${os.platform()}/${os.arch()}`,
        cli_version: version.stdout?.trim(),
        records,
        scope:
          "Read-back evidence only; does not itself prove separate physical machines or Skill execution",
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
