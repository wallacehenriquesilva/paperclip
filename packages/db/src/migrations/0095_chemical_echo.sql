ALTER TABLE "issues" ADD COLUMN "source_slug" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "source_slug" text;--> statement-breakpoint
CREATE UNIQUE INDEX "issues_company_source_slug_uq" ON "issues" USING btree ("company_id","source_slug") WHERE "issues"."source_slug" is not null and "issues"."hidden_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "routines_company_source_slug_uq" ON "routines" USING btree ("company_id","source_slug") WHERE "routines"."source_slug" is not null;