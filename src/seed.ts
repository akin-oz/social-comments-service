import { Client } from 'pg';

import { seedSecondConnection, seedTenants } from './seed-data.js';

/**
 * Populates reference data for local use and the isolation tests (Spec-012).
 *
 * Two tenants exist so cross-tenant reads can be tested against real rows.
 * Comments are deliberately absent: they arrive by provider hydration, and
 * seeding them would fake the path Spec-008 exists to exercise.
 *
 * Runs as the owning role, and every statement is idempotent so re-running
 * leaves the data unchanged.
 */
async function seed(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined) {
    throw new Error('DATABASE_URL must be set to seed the database.');
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('begin');
    for (const tenant of seedTenants) {
      await client.query(
        `insert into accounts (id, external_tenant_id) values ($1, $2)
         on conflict (id) do nothing`,
        [tenant.accountId, tenant.externalTenantId],
      );
      await client.query(
        `insert into social_accounts
           (id, account_id, platform, external_account_id, credential_reference)
         values ($1, $2, $3, $4, $5)
         on conflict (id) do nothing`,
        [
          tenant.socialAccountId,
          tenant.accountId,
          tenant.platform,
          tenant.externalAccountId,
          // A reference to a secret held elsewhere, never the secret itself.
          tenant.credentialReference,
        ],
      );
      await client.query(
        `insert into posts
           (id, account_id, social_account_id, external_post_id, status, published_at)
         values ($1, $2, $3, $4, 'published', $5)
         on conflict (id) do nothing`,
        [
          tenant.postId,
          tenant.accountId,
          tenant.socialAccountId,
          tenant.externalPostId,
          tenant.publishedAt,
        ],
      );
    }
    // A second connection for tenant A on the same platform, so the queries
    // that scope by social account have something to exclude (Spec-020).
    await client.query(
      `insert into social_accounts
         (id, account_id, platform, external_account_id, credential_reference)
       values ($1, $2, $3, $4, $5)
       on conflict (id) do nothing`,
      [
        seedSecondConnection.socialAccountId,
        seedSecondConnection.accountId,
        seedSecondConnection.platform,
        seedSecondConnection.externalAccountId,
        seedSecondConnection.credentialReference,
      ],
    );
    await client.query(
      `insert into posts
         (id, account_id, social_account_id, external_post_id, status, published_at)
       values ($1, $2, $3, $4, 'published', $5)
       on conflict (id) do nothing`,
      [
        seedSecondConnection.postId,
        seedSecondConnection.accountId,
        seedSecondConnection.socialAccountId,
        seedSecondConnection.externalPostId,
        seedSecondConnection.publishedAt,
      ],
    );

    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  for (const tenant of seedTenants) {
    process.stdout.write(
      `seeded ${tenant.label}: account ${tenant.accountId}, post ${tenant.postId}\n`,
    );
  }
  process.stdout.write(
    `seeded ${seedSecondConnection.label}: post ${seedSecondConnection.postId}\n`,
  );
}

seed().catch((error: unknown) => {
  process.stderr.write(`seeding failed: ${String(error)}\n`);
  process.exitCode = 1;
});
