import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RoomPlan2D } from "@/components/RoomPlan2D";
import { cn } from "@/lib/utils";

function hasPlan(r: { widthM: number | null; depthM: number | null } | null | undefined) {
  return r != null && (r.widthM ?? 0) > 0 && (r.depthM ?? 0) > 0;
}
function hasWalls(r: { walls: unknown } | null | undefined) {
  return r != null && r.walls != null;
}

/** Confirm merging one room into another; pick which floorplan / 3D scan stays when both have one. */
export function MergeRoomsDialog({
  open,
  fromId,
  toId,
  onClose,
  onMerged,
}: {
  open: boolean;
  fromId: number | null;
  toId: number | null;
  onClose: () => void;
  onMerged?: () => void;
}) {
  const enabled = open && fromId != null && toId != null;
  const fromQ = trpc.rooms.get.useQuery({ id: fromId ?? 0 }, { enabled: enabled && fromId != null });
  const toQ = trpc.rooms.get.useQuery({ id: toId ?? 0 }, { enabled: enabled && toId != null });
  const from = fromQ.data;
  const to = toQ.data;
  const bothPlan = hasPlan(from) && hasPlan(to);
  const bothGeom = hasWalls(from) && hasWalls(to);
  const [keepPlanFrom, setKeepPlanFrom] = useState<"from" | "to">("to");
  const [keepGeometryFrom, setKeepGeometryFrom] = useState<"from" | "to">("to");
  const [confirm, setConfirm] = useState(false);

  const utils = trpc.useUtils();
  const merge = trpc.rooms.merge.useMutation({
    onSuccess: () => {
      utils.rooms.list.invalidate();
      utils.rooms.get.invalidate();
      utils.items.listAll.invalidate();
      utils.photos.roomPhotos.invalidate();
      onMerged?.();
      onClose();
    },
  });

  useEffect(() => {
    if (!open) return;
    setKeepPlanFrom("to");
    setKeepGeometryFrom("to");
    setConfirm(false);
  }, [open, fromId, toId]);

  const ready = from && to;
  const canMerge = ready && (!bothPlan || keepPlanFrom) && (!bothGeom || keepGeometryFrom) && confirm;

  const sides = useMemo(() => {
    if (!from || !to) return [];
    return [
      { key: "from" as const, room: from, label: `“${from.name}” (source, will be removed)` },
      { key: "to" as const, room: to, label: `“${to.name}” (survives)` },
    ];
  }, [from, to]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Merge rooms?</DialogTitle>
        </DialogHeader>
        {!ready ? (
          <p className="text-[13px] text-muted-foreground">Loading rooms…</p>
        ) : (
          <div className="space-y-4 text-[13px]">
            <p>
              Merge <b>{from.name}</b> into <b>{to.name}</b>. Items, photos and pins move to{" "}
              <b>{to.name}</b>. <b>{from.name}</b> is then deleted. This cannot be undone.
            </p>
            <p className="text-muted-foreground">
              {from.items.length} Thing{from.items.length === 1 ? "" : "s"} in the source · {to.items.length} in the
              surviving room.
            </p>

            {bothPlan && (
              <div>
                <div className="micro-label text-muted-foreground mb-2">Both rooms have a floorplan — pick which stays</div>
                <div className="grid grid-cols-2 gap-3">
                  {sides.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => setKeepPlanFrom(s.key)}
                      className={cn(
                        "rounded-lg border p-2 text-left",
                        keepPlanFrom === s.key ? "border-primary bg-primary/5" : "border-border",
                      )}
                    >
                      <div className="text-[12px] font-medium mb-1">{s.label}</div>
                      <div className="overflow-hidden rounded bg-muted/40 max-h-40">
                        <RoomPlan2D
                          widthM={s.room.widthM ?? 0}
                          depthM={s.room.depthM ?? 0}
                          walls={s.room.walls}
                          openings={s.room.openings}
                          items={s.room.items.map((it) => ({ id: it.id, name: it.name, pos: it.pos, editable: false }))}
                          editable={false}
                        />
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {bothGeom && (
              <div>
                <div className="micro-label text-muted-foreground mb-2">Both rooms have a 3D scan — pick which stays</div>
                <div className="grid grid-cols-2 gap-3">
                  {sides.map((s) => (
                    <label
                      key={s.key}
                      className={cn(
                        "rounded-lg border p-2 flex items-start gap-2 cursor-pointer",
                        keepGeometryFrom === s.key ? "border-primary bg-primary/5" : "border-border",
                      )}
                    >
                      <input
                        type="radio"
                        name="keep-3d"
                        checked={keepGeometryFrom === s.key}
                        onChange={() => setKeepGeometryFrom(s.key)}
                      />
                      <span>
                        <span className="block font-medium">{s.room.name}</span>
                        <span className="block text-[12px] text-muted-foreground">
                          {(s.room.walls ?? []).length} wall segment{s.room.walls?.length === 1 ? "" : "s"}
                          {s.room.wallHeightM != null ? ` · ${s.room.wallHeightM} m high` : ""}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
              <span>I understand {from.name} will be deleted after its Things move to {to.name}.</span>
            </label>

            {merge.isError && <p className="text-destructive">{merge.error.message}</p>}

            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!canMerge || merge.isPending}
                onClick={() =>
                  merge.mutate({
                    fromId: from.id,
                    toId: to.id,
                    ...(bothPlan ? { keepPlanFrom } : {}),
                    ...(bothGeom ? { keepGeometryFrom } : {}),
                  })
                }
              >
                {merge.isPending ? "Merging…" : "Merge rooms"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
