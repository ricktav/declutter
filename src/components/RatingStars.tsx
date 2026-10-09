import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

/** 1–5 star control. Writes the Systems `rating` attribute. */
export function RatingStars({
  value,
  onChange,
  disabled,
  dark,
}: {
  value: number;
  onChange: (n: 1 | 2 | 3 | 4 | 5) => void;
  disabled?: boolean;
  dark?: boolean;
}) {
  const n = Math.min(5, Math.max(0, Math.round(value)));
  return (
    <div className="inline-flex items-center gap-0.5" role="group" aria-label="Rating">
      {([1, 2, 3, 4, 5] as const).map((i) => (
        <button
          key={i}
          type="button"
          disabled={disabled}
          title={`${i} star${i === 1 ? "" : "s"}`}
          aria-label={`${i} star${i === 1 ? "" : "s"}`}
          aria-pressed={i <= n}
          onClick={() => onChange(i)}
          className={cn(
            "p-0.5 rounded disabled:opacity-50",
            dark ? "hover:bg-white/10" : "hover:bg-muted",
          )}
        >
          <Star
            className={cn("h-4 w-4", i <= n ? (dark ? "text-[#ff6b35]" : "text-amber-500") : dark ? "text-[#444]" : "text-muted-foreground/40")}
            fill={i <= n ? "currentColor" : "none"}
          />
        </button>
      ))}
    </div>
  );
}
