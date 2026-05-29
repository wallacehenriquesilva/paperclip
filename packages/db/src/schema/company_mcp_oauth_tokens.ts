import {
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companyMcpServers } from "./company_mcp_servers.js";

export const companyMcpOauthTokens = pgTable(
  "company_mcp_oauth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    mcpServerId: uuid("mcp_server_id")
      .notNull()
      .references(() => companyMcpServers.id, { onDelete: "cascade" }),
    accessTokenCiphertext: text("access_token_ciphertext").notNull(),
    refreshTokenCiphertext: text("refresh_token_ciphertext"),
    tokenType: text("token_type").notNull().default("Bearer"),
    scope: text("scope"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    refreshFailureCount: integer("refresh_failure_count").notNull().default(0),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    mcpServerUq: uniqueIndex("company_mcp_oauth_tokens_mcp_server_uq").on(table.mcpServerId),
  }),
);
