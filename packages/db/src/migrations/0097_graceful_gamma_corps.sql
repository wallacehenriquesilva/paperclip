ALTER TABLE "projects" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_company_default_idx" ON "projects" USING btree ("company_id") WHERE "projects"."is_default" = true;
