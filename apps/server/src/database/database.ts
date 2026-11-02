import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });
  /** Typed queries with tables from ./schema; query()/transaction() stay for raw SQL. */
  readonly orm = drizzle({ client: this.pool });

  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[]
  ) {
    return this.pool.query<T>(sql, values);
  }

  transaction<T>(work: (client: PoolClient) => Promise<T>) {
    return this.pool.connect().then(async (client) => {
      try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
