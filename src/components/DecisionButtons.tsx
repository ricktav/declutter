import type { ItemDecision } from "@db/schema";
import { DECISIONS } from "@/lib/decisions";
import { cn } from "@/lib/utils";

export function DecisionButtons({
  value,
  onChange,
  disabled,
}: {
  value: ItemDecision | null;
  onChange: (d: ItemDecision | null) => void;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label="Decision" className="inline-flex flex-wrap gap-1.5">
      {DECISIONS.map((d) => {
        const active = value === d.key;
        return (
          <button
            key={d.key}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(active ? null : d.key)}
            className={cn(
              "h-7 rounded-md border px-2.5 text-[12px] font-medium transition-colors disabled:opacity-50",
              active ? "text-white" : "bg-white hover:bg-muted",
            )}
            style={active ? { backgroundColor: d.color, borderColor: d.color } : { color: d.color, borderColor: d.color }}
          >
            {d.label}
          </button>
        );
      })}
    </div>
  );
}
