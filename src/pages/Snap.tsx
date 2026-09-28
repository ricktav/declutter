import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Camera, Link2, StickyNote, Loader2, CheckCircle2, ArrowRight } from "lucide-react";
import { fileToBase64, timeAgo } from "@/lib/format";

/** Phone-first capture screen: snap photos / quick notes straight into the inbox. */
export default function SnapPage() {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const photoRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState("");
  const [lastOk, setLastOk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recent = trpc.inbox.list.useQuery();
  const create = trpc.inbox.create.useMutation({
    onSuccess: (_, vars) => {
      utils.inbox.list.invalidate();
      setError(null);
      setLastOk(vars.kind === "note" ? "note" : vars.kind === "link" ? "link" : "photo");
      setNote("");
      setTimeout(() => setLastOk(null), 2500);
    },
    onError: (e) => setError(e.message),
  });

  const snap = async (file: File) => {
    const contentBase64 = await fileToBase64(file);
    create.mutate({
      kind: "image",
      fileName: file.name || `snap-${Date.now()}.jpg`,
      contentBase64,
      mimeType: file.type || "image/jpeg",
    });
  };

  const submitNote = () => {
    const t = note.trim();
    if (!t) return;
    const isUrl = /^https?:\/\/\S+$/.test(t);
    create.mutate(isUrl ? { kind: "link", url: t } : { kind: "note", rawText: t });
  };

  const mine = (recent.data ?? []).slice(0, 5);

  return (
    <div className="max-w-lg mx-auto px-4 py-6">
      <h1 className="text-xl font-semibold tracking-tight">Snap & capture</h1>
      <p className="text-[13px] text-muted-foreground mt-1">
        Walk the building — everything lands in the inbox for triage later.
      </p>

      {/* camera button */}
      <input
        ref={photoRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) snap(f);
          e.target.value = "";
        }}
      />
      <button
        onClick={() => photoRef.current?.click()}
        disabled={create.isPending}
        className="mt-5 w-full rounded-2xl bg-[#282c20] text-[#f4f4ed] py-8 flex flex-col items-center gap-2 active:bg-[#3a3f2e] transition-colors"
      >
        {create.isPending ? (
          <Loader2 className="h-8 w-8 animate-spin text-[#d2ff00]" />
        ) : (
          <Camera className="h-8 w-8 text-[#d2ff00]" />
        )}
        <span className="text-[15px] font-semibold">Take photo</span>
        <span className="micro-label text-[#b4b8a5]">of a shelf · cupboard · corner · device</span>
      </button>

      {lastOk && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-[13px] text-emerald-900">
          <CheckCircle2 className="h-4 w-4" /> Captured — {lastOk} is in the inbox.
        </div>
      )}
      {error && (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
          {error}
        </div>
      )}

      {/* quick note */}
      <div className="mt-4 flex gap-2">
        <div className="flex-1 flex items-center gap-2 rounded-xl border border-input bg-white px-3">
          <StickyNote className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            className="flex-1 bg-transparent outline-none text-[15px] py-3"
            placeholder="or type a quick note / link…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitNote()}
          />
        </div>
        <Button className="h-auto rounded-xl px-4" disabled={!note.trim() || create.isPending}
          onClick={submitNote}>
          <Link2 className="h-4 w-4" />
        </Button>
      </div>

      {/* recent captures */}
      {mine.length > 0 && (
        <>
          <div className="micro-label text-muted-foreground mt-6 mb-2">Just captured</div>
          <div className="rounded-xl border border-border bg-white divide-y divide-border">
            {mine.map((c) => (
              <div key={c.id} className="flex items-center gap-2 px-3 py-2.5 text-[13px]">
                <span className="micro-label text-muted-foreground w-12 shrink-0">{c.kind}</span>
                <span className="flex-1 truncate">{c.rawText ?? c.url ?? "photo"}</span>
                <span className="font-data text-[11px] text-muted-foreground">{timeAgo(c.createdAt)}</span>
              </div>
            ))}
          </div>
          <button
            onClick={() => navigate("/inbox")}
            className="mt-3 flex items-center gap-1 text-[13px] text-primary"
          >
            Triage in the inbox <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  );
}
