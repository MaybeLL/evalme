import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {installV2} from '../../src/postgres-delete.mjs';
import {structure,contractSource} from '../../src/postgres-setup.mjs';
if(!process.env.EVALME_SETUP_PG_PORT)throw Error('Isolated EVALME_SETUP_PG_PORT required');
const x=randomUUID().replaceAll('-',''),database='contract_'+x,owner='owner_'+x,user='app_'+x;
const base={host:'127.0.0.1',port:Number(process.env.EVALME_SETUP_PG_PORT),user:'postgres',database:'postgres',ssl:false};
const root=new pg.Client(base);await root.connect();let c;
try {
 await root.query(`CREATE ROLE ${owner};CREATE ROLE ${user}`);await root.query(`CREATE DATABASE ${database}`);
 c=new pg.Client({...base,database});await c.connect();await c.query(`CREATE SCHEMA evalme AUTHORIZATION ${owner}`);await c.query(`SET ROLE ${owner}`);
 const {schema,postgresGradeForeignKey}=await import('../../src/providers/schema.mjs');await c.query('SET search_path TO evalme,pg_catalog');
 for(const sql of schema('postgres'))await c.query(sql);await c.query(postgresGradeForeignKey);await c.query('INSERT INTO schema_meta VALUES(1)');
 await c.query('RESET ROLE');await c.query('BEGIN');await installV2(c,user);await c.query('COMMIT');
 writeFileSync(new URL('../../src/providers/postgres-schema-v2.json',import.meta.url),JSON.stringify({source:contractSource(),structure:await structure(c)},null,2)+'\n');
}finally{await c?.end();await root.query(`DROP DATABASE IF EXISTS ${database}`);await root.query(`DROP ROLE IF EXISTS ${owner};DROP ROLE IF EXISTS ${user}`);await root.end();}
