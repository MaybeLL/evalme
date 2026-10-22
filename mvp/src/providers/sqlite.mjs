import { DatabaseSync } from "node:sqlite";
import { mkdir, chmod, access, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { EvalmeError } from "../core-validation.mjs";
export async function connect(config, { initialize = false } = {}) {
  if (typeof config.path !== "string" || !isAbsolute(config.path))
    throw new EvalmeError("CONFIG_ERROR", "SQLite requires an absolute path");
  if (!initialize) {
    try {
      await access(config.path);
    } catch {
      throw new EvalmeError(
        "SCHEMA_SETUP_REQUIRED",
        "SQLite database does not exist; run init",
      );
    }
  }
  if (initialize)
    await mkdir(dirname(config.path), { recursive: true, mode: 0o700 });
  if (initialize) {
    try {
      const file = await open(config.path, "wx", 0o600);
      await file.close();
    } catch (error) {
      if (error.code !== "EEXIST")
        throw new EvalmeError(
          "DB_CONNECTION_FAILED",
          "Cannot create SQLite database",
        );
    }
  }
  let db;
  try {
    db = new DatabaseSync(config.path, {
      open: true,
      enableForeignKeyConstraints: true,
    });
    db.exec("PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON;");
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    let owned = false;
    try {
      const marker = db.prepare("SELECT version FROM schema_meta").all();
      owned = marker.length === 1 && [1,2].includes(marker[0].version);
    } catch {}
    if (owned || (initialize && tables.length === 0)) {
      await chmod(config.path, 0o600);
      db.exec("PRAGMA journal_mode=WAL;");
    }
  } catch {
    db?.close();
    throw new EvalmeError(
      "DB_CONNECTION_FAILED",
      "Cannot open SQLite database",
    );
  }
  return {
    dialect: "sqlite",
    async query(sql, params = []) {
      const statement = db.prepare(sql);
      return statement.all(...params);
    },
    async exec(sql) {
      db.exec(sql);
    },
    async close() {
      db.close();
    },
  };
}
