// Developer-only: generate the read-only inspection contract from the actual DDL
// in a disposable database on the explicitly configured test server.
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {connection} from '../../src/config.mjs';
import {openStore} from '../../src/core.mjs';
import {withPg,structure,contractSource} from '../../src/postgres-setup.mjs';
if(!process.env.EVALME_SETUP_PG_PORT && !process.env.EVALME_TEST_PG_ADMIN_CONFIG) throw Error('EVALME_TEST_PG_ADMIN_CONFIG is required');
const config=process.env.EVALME_SETUP_PG_PORT ? {provider:'postgres',host:'127.0.0.1',port:Number(process.env.EVALME_SETUP_PG_PORT),user:'postgres',database:'postgres',ssl:false} : connection(process.env.EVALME_TEST_PG_ADMIN_CONFIG).runtime;
const client=new pg.Client(config);await client.connect();
const database='evalme_contract_'+randomUUID().replaceAll('-','');
try {
 await client.query(`CREATE DATABASE "${database}"`);
 const c={...config,database};const store=await openStore(c);
 try {await store.initialize();} finally {await store.close();}
 const contract={source:contractSource(),structure:await withPg(c,structure)};
 writeFileSync(new URL('../../src/providers/postgres-schema-contract.json',import.meta.url),JSON.stringify(contract,null,2)+'\n');
} finally {await client.query(`DROP DATABASE IF EXISTS "${database}"`);await client.end();}
