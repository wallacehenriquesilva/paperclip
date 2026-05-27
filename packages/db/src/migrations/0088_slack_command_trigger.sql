ALTER TABLE "routine_triggers" ADD COLUMN "allowed_commands" jsonb;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN "allowed_user_ids" jsonb;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN "allowed_channel_ids" jsonb;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN "ack_message" text;
