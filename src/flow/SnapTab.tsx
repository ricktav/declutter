import { useRef, useState } from "react";
import { Camera, FileUp, Loader2, MapPin, Send } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { uploadFile } from "@/lib/upload";
import { useFlow } from "./context";
import { placeLabel, setSnapPlace } from "./data";
import { ErrorLine, Photo } from "./ui";

/** Put things in, as fast as possible. No questions here - Sort asks them later. */
export function SnapTab({ onChangeHere, onGoSort }: { onChangeHere: () => void; onGoSort: () => void }) {
  const { here, locations, captures, refresh } = useFlow();
  const camRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const create = trpc.inbox.create.useMutation();

  const pending = captures.filter((c) => c.status === "pending");
  const recent = pending.filter((c) => c.kind === "image" && c.storageKey).slice(0, 8);
  const hereLabel = placeLabel(here.roomId, locations);

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    for (const file of Array.from(files)) {
      setBusy((n) => n + 1);
      try {
        const up = await uploadFile(file, "inbox");
        const row = await create.mutateAsync({
          kind: up.mimeType.startsWith("image/") ? "image" : "file",
          storageKey: up.key,
          fileName: up.fileName,
          mimeType: up.mimeType,
        });
        if (here.roomId != null) setSnapPlace(row.id, here);
        setSavedCount((n) => n + 1);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed.");
      } finally {
        setBusy((n) => n - 1);
      }
    }
    refresh();
  }

  async function addNote() {
    const t = note.trim();
    if (!t) return;
    setError(null);
    try {
      const isUrl = /^https?:\/\//i.test(t);
      const row = await create.mutateAsync(isUrl ? { kind: "link", url: t } : { kind: "note", rawText: t });
      if (here.roomId != null) setSnapPlace(row.id, here);
      setNote("");
      setSavedCount((n) => n + 1);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the note.");
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <button
        onClick={onChangeHere}
        className="flex items-center gap-2 self-start rounded-full border border-border bg-white px-3 py-1.5 text-[13px]"
      >
        <MapPin className="h-3.5 w-3.5 text-[#3C5D41]" />
        {here.roomId != null ? (
          <span>
            Snaps go to <b>{hereLabel}</b>
          </span>
        ) : (
          <span className="text-muted-foreground">Set where you are (optional)</span>
        )}
      </button>

      <div className="flex flex-col items-center gap-3 py-2">
        <button
          onClick={() => camRef.current?.click()}
          className="grid h-40 w-40 place-items-center rounded-full border-[7px] border-[#3C5D41] bg-white active:scale-95 transition-transform"
          aria-label="Take a photo"
        >
          <span className="grid h-28 w-28 place-items-center rounded-full bg-[#3C5D41] text-[#f4f4ed]">
            {busy > 0 ? <Loader2 className="h-9 w-9 animate-spin" /> : <Camera className="h-10 w-10" />}
          </span>
        </button>
        <p className="text-[13px] text-muted-foreground">One photo for each thing, or one photo of a shelf.</p>
        <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        <input ref={fileRef} type="file" multiple accept="image/*,application/pdf,.json,.geojson" className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        <button onClick={() => fileRef.current?.click()} className="flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 text-[13px]">
          <FileUp className="h-4 w-4" /> Photos or files from this device
        </button>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          addNote();
        }}
      >
        <input
          id="flow-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Or type a note or a link"
          className="flex-1 rounded-lg border border-input bg-white px-3 py-2.5 text-[15px]"
        />
        <button type="submit" disabled={!note.trim()} className="rounded-lg bg-[#282c20] px-3 text-[#f4f4ed] disabled:opacity-40" aria-label="Save note">
          <Send className="h-4 w-4" />
        </button>
      </form>

      <ErrorLine message={error} />

      <div className="flex items-center justify-between rounded-xl bg-[#282c20] px-4 py-3 text-[#f4f4ed]">
        <span className="text-[13px]">
          {savedCount > 0 && <b className="text-[#d2ff00]">+{savedCount} saved · </b>}
          <b className="font-data">{pending.length}</b> waiting to sort
        </span>
        <button onClick={onGoSort} disabled={pending.length === 0} className="rounded-lg bg-[#d2ff00] px-3 py-1.5 font-data text-[13px] font-semibold text-[#282c20] disabled:opacity-40">
          Sort now
        </button>
      </div>

      {recent.length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {recent.map((c) => (
            <Photo key={c.id} storageKey={c.storageKey} className="aspect-square" />
          ))}
        </div>
      )}
    </div>
  );
}
