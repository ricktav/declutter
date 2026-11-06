import { useState } from "react";
import { Link } from "react-router";
import { Loader2 } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { ItemPicker } from "@/components/ItemPicker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { invalidatePhotoChange, photoTargetKey, usePhotoFromTarget, type PhotoTarget } from "@/hooks/use-photo-from-target";

/** What the dialog attaches: a real photo, or an inbox capture that first
 * has to become a photo (photos.ensureForCapture) before it can be attached. */
export type AttachTarget = PhotoTarget;

type Thing = { id: number; name: string };

/** The server's CONFLICT message for a photo owned by another Thing; only this one asks to move it. */
const OWNED_PREFIX = "Photo belongs to ";

/** Attach a bucket photo (no Thing yet) to a Thing. When the photo already
 * belongs to another Thing the server answers CONFLICT and the dialog asks
 * before moving it (force). */
export function AttachPhotoDialog({ target, onClose }: { target: AttachTarget | null; onClose: () => void }) {
  return (
    <Dialog open={target != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        {/* keyed so every opening starts from a clean picker */}
        {target && (
          <AttachBody key={photoTargetKey(target)} target={target} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AttachBody({ target, onClose }: { target: AttachTarget; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [q, setQ] = useState("");
  const [thing, setThing] = useState<Thing | null>(null);
  // the photo id once resolved in this dialog, so Try again / Move act on the
  // same Photo: once attached it is no longer bare, and ensureForCapture
  // would make a second Photo for the capture
  const [photoId, setPhotoId] = useState<number | null>(null);
  // the owner the server named: its name for the question, its id so the
  // move happens only from that owner (fromItemId)
  const [conflict, setConflict] = useState<{ name: string; ownerId: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(false);
  const [done, setDone] = useState<Thing | null>(null);

  const { resolve, isPending: resolving } = usePhotoFromTarget();
  const attach = trpc.photos.attachToItem.useMutation();
  const busy = resolving || attach.isPending;

  const run = async (t: Thing, force: boolean, fromItemId?: number | null) => {
    setError(null);
    setRetry(false);
    setConflict(null);
    try {
      const id = photoId ?? (await resolve(target));
      setPhotoId(id);
      await attach.mutateAsync({
        photoId: id,
        itemId: t.id,
        ...(force ? { force: true } : {}),
        ...(force && fromItemId != null ? { fromItemId } : {}),
      });
      // the Thing's photos and placement (and a moved photo's old owner's)
      // changed. Wait for the refetch: a grid tile still marked as a capture
      // would make a second Photo on its next Place or Pin.
      await invalidatePhotoChange(utils, { itemIds: [t.id, ...(fromItemId != null ? [fromItemId] : [])] });
      setDone(t);
    } catch (err) {
      const e = err as { message?: string; data?: { code?: string; ownerId?: number } };
      // a capture that became a photo moves out of the inbox list either way
      void utils.photos.listAll.invalidate();
      const message = e.message ?? "";
      if (e.data?.code === "CONFLICT" && message.startsWith(OWNED_PREFIX)) {
        setConflict({ name: message.slice(OWNED_PREFIX.length), ownerId: e.data.ownerId ?? null });
      } else if (e.data?.code === "PRECONDITION_FAILED") {
        // a scene with other Things pinned in it: never attached, no Move;
        // the message says to pin the Thing in it instead
        setError(message);
      } else if (e.data?.code === "CONFLICT") {
        // any other conflict (say, attached elsewhere a moment ago) is not a
        // move question: re-read and let the user try again without force
        setError(message || "The photo changed while attaching.");
        setRetry(true);
      } else {
        setError(e.message ?? "Could not attach the photo.");
      }
    }
  };

  if (done) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Photo attached</DialogTitle>
          <DialogDescription>
            Attached to{" "}
            <Link to={`/items/${done.id}`} className="text-primary hover:underline" onClick={onClose}>
              {done.name}
            </Link>
            .
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end">
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Attach to Thing</DialogTitle>
        <DialogDescription>The photo becomes one of the Thing's photos. Its own Place stays as it is.</DialogDescription>
      </DialogHeader>
      <div className="min-h-[15rem]">
        <ItemPicker
          placeholder="Search Things…"
          value={q}
          onQueryChange={setQ}
          allowCreate={false}
          autoFocus
          onSelect={(item) => {
            setQ(item.name);
            setThing(item);
            void run(item, false);
          }}
        />
        {busy && (
          <div className="mt-3 flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Attaching…
          </div>
        )}
        {conflict != null && thing && !busy && (
          <div className="mt-3 rounded-md border border-border bg-muted/40 p-3 text-[13px]">
            <div>Move from {conflict.name}?</div>
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => void run(thing, true, conflict.ownerId)}>
                Move
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConflict(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {error && !busy && (
          <div className="mt-3 text-[13px] text-destructive">
            {error}
            {retry && thing && (
              <Button
                size="sm"
                variant="outline"
                className="ml-2"
                onClick={() => {
                  void utils.photos.listAll.invalidate();
                  void run(thing, false);
                }}
              >
                Try again
              </Button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
