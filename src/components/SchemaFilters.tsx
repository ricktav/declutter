import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Flag } from "lucide-react";
import { OTHER_TYPE, SCHEMA_PRESETS, TYPE_LABELS, TYPE_TREE, ancestorsOf, isTypeNode, isUnder } from "@db/taxonomy";
import { DECISIONS } from "@/lib/decisions";
import {
  DECISION_FILTERS,
  EMPTY_SCHEMA_FILTER,
  NEUTRAL_PIN_COLOR,
  activePreset,
  type DecisionFilter,
  type SchemaFilter,
  type SchemaPin,
} from "@/lib/schemaFilter";

type Topic = { id: number; name: string; color: string | null };

const CHILDREN: Record<string, string[]> = {};
const ROOTS: string[] = [];
for (const [node, parent] of Object.entries(TYPE_TREE)) {
  if (parent == null) ROOTS.push(node);
  else (CHILDREN[parent] ??= []).push(node);
}

function chip(active: boolean): string {
  return (
    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors " +
    (active ? "border-foreground bg-foreground text-background" : "border-border bg-background hover:bg-muted")
  );
}

/**
 * The Schema view's filters: presets, a Type tree (a node means its whole
 * subtree; "Other" = no known Type), Tags and Topic chips from the room's
 * data, Flagged and a Decision. OR within a facet, AND across facets.
 */
