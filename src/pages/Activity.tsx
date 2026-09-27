import { useState } from "react";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { timeAgo } from "@/lib/format";

const ENTITY_TYPES = ["all", "item", "area", "task", "idea", "capture", "attachment", "relation", "wiki", "chat"];

export default function ActivityPage() {
  const [filter, setFilter] = useState("all");
  const events = trpc.events.list.useQuery({
    limit: 200,
    entityType: filter === "all" ? undefined : filter,
  });

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
      <p className="text-sm text-muted-foreground mt-1">
        The audit trail — everything the app (and the AI) did, in order.
      </p>

      <div className="flex gap-1.5 mt-5 flex-wrap">
        {ENTITY_TYPES.map((t) => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            className={`rounded-full px-3 py-1 text-[12px] transition-colors ${
              filter === t ? "bg-primary text-primary-foreground" : "bg-white border border-border hover:bg-accent"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="mt-4 rounded-lg border border-border bg-white overflow-hidden">
        <table className="ledger-table w-full border-collapse">
          <thead>
            <tr>
              <th className="w-28">When</th>
              <th className="w-16">Actor</th>
              <th className="w-20">Entity</th>
              <th className="w-28">Action</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {(events.data ?? []).map((e) => (
              <tr key={e.id}>
                <td className="font-data text-[11px] text-muted-foreground whitespace-nowrap">
                  {timeAgo(e.createdAt)}
                </td>
                <td>
                  <span
                    className={`micro-label ${
                      e.actor === "ai" ? "text-violet-600" : e.actor === "system" ? "text-sky-600" : "text-muted-foreground"
                    }`}
                  >
                    {e.actor}
                  </span>
                </td>
                <td className="font-data text-[11px]">
                  {e.entityType === "item" && e.entityId ? (
                    <Link to={`/items/${e.entityId}`} className="text-primary hover:underline">
                      {e.entityType}#{e.entityId}
                    </Link>
                  ) : (
                    `${e.entityType}${e.entityId ? `#${e.entityId}` : ""}`
                  )}
                </td>
                <td className="font-data text-[11px]">{e.action}</td>
                <td className="text-[12px]">{e.summary}</td>
              </tr>
            ))}
            {(events.data ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-muted-foreground py-8">
                  No events yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
