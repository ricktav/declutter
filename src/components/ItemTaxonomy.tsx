import { TYPE_LABELS, TYPE_TREE, ancestorsOf, derivedType, isTypeNode } from "@db/taxonomy";

type Attrs = Record<string, string | number> | null;

/** Roots of the Type tree in tree order, each with its subtree (depth-first, tree order). */
function typeGroups(): Array<{ root: string; nodes: Array<{ type: string; depth: number }> }> {
  const keys = Object.keys(TYPE_TREE);
  const childrenOf = (p: string) => keys.filter((k) => TYPE_TREE[k] === p);
  const walk = (t: string, depth: number, out: Array<{ type: string; depth: number }>) => {
    out.push({ type: t, depth });
    for (const c of childrenOf(t)) walk(c, depth + 1, out);
    return out;
  };
  return keys.filter((k) => TYPE_TREE[k] == null).map((root) => ({ root, nodes: walk(root, 0, []) }));
}

const GROUPS = typeGroups();

function typeLabel(t: string): string {
  return TYPE_LABELS[t] ?? t;
}

/**
 * The Thing's Type (`attributes.type`): a select over the Type tree grouped by
 * root. "no Type" removes the key; then the Type derived from `role` shows as
 * a hint.
 */
export function TypeSelect({
  attributes,
  disabled,
  onChange,
}: {
  attributes: Attrs;
  disabled?: boolean;
  onChange: (type: string | null) => void;
}) {
  const raw = attributes?.type;
  const stored = raw == null || raw === "" ? null : String(raw).trim().toLowerCase();
  const fromRole = stored ? null : derivedType({ ...(attributes ?? {}), type: "" });
  const path = stored && isTypeNode(stored) ? [...ancestorsOf(stored)].reverse().map(typeLabel).join(" › ") : null;
  return (
    <>
      <span className="micro-label shrink-0">Type</span>
      <select
        aria-label="Type"
        className="h-7 w-44 shrink-0 rounded-md border border-input bg-white px-1.5 text-[12px]"
        value={stored ?? ""}
        disabled={disabled}
        title={path ? `${path} › ${typeLabel(stored!)}` : undefined}
        onChange={(e) => {
          const next = e.target.value || null;
          if (next !== stored) onChange(next);
        }}
      >
        <option value="">no Type</option>
        {stored && !isTypeNode(stored) && <option value={stored}>{stored}</option>}
        {GROUPS.map((g) => (
          <optgroup key={g.root} label={typeLabel(g.root)}>
            {g.nodes.map((n) => (
              <option key={n.type} value={n.type}>
                {"  ".repeat(n.depth) + typeLabel(n.type)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {fromRole && (
        <span className="shrink-0 text-[11px] text-muted-foreground" title="No Type set: this one follows from the role">
          from role: {typeLabel(fromRole)}
        </span>
      )}
    </>
  );
}

/** Comma-separated, trimmed, lower case (spaces → "-", as tagsOf reads them), de-duplicated. */
function normalizeTags(text: string): string {
  const out: string[] = [];
  for (const part of text.split(",")) {
    const t = part.trim().toLowerCase().replace(/\s+/g, "-");
    if (t && !out.includes(t)) out.push(t);
  }
  return out.join(",");
}

/**
 * The Thing's Tags (`attributes.tags`), saved on blur. `brand` counts as a tag
 * too and shows as a chip next to the field.
 */
export function TagsField({
  attributes,
  disabled,
  onSave,
}: {
  attributes: Attrs;
  disabled?: boolean;
  onSave: (tags: string | null) => void;
}) {
  const current = attributes?.tags == null ? "" : String(attributes.tags);
  const brand = attributes?.brand == null || attributes.brand === "" ? null : String(attributes.brand).trim().toLowerCase().replace(/\s+/g, "-");
  const brandImplicit = brand != null && !current.split(",").map((t) => t.trim().toLowerCase()).includes(brand);
  return (
    <>
      <span className="micro-label shrink-0">Tags</span>
      <input
        key={current}
        aria-label="Tags"
        className="h-7 w-44 shrink-0 rounded-md border border-input bg-white px-1.5 text-[12px]"
        placeholder="e.g. apple, office"
        defaultValue={current.split(",").filter(Boolean).join(", ")}
        disabled={disabled}
        onBlur={(e) => {
          const next = normalizeTags(e.target.value);
          if (next !== normalizeTags(current)) onSave(next || null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      {brandImplicit && (
        <span
          className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
          title="The brand counts as a tag"
        >
          {brand}
        </span>
      )}
    </>
  );
}
