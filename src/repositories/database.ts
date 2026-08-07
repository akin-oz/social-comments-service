import { Pool, type PoolConfig } from 'pg';

import type { AccountId } from '../shared/types.js';

export interface SqlResult<Row> {
  rows: Row[];
}

/** A connection already inside a tenant-scoped transaction. */
export interface SqlSession {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
}

/**
 * Persistence port (ADR-0012).
 *
 * Every database access names a tenant, so omitting tenant context is a type
 * error rather than a silent read across the whole table.
 */
export interface Database {
  withTenant<T>(accountId: AccountId, run: (tx: SqlSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * The longest one database call can take: waiting for a pooled connection, then
 * running the statement.
 *
 * Exported because the reply lease has to outlast the work it protects, and
 * that work is mostly database calls. Deriving the lease from this rather than
 * from a number in a comment is what keeps the two from drifting apart
 * (Spec-033).
 */
export const DATABASE_CALL_BUDGET_MS = 5_000 + 10_000;

export class PostgresDatabase implements Database {
  private readonly pool: Pool;

  public constructor(config: PoolConfig | string) {
    // Every database call is bounded. Without these a single request can hold a
    // pooled connection indefinitely while the client has long since given up.
    const defaults: PoolConfig = {
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 10_000,
      query_timeout: 10_000,
    };
    this.pool = new Pool(
      typeof config === 'string'
        ? { ...defaults, connectionString: config }
        : { ...defaults, ...config },
    );
  }

  /**
   * Runs the callback in a transaction whose `app.account_id` is set for the
   * duration of that transaction only.
   *
   * The third argument to `set_config` makes the setting transaction-local, so
   * a connection returned to the pool cannot carry one tenant's context into
   * the next checkout. That property is what makes pooling safe here.
   */
  public async withTenant<T>(
    accountId: AccountId,
    run: (tx: SqlSession) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.account_id', $1, true)`, [accountId]);
      const result = await run({
        query: async <Row>(text: string, values?: readonly unknown[]) => {
          const queried = await client.query(text, values ? [...values] : undefined);
          return { rows: queried.rows as Row[] };
        },
      });
      await client.query('commit');
      return result;
    } catch (error) {
      // A failed rollback must not mask the error that caused it.
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
