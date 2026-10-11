import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString)
  throw new Error("DATABASE_URL is required for migrations");

const pool = new Pool({
  connectionString,
  ssl: connectionString.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

const files = [
  "schema.sql",
  "migrations/002_persistent_memory.sql",
  "migrations/003_robo_portfolios.sql",
];

try {
  // Prevent two deploying instances from applying DDL concurrently.
  await pool.query("SELECT pg_advisory_lock(hashtext($1))", [
    "penny-schema-migrations",
  ]);
  for (const file of files) {
    const url = new URL(`../db/${file}`, import.meta.url);
    await pool.query(await readFile(url, "utf8"));
    console.log(JSON.stringify({ event: "migration_applied", file }));
  }
} finally {
  await pool
    .query("SELECT pg_advisory_unlock(hashtext($1))", [
      "penny-schema-migrations",
    ])
    .catch(() => undefined);
  await pool.end();
}
