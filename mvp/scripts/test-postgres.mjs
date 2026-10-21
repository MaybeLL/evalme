import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
if (
  !process.env.EVALME_TEST_PG_CONFIG ||
  !process.env.EVALME_TEST_PG_ADMIN_CONFIG
) {
  console.error(
    "Real PostgreSQL tests require EVALME_TEST_PG_CONFIG and EVALME_TEST_PG_ADMIN_CONFIG. No mock or SQLite substitution.",
  );
  process.exit(2);
}
const dir = fileURLToPath(new URL("../tests/", import.meta.url));
const result = spawnSync(
  process.execPath,
  [
    "--test",
    ...readdirSync(dir)
      .filter((x) => x.endsWith(".test.mjs"))
      .map((x) => dir + x),
  ],
  { stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
