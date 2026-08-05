import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { Client } from 'pg';

/**
 * Applies migrations in filename order and records what it applied (Spec-012).
 *
 * One controlled runner per release, per ADR-0009: API replicas never migrate
 * on startup. Runs as the owning role, unlike the service itself.
 */
const directory = 'migrations';

async function migrate(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined) {
    throw new Error('DATABASE_URL must be set to run migrations.');
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`);

    const applied = new Set(
      (await client.query<{ name: string }>('select name from schema_migrations')).rows.map(
        (row) => row.name,
      ),
    );
    const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(directory, file), 'utf8');
      // Each migration is one transaction: a failure leaves no partial schema.
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw new Error(`migration ${file} failed: ${String(error)}`);
      }
      process.stdout.write(`applied ${file}\n`);
      count += 1;
    }

    await setApplicationPassword(client);
    process.stdout.write(count === 0 ? 'schema already up to date\n' : `applied ${count}\n`);
  } finally {
    await client.end();
  }
}

/**
 * Sets the service role's password from the environment. Credentials must not
 * live in a migration file, and DDL cannot take a bound parameter, so the value
 * is escaped as a literal rather than interpolated raw.
 */
async function setApplicationPassword(client: Client): Promise<void> {
  const password = process.env.APP_DATABASE_PASSWORD;
  if (password === undefined || password === '') {
    // Silently skipping leaves comments_app able to log in without one.
    throw new Error('APP_DATABASE_PASSWORD must be set so the service role has a password.');
  }
  await client.query(`alter role comments_app password ${client.escapeLiteral(password)}`);
  process.stdout.write('set the comments_app password\n');
}

migrate().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
