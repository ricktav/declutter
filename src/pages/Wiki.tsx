import { useMemo, useState } from "react";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { marked } from "marked";
import { timeAgo } from "@/lib/format";
import { RefreshCw, Sparkles, Download, Copy, Check, Loader2, AlertTriangle } from "lucide-react";

export default function WikiPage() {
  const utils = trpc.useUtils();
  const pages = trpc.wiki.list.useQuery();
  const [slug, setSlug] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = trpc.wiki.get.useQuery(
    { slug: slug ?? "" },
    { enabled: !!slug },
  );
  const activeSlug = slug ?? pages.data?.find((p) => p.slug === "index")?.slug ?? pages.data?.[0]?.slug;
  const activePage = slug ? current.data : (pages.data?.find((p) => p.slug === activeSlug) ?? null);
  const pageContent = slug ? current.data?.content : activePage?.content;

  const generate = trpc.wiki.generate.useMutation({
    onSuccess: () => utils.wiki.list.invalidate(),
  });
  const enhance = trpc.wiki.enhance.useMutation({
    onSuccess: (res) => {
      if (res.ok) {
        utils.wiki.list.invalidate();
        utils.wiki.get.invalidate();
        setError(null);
      } else setError(res.error);
    },
    onError: (e) => setError(e.message),
  });

  const html = useMemo(() => {
    if (!pageContent) return "";
    return marked.parse(pageContent, { async: false }) as string;
  }, [pageContent]);

  const downloadPack = async () => {
    const pack = await utils.wiki.exportPack.fetch();
    const blob = new Blob([pack.content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "homebase-wiki.md";
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyPack = async () => {
    const pack = await utils.wiki.exportPack.fetch();
    await navigator.clipboard.writeText(pack.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Wiki</h1>
        <span className="text-sm text-muted-foreground">
          your inventory as a portable, LLM-ready knowledge base
        </span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" className="h-8 text-[12px]" onClick={copyPack}>
            {copied ? <Check className="h-3.5 w-3.5 mr-1" /> : <Copy className="h-3.5 w-3.5 mr-1" />}
            Copy context pack
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-[12px]" onClick={downloadPack}>
            <Download className="h-3.5 w-3.5 mr-1" /> Download .md
          </Button>
          <Button size="sm" className="h-8 text-[12px]" disabled={generate.isPending}
            onClick={() => generate.mutate()}>
            {generate.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
            Regenerate
          </Button>
        </div>
      </div>

      {error && (
        <div className="mt-3 flex gap-2 items-start rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {error}
        </div>
      )}

      <div className="flex gap-6 mt-6 items-start">
        <aside className="w-52 shrink-0 rounded-lg border border-border bg-white p-2 max-h-[70vh] overflow-y-auto">
          {(pages.data ?? []).length === 0 && (
            <div className="text-[12px] text-muted-foreground p-2">
              No pages yet — press Regenerate.
            </div>
          )}
          {(pages.data ?? []).map((p) => (
            <button
              key={p.slug}
              onClick={() => setSlug(p.slug)}
              className={`w-full text-left rounded px-2 py-1.5 text-[12px] truncate transition-colors ${
                (slug ?? activeSlug) === p.slug ? "bg-accent font-medium" : "hover:bg-accent/50"
              }`}
            >
              <span className="micro-label text-muted-foreground mr-1">{p.entityType}</span>
              {p.title}
            </button>
          ))}
        </aside>

        <div className="flex-1 min-w-0 rounded-lg border border-border bg-white p-6">
          {pageContent ? (
            <>
              <div className="flex items-center gap-2 mb-4 pb-3 border-b border-border">
                <span className="font-data text-[11px] text-muted-foreground">
                  generated {timeAgo((slug ? current.data : activePage)?.generatedAt)}
                </span>
                <Button size="sm" variant="outline" className="h-6 text-[11px] ml-auto px-2"
                  disabled={enhance.isPending}
                  onClick={() => {
                    const s = slug ?? activeSlug;
                    if (s) {
                      setError(null);
                      enhance.mutate({ slug: s });
                    }
                  }}>
                  {enhance.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Sparkles className="h-3 w-3 mr-1" />}
                  AI enhance
                </Button>
              </div>
              <article
                className="prose prose-sm max-w-none prose-headings:tracking-tight"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </>
          ) : (
            <div className="text-[13px] text-muted-foreground py-8 text-center">
              Select a page, or regenerate the wiki from live data.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
