#!/usr/bin/env node
import {interactive, confirmReplacement, requestInitialization} from "./init-prompts.mjs";
import { VERSION, compatibleNode, runtimeHint } from "./runtime.mjs";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AppError,
  invalid,
  configPath,
  readConfig,
  initialize,
} from "./config.mjs";
const GLOBAL = [
  "json",
  "config",
  "non-interactive",
  "expect-api-version",
  "help",
  "version",
];
const BOOL = new Set([
  "json",
  "non-interactive",
  "help",
  "version",
  "prompt-only",
  "all-versions",
  "family",
  "replace-config",
  "force",
  "yes",
  "purge-config",
]);
const COMMANDS = {
  init: [
    "provider",
    "path",
    "connection-file",
    "admin-connection-file",
    "replace-config",
  ],
  "id new": [],
  doctor: [],
  upgrade: ["source"],
  uninstall: ["yes", "purge-config"],
  "skill install": ["agent", "scope", "force", "cli-path"],
  "skill uninstall": ["agent", "scope", "force"],
  "topic create": ["input"],
  "topic list": ["query", "limit", "cursor"],
  "topic get": [],
  "task create": ["input"],
  "task revise": ["input"],
  "task get": ["prompt-only"],
  "task list": ["topic", "query", "all-versions", "limit", "cursor"],
  "trial record": ["input"],
  "trial get": [],
  "trial list": ["task", "family", "limit", "cursor"],
  "grade submit": ["input"],
  "grade get": [],
  "grade list": ["trial", "limit", "cursor"],
};
function parse(argv) {
  const flags = {},
    pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (Object.hasOwn(flags, k)) throw invalid("Duplicate option.");
      if (BOOL.has(k)) flags[k] = true;
      else {
        if (!argv[i + 1] || argv[i + 1].startsWith("--"))
          throw invalid("Missing option value.");
        flags[k] = argv[++i];
      }
    } else pos.push(a);
  }
  const key = ["init","doctor","upgrade","uninstall"].includes(pos[0]) ? pos[0] : pos.slice(0, 2).join(" ");
  const allowed = new Set([...GLOBAL, ...(COMMANDS[key] || [])]);
  if (Object.keys(flags).some((k) => !allowed.has(k)))
    throw invalid("Unknown option.");
  return { flags, pos, key };
}
async function input(flags) {
  if (!flags.input) throw invalid("--input is required.");
  let text;
  if (flags.input === "-") {
    const chunks = [];
    let bytes = 0;
    for await (const b of process.stdin) {
      bytes += b.length;
      if (bytes > 1048576) throw invalid("Input exceeds 1 MiB.");
      chunks.push(b);
    }
    text = Buffer.concat(chunks).toString("utf8");
  } else {
    try {
      const { statSync } = await import("node:fs");
      if (statSync(flags.input).size > 1048576)
        throw invalid("Input exceeds 1 MiB.");
      text = readFileSync(flags.input, "utf8");
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw invalid("Input file could not be read.");
    }
  }
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw Error();
    return v;
  } catch {
    throw invalid("Expected a JSON object.");
  }
}
export async function main(argv = process.argv.slice(2)) {
  let flags = {},
    store;
  try {
    const parsed = parse(argv);
    ({ flags } = parsed);
    const { pos, key } = parsed;
    if (flags.version) return emit({ version: VERSION, api_version: 1 }, flags);
    if (flags.help || argv.length === 0)
      return emit(
        {
          usage:
            "evalme-mvp <init|doctor|upgrade|uninstall|id new|skill install/uninstall|topic create/list/get|task create/revise/list/get|trial record/list/get|grade submit/list/get> [--json]",
          commands: COMMANDS,
          protocol: 1,
        },
        flags,
      );
    if (!Object.hasOwn(COMMANDS, key)) throw invalid("Unknown command.");
    const count = ["init","doctor","upgrade","uninstall"].includes(key) ? 1 : key.endsWith(" get") ? 3 : 2;
    if (pos.length !== count)
      throw invalid("Wrong number of positional arguments.");
    if (
      flags["expect-api-version"] !== undefined &&
      flags["expect-api-version"] !== "1"
    )
      throw new AppError(
        "API_VERSION_UNSUPPORTED",
        "Only API version 1 is supported.",
      );
    if (!compatibleNode()) throw new AppError('RUNTIME_UNSUPPORTED', runtimeHint, 2);
    if (key === 'doctor') {
      const {doctor}=await import('./doctor.mjs');
      const result=await doctor(flags);if(!result.ready) process.exitCode=5;
      return emit(result,flags);
    }
    if (key === 'upgrade' || key === 'uninstall') {
      const {upgrade,uninstall}=await import('./lifecycle.mjs');
      return emit(await (key === 'upgrade' ? upgrade(flags) : uninstall(flags)),flags);
    }
    if (key === "id new") return emit({ id: randomUUID() }, flags);
    if (key === "init") {
      await interactive(flags);
      try {
        while(true) {
          try {return emit(await initialize(flags),flags);}
          catch(e) {
            if(flags.json || flags['non-interactive'] || !process.stdin.isTTY) throw e;
            if(e.code === 'CONFIG_CONFLICT' && !flags['replace-config']) {
              if(!(await confirmReplacement(e.details.next,e.details.previous))) throw new AppError('CONFIG_CONFLICT','原配置保持不变。',4);
              flags['replace-config']=true;
            } else if(e.code === 'SCHEMA_SETUP_REQUIRED' && !flags._admin && !flags['admin-connection-file']) {
              flags._admin=await requestInitialization(e.details.target);
            } else throw e;
          }
        }
      } finally {delete flags._password;delete flags._admin;}
    }
    if (key === "skill install" || key === "skill uninstall") {
      const { installSkill, uninstallSkill } = await import("./skill-install.mjs");
      return emit(
        await (key === "skill uninstall" ? uninstallSkill : installSkill)({
          agent: flags.agent,
          scope: flags.scope || "user",
          cliPath: flags["cli-path"] || process.env.EVALME_LAUNCHER || fileURLToPath(import.meta.url),
          force: flags.force || false,
        }),
        flags,
      );
    }
    const limit = flags.limit === undefined ? 20 : Number(flags.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw invalid("limit must be between 1 and 100.");
    const mutation = ["create", "revise", "record", "submit"].includes(pos[1]);
    const payload = mutation ? await input(flags) : undefined;
    const runtime = readConfig(configPath(flags));
    const { openStore } = await import("./core.mjs");
    store = await openStore(runtime);
    await store.checkSchema();
    const [entity, verb] = key.split(" ");
    const singular = entity[0].toUpperCase() + entity.slice(1);
    if (["create", "revise", "record", "submit"].includes(verb)) {
      const method = {
        create: `create${singular}`,
        revise: "reviseTask",
        record: "recordTrial",
        submit: "submitGrade",
      }[verb];
      const result = await store[method](payload);
      return emit(result.data, flags, { replayed: result.replayed });
    }
    if (verb === "get") {
      let result = await store[`get${singular}`](pos[2]);
      if (flags["prompt-only"]) {
        result = Object.fromEntries(
          [
            "id",
            "family_id",
            "version",
            "title",
            "prompt",
            "background",
            "topic_ids",
          ]
            .filter((k) => Object.hasOwn(result, k))
            .map((k) => [k, result[k]]),
        );
      }
      return emit(result, flags);
    }
    if (entity === "trial" && !flags.task)
      throw invalid("trial list requires --task.");
    if (entity === "grade" && !flags.trial)
      throw invalid("grade list requires --trial.");
    const filters = { limit };
    for (const k of ["topic", "query", "task", "trial", "cursor", "family"])
      if (flags[k] !== undefined) filters[k] = flags[k];
    if (flags["all-versions"]) filters.allVersions = true;
    const result = await store[`list${singular}s`](filters);
    if (entity === "task")
      result.data = result.data.map((row) =>
        Object.fromEntries(
          [
            "id",
            "family_id",
            "version",
            "title",
            "prompt",
            "topic_ids",
            "created_at",
            "superseded_by",
          ]
            .filter((k) => Object.hasOwn(row, k))
            .map((k) => [k, row[k]]),
        ),
      );
    return emit(result.data, flags, { next_cursor: result.next_cursor });
  } catch (e) {
    const code = e.code || "INTERNAL_ERROR";
    const known = {
      VALIDATION_ERROR: 2,
      INVALID_CURSOR: 2,
      NOT_FOUND: 3,
      CONFLICT: 4,
      TOPIC_EXISTS: 4,
      IDEMPOTENCY_CONFLICT: 4,
      DB_BUSY: 6,
      COMMIT_UNKNOWN: 6,
      SCHEMA_SETUP_REQUIRED: 5,
      SCHEMA_VERSION_UNSUPPORTED: 5,
    };
    const exit =
      e.exitCode ||
      known[code] ||
      (["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"].includes(code) ? 6 : 1);
    process.exitCode = exit;
    const safe =
      exit === 1
        ? "Unexpected internal error."
        : exit === 6
          ? (e instanceof AppError ? e.message : "Database operation could not be completed; retry with the original ID.")
          : e.message;
    const details = {};
    for (const k of ["field", "existing_id", "id", "expected", "actual", "cause"])
      if (e.details?.[k] !== undefined) details[k] = e.details[k];
    const result = {
      ok: false,
      error: { code, message: safe, details, retryable: Boolean(e.retryable) },
      meta: { api_version: 1 },
    };
    if (flags.json || argv.includes("--json"))
      process.stdout.write(JSON.stringify(result) + "\n");
    else process.stderr.write(`${code}: ${safe}\n`);
  } finally {
    if (store) await store.close().catch(() => {});
  }
}
function emit(data, flags, meta = {}) {
  const result = {
    ok: true,
    data,
    meta: { api_version: 1, replayed: false, next_cursor: null, ...meta },
  };
  process.stdout.write(
    (flags.json ? JSON.stringify(result) : JSON.stringify(data, null, 2)) +
      "\n",
  );
}
await main();
