import { useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { ItemPicker } from "@/components/ItemPicker";
import { AreaPicker } from "@/components/AreaPicker";
import {
  Sparkles,
  Loader2,
  AlertTriangle,
  Check,
  X,
  Plus,
  ArrowLeft,
  MapPin,
} from "lucide-react";

type Pin = {
  id: number;
  xPct: number;
  yPct: number;
  wPct: number | null;
  hPct: number | null;
  label: string;
  itemId: number | null;
  itemName: string | null;
  origin: "user" | "ai";
  status: "suggested" | "confirmed";
};

export default function AnnotatePage() {
  const { attachmentId } = useParams<{ attachmentId: string }>();
  const attId = Number(attachmentId);
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const imgRef = useRef<HTMLImageElement>(null);

  const pinsQuery = trpc.annotations.listForAttachment.useQuery({ attachmentId: attId });
  const urlQuery = trpc.attachments.urlForAttachment.useQuery({ attachmentId: attId });
  const areas = trpc.areas.list.useQuery();

  const [pending, setPending] = useState<{ xPct: number; yPct: number } | null>(null);
  const [pendingLabel, setPendingLabel] = useState("");
  const [pendingItem, setPendingItem] = useState<{ id: number; name: string } | null>(null);
  const [newItemArea, setNewItemArea] = useState<number | "">("");
  const [aiError, setAiError] = useState<string | null>(null);
  const [detectInfo, setDetectInfo] = useState<string | null>(null);

  const invalidate = () => utils.annotations.listForAttachment.invalidate({ attachmentId: attId });

  const addPin = trpc.annotations.add.useMutation({ onSuccess: invalidate });
  const resolve = trpc.annotations.resolve.useMutation({
    onSuccess: () => {
      invalidate();
      utils.events.list.invalidate();
    },
  });
  const removePin = trpc.annotations.remove.useMutation({ onSuccess: invalidate });
  const createItem = trpc.items.create.useMutation();
  const detect = trpc.annotations.detect.useMutation({
    onSuccess: (res) => {
      if (res.ok) {
        setAiError(null);
        setDetectInfo(
          res.created === 0
            ? "No objects detected."
            : `Detected ${res.created} object${res.created === 1 ? "" : "s"} — ${res.matched} matched your inventory.`,
        );
        invalidate();
      } else setAiError(res.error);
    },
    onError: (e) => setAiError(e.message),
  });

  useEffect(() => {
    if (areas.data?.length && newItemArea === "") {
      setNewItemArea(areas.data[0].id);
    }
  }, [areas.data, newItemArea]);

  const onImageClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const rect = imgRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPending({
      xPct: ((e.clientX - rect.left) / rect.width) * 100,
      yPct: ((e.clientY - rect.top) / rect.height) * 100,
    });
    setPendingLabel("");
    setPendingItem(null);
  };

  const savePending = async () => {
    if (!pending) return;
    let itemId = pendingItem?.id;
    if (!itemId && pendingLabel.trim() && newItemArea !== "") {
      const res = await createItem.mutateAsync({
        areaId: Number(newItemArea),
        name: pendingLabel.trim(),
      });
      itemId = res.id;
      utils.items.listByArea.invalidate();
      utils.areas.list.invalidate();
    }
    await addPin.mutateAsync({
      attachmentId: attId,
      xPct: pending.xPct,
      yPct: pending.yPct,
      label: pendingLabel.trim() || pendingItem?.name || "",
      itemId,
    });
    setPending(null);
  };

  const pins: Pin[] = pinsQuery.data ?? [];
  const confirmed = pins.filter((p) => p.status === "confirmed");
  const suggested = pins.filter((p) => p.status === "suggested");

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center gap-3">
        <Button size="sm" variant="ghost" className="h-8" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <h1 className="text-xl font-semibold tracking-tight">Annotate photo</h1>
        <span className="text-[12px] text-muted-foreground">
          click the photo to pin an object · link it to your inventory or create it on the spot
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-[12px] ml-auto border-violet-300 text-violet-700"
          disabled={detect.isPending}
          onClick={() => {
            setAiError(null);
            setDetectInfo(null);
            detect.mutate({ attachmentId: attId });
          }}
        >
          {detect.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
          ) : (
            <Sparkles className="h-3.5 w-3.5 mr-1" />
          )}
          AI detect objects
        </Button>
      </div>

      {aiError && (
        <div className="mt-3 flex gap-2 items-start rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {aiError}
        </div>
      )}
      {detectInfo && (
        <div className="mt-3 rounded-md border border-violet-300 bg-violet-50 px-3 py-2 text-[12px] text-violet-900">
          {detectInfo} Confirm or reject each suggested pin below.
        </div>
      )}

      <div className="flex gap-6 mt-4 items-start">
        {/* photo + pins */}
        <div className="flex-1 min-w-0 rounded-lg border border-border bg-white p-2">
          {urlQuery.data?.url ? (
            <div className="relative select-none">
              <img
                ref={imgRef}
                src={urlQuery.data.url}
                alt="annotate"
                className="w-full rounded cursor-crosshair"
                onClick={onImageClick}
                draggable={false}
              />
              <svg
                className="absolute inset-0 h-full w-full pointer-events-none"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
              >
                {pins
                  .filter((p) => p.wPct != null && p.hPct != null)
                  .map((p) => (
                    <rect
                      key={p.id}
                      x={p.xPct - (p.wPct ?? 0) / 2}
                      y={p.yPct - (p.hPct ?? 0) / 2}
                      width={p.wPct ?? 0}
                      height={p.hPct ?? 0}
                      rx={1.5}
                      vectorEffect="non-scaling-stroke"
                      strokeWidth={2}
                      fill={
                        p.status === "suggested"
                          ? "rgba(124,58,237,0.10)"
                          : p.itemId
                            ? "rgba(210,255,0,0.12)"
                            : "rgba(40,44,32,0.10)"
                      }
                      stroke={
                        p.status === "suggested"
                          ? "#7c3aed"
                          : p.itemId
                            ? "#2d4a22"
                            : "#282c20"
                      }
                      strokeDasharray={p.status === "suggested" ? "4 2" : undefined}
                    />
                  ))}
              </svg>
              {pins.map((p, i) => (
                <div
                  key={p.id}
                  className="absolute -translate-x-1/2 -translate-y-1/2 group"
                  style={{ left: `${p.xPct}%`, top: `${p.yPct}%` }}
                >
                  <div
                    className={`flex items-center justify-center h-6 w-6 rounded-full border-2 text-[10px] font-data shadow ${
                      p.status === "suggested"
                        ? "border-violet-500 bg-violet-500/80 text-white border-dashed"
                        : p.itemId
                          ? "border-[#2d4a22] bg-[#d2ff00] text-[#282c20]"
                          : "border-white bg-[#282c20] text-white"
                    }`}
                  >
                    {i + 1}
                  </div>
                  <div className="absolute left-1/2 -translate-x-1/2 top-7 whitespace-nowrap rounded bg-black/80 text-white text-[10px] px-1.5 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                    {p.label || p.itemName || "untitled"}
                    {p.itemName && p.label && p.itemName !== p.label ? ` → ${p.itemName}` : ""}
                  </div>
                </div>
              ))}
              {pending && (
                <div
                  className="absolute -translate-x-1/2 -translate-y-1/2"
                  style={{ left: `${pending.xPct}%`, top: `${pending.yPct}%` }}
                >
                  <MapPin className="h-6 w-6 text-primary animate-bounce" />
                </div>
              )}
            </div>
          ) : (
            <div className="py-20 text-center text-sm text-muted-foreground">
              {urlQuery.isLoading ? "Loading photo…" : "Photo unavailable (storage not provisioned?)"}
            </div>
          )}
        </div>

        {/* side panel */}
        <aside className="w-80 shrink-0 space-y-4">
          {pending && (
            <div className="rounded-lg border border-primary bg-white p-3 space-y-2">
              <div className="micro-label text-primary">New pin</div>
              <input
                className="w-full rounded-md border border-input px-2 py-1.5 text-[13px]"
                placeholder="Label — e.g. 'USB-C dock'"
                value={pendingLabel}
                onChange={(e) => setPendingLabel(e.target.value)}
                autoFocus
              />
              <ItemPicker placeholder="link existing item…" onSelect={setPendingItem} />
              {pendingItem && (
                <div className="text-[12px] rounded bg-accent px-2 py-1 flex items-center gap-1">
                  linked: <b>{pendingItem.name}</b>
                  <button className="ml-auto" onClick={() => setPendingItem(null)}>
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )}
              {!pendingItem && pendingLabel.trim() && (
                <div className="space-y-1 text-[12px]">
                  <span className="text-muted-foreground">create as new item in</span>
                  <AreaPicker
                    value={newItemArea === "" ? null : newItemArea}
                    onChange={(id) => setNewItemArea(id)}
                  />
                </div>
              )}
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="ghost" className="h-7 text-[12px]" onClick={() => setPending(null)}>
                  Cancel
                </Button>
                <Button size="sm" className="h-7 text-[12px]" onClick={savePending}
                  disabled={addPin.isPending || createItem.isPending}>
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add pin
                </Button>
              </div>
            </div>
          )}

          {suggested.length > 0 && (
            <div className="rounded-lg border border-violet-300 bg-violet-50/60 p-3 space-y-2">
              <div className="micro-label text-violet-700">AI suggestions ({suggested.length})</div>
              {suggested.map((p) => (
                <SuggestedPinRow key={p.id} pin={p}
                  onResolve={(label, itemId) => resolve.mutate({ id: p.id, confirm: true, label, itemId })}
                  onReject={() => resolve.mutate({ id: p.id, confirm: false })} />
              ))}
            </div>
          )}

          <div className="rounded-lg border border-border bg-white p-3">
            <div className="micro-label text-muted-foreground mb-2">Pins ({confirmed.length})</div>
            {confirmed.length === 0 && (
              <div className="text-[12px] text-muted-foreground">
                None yet — click the photo to pin by hand, or run AI detection (boxes + pins for up to 15 objects).
              </div>
            )}
            <div className="space-y-1.5">
              {confirmed.map((p, i) => (
                <div key={p.id} className="flex items-center gap-2 text-[13px] group">
                  <span className="font-data text-[11px] text-muted-foreground w-5">{i + 1}.</span>
                  <span className="flex-1 min-w-0 truncate">
                    {p.label || <span className="text-muted-foreground">untitled</span>}
                  </span>
                  {p.itemId && p.itemName ? (
                    <Link to={`/items/${p.itemId}`} className="text-[11px] text-primary hover:underline truncate max-w-24">
                      {p.itemName}
                    </Link>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">unlinked</span>
                  )}
                  <button className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                    onClick={() => removePin.mutate({ id: p.id })}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function SuggestedPinRow({
  pin,
  onResolve,
  onReject,
}: {
  pin: Pin;
  onResolve: (label: string, itemId: number | null) => void;
  onReject: () => void;
}) {
  const [label, setLabel] = useState(pin.label);
  const [item, setItem] = useState<{ id: number; name: string } | null>(
    pin.itemId && pin.itemName ? { id: pin.itemId, name: pin.itemName } : null,
  );
  return (
    <div className="rounded border border-violet-200 bg-white p-2 space-y-1.5">
      <input
        className="w-full rounded border border-input px-2 py-1 text-[12px]"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <div className="flex items-center gap-1.5">
        <div className="flex-1 min-w-0">
          <ItemPicker
            placeholder={item ? item.name : "link item…"}
            onSelect={setItem}
          />
        </div>
        {item && (
          <button onClick={() => setItem(null)} className="text-muted-foreground shrink-0">
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="ghost" className="h-6 text-[11px] px-2" onClick={onReject}>
          <X className="h-3 w-3 mr-0.5" /> reject
        </Button>
        <Button size="sm" className="h-6 text-[11px] px-2" onClick={() => onResolve(label, item?.id ?? null)}>
          <Check className="h-3 w-3 mr-0.5" /> confirm
        </Button>
      </div>
    </div>
  );
}
