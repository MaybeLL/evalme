import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  lstatSync,
  chmodSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
export class AppError extends Error {
  constructor(code, message, exitCode = 5, details = {}) {
    super(message);
    Object.assign(this, { code, exitCode, details, retryable: false });
  }
}
export const invalid = (message) =>
  new AppError("VALIDATION_ERROR", message, 2);
export function configPath(flags = {}) {
  return (
    flags.config ||
    process.env.EVALME_CONFIG ||
    join(homedir(), ".config/evalme-mvp/config.json")
  );
}
function absolute(p) {
  if (typeof p !== "string" || !isAbsolute(p))
    throw invalid("An absolute path is required.");
  return p;
}
export function privateJson(path) {
  absolute(path);
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.mode & 0o077)
      throw new AppError(
        "CONFIG_PERMISSIONS",
        "Configuration must be a private regular file (0600).",
      );
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new AppError("CONFIG_INVALID", "Expected a configuration object.");
    return value;
  } catch (e) {
    if (e.code === "ENOENT")
      throw new AppError(
        "CONFIG_NOT_FOUND",
        "Configuration file was not found.",
      );
    if (e instanceof AppError) throw e;
    throw new AppError("CONFIG_INVALID", "Configuration could not be read.");
  }
}
export function connection(path) {
  return parseConnection(privateJson(path));
}
function parseConnection(c, suppliedPassword) {
  const allowed = [
    "host",
    "port",
    "database",
    "user",
    "secret_file",
    "ssl",
    "ca_file",
    "provider",
  ];
  if (Object.keys(c).some((k) => !allowed.includes(k)))
    throw invalid("Unknown connection field.");
  for (const key of ["host", "database", "user", ...(suppliedPassword === undefined ? ["secret_file"] : [])])
    if (typeof c[key] !== "string" || !c[key].trim())
      throw invalid(`Connection requires ${key}.`);
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535)
    throw invalid("Invalid port.");
  let password = suppliedPassword;
  if (suppliedPassword === undefined) {
  absolute(c.secret_file);
  try {
    const st = lstatSync(c.secret_file);
    if (!st.isFile() || st.isSymbolicLink() || st.mode & 0o077)
      throw new Error();
    password = readFileSync(c.secret_file, "utf8").replace(/\r?\n$/, "");
    if (!password) throw new Error();
  } catch {
    throw new AppError(
      "CREDENTIALS_UNAVAILABLE",
      "Credential file must be a readable private regular file.",
    );
  }
  }
  if (c.ssl !== false && c.ssl !== "verify-full")
    throw invalid("ssl must be false or verify-full; choose explicitly.");
  let ssl = false;
  if (c.ssl === "verify-full") {
    ssl = { rejectUnauthorized: true };
    if (c.ca_file) ssl.ca = readFileSync(absolute(c.ca_file), "utf8");
  }
  return {
    saved: { ...c, provider: "postgres" },
    runtime: {
      provider: "postgres",
      host: c.host,
      port: c.port,
      database: c.database,
      user: c.user,
      password,
      ssl,
    },
  };
}
export function readConfig(path) {
  const c = privateJson(path);
  if (c.provider === "sqlite") {
    if (Object.keys(c).some((k) => !["provider", "path"].includes(k)))
      throw invalid("Unknown SQLite configuration field.");
    absolute(c.path);
    if (!existsSync(c.path))
      throw new AppError(
        "DB_NOT_FOUND",
        "SQLite database does not exist; initialize it first.",
      );
    const st = lstatSync(c.path);
    if (!st.isFile() || st.isSymbolicLink() || st.mode & 0o077)
      throw new AppError(
        "CONFIG_PERMISSIONS",
        "SQLite database must be a private regular file.",
      );
    return c;
  }
  if (c.provider === "postgres") return connection(path).runtime;
  throw new AppError("CONFIG_INVALID", "Unknown database provider.");
}
function save(path, value) {
  absolute(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}
export async function assertRuntimePrivileges(c, {requireTables = false} = {}) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ ...c, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  client.on('error',()=>{});
  try {
    await client.connect();
    const { rows } = await client.query(
      `SELECT EXISTS(SELECT 1 FROM pg_auth_members am WHERE am.member=r.oid) OR r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls OR d.datdba=r.oid OR has_database_privilege(current_user,current_database(),'CREATE') OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='evalme' AND (n.nspowner=r.oid OR has_schema_privilege(current_user,n.oid,'CREATE'))) OR EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='evalme' AND t.relkind='r' AND (t.relowner=r.oid OR has_table_privilege(current_user,t.oid,'UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege(current_user,t.oid,'UPDATE'))) AS elevated FROM pg_roles r CROSS JOIN pg_database d WHERE r.rolname=current_user AND d.datname=current_database()`,
    );
    if (rows[0]?.elevated)
      throw new AppError(
        "UNSAFE_RUNTIME_ROLE",
        "Use a dedicated SELECT/INSERT runtime role without administrative memberships.",
      );
    if (requireTables) {
      const usage=await client.query("SELECT has_schema_privilege(current_user,'evalme','USAGE') AS ok");
      if(!usage.rows[0]?.ok) throw new AppError('DB_PERMISSION_DENIED','应用账号缺少 evalme schema USAGE 权限。');
      for (const table of ['tasks','trials','grades','topics','task_topics','schema_meta']) {
        const {rows} = await client.query("SELECT has_table_privilege(current_user, $1, 'SELECT') AS r, has_table_privilege(current_user, $1, 'INSERT') AS w", [`evalme.${table}`]);
        if (!rows[0]?.r || (table !== 'schema_meta' && !rows[0]?.w))
          throw new AppError('DB_PERMISSION_DENIED', 'Application account needs SELECT/INSERT grants.');
      }
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    const {pgError}=await import('./postgres-setup.mjs');
    throw pgError(e);
  } finally {
    await client.end().catch(() => {});
  }
}
export function connectionTarget(c) {
  return c.provider === 'sqlite' ? c.path : `${c.host}:${c.port}/${c.database}（${c.user}，schema: evalme）`;
}
export async function initialize(flags) {
  let interrupted=false;
  const onInterrupt=()=>{interrupted=true;};
  const checkpoint=()=>{if(interrupted) throw new AppError('CANCELLED','初始化已取消，旧配置保持不变。',130);};
  process.on('SIGINT',onInterrupt);
  try {return await initializeSaved(flags,checkpoint);}
  finally {process.off('SIGINT',onInterrupt);}
}
async function initializeSaved(flags, checkpoint) {
  if (flags._password !== undefined && (typeof flags._password !== "string" || !flags._password || /[\r\n\x00]/.test(flags._password))) throw invalid("Password must be a nonempty single line.");
  const path = absolute(configPath(flags));
  let saved, runtime;
  if (flags.provider === "sqlite") {
    if (flags["connection-file"] || flags["admin-connection-file"])
      throw invalid(
        "PostgreSQL connection options cannot be used with SQLite.",
      );
    const db = absolute(
      flags.path || join(homedir(), ".local/share/evalme-mvp/evalme.sqlite3"),
    );
    saved = runtime = { provider: "sqlite", path: db };
  } else if (flags.provider === "postgres") {
    if (flags.path)
      throw invalid("SQLite path cannot be used with PostgreSQL.");
    ({ saved, runtime } = flags._connectionValues
      ? parseConnection(flags._connectionValues, flags._password)
      : connection(flags["connection-file"]));
  } else throw invalid("Select sqlite or postgres.");
  if (existsSync(path)) {
    const before = privateJson(path);
    if (
      JSON.stringify(before) !== JSON.stringify(saved) &&
      !flags["replace-config"]
    )
      throw new AppError(
        "CONFIG_CONFLICT",
        "Configuration differs; use --replace-config to switch without deleting data.",
        4,
        {previous:connectionTarget(before),next:connectionTarget(saved)},
      );
  }
  checkpoint();
  let remoteInitialized=false;
  const { openStore } = await import("./core.mjs");
  if (runtime.provider === "sqlite") {
    mkdirSync(dirname(runtime.path), { recursive: true, mode: 0o700 });
    if (!existsSync(runtime.path)) {
      const fd = openSync(runtime.path, "wx", 0o600);
      closeSync(fd);
    } else {
      const st = lstatSync(runtime.path);
      if (!st.isFile() || st.isSymbolicLink())
        throw new AppError(
          "CONFIG_PERMISSIONS",
          "Database must be a regular non-symlink file.",
        );
      if (st.mode & 0o077)
        throw new AppError(
          "CONFIG_PERMISSIONS",
          "Existing database permissions must be 0600.",
        );
    }
    const store = await openStore(runtime);
    let fresh=false;
    try {
      fresh=!(await store.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).length;
      await store.initialize();
    } finally {
      await store.close();
    }
    if(fresh) await (await import('./database.mjs')).migrateDatabase(runtime);
  } else {
    const {inspectPostgres,initializePostgres} = await import('./postgres-setup.mjs');
    await assertRuntimePrivileges(runtime);
    const admin = flags._admin ? {...runtime,user:flags._admin.user,password:flags._admin.password} : flags['admin-connection-file'] ? connection(flags['admin-connection-file']).runtime : undefined;
    if (admin) {
      for (const k of ['host','port','database']) if (admin[k] !== runtime[k]) throw invalid('Admin and runtime connections must target the same endpoint and database.');
      if (JSON.stringify(admin.ssl) !== JSON.stringify(runtime.ssl)) throw invalid('Admin and runtime TLS settings must match.');
    }
    const state=await inspectPostgres(runtime);
    checkpoint();
    if(state === 'UNINITIALIZED') {
      if (!admin) throw new AppError('SCHEMA_SETUP_REQUIRED','当前数据库尚未初始化 EvalMe。请运行交互式 init 或由管理员初始化。',5,{target:connectionTarget(saved)});
      await initializePostgres(admin,runtime,checkpoint);
      remoteInitialized=true;
    }
    try {
      checkpoint();
      if(await inspectPostgres(runtime) !== 'READY') throw new AppError('SCHEMA_SETUP_REQUIRED','数据库尚未初始化。');
      await assertRuntimePrivileges(runtime,{requireTables:true});
      checkpoint();
    } catch(e) {
      if(remoteInitialized) throw new AppError('INIT_VERIFICATION_FAILED','数据库结构已初始化，应用连接验证未通过，旧配置保持不变。请检查网络或联系管理员处理权限，再运行 init。',5,{cause:e.code});
      throw e;
    }
  }
  let createdSecret;
  try {
    checkpoint();
    if(flags._password !== undefined) {
      mkdirSync(dirname(path),{recursive:true,mode:0o700});
      const st=lstatSync(dirname(path));
      if(!st.isDirectory() || st.isSymbolicLink()) throw invalid('Configuration directory must be a real directory.');
      createdSecret=join(dirname(path),`credential-${randomUUID()}.secret`);
      writeFileSync(createdSecret,flags._password,{mode:0o600,flag:'wx'});
      saved={...saved,secret_file:createdSecret};
    }
    save(path,saved);
  } catch(e) {
    if(createdSecret && existsSync(createdSecret)) unlinkSync(createdSecret);
    if(remoteInitialized) throw new AppError('INIT_CONFIG_SAVE_FAILED','数据库已初始化，本机配置未保存；请修复本机配置目录后重新运行 init。');
    throw e;
  }
  return { provider: runtime.provider, config: path };
}
