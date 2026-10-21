import {
  EvalmeError,
  normalize,
  normalizeSearch,
  topicKey,
  hash,
  stable,
  uuid,
  fail,
} from "./core-validation.mjs";
import { schema, JSON_COLUMNS } from "./providers/schema.mjs";
export { EvalmeError } from "./core-validation.mjs";
export const schemaVersion = 1;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tables = {
  topic: "topics",
  task: "tasks",
  revision: "tasks",
  trial: "trials",
  grade: "grades",
};
export async function openStore(config, { initialize = false } = {}) {
  if (!["sqlite", "postgres"].includes(config?.provider))
    throw new EvalmeError("CONFIG_ERROR", "Unknown database provider");
  const driver = await import(`./providers/${config.provider}.mjs`);
  const db = await driver.connect(config, { initialize });
  const store = new Store(db);
  try {
    if (initialize) await store.initialize();
    return store;
  } catch (error) {
    await db.close();
    throw error;
  }
}
function mapError(error, committing = false) {
  if (error instanceof EvalmeError) return error;
  if (
    committing &&
    !["SQLITE_BUSY", "40001", "40P01", "55P03"].includes(error.code)
  )
    return new EvalmeError(
      "COMMIT_UNKNOWN",
      "Commit outcome unknown; retry the same ID and original request",
      {},
      true,
    );
  if (
    ["SQLITE_BUSY", "SQLITE_LOCKED", "40001", "40P01", "55P03"].includes(
      error.code,
    ) ||
    error.errcode === 5
  )
    return new EvalmeError(
      "DB_BUSY",
      "Database busy; retry the same request",
      {},
      true,
    );
  if (["23503"].includes(error.code) || error.errcode === 787)
    return new EvalmeError("NOT_FOUND", "Referenced record does not exist");
  if (["23505"].includes(error.code) || [1555, 2067].includes(error.errcode))
    return new EvalmeError(
      "CONFLICT",
      "Concurrent write conflicts with an existing record",
    );
  if (
    ["42P01", "3F000"].includes(error.code) ||
    /no such table/.test(error.message ?? "")
  )
    return new EvalmeError(
      "SCHEMA_SETUP_REQUIRED",
      "Initialize storage before use",
    );
  if (error.code === "42501")
    return new EvalmeError(
      "CONFIG_ERROR",
      "Database role lacks required permissions",
    );
  return new EvalmeError(
    "DB_CONNECTION_FAILED",
    "Database operation failed",
    {},
    true,
  );
}
class Store {
  constructor(db) {
    this.db = db;
    this.queue = Promise.resolve();
    this.closed = false;
  }
  async exclusive(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  async query(sql, params = []) {
    return this.db.query(sql, params);
  }
  async close() {
    return this.exclusive(async () => {
      if (!this.closed) {
        await this.db.close();
        this.closed = true;
      }
    });
  }
  async initialize() {
    return this.exclusive(() =>
      this.transaction(async () => {
        if (this.db.dialect === "postgres") {
          // PostgreSQL checks database CREATE even for CREATE SCHEMA IF NOT
          // EXISTS. A migration identity may own the existing schema without
          // permission to create unrelated schemas in the database.
          const namespace = await this.query(
            "SELECT 1 FROM pg_namespace WHERE nspname='evalme'",
          );
          if (!namespace.length)
            await this.db.exec("CREATE SCHEMA evalme");
        }
        let existing = [];
        if (this.db.dialect === "postgres") {
          const present = await this.query(
            "SELECT to_regclass('evalme.schema_meta') AS relation",
          );
          if (present[0]?.relation)
            existing = await this.query("SELECT version FROM schema_meta");
          else if (
            (
              await this.query(
                "SELECT table_name FROM information_schema.tables WHERE table_schema='evalme'",
              )
            ).length
          )
            throw new EvalmeError(
              "SCHEMA_INCOMPATIBLE",
              "Existing schema has no EvalMe ownership marker; refusing initialization",
            );
        } else {
          try {
            existing = await this.query("SELECT version FROM schema_meta");
          } catch (error) {
            if (!/no such table/.test(error.message)) throw error;
            if (
              (
                await this.query(
                  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
                )
              ).length
            )
              throw new EvalmeError(
                "SCHEMA_INCOMPATIBLE",
                "Existing database has no EvalMe ownership marker; refusing initialization",
              );
          }
        }
        if (
          existing.length &&
          existing.some((r) => Number(r.version) !== schemaVersion)
        )
          throw new EvalmeError(
            "SCHEMA_INCOMPATIBLE",
            "Unsupported schema version",
          );
        for (const sql of schema(this.db.dialect)) await this.db.exec(sql);
        if (this.db.dialect === "postgres") {
          const fk = await this.query(
            "SELECT 1 FROM pg_constraint WHERE conname='trials_based_on_grade_fk' AND conrelid='trials'::regclass",
          );
          if (!fk.length)
            await this.db.exec(
              "ALTER TABLE trials ADD CONSTRAINT trials_based_on_grade_fk FOREIGN KEY(based_on_grade_id) REFERENCES grades(id)",
            );
        }
        await this.query(
          "INSERT INTO schema_meta(version) VALUES (?) ON CONFLICT(version) DO NOTHING",
          [schemaVersion],
        );
        if (
          this.db.dialect === "sqlite" &&
          (await this.query("PRAGMA foreign_key_check")).length
        )
          throw new EvalmeError(
            "SCHEMA_INCOMPATIBLE",
            "Foreign key check failed",
          );
        return { schema_version: schemaVersion };
      }),
    );
  }
  async schemaState() {
    const rows = await this.query("SELECT version FROM schema_meta");
    if (rows.length !== 1 || Number(rows[0].version) !== schemaVersion)
      throw new EvalmeError(
        "SCHEMA_INCOMPATIBLE",
        "Unsupported schema version",
      );
    return { schema_version: schemaVersion };
  }
  async checkSchema() {
    return this.exclusive(async () => {
      try {
        return await this.schemaState();
      } catch (error) {
        throw mapError(error);
      }
    });
  }
  async transaction(fn) {
    const deadline = Date.now() + 5000;
    while (true) {
      let begun = false,
        committing = false;
      try {
        await this.db.exec(
          this.db.dialect === "sqlite" ? "BEGIN IMMEDIATE" : "BEGIN",
        );
        begun = true;
        if (this.db.dialect === "postgres") {
          await this.db.exec(
            `SET LOCAL lock_timeout='${Math.max(1, Math.min(4500, deadline - Date.now()))}ms'`,
          );
          await this.query("SELECT pg_advisory_xact_lock(109539641,1)");
        }
        const result = await fn();
        committing = true;
        await this.db.exec("COMMIT");
        return result;
      } catch (error) {
        if (begun) await this.db.exec("ROLLBACK").catch(() => {});
        const mapped = mapError(error, committing);
        if (mapped.code === "DB_BUSY" && Date.now() < deadline) {
          await delay(20);
          continue;
        }
        throw mapped;
      }
    }
  }
  decode(row) {
    if (!row) return null;
    const data = { ...row };
    for (const key of JSON_COLUMNS)
      if (typeof data[key] === "string") data[key] = JSON.parse(data[key]);
    for (const key of ["created_at", "occurred_at"])
      if (data[key] instanceof Date) data[key] = data[key].toISOString();
    return data;
  }
  async raw(table, id) {
    return this.decode(
      (await this.query(`SELECT * FROM ${table} WHERE id=?`, [id]))[0],
    );
  }
  async required(table, id) {
    const row = await this.raw(table, id);
    if (!row)
      throw new EvalmeError("NOT_FOUND", `${table} record not found`, { id });
    return row;
  }
  async decorate(table, row) {
    const data = { ...row };
    delete data.payload_hash;
    if (table === "tasks") {
      data.topic_ids = (
        await this.query(
          "SELECT topic_id FROM task_topics WHERE task_id=? ORDER BY topic_id",
          [row.id],
        )
      ).map((r) => r.topic_id);
      delete data.search_text;
    }
    if (table === "trials" || table === "grades") {
      const field =
        table === "trials" ? "supersedes_trial_id" : "supersedes_grade_id";
      data.superseded_by =
        (
          await this.query(`SELECT id FROM ${table} WHERE ${field}=?`, [row.id])
        )[0]?.id ?? null;
    }
    return data;
  }
  async get(table, id) {
    uuid(id);
    return this.exclusive(async () => {
      try {
        await this.schemaState();
        return await this.decorate(
          table,
          await this.required(table, id.toLowerCase()),
        );
      } catch (error) {
        throw mapError(error);
      }
    });
  }
  getTopic(id) {
    return this.get("topics", id);
  }
  getTask(id) {
    return this.get("tasks", id);
  }
  getTrial(id) {
    return this.get("trials", id);
  }
  getGrade(id) {
    return this.get("grades", id);
  }
  async insert(table, data) {
    const columns = Object.keys(data);
    const params = columns.map((k) =>
      JSON_COLUMNS.has(k) && data[k] !== null
        ? JSON.stringify(data[k])
        : data[k],
    );
    await this.query(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      params,
    );
  }
  async create(kind, input) {
    const n = normalize(kind, input);
    const table = tables[kind];
    const digest = hash(n);
    return this.exclusive(() =>
      this.transaction(async () => {
        await this.schemaState();
        const existing = await this.raw(table, n.id);
        if (existing) {
          if (existing.payload_hash !== digest)
            throw new EvalmeError(
              "IDEMPOTENCY_CONFLICT",
              "ID already used for a different request",
              { id: n.id },
            );
          return { data: await this.decorate(table, existing), replayed: true };
        }
        const clock = (
          await this.query(
            this.db.dialect === "postgres"
              ? "SELECT clock_timestamp() AS created_at"
              : "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS created_at",
          )
        )[0].created_at;
        let data = {
          ...n,
          schema_version: schemaVersion,
          payload_hash: digest,
          created_at: clock instanceof Date ? clock.toISOString() : clock,
        };
        if (kind === "topic") {
          data.name_key = topicKey(data.name);
          const same = (
            await this.query("SELECT id FROM topics WHERE name_key=?", [
              data.name_key,
            ])
          )[0];
          if (same)
            throw new EvalmeError("TOPIC_EXISTS", "Reuse the existing topic", {
              id: same.id,
              existing_id: same.id,
            });
        }
        if (kind === "task" || kind === "revision") {
          for (const id of n.topic_ids) await this.required("topics", id);
          if (kind === "revision") {
            const previous = await this.required("tasks", n.previous_task_id);
            await this.tip("tasks", "previous_task_id", previous.id);
            data.family_id = previous.family_id;
            data.version = previous.version + 1;
          } else {
            data.family_id = n.id;
            data.version = 1;
            data.previous_task_id = null;
          }
          data.search_text = JSON.stringify([
            normalizeSearch(n.title),
            normalizeSearch(n.prompt),
          ]);
          delete data.topic_ids;
        }
        if (kind === "trial") {
          await this.required("tasks", n.task_id);
          let based = null;
          if (n.based_on_grade_id)
            based = await this.required("grades", n.based_on_grade_id);
          if (n.supersedes_trial_id) {
            let previous = await this.required("trials", n.supersedes_trial_id);
            if (previous.task_id !== n.task_id)
              fail("Trial correction must retain task_id");
            await this.tip("trials", "supersedes_trial_id", previous.id);
            while (previous) {
              if (based?.trial_id === previous.id)
                fail(
                  "Correction cannot use its own chain evaluation as feedback",
                );
              previous = previous.supersedes_trial_id
                ? await this.required("trials", previous.supersedes_trial_id)
                : null;
            }
          }
        }
        if (kind === "grade") {
          const trial = await this.required("trials", n.trial_id);
          const task = await this.required("tasks", trial.task_id);
          if (
            n.basis.mode === "task_rubric" &&
            !task.rubric &&
            !task.reference_answer
          )
            fail("task_rubric requires a saved rubric or reference answer");
          data.basis = { ...n.basis, task_id: trial.task_id };
          data.findings = n.findings.map((f) => {
            let userEvidence = false;
            const evidence = f.evidence.map((e) => {
              const target =
                e.target === "answer"
                  ? {
                      text: trial.answer,
                      role: "user",
                      kind: trial.answer_kind,
                    }
                  : e.target.startsWith("process:")
                    ? trial.process.find((p) => p.id === e.target.slice(8))
                    : null;
              if (!target || !target.text.includes(e.quote))
                fail(
                  "Evidence reference or quote does not match saved content",
                );
              if (target.role === "user") userEvidence = true;
              return { ...e, kind: target.kind };
            });
            if (["correct", "incorrect"].includes(f.kind) && !userEvidence)
              fail(
                "Correct/incorrect findings require evidence from the learner",
              );
            return { ...f, evidence };
          });
          if (n.supersedes_grade_id) {
            const old = await this.required("grades", n.supersedes_grade_id);
            if (old.trial_id !== n.trial_id)
              fail("Grade correction must retain trial_id");
            await this.tip("grades", "supersedes_grade_id", old.id);
          }
        }
        await this.insert(table, data);
        if (kind === "task" || kind === "revision")
          for (const id of n.topic_ids)
            await this.query(
              "INSERT INTO task_topics(task_id,topic_id) VALUES (?,?)",
              [n.id, id],
            );
        return { data: await this.decorate(table, data), replayed: false };
      }),
    );
  }
  async tip(table, field, id) {
    if (
      (await this.query(`SELECT id FROM ${table} WHERE ${field}=?`, [id]))
        .length
    )
      throw new EvalmeError("CONFLICT", "Record already has a successor", {
        id,
      });
  }
  createTopic(input) {
    return this.create("topic", input);
  }
  createTask(input) {
    return this.create("task", input);
  }
  reviseTask(input) {
    return this.create("revision", input);
  }
  recordTrial(input) {
    return this.create("trial", input);
  }
  submitGrade(input) {
    return this.create("grade", input);
  }
  async list(table, filters = {}) {
    const limit = filters.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      fail("limit must be 1–100");
    filters = { ...filters };
    for (const key of ["topic", "task", "trial"])
      if (filters[key] !== undefined) filters[key] = uuid(filters[key], key);
    if (filters.query !== undefined && typeof filters.query !== "string")
      fail("query must be text");
    const normalized = { ...filters };
    delete normalized.cursor;
    normalized.limit = limit;
    const binding = hash({ v: 1, table, filters: normalized });
    let after = null;
    if (filters.cursor) {
      try {
        const decoded = JSON.parse(
          Buffer.from(filters.cursor, "base64url").toString("utf8"),
        );
        if (
          decoded.binding !== binding ||
          decoded.v !== 1 ||
          typeof decoded.created_at !== "string" ||
          typeof decoded.id !== "string" ||
          decoded.checksum !==
            hash({
              binding: decoded.binding,
              created_at: decoded.created_at,
              id: decoded.id,
              v: 1,
            })
        )
          throw Error();
        uuid(decoded.id);
        after = decoded;
      } catch {
        throw new EvalmeError(
          "INVALID_CURSOR",
          "Cursor is invalid or belongs to different filters",
        );
      }
    }
    return this.exclusive(async () => {
      try {
        await this.schemaState();
        const where = [],
          params = [];
        const contains = this.db.dialect === "postgres" ? "strpos" : "instr";
        if (table === "topics" && filters.query) {
          where.push(`${contains}(t.name_key,?)>0`);
          params.push(topicKey(filters.query));
        }
        if (table === "tasks") {
          if (!filters.allVersions)
            where.push(
              "NOT EXISTS (SELECT 1 FROM tasks successor WHERE successor.previous_task_id=t.id)",
            );
          if (filters.query) {
            const q = normalizeSearch(filters.query);
            const title =
              this.db.dialect === "postgres"
                ? "(t.search_text::jsonb ->> 0)"
                : "json_extract(t.search_text,'$[0]')";
            const prompt =
              this.db.dialect === "postgres"
                ? "(t.search_text::jsonb ->> 1)"
                : "json_extract(t.search_text,'$[1]')";
            where.push(
              `(${contains}(${title},?)>0 OR ${contains}(${prompt},?)>0)`,
            );
            params.push(q, q);
          }
          if (filters.topic) {
            where.push(
              "EXISTS (SELECT 1 FROM task_topics label WHERE label.task_id=t.id AND label.topic_id=?)",
            );
            params.push(filters.topic);
          }
        }
        if (table === "trials") {
          if (!filters.task) fail("trial list requires task");
          if (filters.family) {
            const task = await this.required("tasks", filters.task);
            where.push("t.task_id IN (SELECT id FROM tasks WHERE family_id=?)");
            params.push(task.family_id);
          } else {
            where.push("t.task_id=?");
            params.push(filters.task);
          }
        }
        if (table === "grades") {
          if (!filters.trial) fail("grade list requires trial");
          where.push("t.trial_id=?");
          params.push(filters.trial);
        }
        if (after) {
          where.push("(t.created_at>? OR (t.created_at=? AND t.id>?))");
          params.push(after.created_at, after.created_at, after.id);
        }
        params.push(limit + 1);
        const rows = (
          await this.query(
            `SELECT t.* FROM ${table} t ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY t.created_at,t.id LIMIT ?`,
            params,
          )
        ).map((r) => this.decode(r));
        const page = rows.slice(0, limit);
        let next_cursor = null;
        if (rows.length > limit) {
          const last = page.at(-1);
          const cursor = {
            v: 1,
            binding,
            created_at: last.created_at,
            id: last.id,
          };
          next_cursor = Buffer.from(
            JSON.stringify({ ...cursor, checksum: hash(cursor) }),
          ).toString("base64url");
        }
        const data = [];
        for (const row of page) {
          const item = await this.decorate(table, row);
          if (table === "tasks") {
            delete item.reference_answer;
            delete item.rubric;
          }
          data.push(item);
        }
        return { data, next_cursor };
      } catch (error) {
        throw mapError(error);
      }
    });
  }
  listTopics(filters) {
    return this.list("topics", filters);
  }
  listTasks(filters) {
    return this.list("tasks", filters);
  }
  listTrials(filters) {
    return this.list("trials", filters);
  }
  listGrades(filters) {
    return this.list("grades", filters);
  }
}
