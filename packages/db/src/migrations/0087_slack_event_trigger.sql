ALTER TABLE "routine_triggers" ADD COLUMN "allowed_event_types" jsonb;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN "bot_user_id" text;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN "team_id" text;
