import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Pencil, Plus, X } from "lucide-react";

interface IssueMetadataPanelProps {
  metadata: Record<string, unknown> | null | undefined;
  onUpdate: (data: { metadata: Record<string, unknown> | null }) => void;
}

function isEmpty(value: Record<string, unknown> | null | undefined): boolean {
  return value == null || Object.keys(value).length === 0;
}

export function IssueMetadataPanel({ metadata, onUpdate }: IssueMetadataPanelProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(isEmpty(metadata) ? "{\n  \n}" : JSON.stringify(metadata, null, 2));
      setError(null);
    }
  }, [open, metadata]);

  const handleSave = () => {
    const trimmed = draft.trim();
    let parsed: Record<string, unknown> | null;
    if (trimmed.length === 0) {
      parsed = null;
    } else {
      try {
        const value = JSON.parse(trimmed);
        if (value === null) {
          parsed = null;
        } else if (typeof value !== "object" || Array.isArray(value)) {
          setError("Metadata must be a JSON object (e.g. { \"prUrl\": \"...\" }) or empty.");
          return;
        } else {
          parsed = value as Record<string, unknown>;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Invalid JSON");
        return;
      }
    }
    onUpdate({ metadata: parsed });
    setOpen(false);
  };

  const handleClear = () => {
    onUpdate({ metadata: null });
  };

  const empty = isEmpty(metadata);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between py-1.5">
        <span className="text-xs text-muted-foreground">Metadata</span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setOpen(true)}
          >
            {empty ? (
              <>
                <Plus className="h-3 w-3 mr-1" /> Add
              </>
            ) : (
              <>
                <Pencil className="h-3 w-3 mr-1" /> Edit
              </>
            )}
          </Button>
          {!empty && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              title="Clear metadata"
              onClick={handleClear}
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

      {!empty && (
        <pre className="rounded border border-border bg-muted/30 p-2 text-xs overflow-x-auto font-mono leading-snug max-h-48">
          {JSON.stringify(metadata, null, 2)}
        </pre>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit metadata</DialogTitle>
            <DialogDescription>
              Free-form JSON object attached to the issue. Used by scripts/adapters to read
              issue-specific config (e.g. <code>prUrl</code>, <code>engineerAgent</code>). Leave
              empty to clear.
            </DialogDescription>
          </DialogHeader>

          <textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            spellCheck={false}
            className="min-h-[240px] w-full rounded border border-border bg-background p-2 font-mono text-xs leading-snug focus:outline-none focus:ring-2 focus:ring-ring"
          />

          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" type="button">
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" onClick={handleSave}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
