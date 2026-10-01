import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronUp, ChevronDown, X, Plus, Layers } from "lucide-react";
import { DEFAULT_FLOORS } from "@/components/RoomPicker";

/**
 * A house's floor labels, in order - click chips instead of editing a
 * comma-separated string.
 *
 * `null` means "not customized yet" - RoomPicker falls back to the generic
 * default list elsewhere in the app. An explicit empty array means "this
 * building has no floors" - RoomPicker hides the floor field entirely for
 * it instead of making every item pick a meaningless one. Removing every
 * chip naturally lands you in that second state, which is the point: a
 * single-level house ends up with no floors by simply having none added.
 */
export function FloorsEditor({
  value,
  onChange,
}: {
  value: string[] | null;
  onChange: (floors: string[] | null) => void;
}) {
  const [draft, setDraft] = useState("");
  const [addingCustom, setAddingCustom] = useState(false);

  const floors = value ?? [];
  const noFloors = value !== null && value.length === 0;

  const addFloor = (f: string) => {
    const t = f.trim();
    if (!t || floors.includes(t)) return;
    onChange([...floors, t]);
    setDraft("");
    setAddingCustom(false);
  };
  const removeFloor = (f: string) => onChange(floors.filter((x) => x !== f));
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= floors.length) return;
    const next = [...floors];
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(next);
  };

  const remainingDefaults = DEFAULT_FLOORS.filter((f) => !floors.includes(f));

  return (
    <div>
      {floors.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {floors.map((f, i) => (
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
                disabled={i === floors.length - 1}
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

      {noFloors && (
        <div className="flex items-center gap-1.5 mb-1.5 text-[12px] text-muted-foreground">
          <Layers className="h-3.5 w-3.5" />
          No floors — items here won't ask for one.
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
