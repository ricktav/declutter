import { useEffect, useRef, useState } from "react";
import { trpc } from "@/providers/trpc";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Sparkles, Send, Trash2, AlertTriangle } from "lucide-react";
import type { AskScope } from "@/context/ask";
import { timeAgo } from "@/lib/format";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: AskScope;
  scopeId: number;
  label: string;
}

export function AskPanel({ open, onOpenChange, scope, scopeId, label }: Props) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const history = trpc.ai.history.useQuery({ scope, scopeId }, { enabled: open });
  const utils = trpc.useUtils();
  const chat = trpc.ai.chat.useMutation({
    onSuccess: (res) => {
      if (res.ok) {
        setError(null);
        utils.ai.history.invalidate({ scope, scopeId });
      } else {
        setError(res.error);
      }
    },
    onError: (e) => setError(e.message),
  });
  const clear = trpc.ai.clearHistory.useMutation({
    onSuccess: () => utils.ai.history.invalidate({ scope, scopeId }),
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history.data?.length, chat.isPending]);

  const send = () => {
    const msg = input.trim();
    if (!msg || chat.isPending) return;
    setInput("");
    chat.mutate({ scope, scopeId, message: msg });
  };

  const messages = history.data ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[420px] sm:w-[480px] flex flex-col p-0">
        <SheetHeader className="px-4 py-3 border-b border-border">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <Sparkles className="h-4 w-4 text-primary" />
            Ask about: <span className="font-semibold">{label}</span>
            <span className="micro-label text-muted-foreground ml-1">({scope})</span>
            <button
              className="ml-auto text-muted-foreground hover:text-foreground"
              title="Clear history"
              onClick={() => clear.mutate({ scope, scopeId })}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {messages.length === 0 && (
            <div className="text-sm text-muted-foreground mt-6 space-y-2">
              <p>The assistant sees the current {scope} as context. Try:</p>
              <ul className="list-disc pl-5 space-y-1 text-[13px]">
                <li>What can be consolidated here?</li>
                <li>Summarise what I have and what's missing.</li>
                <li>Turn this into a checklist of tasks.</li>
              </ul>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={
                  m.role === "user"
                    ? "bg-primary text-primary-foreground rounded-lg px-3 py-2 text-sm max-w-[85%]"
                    : "bg-muted rounded-lg px-3 py-2 text-sm max-w-[85%] whitespace-pre-wrap"
                }
              >
                {m.content}
                <div className="text-[10px] opacity-60 mt-1">{timeAgo(m.createdAt)}</div>
              </div>
            </div>
          ))}
          {chat.isPending && (
            <div className="text-sm text-muted-foreground animate-pulse">Thinking…</div>
          )}
          {error && (
            <div className="flex gap-2 items-start rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="border-t border-border p-3 flex gap-2 items-end">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Ask about this ${scope}…`}
            className="min-h-[40px] max-h-32 text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <Button size="icon" onClick={send} disabled={chat.isPending || !input.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
