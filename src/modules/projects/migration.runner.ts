import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { assertConversationSchema } from './schema-verification.js';

export type MigrationResult = { version: number; name: string; checksum: string; applied: boolean };
type MigrationFile = { version: number; name: string; path: string; sql: string; checksum: string };

export async function runMigrations(pool: Pool, migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations')): Promise<MigrationResult[]> {
  const client = await pool.connect();
  let locked = false;
  try {
    const schema = (await client.query<{ schema: string }>('SELECT current_schema() AS schema')).rows[0]?.schema;
    if (!schema) throw new Error('Nenhum schema PostgreSQL selecionado para migrations');
    await client.query("SELECT pg_advisory_lock(hashtext('process-ai-schema-migrations'), hashtext($1))", [schema]);
    locked = true;
    await client.query(`CREATE TABLE IF NOT EXISTS process_ai_schema_migrations (
      version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS process_ai_schema_migration_failures (
      id bigserial PRIMARY KEY, version integer NOT NULL, name text NOT NULL,
      checksum text NOT NULL, error text NOT NULL, failed_at timestamptz NOT NULL DEFAULT now()
    )`);
    const files = await loadMigrationFiles(migrationsDirectory);
    const result: MigrationResult[] = [];
    for (const migration of files) {
      const recorded = await client.query<{ checksum: string }>('SELECT checksum FROM process_ai_schema_migrations WHERE version=$1', [migration.version]);
      if (recorded.rows[0]) {
        if (recorded.rows[0].checksum !== migration.checksum) throw new Error(`Checksum divergente na migration ${migration.version} (${migration.name})`);
        result.push({ version: migration.version, name: migration.name, checksum: migration.checksum, applied: false });
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await assertConversationSchema(client, false, migration.version);
        await client.query('INSERT INTO process_ai_schema_migrations(version,name,checksum) VALUES($1,$2,$3)', [migration.version, migration.name, migration.checksum]);
        await client.query('COMMIT');
        result.push({ version: migration.version, name: migration.name, checksum: migration.checksum, applied: true });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        const message = error instanceof Error ? error.message.slice(0, 2000) : 'erro desconhecido durante migration';
        await client.query('INSERT INTO process_ai_schema_migration_failures(version,name,checksum,error) VALUES($1,$2,$3,$4)', [migration.version, migration.name, migration.checksum, message]);
        throw error;
      }
    }
    await assertConversationSchema(client, false, files.at(-1)?.version || 1);
    return result;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtext(\'process-ai-schema-migrations\'), hashtext($1))', [(await client.query<{ schema: string }>('SELECT current_schema() AS schema')).rows[0]?.schema]).catch(() => undefined);
    client.release();
  }
}

async function loadMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory)).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/i.test(name)).sort();
  if (!names.length) throw new Error(`Nenhum arquivo de migration versionada em ${directory}`);
  const files: MigrationFile[] = [];
  for (const name of names) {
    const version = Number(name.slice(0, 3));
    if (files.some(item => item.version === version)) throw new Error(`Versão de migration duplicada: ${version}`);
    const path = resolve(directory, name);
    const sql = await readFile(path, 'utf8');
    files.push({ version, name, path, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return files;
}
