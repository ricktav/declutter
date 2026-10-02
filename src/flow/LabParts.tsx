import { useState, type ReactNode } from "react";
import { Check, ChevronDown, HardDrive, X } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { cn } from "@/lib/utils";
import { useFlow } from "./context";
import { ErrorLine } from "./ui";
import { isReal, type FlowItem } from "./data";
import {
  BACKS_UP,
  LAB,
  LAB_KEYS,
  ROLES,
  backupsOf,
  guessRole,
  isBackupTarget,
  role,
  safetyChecks,
  shortDate,
  today,
  type LensField,
} from "./lenses";

const FIELDS: LensField[] = [...LAB.mainFields, ...LAB.moreFields];

/** One tap per device role. */
export function RoleChips({ value, onPick }: { value: string; onPick: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {ROLES.map((r) => (
        <button
          key={r.value}
          type="button"
          onClick={() => onPick(r.value === value ? "" : r.value)}
          className={cn(
            "rounded-full border px-3 py-1.5 text-[13px]",
            r.value === value ? "border-transparent bg-[#282c20] text-[#f4f4ed]" : "border-border bg-white",
          )}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Device details: role, then brand / model / serial, then the rest behind
 * "More details". Saves only the keys that changed; an emptied field is
 * removed from the item instead of stored as "".
 */
export function LabFields({
  item,
  requireRole,
  expanded,
  saveLabel = "Save",
  onSaved,
  children,
}: {
  item: FlowItem;
  requireRole?: boolean;
  expanded?: boolean;
  saveLabel?: string;
  onSaved?: () => void;
  children?: ReactNode;
}) {
  const { refresh } = useFlow();
  const guess = role(item) ? null : guessRole(item);
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const d: Record<string, string> = { role: role(item) || guess || "" };
    for (const f of FIELDS) d[f.key] = String(item.attributes?.[f.key] ?? "");
    return d;
  });
  const [more, setMore] = useState(!!expanded || LAB.moreFields.some((f) => item.attributes?.[f.key] != null));
  const [error, setError] = useState<string | null>(null);
  const patch = trpc.items.patchAttributes.useMutation({
    onSuccess: () => {
      refresh();
      onSaved?.();
    },
    onError: (e) => setError(e.message),
  });

  const changes: Record<string, string | number | null> = {};
  for (const key of ["role", ...FIELDS.map((f) => f.key)]) {
    const next = draft[key].trim();
    const cur = item.attributes?.[key];
    if (next === String(cur ?? "")) continue;
    if (!next) {
      if (cur != null) changes[key] = null;
      continue;
    }
    const kind = FIELDS.find((f) => f.key === key)?.kind;
    changes[key] = kind === "number" && Number.isFinite(Number(next)) ? Number(next) : next;
  }
  const dirty = Object.keys(changes).length > 0;
  const set = (key: string, v: string) => setDraft((d) => ({ ...d, [key]: v }));

  const field = (f: LensField) => (
    <label key={f.key} className="flex flex-col gap-0.5">
      <span className="micro-label text-muted-foreground">
        {f.label}
        {f.unit && ` (${f.unit})`}
      </span>
      <input
        id={`lab-${item.id}-${f.key}`}
        value={draft[f.key]}
        onChange={(e) => set(f.key, e.target.value)}
        placeholder={f.placeholder}
        inputMode={f.kind === "number" ? "numeric" : undefined}
        autoCapitalize={f.key === "serial" || f.key === "mac" ? "characters" : "off"}
        autoCorrect="off"
        className="w-full rounded-lg border border-input bg-white px-2.5 py-2 text-[14px]"
      />
    </label>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <RoleChips value={draft.role} onPick={(v) => set("role", v)} />
        {guess && draft.role === guess && <p className="text-[11px] text-muted-foreground">First guess from the name. Tap another role if it is wrong.</p>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {LAB.mainFields.map((f) => (
          <div key={f.key} className={f.key === "model" ? "col-span-2" : undefined}>
            {field(f)}
          </div>
        ))}
      </div>
      {more ? (
        <div className="grid grid-cols-2 gap-2">{LAB.moreFields.map(field)}</div>
      ) : (
        <button type="button" onClick={() => setMore(true)} className="flex items-center gap-1 self-start text-[12px] text-[#3C5D41] underline">
          <ChevronDown className="h-3.5 w-3.5" /> More details (OS, RAM, IP…)
        </button>
      )}
      <ErrorLine message={error} />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!dirty || patch.isPending || (requireRole && !draft.role)}
          onClick={() => {
            setError(null);
            patch.mutate({ id: item.id, set: changes });
          }}
          className="flex-1 rounded-xl bg-[#282c20] py-3 font-data text-[14px] font-semibold text-[#f4f4ed] disabled:opacity-40"
        >
          {patch.isPending ? "Saving…" : saveLabel}
        </button>
        {children}
      </div>
    </div>
  );
}

/** Link a device to the NAS, drive or server that holds its backup - or say it needs none. */
export function BackupPicker({ item, onDone }: { item: FlowItem; onDone?: () => void }) {
  const { items, backups, refresh } = useFlow();
  const [error, setError] = useState<string | null>(null);
  const opts = {
    onSuccess: () => {
      refresh();
      onDone?.();
    },
    onError: (e: { message: string }) => setError(e.message),
  };
  const add = trpc.items.addRelation.useMutation(opts);
  const remove = trpc.items.removeRelation.useMutation({ onSuccess: refresh, onError: (e) => setError(e.message) });
  const patch = trpc.items.patchAttributes.useMutation(opts);

  const mine = backupsOf(item, backups);
  const linked = new Set(mine.map((r) => r.fromItemId));
  const targets = items.filter((t) => t.status === "active" && isReal(t) && t.id !== item.id && isBackupTarget(t) && !linked.has(t.id));
  const nameOf = (id: number) => items.find((t) => t.id === id)?.name ?? `#${id}`;
  const busy = add.isPending || patch.isPending || remove.isPending;

  return (
    <div className="flex flex-col gap-2">
      {mine.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {mine.map((r) => (
            <span key={r.id} className="flex items-center gap-1 rounded-full bg-[#2F7A45]/10 py-1 pl-3 pr-1 text-[13px] text-[#2F7A45]">
              <HardDrive className="h-3.5 w-3.5" /> {nameOf(r.fromItemId)}
              <button onClick={() => remove.mutate({ id: r.id })} disabled={busy} className="p-1" aria-label={`Remove backup to ${nameOf(r.fromItemId)}`}>
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      {targets.length > 0 ? (
        <>
          <span className="micro-label text-muted-foreground">{mine.length ? "Also backed up to" : "Backed up to"}</span>
          <div className="flex flex-col gap-1.5">
            {targets.map((t) => (
              <button
                key={t.id}
                disabled={busy}
                onClick={() => add.mutate({ fromItemId: t.id, toItemId: item.id, type: BACKS_UP })}
                className="flex items-center gap-2 rounded-xl border border-border bg-white px-3 py-2.5 text-left text-[14px] disabled:opacity-40"
              >
                <HardDrive className="h-4 w-4 shrink-0 text-[#3C5D41]" />
                <span className="flex-1 truncate">{t.name}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        mine.length === 0 && (
          <p className="text-[12px] text-muted-foreground">
            No backup target yet. Give your NAS, backup drive or server its role first (role NAS, Drive or Server).
          </p>
        )
      )}
      {mine.length === 0 && item.attributes?.[LAB_KEYS.backup] !== "none-needed" && (
        <button
          disabled={busy}
          onClick={() => patch.mutate({ id: item.id, set: { [LAB_KEYS.backup]: "none-needed" } })}
          className="rounded-xl border border-border py-2.5 text-[13px] text-muted-foreground disabled:opacity-40"
        >
          No backup needed (nothing personal on it)
        </button>
      )}
      <ErrorLine message={error} />
    </div>
  );
}

/**
 * "Before it leaves" - three checks on a device that holds data. Each one is
 * a tap; tap again to undo. Gone and Sold stay locked until all three are done.
 */
export function SafetyChecklist({ item }: { item: FlowItem }) {
  const { items, backups, refresh } = useFlow();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = trpc.items.patchAttributes.useMutation({ onSuccess: refresh, onError: (e) => setError(e.message) });
  const checks = safetyChecks(item, backups);
  if (!checks) return null;
  const allDone = checks.every((c) => c.done);
  const mine = backupsOf(item, backups);

  const detail = (key: string) => {
    if (key === LAB_KEYS.backup) {
      if (mine.length) return mine.map((r) => items.find((t) => t.id === r.fromItemId)?.name).join(", ");
      return item.attributes?.[LAB_KEYS.backup] === "none-needed" ? "not needed" : "pick where";
    }
    return shortDate(item.attributes?.[key]);
  };
  const tap = (key: string, done: boolean) => {
    setError(null);
    if (key !== LAB_KEYS.backup) return patch.mutate({ id: item.id, set: { [key]: done ? null : today() } });
    if (!mine.length && done) return patch.mutate({ id: item.id, set: { [LAB_KEYS.backup]: null } });
    setPicking((p) => !p);
  };

  return (
    <div className={cn("flex flex-col gap-1.5 rounded-xl border p-2.5", allDone ? "border-[#2F7A45]/40 bg-[#2F7A45]/5" : "border-[#9E6A08]/50 bg-[#9E6A08]/5")}>
      <span className="micro-label" style={{ color: allDone ? "#2F7A45" : "#9E6A08" }}>
        {allDone ? "Data checks done" : "Holds data: three checks before it leaves"}
      </span>
      {checks.map((c) => (
        <button
          key={c.key}
          type="button"
          disabled={patch.isPending}
          onClick={() => tap(c.key, c.done)}
          className="flex items-center gap-2 rounded-lg bg-white px-2 py-2 text-left text-[13px] disabled:opacity-60"
        >
          <span
            className={cn("grid h-5 w-5 shrink-0 place-items-center rounded border-2", c.done ? "border-[#2F7A45] bg-[#2F7A45] text-white" : "border-[#9E6A08]")}
          >
            {c.done && <Check className="h-3.5 w-3.5" />}
          </span>
          <span className="flex-1">{c.label}</span>
          <span className="truncate text-[11px] text-muted-foreground">{c.done || c.key === LAB_KEYS.backup ? detail(c.key) : ""}</span>
        </button>
      ))}
      {picking && <BackupPicker item={item} onDone={() => setPicking(false)} />}
      <ErrorLine message={error} />
    </div>
  );
}
