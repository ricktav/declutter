import { useAiProgress } from "@/hooks/use-ai-progress";

/** Shown under/beside a pending AI call: elapsed time, and once we've timed
 * this kind of call before, a remembered typical duration so the wait has a
 * sense of scale instead of being an indefinite spinner. */
export function AiProgressBar({ active, action }: { active: boolean; action: string }) {
  const { elapsedMs, typicalMs, pct } = useAiProgress(active, action);
  if (!active) return null;
  return (
    <div className="mt-1.5 w-full max-w-[220px]">
      <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={
            pct == null
              ? "h-full w-full bg-violet-400 rounded-full animate-pulse"
              : "h-full bg-violet-500 rounded-full transition-[width] duration-150"
          }
          style={pct == null ? undefined : { width: `${pct}%` }}
        />
      </div>
      <div className="mt-0.5 font-data text-[10px] text-muted-foreground">
        {(elapsedMs / 1000).toFixed(1)}s{typicalMs ? ` (usually ~${Math.round(typicalMs / 1000)}s)` : ""}
      </div>
    </div>
  );
}
