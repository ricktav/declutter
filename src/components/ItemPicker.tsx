import { useEffect, useRef, useState } from "react";
import { trpc } from "@/providers/trpc";
import { Search } from "lucide-react";

interface Props {
  onSelect: (item: { id: number; name: string }) => void;
  placeholder?: string;
  excludeId?: number;
}

export function ItemPicker({ onSelect, placeholder = "Search items…", excludeId }: Props) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const results = trpc.items.search.useQuery({ q }, { enabled: q.length > 0 });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

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
        />
      </div>
      {open && q && (
        <div className="absolute z-30 mt-1 w-full rounded-md border border-border bg-white shadow-md max-h-48 overflow-y-auto">
          {(results.data ?? []).filter((r) => r.id !== excludeId).length === 0 && (
            <div className="px-3 py-2 text-[12px] text-muted-foreground">No matches</div>
          )}
          {(results.data ?? [])
            .filter((r) => r.id !== excludeId)
            .map((r) => (
              <button
                key={r.id}
                className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-accent"
                onClick={() => {
                  onSelect(r);
                  setQ("");
                  setOpen(false);
                }}
              >
                {r.name}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
