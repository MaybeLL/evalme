import { EvalmeError } from "../core-validation.mjs";
export async function connect(config) {
  const { Client } = await import("pg");
  const { provider, ...connection } = config;
  const client = new Client({ ...connection, connectionTimeoutMillis: 5000 });
  // A connection error outside a pending query must not terminate the CLI process.
  client.on("error", () => {});
  try {
    await client.connect();
    await client.query("SET TIME ZONE 'UTC'");
    await client.query("SET search_path TO evalme");
  } catch {
    await client.end().catch(() => {});
    throw new EvalmeError(
      "DB_CONNECTION_FAILED",
      "Cannot connect to PostgreSQL",
      {},
      true,
    );
  }
  return {
    dialect: "postgres",
    async query(sql, params = []) {
      let n = 0;
      const result = await client.query(
        sql.replace(/\?/g, () => `$${++n}`),
        params,
      );
      return result.rows;
    },
    async exec(sql) {
      await client.query(sql);
    },
    async close() {
      await client.end();
    },
  };
}
