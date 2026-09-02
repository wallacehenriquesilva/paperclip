DROP INDEX "activity_log_entity_type_id_idx";--> statement-breakpoint
CREATE INDEX "activity_log_entity_type_id_idx" ON "activity_log" USING btree ("entity_type","entity_id","agent_id");