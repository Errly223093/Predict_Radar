import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { config } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 12
});

export async function runMigrations(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const sqlDir = path.resolve(__dirname, "../sql");
  const entries = await readdir(sqlDir, { withFileTypes: true });
  const migrations = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  for (const name of migrations) {
    const existing = await pool.query(`SELECT 1 FROM schema_migrations WHERE name = $1`, [name]);
    if (existing.rowCount && existing.rowCount > 0) continue;

    const sqlPath = path.join(sqlDir, name);
    const sql = await readFile(sqlPath, "utf-8");

    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [name]);
      await pool.query("COMMIT");
      console.info(`[migrations] applied ${name}`);
    } catch (error) {
      await pool.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
}

export function toMinute(date: Date = new Date()): Date {
  return new Date(Math.floor(date.getTime() / 60_000) * 60_000);
}