export function SchemaFilters({
  filter,
  onChange,
  pins,
  topics,
}: {
  filter: SchemaFilter;
  onChange: (f: SchemaFilter) => void;
  pins: SchemaPin[];
  topics: Topic[];
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [treeOpen, setTreeOpen] = useState(false);

  const typeCounts = useMemo(() => {
    const out = new Map<string, number>();
    for (const p of pins) {
      const t = p.item?.type ?? null;
      const key = isTypeNode(t) ? t : OTHER_TYPE;
      for (const n of key === OTHER_TYPE ? [OTHER_TYPE] : [key, ...ancestorsOf(key)]) out.set(n, (out.get(n) ?? 0) + 1);
    }
    return out;
  }, [pins]);

  const tags = useMemo(() => {
    const set = new Set<string>(filter.tags);
    for (const p of pins) for (const t of p.item?.tags ?? []) set.add(t);
    return [...set].sort();
  }, [pins, filter.tags]);

  const shownTopics = useMemo(() => {
    const ids = new Set<number>(filter.topics);
    for (const p of pins) if (p.item) ids.add(p.item.areaId);
    return topics.filter((t) => ids.has(t.id));
  }, [pins, topics, filter.topics]);

  const preset = activePreset(filter);

  const toggleType = (node: string) => {
    if (filter.types.includes(node)) {
      onChange({ ...filter, types: filter.types.filter((t) => t !== node) });
      return;
    }
    // a node stands for its subtree: drop chosen descendants
    const kept = filter.types.filter((t) => t === OTHER_TYPE || !isUnder(t, node));
    onChange({ ...filter, types: [...kept, node] });
  };
  const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const renderNode = (node: string, depth: number) => {
    const kids = CHILDREN[node] ?? [];
    const expanded = open.has(node);
    const chosen = filter.types.includes(node);
    const implied = !chosen && ancestorsOf(node).some((a) => filter.types.includes(a));
    const count = typeCounts.get(node) ?? 0;
    return (
      <li key={node}>
        <div className="flex items-center gap-1" style={{ paddingLeft: depth * 14 }}>
          {kids.length ? (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              title={expanded ? "Collapse" : "Expand"}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${TYPE_LABELS[node] ?? node}`}
              aria-expanded={expanded}
              onClick={() =>
                setOpen((s) => {
                  const n = new Set(s);
                  if (n.has(node)) n.delete(node);
                  else n.add(node);
                  return n;
                })
              }
            >
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
          ) : (
            <span className="w-3" />
          )}
          <label className={"flex items-center gap-1.5 text-[12px] " + (count ? "" : "text-muted-foreground")}>
            <input
              type="checkbox"
              data-type-node={node}
              checked={chosen || implied}
              disabled={implied}
              onChange={() => toggleType(node)}
            />
            {TYPE_LABELS[node] ?? node}
            {count > 0 && <span className="text-[10px] text-muted-foreground">{count}</span>}
          </label>
        </div>
        {kids.length > 0 && expanded && <ul>{kids.map((k) => renderNode(k, depth + 1))}</ul>}
      </li>
    );
  };

  const typeSummary = filter.types.map((t) => (t === OTHER_TYPE ? "Other" : (TYPE_LABELS[t] ?? t))).join(", ");

  return (
    <div className="mb-3 space-y-2 rounded-lg border border-border bg-muted/30 p-2.5" data-testid="schema-filters">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="micro-label text-muted-foreground mr-1">Show</span>
        <button type="button" className={chip(preset === "everything")}
          aria-pressed={preset === "everything"} onClick={() => onChange(EMPTY_SCHEMA_FILTER)}>
          Everything
        </button>
        {SCHEMA_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            data-preset={p.id}
            className={chip(preset === p.id)}
            aria-pressed={preset === p.id}
            onClick={() => onChange({ ...EMPTY_SCHEMA_FILTER, types: [...p.types] })}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div>
        <button
          type="button"
          className="flex items-center gap-1 text-[12px] font-medium"
          onClick={() => setTreeOpen((v) => !v)}
          aria-expanded={treeOpen}
          data-testid="type-tree-toggle"
        >
          {treeOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Type
          <span className="font-normal text-muted-foreground truncate">{typeSummary ? `: ${typeSummary}` : ": any"}</span>
        </button>
        {treeOpen && (
          <ul className="mt-1 max-h-56 overflow-y-auto rounded border border-border bg-background p-1.5">
            {ROOTS.map((r) => renderNode(r, 0))}
            <li>
              <label className="flex items-center gap-1.5 text-[12px]" style={{ paddingLeft: 16 }}>
                <input
                  type="checkbox"
                  data-type-node={OTHER_TYPE}
                  checked={filter.types.includes(OTHER_TYPE)}
                  onChange={() => toggleType(OTHER_TYPE)}
                />
                Other
                {(typeCounts.get(OTHER_TYPE) ?? 0) > 0 && (
                  <span className="text-[10px] text-muted-foreground">{typeCounts.get(OTHER_TYPE)}</span>
                )}
              </label>
            </li>
          </ul>
        )}
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[12px] font-medium mr-1">Tags</span>
          {tags.map((t) => (
            <button
              key={t}
              type="button"
              data-tag={t}
              className={chip(filter.tags.includes(t))}
              aria-pressed={filter.tags.includes(t)}
              onClick={() => onChange({ ...filter, tags: toggle(filter.tags, t) })}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {shownTopics.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[12px] font-medium mr-1">Topic</span>
          {shownTopics.map((t) => (
            <button
              key={t.id}
              type="button"
              data-topic={t.id}
              className={chip(filter.topics.includes(t.id))}
              aria-pressed={filter.topics.includes(t.id)}
              onClick={() => onChange({ ...filter, topics: toggle(filter.topics, t.id) })}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: t.color ?? NEUTRAL_PIN_COLOR }} />
              {t.name}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="filter-flagged"
          className={chip(filter.flagged)}
          aria-pressed={filter.flagged}
          onClick={() => onChange({ ...filter, flagged: !filter.flagged })}
        >
          <Flag className="h-3 w-3" /> Flagged
        </button>
        <label className="flex items-center gap-1 text-[12px]">
          Decision
          <select
            data-testid="filter-decision"
            className="rounded border border-border bg-background px-1 py-0.5 text-[12px]"
            value={filter.decision ?? ""}
            onChange={(e) => onChange({ ...filter, decision: (e.target.value || null) as DecisionFilter | null })}
          >
            <option value="">Any</option>
            {DECISION_FILTERS.map((d) => (
              <option key={d} value={d}>
                {d === "none" ? "No decision" : (DECISIONS.find((x) => x.key === d)?.label ?? d)}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
