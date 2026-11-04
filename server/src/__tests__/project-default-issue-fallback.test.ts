import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, describe } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  goals,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { getDefaultCompanyProject, projectService } from "../services/projects.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("company default project", () => {
  let db!: ReturnType<typeof createDb>;
  let projectsSvc!: ReturnType<typeof projectService>;
  let issuesSvc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-default-project-");
    db = createDb(tempDb.connectionString);
    projectsSvc = projectService(db);
    issuesSvc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("keeps at most one default project per company", async () => {
    const companyId = await createCompany();
    const first = await projectsSvc.create(companyId, { name: "First", isDefault: true });
    expect(first.isDefault).toBe(true);

    const second = await projectsSvc.create(companyId, { name: "Second", isDefault: true });
    expect(second.isDefault).toBe(true);

    const firstReloaded = await projectsSvc.getById(first.id);
    expect(firstReloaded?.isDefault).toBe(false);

    const defaultProject = await getDefaultCompanyProject(db, companyId);
    expect(defaultProject?.id).toBe(second.id);
  });

  it("moves the default flag on update and drops it when the project is archived", async () => {
    const companyId = await createCompany();
    const first = await projectsSvc.create(companyId, { name: "First", isDefault: true });
    const second = await projectsSvc.create(companyId, { name: "Second" });

    await projectsSvc.update(second.id, { isDefault: true });
    expect((await projectsSvc.getById(first.id))?.isDefault).toBe(false);
    expect((await projectsSvc.getById(second.id))?.isDefault).toBe(true);

    await projectsSvc.update(second.id, { archivedAt: new Date() });
    expect((await projectsSvc.getById(second.id))?.isDefault).toBe(false);
    expect(await getDefaultCompanyProject(db, companyId)).toBeNull();
  });

  it("places issues created without a project into the company default project", async () => {
    const companyId = await createCompany();
    const defaultProject = await projectsSvc.create(companyId, { name: "Inbox", isDefault: true });

    const issue = await issuesSvc.create(companyId, { title: "Untargeted task" });
    expect(issue.projectId).toBe(defaultProject.id);
  });

  it("respects an explicitly provided project over the default", async () => {
    const companyId = await createCompany();
    await projectsSvc.create(companyId, { name: "Inbox", isDefault: true });
    const other = await projectsSvc.create(companyId, { name: "Other" });

    const issue = await issuesSvc.create(companyId, { title: "Targeted task", projectId: other.id });
    expect(issue.projectId).toBe(other.id);
  });

  it("leaves issues without a project when no default is configured", async () => {
    const companyId = await createCompany();
    await projectsSvc.create(companyId, { name: "Regular" });

    const issue = await issuesSvc.create(companyId, { title: "Untargeted task" });
    expect(issue.projectId).toBeNull();
  });

  it("does not apply the default to child issues of a project-less parent", async () => {
    const companyId = await createCompany();
    await projectsSvc.create(companyId, { name: "Inbox", isDefault: true });

    const parentId = randomUUID();
    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Parent without project",
      status: "backlog",
      priority: "medium",
    });

    const child = await issuesSvc.create(companyId, { title: "Child", parentId });
    expect(child.projectId).toBeNull();
  });
});
