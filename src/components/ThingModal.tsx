import { Link } from "react-router";
import { typeLabel, ancestorsOf } from "@db/taxonomy";
import { trpc } from "@/providers/trpc";
import { DECISIONS } from "@/lib/decisions";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NEUTRAL_PIN_COLOR, pinTitle, type SchemaPin } from "@/lib/schemaFilter";

const DETAIL_LABELS: Array<[string, string, string?]> = [
  ["hostname", "Hostname"],
  ["ip", "IP"],
  ["os", "OS"],
  ["cpu", "CPU"],
  ["ram_gb", "RAM", " GB"],
  ["storage_gb", "Storage", " GB"],
];

type ItemPhoto = { id: number; storageKey: string; cropBox: unknown; shared: boolean };

/** The Thing's cover as the API picks it: the newest own cutout, else its first own Photo, else a shared one. */
function coverKey(photos: ItemPhoto[] | undefined): string | null {
  if (!photos?.length) return null;
  const own = photos.filter((p) => !p.shared).sort((a, b) => a.id - b.id);
  const cutouts = own.filter((p) => p.cropBox);
  return (cutouts.at(-1) ?? own[0] ?? photos[0]).storageKey;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** Details of the Thing behind a schematic block, with links to its page and to Annotate. */
export function ThingModal({ pin, onClose }: { pin: SchemaPin | null; onClose: () => void }) {
  const item = pin?.item ?? null;
  const full = trpc.items.get.useQuery({ id: item?.id ?? 0 }, { enabled: item != null });
  const key = coverKey(full.data?.photos as ItemPhoto[] | undefined);
  const cover = trpc.photos.url.useQuery({ key: key ?? "" }, { enabled: key != null });
  const type = item?.type ?? null;
  const typeLine = type ? [type, ...ancestorsOf(type)].map(typeLabel).join(" › ") : null;
  const decision = item?.decision ? (DECISIONS.find((d) => d.key === item.decision) ?? null) : null;
  const attrs = (item?.attributes ?? {}) as Record<string, string | number | undefined>;

  return (
    <Dialog open={pin != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="thing-modal">
        {pin && (
          <>
            <DialogHeader>
              <DialogTitle className="break-words pr-6">{pinTitle(pin)}</DialogTitle>
              <DialogDescription>
                {item ? (typeLine ?? "No Type yet") : "This pin has no Thing yet."}
              </DialogDescription>
            </DialogHeader>
            <div className="flex gap-3">
              {item && (
                <div className="h-24 w-24 shrink-0 overflow-hidden rounded bg-muted">
                  {cover.data?.url && <img src={cover.data.url} alt="" className="h-full w-full object-cover" />}
                </div>
              )}
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px] min-w-0">
                {item && (
                  <>
                    {full.data?.area && (
                      <Row label="Topic">
                        <span className="inline-flex items-center gap-1">
                          <span className="h-2 w-2 rounded-full" style={{ background: full.data.area.color ?? NEUTRAL_PIN_COLOR }} />
                          {full.data.area.name}
                        </span>
                      </Row>
                    )}
                    {item.role && <Row label="Role">{item.role}</Row>}
                    {item.tags.length > 0 && <Row label="Tags">{item.tags.join(", ")}</Row>}
                    <Row label="Decision">
                      {decision ? <span style={{ color: decision.color }}>{decision.label}</span> : "None yet"}
                    </Row>
                    <Row label="Verification">{item.verificationStatus}</Row>
                    {DETAIL_LABELS.map(([k, label, unit]) =>
                      attrs[k] != null && attrs[k] !== "" ? (
                        <Row key={k} label={label}>
                          {String(attrs[k])}
                          {unit ?? ""}
                        </Row>
                      ) : null,
                    )}
                  </>
                )}
                {pin.flagged && <Row label="Flagged">yes</Row>}
                {pin.status === "suggested" && <Row label="Pin">suggested</Row>}
                <Row label="Photo">{pin.photoTitle || `#${pin.photoId}`}</Row>
              </dl>
            </div>
            <div className="flex flex-wrap gap-2 text-[13px]">
              {item && (
                <Link to={`/items/${item.id}`} className="rounded border border-border px-2.5 py-1 hover:bg-muted" data-testid="open-thing">
                  Open Thing
                </Link>
              )}
              <Link to={item ? `/annotate/${pin.photoId}?itemId=${item.id}` : `/annotate/${pin.photoId}`} className="rounded border border-border px-2.5 py-1 hover:bg-muted" data-testid="open-annotate">
                Open in Annotate
              </Link>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
