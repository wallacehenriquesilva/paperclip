import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const companyMcpServers = pgTable(
  "company_mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    transport: text("transport").notNull().default("stdio"),
    command: text("command").notNull(),
    args: jsonb("args").$type<string[]>().notNull().default([]),
    envTemplate: jsonb("env_template").$type<Record<string, string>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUniqueIdx: uniqueIndex("company_mcp_servers_company_key_idx").on(
      table.companyId,
      table.key,
    ),
    companyNameIdx: index("company_mcp_servers_company_name_idx").on(
      table.companyId,
      table.name,
    ),
  }),
);
