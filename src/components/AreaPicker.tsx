import { useEffect, useRef, useState } from "react";
import { trpc } from "@/providers/trpc";
import { Check, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

/** Combobox for picking an area or typing a brand-new one inline. */
export function AreaPicker({
  value,
  onChange,
  placeholder = "pick a topic or type a new one…",
}: {
  value: number | null;
  onChange: (id: number) => void;
  placeholder?: string;
}) {
  const areas = trpc.areas.list.useQuery();
  const utils = trpc.useUtils();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const createArea = trpc.areas.create.useMutation({
    onSuccess: (area) => {
      if (!area) return;
      utils.areas.list.invalidate();
      setText(area.name);
      setOpen(false);
      onChange(area.id);
    },
  });

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // reflect the chosen area into the input when not editing
  useEffect(() => {
    if (open) return;
    const chosen = (areas.data ?? []).find((a) => a.id === value);
    setText(chosen ? chosen.name : "");
  }, [value, areas.data, open]);

  const all = areas.data ?? [];
  const q = text.trim().toLowerCase();
  const matches = (q ? all.filter((a) => a.name.toLowerCase().includes(q)) : all).slice(0, 8);
  const exact = q.length > 0 && all.some((a) => a.name.toLowerCase() === q);
  const showCreateRow = q.length > 0 && !exact;
  const rowCount = matches.length + (showCreateRow ? 1 : 0);

  useEffect(() => setHighlight(0), [q, matches.length]);

  const create = () => {
    const name = text.trim();
    if (!name || createArea.isPending) return;
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || `area-${Date.now()}`;
    createArea.mutate({ name, slug, icon: "box", color: "#5b8c5a" });
  };

  const selectAt = (i: number) => {
    if (i < matches.length) {
      onChange(matches[i].id);
      setText(matches[i].name);
      setOpen(false);
    } else if (showCreateRow) {
      create();
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <input
        className="w-full rounded-md border border-input bg-white px-2 py-1.5 text-[13px]"
        placeholder={placeholder}
        value={text}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (!open || rowCount === 0) {
            if (e.key === "Escape") setOpen(false);
            return;
          }
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
      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-border bg-white shadow-lg max-h-64 overflow-auto">
          {matches.map((a, i) => (
            <button
              key={a.id}
              type="button"
              className={cn(
                "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px]",
                i === highlight ? "bg-accent" : "hover:bg-accent",
              )}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => selectAt(i)}
            >
              <span className="h-2 w-2 rounded-sm shrink-0" style={{ background: a.color }} />
              <span className="flex-1 truncate">{a.name}</span>
              {a.id === value && <Check className="h-3.5 w-3.5 text-primary" />}
            </button>
          ))}
          {matches.length === 0 && !q && (
            <div className="px-2.5 py-1.5 text-[12px] text-muted-foreground">No topics yet.</div>
          )}
          {showCreateRow && (
            <button
              type="button"
              className={cn(
                "flex w-full items-center gap-2 border-t border-border px-2.5 py-1.5 text-left text-[13px] font-medium text-primary",
                highlight === matches.length ? "bg-accent" : "hover:bg-accent",
              )}
              onMouseEnter={() => setHighlight(matches.length)}
              onClick={() => selectAt(matches.length)}
              disabled={createArea.isPending}
            >
              <Plus className="h-3.5 w-3.5" />
              {createArea.isPending ? "Creating…" : `Create topic “${text.trim()}” (Enter)`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
