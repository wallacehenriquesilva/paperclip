import { useQuery } from "@tanstack/react-query";
import type { IssueCostBreakdown, IssueCostBucket } from "@paperclipai/shared";
import { Coins } from "lucide-react";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { formatDurationMs, formatTokens } from "../lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const CURRENCY_FORMATTER = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

function formatUsd(costCents: number): string {
  return CURRENCY_FORMATTER.format(costCents / 100);
}

function bucketHasUsage(bucket: IssueCostBucket): boolean {
  return (
    bucket.costCents > 0
    || bucket.inputTokens > 0
    || bucket.cachedInputTokens > 0
    || bucket.outputTokens > 0
    || bucket.runCount > 0
  );
}

function BucketRow({ label, bucket }: { label: string; bucket: IssueCostBucket }) {
  const totalTokens = bucket.inputTokens + bucket.outputTokens;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between gap-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <span>{label}</span>
        {bucket.issueCount > 0 ? (
          <span>
            {bucket.issueCount} issue{bucket.issueCount === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs tabular-nums">
        <span className="font-semibold text-foreground">{formatUsd(bucket.costCents)}</span>
        <span className="text-muted-foreground">
          {formatTokens(totalTokens)} tokens
          {bucket.cachedInputTokens > 0
            ? ` (in ${formatTokens(bucket.inputTokens)}, out ${formatTokens(bucket.outputTokens)}, cached ${formatTokens(bucket.cachedInputTokens)})`
            : ` (in ${formatTokens(bucket.inputTokens)}, out ${formatTokens(bucket.outputTokens)})`}
        </span>
        {bucket.runCount > 0 ? (
          <span className="text-muted-foreground">
            {bucket.runCount} run{bucket.runCount === 1 ? "" : "s"}
            {bucket.runtimeMs > 0 ? ` · ${formatDurationMs(bucket.runtimeMs)}` : ""}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function IssueCostRollupBadge({ issueId }: { issueId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.issues.costBreakdown(issueId),
    queryFn: () => issuesApi.getCostBreakdown(issueId),
    staleTime: 30_000,
  });

  if (isLoading || !data) return null;

  const { total, self, subtree } = data;
  if (!bucketHasUsage(total)) return null;

  const totalTokens = total.inputTokens + total.outputTokens;
  const hasSubtree = bucketHasUsage(subtree);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300 shrink-0 hover:bg-emerald-500/20 transition-colors tabular-nums"
          title="Cost & tokens for this task and its sub-tasks"
        >
          <Coins className="h-3 w-3" />
          <span>{formatUsd(total.costCents)}</span>
          {totalTokens > 0 ? <span className="opacity-70">· {formatTokens(totalTokens)}</span> : null}
          {total.runCount > 0 ? (
            <span className="opacity-70">
              · {total.runCount} run{total.runCount === 1 ? "" : "s"}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3 space-y-3">
        <div className="text-xs font-semibold text-foreground">Cost &amp; tokens</div>
        <BucketRow label="This task" bucket={self} />
        {hasSubtree ? <BucketRow label="Sub-tasks" bucket={subtree} /> : null}
        <div className="border-t border-border pt-2">
          <BucketRow label="Total" bucket={total} />
        </div>
        <p className="text-[10px] text-muted-foreground leading-snug">
          Aggregated across all executions of this task and every descendant sub-task.
        </p>
      </PopoverContent>
    </Popover>
  );
}
