import {DatabaseSync} from 'node:sqlite';
import {schema} from './schema.mjs';
import {AppError} from '../config.mjs';
export const metadataV2='DROP TABLE schema_meta; CREATE TABLE schema_meta(version INTEGER PRIMARY KEY CHECK(version=2)); INSERT INTO schema_meta VALUES(2)';
export const identityDDL='CREATE TABLE database_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), database_uuid TEXT NOT NULL UNIQUE)';
export const feedbackTriggers=['INSERT','UPDATE'].map(action=>`CREATE TRIGGER evalme_feedback_${action.toLowerCase()} BEFORE ${action} ON trials WHEN NEW.based_on_grade_id IS NOT NULL BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM tasks a JOIN grades g ON g.id=NEW.based_on_grade_id JOIN trials r ON r.id=g.trial_id JOIN tasks b ON b.id=r.task_id WHERE a.id=NEW.task_id AND a.family_id=b.family_id) THEN RAISE(ABORT,'FEEDBACK_FAMILY_MISMATCH') END; END`);
const catalog="SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
const expected=new Map();
function contract(version) {
 if(!expected.has(version)) {
  const db=new DatabaseSync(':memory:');
  try {
   for(const ddl of schema('sqlite'))db.exec(ddl);
   if(version===2){db.exec(metadataV2);db.exec(identityDDL);for(const ddl of feedbackTriggers)db.exec(ddl);}
   expected.set(version,JSON.stringify(db.prepare(catalog).all()));
  }finally{db.close();}
 }
 return expected.get(version);
}
export async function assertSQLite(s,version) {
 const fail=()=>{throw new AppError('SCHEMA_INCOMPATIBLE','SQLite 结构、外键或删除能力异常；请检查数据库，不会自动修补。',5);};
 if(JSON.stringify(await s.query(catalog))!==contract(version))fail();
 if((await s.query('PRAGMA foreign_key_check')).length)fail();
 if(version===2) {
  const ids=await s.query('SELECT * FROM database_identity');
  if(ids.length!==1||ids[0].singleton!==1||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(ids[0].database_uuid))fail();
 }
}
