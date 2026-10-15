import { Pool } from 'pg';
import { runMigrations } from '../src/modules/projects/migration.runner.js';

const connectionString = process.env.MIGRATION_DATABASE_URL;
if (!connectionString) {
  console.error('Defina MIGRATION_DATABASE_URL explicitamente no mesmo processo para executar migrations.');
  process.exitCode = 1;
} else {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const results = await runMigrations(pool);
    for (const item of results) console.log(`${item.applied ? 'APLICADA' : 'JÁ APLICADA'} v${item.version} ${item.name} sha256=${item.checksum}`);
    if (!results.length) console.log('Schema sem alterações; nenhuma migration pendente.');
  } catch (error) {
    console.error(`Falha ao executar migrations: ${error instanceof Error ? error.message : 'erro desconhecido'}`);
    process.exitCode = 1;
  } finally { await pool.end(); }
}
