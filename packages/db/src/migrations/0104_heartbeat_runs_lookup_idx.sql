-- Latest-run-per-issue and runs-per-session lookups on heartbeat_runs (the
-- largest table in production, ~10 GB). Without created_at in the key the
-- recovery job and issue run lists read every run of the issue/session and sort.
--
-- Plain CREATE INDEX because Drizzle runs each migration inside a transaction,
-- where CREATE INDEX CONCURRENTLY is illegal. On a large instance build them
-- out-of-band FIRST with CREATE INDEX CONCURRENTLY IF NOT EXISTS (same
-- definitions); this migration then becomes a no-op thanks to IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_issue_created_idx" ON "heartbeat_runs" USING btree ("company_id",(("context_snapshot" ->> 'issueId')),"created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE ("heartbeat_runs"."context_snapshot" ->> 'issueId') is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_agent_session_after_created_idx" ON "heartbeat_runs" USING btree ("agent_id","session_id_after","created_at" DESC NULLS LAST) WHERE "heartbeat_runs"."session_id_after" is not null;
