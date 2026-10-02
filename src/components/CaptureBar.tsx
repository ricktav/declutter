import { useState, useRef } from "react";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Link2, ImagePlus, StickyNote, Loader2 } from "lucide-react";
import { uploadFile } from "@/lib/upload";

/** Frictionless capture: paste text/URL or drop a file — lands in the inbox. */
export function CaptureBar({ compact = false }: { compact?: boolean }) {
  const [text, setText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();

  const create = trpc.inbox.create.useMutation({
    onSuccess: () => {
      setText("");
      utils.inbox.list.invalidate();
    },
  });

  const submitText = () => {
    const t = text.trim();
    if (!t) return;
    const isUrl = /^https?:\/\/\S+$/.test(t);
    create.mutate(isUrl ? { kind: "link", url: t } : { kind: "note", rawText: t });
  };

  const [uploadError, setUploadError] = useState<string | null>(null);
  const submitFile = async (file: File) => {
    setUploadError(null);
    try {
      const up = await uploadFile(file, "inbox");
      create.mutate({
        kind: up.mimeType.startsWith("image/") ? "image" : "file",
        fileName: up.fileName,
        storageKey: up.key,
        mimeType: up.mimeType,
        rawText: file.name,
      });
    } catch (e) {
      setUploadError((e as Error).message);
    }
  };

  return (
    <div
      className={`rounded-lg border-2 border-dashed transition-colors bg-white ${
        dragOver ? "border-primary bg-accent/40" : "border-input"
      } ${compact ? "p-2" : "p-3"}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) submitFile(f);
        else {
          const t = e.dataTransfer.getData("text");
          if (t) setText(t);
        }
      }}
    >
      <div className="flex gap-2 items-center">
        <StickyNote className="h-4 w-4 text-muted-foreground shrink-0" />
        <input
          className="flex-1 min-w-0 bg-transparent outline-none text-[13px] py-1"
          placeholder="Quick capture: a note, a https:// link, or drop a photo / file here…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submitText()}
        />
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) submitFile(f);
            e.target.value = "";
          }}
        />
        <Button variant="ghost" size="icon" className="h-7 w-7" title="Attach file / photo"
          onClick={() => fileRef.current?.click()}>
          <ImagePlus className="h-4 w-4" />
        </Button>
        <Button size="sm" className="h-7 text-[12px]" onClick={submitText}
          disabled={create.isPending || !text.trim()}>
          {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5 mr-1" />}
          Capture
        </Button>
      </div>
      {(uploadError || create.isError) && (
        <div className="mt-2 text-[12px] text-destructive">{uploadError ?? create.error?.message}</div>
      )}
    </div>
  );
}
