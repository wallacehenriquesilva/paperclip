import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companyMcpServers } from "./company_mcp_servers.js";

/**
 * Persisted state for MCPs that use OAuth 2.1 with Dynamic Client Registration
 * (RFC 7591). One row per MCP server when dynamicRegistration is enabled.
 *
 * The discovered endpoints (authorization/token/revocation/registration) are
 * cached here so we don't re-fetch the .well-known documents on every wakeup.
 * `expiresAt` mirrors the `client_secret_expires_at` from the DCR response;
 * we re-register the client when this is in the past.
 */
export const companyMcpOauthClients = pgTable(
  "company_mcp_oauth_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    mcpServerId: uuid("mcp_server_id")
      .notNull()
      .references(() => companyMcpServers.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    clientSecretCiphertext: text("client_secret_ciphertext"),
    authorizationEndpoint: text("authorization_endpoint").notNull(),
    tokenEndpoint: text("token_endpoint").notNull(),
    revocationEndpoint: text("revocation_endpoint"),
    registrationEndpoint: text("registration_endpoint"),
    resourceMetadataUrl: text("resource_metadata_url"),
    authorizationServerUrl: text("authorization_server_url"),
    scopesSupported: jsonb("scopes_supported").$type<string[]>(),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    mcpServerUq: uniqueIndex("company_mcp_oauth_clients_mcp_server_uq").on(table.mcpServerId),
  }),
);
