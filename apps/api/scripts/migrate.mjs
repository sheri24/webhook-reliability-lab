import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const { Pool } = pg;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, '../../..');
const migrationsDirectory = resolve(projectRoot, 'apps/api/migrations');
dotenv.config({ path: resolve(projectRoot, '.env') });

const pool = new Pool({
  connectionString: process.env.WEBHOOK_LAB_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://webhook_lab:webhook_lab_dev@127.0.0.1:5432/webhook_lab',
});

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const name of files) {
    const existing = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
    if (existing.rowCount) {
      console.info(`Already applied: ${name}`);
      continue;
    }

    const sql = await readFile(resolve(migrationsDirectory, name), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.info(`Applied: ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
