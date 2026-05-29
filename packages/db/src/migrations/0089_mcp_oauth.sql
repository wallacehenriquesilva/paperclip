ALTER TABLE "company_mcp_servers" ADD COLUMN "url" text;--> statement-breakpoint
ALTER TABLE "company_mcp_servers" ADD COLUMN "oauth_config" jsonb;--> statement-breakpoint
ALTER TABLE "company_mcp_servers" ALTER COLUMN "command" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "company_mcp_servers" ALTER COLUMN "command" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "company_mcp_servers" ALTER COLUMN "command" SET NOT NULL;--> statement-breakpoint
CREATE TABLE "company_mcp_oauth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"state" text NOT NULL,
	"code_verifier" text NOT NULL,
	"initiated_by_user_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
ALTER TABLE "company_mcp_oauth_sessions" ADD CONSTRAINT "company_mcp_oauth_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_mcp_oauth_sessions" ADD CONSTRAINT "company_mcp_oauth_sessions_mcp_server_id_company_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."company_mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_mcp_oauth_sessions_state_idx" ON "company_mcp_oauth_sessions" USING btree ("state");--> statement-breakpoint
CREATE INDEX "company_mcp_oauth_sessions_mcp_server_idx" ON "company_mcp_oauth_sessions" USING btree ("mcp_server_id");--> statement-breakpoint
CREATE INDEX "company_mcp_oauth_sessions_expires_idx" ON "company_mcp_oauth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE TABLE "company_mcp_oauth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"access_token_ciphertext" text NOT NULL,
	"refresh_token_ciphertext" text,
	"token_type" text DEFAULT 'Bearer' NOT NULL,
	"scope" text,
	"expires_at" timestamp with time zone,
	"last_refreshed_at" timestamp with time zone,
	"refresh_failure_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "company_mcp_oauth_tokens" ADD CONSTRAINT "company_mcp_oauth_tokens_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_mcp_oauth_tokens" ADD CONSTRAINT "company_mcp_oauth_tokens_mcp_server_id_company_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."company_mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_mcp_oauth_tokens_mcp_server_uq" ON "company_mcp_oauth_tokens" USING btree ("mcp_server_id");
