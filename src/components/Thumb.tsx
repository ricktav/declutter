import { trpc } from "@/providers/trpc";
import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";

/** Small square thumbnail from an item's first image attachment. Falls back to a placeholder. */
export function Thumb({ storageKey, size = "sm" }: { storageKey: string | null; size?: "sm" | "lg" }) {
  const dim = size === "sm" ? "h-9 w-9" : "aspect-square w-full";
  const url = trpc.attachments.url.useQuery(
    { key: storageKey ?? "" },
    { enabled: !!storageKey },
  );
  if (!storageKey || (!url.isLoading && !url.data?.url)) {
    return (
      <div className={cn(dim, "flex items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground")}>
        <ImageOff className={size === "sm" ? "h-3.5 w-3.5" : "h-6 w-6"} />
      </div>
    );
  }
  return (
    <div className={cn(dim, "overflow-hidden rounded-md border border-border bg-muted/40")}>
      {url.data?.url && (
        <img src={url.data.url} alt="" className="h-full w-full object-cover" />
      )}
    </div>
  );
}
