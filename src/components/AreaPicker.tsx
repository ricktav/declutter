import { useEffect, useRef, useState } from "react";
import { trpc } from "@/providers/trpc";
import { Check, Plus } from "lucide-react";

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
          if (e.key === "Enter") {
            e.preventDefault();
            if (matches.length > 0 && q) {
              // if the typed text exactly matches nothing, Enter creates; otherwise pick first match
              if (!exact && matches[0].name.toLowerCase() !== q) {
                create();
              } else {
                onChange(matches[0].id);
                setOpen(false);
              }
            } else if (q) {
              create();
            }
          }
          if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-border bg-white shadow-lg max-h-64 overflow-auto">
          {matches.map((a) => (
            <button
              key={a.id}
              type="button"
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-accent"
              onClick={() => {
                onChange(a.id);
                setText(a.name);
                setOpen(false);
              }}
            >
              <span className="h-2 w-2 rounded-sm shrink-0" style={{ background: a.color }} />
              <span className="flex-1 truncate">{a.name}</span>
              {a.id === value && <Check className="h-3.5 w-3.5 text-primary" />}
            </button>
          ))}
          {matches.length === 0 && !q && (
            <div className="px-2.5 py-1.5 text-[12px] text-muted-foreground">No topics yet.</div>
          )}
          {q && !exact && (
            <button
              type="button"
              className="flex w-full items-center gap-2 border-t border-border px-2.5 py-1.5 text-left text-[13px] font-medium text-primary hover:bg-accent"
              onClick={create}
              disabled={createArea.isPending}
            >
              <Plus className="h-3.5 w-3.5" />
              {createArea.isPending ? "Creating…" : `Create topic “${text.trim()}”`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
