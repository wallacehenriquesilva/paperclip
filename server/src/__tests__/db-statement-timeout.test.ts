import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function currentStatementTimeout(db: ReturnType<typeof createDb>) {
  const rows = await db.execute(sql`select current_setting('statement_timeout') as value`);
  return String((rows as unknown as Array<{ value: string }>)[0]?.value);
}

describeEmbeddedPostgres("createDb statement timeout", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-statement-timeout-");
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("applies the cap to every connection of the pool", async () => {
    const db = createDb(tempDb!.connectionString, { statementTimeoutMs: 1500 });
    expect(await currentStatementTimeout(db)).toBe("1500ms");
  });

  it("cancels a statement that runs past the cap", async () => {
    const db = createDb(tempDb!.connectionString, { statementTimeoutMs: 200 });
    const error = await db.execute(sql`select pg_sleep(2)`).then(() => null, (err: unknown) => err);
    // Drizzle wraps the driver error; 57014 is Postgres' query_canceled.
    expect((error as { cause?: { code?: string } } | null)?.cause?.code).toBe("57014");
  });

  it("leaves the server default when no cap is given", async () => {
    const db = createDb(tempDb!.connectionString);
    expect(await currentStatementTimeout(db)).toBe("0");
  });

  it("names the pool so it is identifiable in pg_stat_activity", async () => {
    const named = createDb(tempDb!.connectionString);
    const rows = await named.execute(sql`select current_setting('application_name') as value`);
    expect(String((rows as unknown as Array<{ value: string }>)[0]?.value)).toBe("paperclip");

    const custom = createDb(tempDb!.connectionString, { applicationName: "paperclip-test" });
    const customRows = await custom.execute(sql`select current_setting('application_name') as value`);
    expect(String((customRows as unknown as Array<{ value: string }>)[0]?.value)).toBe("paperclip-test");
  });
});
