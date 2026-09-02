import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    actorType: text("actor_type").notNull().default("system"),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    agentId: uuid("agent_id").references(() => agents.id),
    runId: uuid("run_id").references(() => heartbeatRuns.id),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("activity_log_company_created_idx").on(table.companyId, table.createdAt),
    runIdIdx: index("activity_log_run_id_idx").on(table.runId),
    // agent_id is appended so the per-issue "did this agent act on this
    // entity" EXISTS probe (issues ?participantAgentId=) resolves inside the
    // index instead of filtering every activity row of the entity on the heap.
    // The (entity_type, entity_id) prefix keeps serving the existing lookups.
    entityIdx: index("activity_log_entity_type_id_idx").on(
      table.entityType,
      table.entityId,
      table.agentId,
    ),
  }),
);
