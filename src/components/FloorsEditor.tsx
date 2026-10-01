import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronUp, ChevronDown, X, Plus } from "lucide-react";
import { DEFAULT_FLOORS } from "@/components/RoomPicker";

/** A house's floor labels, in order - click chips instead of editing a
 * comma-separated string. Leads with quick-add pills for the common floor
 * names (minus whichever are already added), since picking "ground, 1, 2"
 * one click at a time is the common case; a free-text field for anything
 * else (attic, basement workshop, whatever) only shows up once asked for. */
export function FloorsEditor({ value, onChange }: { value: string[]; onChange: (floors: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const [addingCustom, setAddingCustom] = useState(false);

  const addFloor = (f: string) => {
    const t = f.trim();
    if (!t || value.includes(t)) return;
    onChange([...value, t]);
    setDraft("");
    setAddingCustom(false);
  };
  const removeFloor = (f: string) => onChange(value.filter((x) => x !== f));
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(next);
  };

  const remainingDefaults = DEFAULT_FLOORS.filter((f) => !value.includes(f));

  return (
    <div>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {value.map((f, i) => (
            <span
              key={f}
              className="inline-flex items-center gap-0.5 rounded-full border border-border bg-accent/60 pl-2 pr-1 py-0.5 text-[12px]"
            >
              {f}
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground disabled:opacity-20 ml-0.5"
                disabled={i === 0}
                onClick={() => move(i, -1)}
                title="Move up"
              >
                <ChevronUp className="h-3 w-3" />
              </button>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground disabled:opacity-20"
                disabled={i === value.length - 1}
                onClick={() => move(i, 1)}
                title="Move down"
              >
                <ChevronDown className="h-3 w-3" />
              </button>
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => removeFloor(f)}
                title="Remove floor"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1">
        {remainingDefaults.map((f) => (
          <button
            key={f}
            type="button"
            className="text-[11px] rounded-full border border-dashed border-border px-2 py-0.5 text-muted-foreground hover:border-primary hover:text-primary"
            onClick={() => addFloor(f)}
          >
            + {f}
          </button>
        ))}
        {!addingCustom && (
          <button
            type="button"
            className="text-[11px] rounded-full border border-dashed border-border px-2 py-0.5 text-muted-foreground hover:border-primary hover:text-primary"
            onClick={() => setAddingCustom(true)}
          >
            + Custom…
          </button>
        )}
      </div>

      {addingCustom && (
        <div className="flex gap-1.5 mt-1.5">
          <input
            className="flex-1 rounded-md border border-input bg-white px-2 py-1 text-[12px]"
            placeholder="Floor name, e.g. attic"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addFloor(draft);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setAddingCustom(false);
                setDraft("");
              }
            }}
            onBlur={() => {
              if (!draft.trim()) setAddingCustom(false);
            }}
          />
          <Button type="button" size="sm" variant="outline" className="h-7 text-[12px] shrink-0" onClick={() => addFloor(draft)}>
            <Plus className="h-3 w-3 mr-1" /> Add
          </Button>
        </div>
      )}
    </div>
  );
}
