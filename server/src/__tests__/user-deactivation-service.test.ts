import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { authSessions, authUsers, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { accessService } from "../services/access.js";
import { boardAuthService } from "../services/board-auth.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createUser(db: ReturnType<typeof createDb>) {
  const now = new Date();
  const id = `user-${randomUUID()}`;
  await db.insert(authUsers).values({
    id,
    name: "Casey",
    email: `${id}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(authSessions).values({
    id: `session-${randomUUID()}`,
    token: randomUUID(),
    userId: id,
    expiresAt: new Date(now.getTime() + 60_000),
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describeEmbeddedPostgres("user deactivation (soft delete)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-user-deactivation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(authSessions);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("stamps deactivatedAt and drops the user's sessions", async () => {
    const access = accessService(db);
    const userId = await createUser(db);

    const updated = await access.deactivateUser(userId);
    expect(updated?.deactivatedAt).toBeInstanceOf(Date);

    const sessions = await db.select().from(authSessions).where(eq(authSessions.userId, userId));
    expect(sessions).toHaveLength(0);
  });

  it("blocks board access for a deactivated user, and restores it on reactivate", async () => {
    const access = accessService(db);
    const boardAuth = boardAuthService(db);
    const userId = await createUser(db);

    const before = await boardAuth.resolveBoardAccess(userId);
    expect(before.user).not.toBeNull();

    await access.deactivateUser(userId);
    const blocked = await boardAuth.resolveBoardAccess(userId);
    expect(blocked.user).toBeNull();
    expect(blocked.isInstanceAdmin).toBe(false);
    expect(blocked.companyIds).toEqual([]);

    await access.reactivateUser(userId);
    const restored = await boardAuth.resolveBoardAccess(userId);
    expect(restored.user).not.toBeNull();
  });

  it("returns null when deactivating a user that does not exist", async () => {
    const access = accessService(db);
    expect(await access.deactivateUser(`missing-${randomUUID()}`)).toBeNull();
  });
});
