import { useEffect, useRef, useState } from "react";
import { trpc } from "@/providers/trpc";
import { Search, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  onSelect: (item: { id: number; name: string }) => void;
  placeholder?: string;
  excludeId?: number;
  /** Controlled mode: pass both, or neither to let the component manage its own text. */
  value?: string;
  onQueryChange?: (q: string) => void;
  /** Show a "+ Create '<query>'" row when nothing matches, for a search-or-create field. */
  allowCreate?: boolean;
  onCreateNew?: (name: string) => void;
  autoFocus?: boolean;
}

export function ItemPicker({
  onSelect,
  placeholder = "Search items…",
  excludeId,
  value,
  onQueryChange,
  allowCreate = false,
  onCreateNew,
  autoFocus,
}: Props) {
  const [internalQ, setInternalQ] = useState("");
  const q = value ?? internalQ;
  const setQ = (v: string) => {
    if (onQueryChange) onQueryChange(v);
    else setInternalQ(v);
  };
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const results = trpc.items.search.useQuery({ q }, { enabled: q.length > 0 });
  const matches = (results.data ?? []).filter((r) => r.id !== excludeId);
  const showCreateRow = allowCreate && q.trim().length > 0 && matches.length === 0 && !results.isLoading;
  const rowCount = matches.length + (showCreateRow ? 1 : 0);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => setHighlight(0), [q, matches.length]);

  const selectAt = (i: number) => {
    if (i < matches.length) {
      onSelect(matches[i]);
      setQ("");
    } else if (showCreateRow) {
      onCreateNew?.(q.trim());
    }
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <div className="flex items-center gap-1.5 border border-input rounded-md px-2 bg-white">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <input
          className="flex-1 py-1.5 text-[13px] bg-transparent outline-none"
          value={q}
          placeholder={placeholder}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          autoFocus={autoFocus}
          onKeyDown={(e) => {
            if (!open || rowCount === 0) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => (h + 1) % rowCount);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => (h - 1 + rowCount) % rowCount);
            } else if (e.key === "Enter") {
              e.preventDefault();
              selectAt(highlight);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
        />
      </div>
      {open && q && (
        <div className="absolute z-30 mt-1 w-full rounded-md border border-border bg-white shadow-md max-h-48 overflow-y-auto">
          {matches.length === 0 && !showCreateRow && (
            <div className="px-3 py-2 text-[12px] text-muted-foreground">No matches</div>
          )}
          {matches.map((r, i) => (
            <button
              key={r.id}
              className={cn("w-full text-left px-3 py-1.5 text-[13px]", i === highlight ? "bg-accent" : "hover:bg-accent")}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => selectAt(i)}
            >
              {r.name}
            </button>
          ))}
          {showCreateRow && (
            <button
              className={cn(
                "w-full flex items-center gap-1.5 text-left px-3 py-1.5 text-[13px] text-primary",
                highlight === matches.length ? "bg-accent" : "hover:bg-accent",
              )}
              onMouseEnter={() => setHighlight(matches.length)}
              onClick={() => selectAt(matches.length)}
            >
              <Plus className="h-3.5 w-3.5" /> Create "{q.trim()}"
            </button>
          )}
        </div>
      )}
    </div>
  );
}
