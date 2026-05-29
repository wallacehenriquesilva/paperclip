CREATE TABLE "company_mcp_oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_ciphertext" text,
	"authorization_endpoint" text NOT NULL,
	"token_endpoint" text NOT NULL,
	"revocation_endpoint" text,
	"registration_endpoint" text,
	"resource_metadata_url" text,
	"authorization_server_url" text,
	"scopes_supported" jsonb,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "company_mcp_oauth_clients" ADD CONSTRAINT "company_mcp_oauth_clients_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_mcp_oauth_clients" ADD CONSTRAINT "company_mcp_oauth_clients_mcp_server_id_company_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."company_mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_mcp_oauth_clients_mcp_server_uq" ON "company_mcp_oauth_clients" USING btree ("mcp_server_id");
