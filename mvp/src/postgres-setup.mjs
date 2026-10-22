import pg from 'pg';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {AppError} from './config.mjs';
import {schema, postgresGradeForeignKey} from './providers/schema.mjs';
export const contractSource = () => createHash('sha256').update(JSON.stringify([...schema('postgres'), postgresGradeForeignKey])).digest('hex');
export function pgError(e) {
  if (e instanceof AppError) return e;
  if(e.code==='P0002') return new AppError('NOT_FOUND','题目不存在。',3);
  if(e.code==='P0001' && ['DELETE_PLAN_CHANGED','DELETE_BLOCKED_REFERENCES','DELETE_ISOLATION_REQUIRED'].includes(e.message)) {
    let details={};if(e.message==='DELETE_BLOCKED_REFERENCES')try{details={blockers:JSON.parse(e.detail)};}catch{}
    return new AppError(e.message,e.message==='DELETE_PLAN_CHANGED'?'删除计划已变化，请重新预览确认。':e.message==='DELETE_BLOCKED_REFERENCES'?'存在异常引用，删除已阻止。':'删除需要 READ COMMITTED 事务。',5,details);
  }
  if (e.code === '3D000') return new AppError('DB_NOT_FOUND','目标数据库不存在，请管理员先创建数据库。');
  if (e.code === '42501') return new AppError('DB_PERMISSION_DENIED','数据库权限不足，请管理员检查 schema USAGE、表权限或初始化权限。');
  if (['28P01','28000'].includes(e.code)) return new AppError('CONFIG_AUTH_FAILED','数据库认证失败，请检查用户名和密码。');
  if (/CERT|TLS|SELF_SIGNED|VERIFY_LEAF/.test(e.code || '')) return new AppError('DB_TLS_FAILED','TLS 证书验证失败，请检查主机名和 CA 配置。');
  if (['55P03','57014','40P01'].includes(e.code)) return new AppError('DB_BUSY','数据库操作超时或正在被其他初始化占用，请重试。',6);
  if (['ECONNREFUSED','ENOTFOUND','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','ECONNRESET','EAI_AGAIN'].includes(e.code) || /timeout|connection terminated/i.test(e.message || '')) return new AppError('DB_CONNECTION_FAILED','无法连接数据库，请检查地址、端口和网络。',6);
  return new AppError('SCHEMA_CHECK_FAILED','无法可靠检查或初始化数据库，请管理员检查；原配置保持不变。');
}
export async function withPg(config, fn) {
  const client = new pg.Client({...config,connectionTimeoutMillis:5000,statement_timeout:5000});
  client.on('error',()=>{});
  try {
    await client.connect();
    await client.query('SET search_path TO evalme, pg_catalog');
    return await fn(client);
  } catch(e) {throw pgError(e);}
  finally {await client.end().catch(()=>{});}
}
// Catalog reads deliberately do not use information_schema's privilege-filtered lists.
export async function structure(client) {
  const rows = async sql => (await client.query(sql)).rows.sort((a,b)=>{const x=JSON.stringify(a),y=JSON.stringify(b);return x<y?-1:x>y?1:0;});
  return {
    relations: await rows(`SELECT c.relname AS name,c.relkind AS kind,c.relpersistence AS persistence,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='evalme' ORDER BY c.relname`),
    columns: await rows(`SELECT c.relname AS table_name,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required,a.attidentity AS identity,a.attgenerated AS generated,pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='evalme' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`),
    constraints: await rows(`SELECT c.relname AS table_name,k.contype AS kind,pg_get_constraintdef(k.oid) AS definition,k.convalidated AS validated FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='evalme' ORDER BY c.relname,k.contype,pg_get_constraintdef(k.oid)`),
    indexes: await rows(`SELECT c.relname AS table_name,pg_get_indexdef(i.indexrelid) AS definition,i.indisvalid AS valid,i.indisready AS ready FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='evalme' ORDER BY c.relname,pg_get_indexdef(i.indexrelid)`),
    extras: await rows(`SELECT 'function' AS kind,p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='evalme' UNION ALL SELECT 'type',t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='evalme' AND t.typrelid=0 AND t.typelem=0 UNION ALL SELECT 'trigger',t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='evalme' AND NOT t.tgisinternal UNION ALL SELECT 'policy',p.polname FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='evalme' UNION ALL SELECT 'rule',r.rulename FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='evalme' UNION ALL SELECT 'other',pg_describe_object(d.classid,d.objid,d.objsubid) FROM pg_depend d JOIN pg_namespace n ON d.refobjid=n.oid WHERE d.refclassid='pg_namespace'::regclass AND n.nspname='evalme' AND d.classid NOT IN ('pg_class'::regclass,'pg_type'::regclass,'pg_proc'::regclass,'pg_constraint'::regclass,'pg_default_acl'::regclass) ORDER BY kind,name`),
  };
}
export async function inspectClient(client) {
  const actual = await structure(client);
  if (!actual.relations.length && !actual.extras.length) return 'UNINITIALIZED';
  const usage=await client.query("SELECT has_schema_privilege(current_user,'evalme','USAGE') AS ok");
  if(!usage.rows[0]?.ok) throw new AppError('DB_PERMISSION_DENIED','应用账号缺少 evalme schema USAGE 权限，请管理员处理。');
  if(!actual.columns.some(c=>c.table_name==='schema_meta'&&c.name==='version'))throw new AppError('SCHEMA_INCOMPATIBLE','EvalMe 版本表缺失或不完整。');
  const {rows} = await client.query('SELECT version FROM evalme.schema_meta');
  if (rows.length !== 1 || ![1,2].includes(rows[0].version)) throw new AppError('SCHEMA_INCOMPATIBLE','EvalMe 版本标记缺失或不兼容，请管理员处理。');
  const v=rows[0].version;
  const expected = JSON.parse(readFileSync(new URL(v===2?'./providers/postgres-schema-v2.json':'./providers/postgres-schema-contract.json',import.meta.url),'utf8'));
  if (expected.source !== contractSource()) throw new AppError('SCHEMA_CHECK_FAILED','Schema contract needs regeneration.');
  if (JSON.stringify(actual) !== JSON.stringify(expected.structure)) throw new AppError('SCHEMA_INCOMPATIBLE','EvalMe 结构不完整、存在未知对象或版本不兼容，请管理员处理；不会自动补表或覆盖。');
  if(v===2)await (await import('./postgres-delete.mjs')).assertSecurity(client);
  return 'READY';
}
export async function inspectPostgres(config) {
  return withPg(config,async client=>{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {return await inspectClient(client);} finally {await client.query('ROLLBACK');}
  });
}
export async function initializePostgres(admin, runtime, checkpoint = ()=>{}) {
  for (const key of ['host','port','database']) if(admin[key] !== runtime[key]) throw new AppError('VALIDATION_ERROR','管理连接与应用连接必须使用相同地址、端口和数据库。',2);
  if (JSON.stringify(admin.ssl) !== JSON.stringify(runtime.ssl)) throw new AppError('VALIDATION_ERROR','管理连接与应用连接必须使用相同 TLS 设置。',2);
  return withPg(admin,async client=>{
    let committing=false;
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout='4500ms'");
      await client.query('SELECT pg_advisory_xact_lock(109539641,1)');
      checkpoint();
      if (await inspectClient(client) === 'READY') {await client.query('ROLLBACK');return false;}
      const ns=await client.query("SELECT 1 FROM pg_namespace WHERE nspname='evalme'");
      if (!ns.rowCount) await client.query('CREATE SCHEMA evalme');
      const {rows:[owner]}=await client.query("SELECT r.rolname,r.rolsuper,r.rolcreatedb,r.rolcreaterole FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname='evalme'");
      if(!owner || owner.rolsuper || owner.rolcreatedb || owner.rolcreaterole || owner.rolname===runtime.user)throw new AppError('MIGRATION_OWNER_REQUIRED','请管理员准备受限的非应用、非超级用户 schema owner，再初始化。');
      await client.query('SET LOCAL ROLE "'+owner.rolname.replaceAll('"','""')+'"');
      for (const sql of schema('postgres')) {checkpoint();await client.query(sql);}
      await client.query(postgresGradeForeignKey);
      await client.query('INSERT INTO evalme.schema_meta(version) VALUES (1)');
      const role='"'+runtime.user.replaceAll('"','""')+'"';
      await client.query(`GRANT USAGE ON SCHEMA evalme TO ${role}`);
      await client.query(`GRANT SELECT ON evalme.schema_meta TO ${role}`);
      await client.query(`GRANT SELECT, INSERT ON evalme.topics,evalme.tasks,evalme.task_topics,evalme.trials,evalme.grades TO ${role}`);
      await (await import('./postgres-delete.mjs')).installV2(client,runtime.user);
      checkpoint();
      committing=true;
      await client.query('COMMIT');
      return true;
    } catch(e) {
      await client.query('ROLLBACK').catch(()=>{});
      if(committing) throw new AppError('COMMIT_UNKNOWN','初始化提交结果未确认；请重新运行 init 检查状态，不要直接重复建表。',6);
      throw e;
    }
  });
}
