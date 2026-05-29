import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companyMcpServers } from "./company_mcp_servers.js";

export const companyMcpOauthSessions = pgTable(
  "company_mcp_oauth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    mcpServerId: uuid("mcp_server_id")
      .notNull()
      .references(() => companyMcpServers.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    codeVerifier: text("code_verifier").notNull(),
    initiatedByUserId: text("initiated_by_user_id"),
    status: text("status").notNull().default("pending"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    stateIdx: uniqueIndex("company_mcp_oauth_sessions_state_idx").on(table.state),
    mcpServerIdx: index("company_mcp_oauth_sessions_mcp_server_idx").on(table.mcpServerId),
    expiresIdx: index("company_mcp_oauth_sessions_expires_idx").on(table.expiresAt),
  }),
);
