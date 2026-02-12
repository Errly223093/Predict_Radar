import { readFile } from "node:fs/promises";
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
  const sqlPath = path.resolve(__dirname, "../sql/001_init.sql");
  const sql = await readFile(sqlPath, "utf-8");
  await pool.query(sql);
}

export function toMinute(date: Date = new Date()): Date {
  return new Date(Math.floor(date.getTime() / 60_000) * 60_000);
}
