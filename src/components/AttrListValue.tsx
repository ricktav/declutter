import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtBytes, hostHref, portHref, rewriteLocalHostUrl, statusTone, worstStatusTone, type StatusTone } from "../../api/lib/serviceUrls.ts";
import {
  PROJECT_KIND_COLOR,
  fmtAgo,
  fmtMinutes,
  fmtTokens,
  inferProjectStatus,
  projectFade,
} from "../../api/lib/servicesProjects.ts";

const LIST_KEYS = new Set(["containers", "docker", "node", "web", "vms", "lxc", "services", "databases", "projects"]);
const COLLAPSE_KEYS = new Set(["containers", "docker", "web", "vms", "lxc", "databases", "projects", "node"]);
export const MACHINE_CORE_LIST_ATTRS = ["databases", "projects", "node"] as const;

export function isJsonListAttr(key: string): boolean {
  return LIST_KEYS.has(key);
}

const LIST_LABELS: Record<string, string> = {
  containers: "Containers",
  docker: "Containers",
  web: "Web",
  node: "AI harness / CLI",
  vms: "VMs",
  lxc: "LXC",
  services: "Services",
  databases: "Databases",
  projects: "Projects",
};

export function jsonListAttrLabel(key: string): string | undefined {
  return LIST_LABELS[key];
}

function parseArray(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  const s = String(v ?? "").trim();
  if (!s.startsWith("[")) return null;
  try {
    const a = JSON.parse(s) as unknown;
    return Array.isArray(a) ? a : null;
  } catch {
    return null;
  }
}

export function prettyJsonList(v: unknown): string {
  const a = parseArray(v);
  return a ? JSON.stringify(a, null, 2) : String(v ?? "");
}

export function compactJsonList(s: string): string {
  const t = s.trim();
  if (!t.startsWith("[")) return s;
  try {
    const a = JSON.parse(t) as unknown;
    return Array.isArray(a) ? JSON.stringify(a) : s;
  } catch {
    return s;
  }
}

export function parsePortValues(v: unknown): number[] {
  const out: number[] = [];
  const add = (n: number) => {
    if (Number.isInteger(n) && n > 0 && n <= 65535 && !out.includes(n)) out.push(n);
  };
  if (Array.isArray(v)) {
    for (const x of v) add(Number(x));
    return out;
  }
  const s = String(v ?? "").trim();
  if (!s) return out;
  if (s.startsWith("[")) {
    try {
      const a = JSON.parse(s) as unknown;
      if (Array.isArray(a)) {
        for (const x of a) {
          if (x && typeof x === "object" && "port" in x) add(Number((x as { port: unknown }).port));
          else add(Number(x));
        }
        return out;
      }
    } catch {
      /* fall through */
    }
  }
  for (const m of s.matchAll(/:?(\d{2,5})\b/g)) add(Number(m[1]));
  return out;
}

function asRec(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return v == null || v === "" ? "" : String(v);
}

function nums(v: unknown): number[] {
  return parsePortValues(v);
}

function fmtDiskGb(g: number): string {
  if (!(g > 0)) return "";
  if (g < 0.01) return `${Math.round(g * 1024)} MB`;
  return `${g} GB`;
}

const TINY_FIRMWARE_MIB = 16;

function isTinyFirmwareDisk(name: string, sizeGb: number): boolean {
  if (!/^(efidisk|tpmstate)\d+$/i.test(name)) return false;
  return sizeGb > 0 && sizeGb * 1024 <= TINY_FIRMWARE_MIB + 0.5;
}

function fmtGibBytes(n: number): string {
  if (!(n > 0) || !Number.isFinite(n)) return "";
  const gib = n / (1024 * 1024 * 1024);
  if (gib < 0.01) return `${Math.round(n / (1024 * 1024))} MB`;
  if (gib < 1) return `${Math.round(gib * 1000) / 1000} GB`;
  return `${Math.round(gib * 10) / 10} GB`;
}

type Mount = { source: string; dest: string; type?: string; size?: number };

function mountsOf(o: Record<string, unknown>): Mount[] {
  const raw = o.mounts;
  if (!Array.isArray(raw)) return [];
  const out: Mount[] = [];
  for (const x of raw) {
    const m = asRec(x);
    if (!m) continue;
    const source = str(m.source).trim();
    const dest = str(m.dest).trim();
    if (!source && !dest) continue;
    const size = Number(m.size);
    const rec: Mount = { source: source || dest, dest: dest || source };
    const type = str(m.type);
    if (type) rec.type = type;
    if (Number.isFinite(size) && size > 0) rec.size = size;
    out.push(rec);
  }
  return out;
}

type TableRow = {
  key: string;
  status: string;
  tone: StatusTone;
  name: string;
  id: string;
  ports: number[];
  hrefs: string[];
  sizeLabel: string;
  sizeBytes: number;
  extra: string[];
  mounts: Mount[];
  fade?: number;
  kindColor?: string;
  reach?: string | null;
};

function rowFrom(key: string, x: unknown, i: number, reach: string | null): TableRow | null {
  if (typeof x === "string" || typeof x === "number") {
    const name = String(x).trim();
    if (!name) return null;
    return { key: `${name}-${i}`, status: "", tone: "dim", name, id: "", ports: [], hrefs: [], sizeLabel: "", sizeBytes: 0, extra: [], mounts: [], fade: 1 };
  }
  const o = asRec(x);
  if (!o) return null;
  const hrefs: string[] = [];
  const addHref = (u: string) => {
    const s = rewriteLocalHostUrl(u, reach);
    if (s && /^https?:\/\//i.test(s) && !hrefs.includes(s)) hrefs.push(s);
  };
  addHref(str(o.url));
  if (Array.isArray(o.urls)) for (const u of o.urls) addHref(str(u));

  if (key === "web") {
    const name = str(o.label ?? o.name).trim();
    if (!name) return null;
    const status = str(o.status);
    return {
      key: `${name}-${i}`,
      status,
      tone: statusTone(status) ?? "dim",
      name,
      id: "",
      ports: nums([o.port, o.ports]),
      hrefs,
      sizeLabel: "",
      sizeBytes: 0,
      extra: [],
      mounts: [],
    };
  }
  if (key === "databases") {
    const name = str(o.name ?? o.db ?? o.database).trim();
    if (!name) return null;
    const status = str(o.status);
    const size = Number(o.size);
    const engine = str(o.engine ?? o.type);
    return {
      key: `${name}-${i}`,
      status,
      tone: statusTone(status) ?? (status ? "ok" : "dim"),
      name,
      id: engine,
      ports: nums([o.port, o.ports]),
      hrefs,
      sizeLabel: Number.isFinite(size) && size > 0 ? (size >= 1024 ? fmtBytes(size) : `${size}`) : "",
      sizeBytes: Number.isFinite(size) && size > 0 ? size : 0,
      extra: [str(o.target), str(o.detail), str(o.checked)].filter(Boolean),
      mounts: [],
      fade: 1,
    };
  }
  if (key === "projects") {
    const name = str(o.name ?? o.project ?? o.path).trim();
    if (!name) return null;
    const kind = str(o.kind ?? o.agent);
    const status = inferProjectStatus(str(o.status) || undefined, str(o.updatedAt) || undefined);
    const tokens = Number(o.tokens);
    const size = Number(o.size);
    const minutes = Number(o.minutes);
    const fade = projectFade(status, str(o.updatedAt) || undefined);
    const path = str(o.path);
    const extra = [
      path && path !== name ? path : "",
      fmtMinutes(Number.isFinite(minutes) && minutes > 0 ? minutes : undefined),
      fmtAgo(str(o.updatedAt) || undefined),
    ].filter(Boolean);
    const tokenLabel = Number.isFinite(tokens) && tokens > 0 ? fmtTokens(tokens) : "";
    const byteLabel = Number.isFinite(size) && size > 0 ? fmtBytes(size) : "";
    return {
      key: `${kind}:${name}-${i}`,
      status,
      tone: /^(active|running|ok|live)$/i.test(status) ? "ok" : fade < 0.6 ? "dim" : statusTone(status) ?? "dim",
      name,
      id: kind,
      ports: nums([o.port, o.ports]),
      hrefs,
      sizeLabel: tokenLabel || byteLabel,
      sizeBytes: Number.isFinite(tokens) && tokens > 0 ? tokens : Number.isFinite(size) && size > 0 ? size : 0,
      extra,
      mounts: [],
      fade,
      kindColor: kind ? PROJECT_KIND_COLOR[kind.toLowerCase()] : undefined,
    };
  }
  if (key === "vms" || key === "lxc") {
    const vmid = o.vmid != null ? String(o.vmid) : "";
    const name = str(o.name).trim() || vmid;
    if (!name) return null;
    const status = str(o.status);
    const template = o.template === true || o.template === 1;
    const diskGb = Number(o.diskGb);
    const usedGb = Number(o.usedGb);
    const sizeBytes = Number.isFinite(diskGb) && diskGb > 0 ? diskGb * 1024 * 1024 * 1024 : 0;
    const extra = [
      o.memMb != null ? `${o.memMb} MB` : "",
      Number.isFinite(usedGb) && usedGb > 0 ? `${usedGb} GB used` : "",
      template ? "template" : "",
    ].filter(Boolean);
    if (Array.isArray(o.disks)) {
      let hasEfi = false;
      let hasTpm = false;
      for (const d of o.disks) {
        const rec = asRec(d);
        if (!rec) continue;
        const n = str(rec.name);
        const g = Number(rec.sizeGb);
        if (n && Number.isFinite(g) && isTinyFirmwareDisk(n, g)) {
          if (/^efidisk/i.test(n)) hasEfi = true;
          if (/^tpmstate/i.test(n)) hasTpm = true;
          continue;
        }
        const storage = str(rec.storage);
        const size = Number.isFinite(g) && g > 0 ? fmtDiskGb(g) : "";
        if (n && size) extra.push(storage ? `${n} ${storage} ${size}` : `${n} ${size}`);
      }
      if (hasEfi && hasTpm) extra.push("efi+tpm");
      else if (hasEfi) extra.push("efi");
      else if (hasTpm) extra.push("tpm");
    }
    const ip = str(o.ip).trim();
    if (ip && !extra.includes(ip)) extra.unshift(ip);
    return {
      key: `${vmid || name}-${i}`,
      status,
      tone: template ? "dim" : statusTone(status) ?? "dim",
      name,
      id: vmid,
      ports: nums([o.port, o.ports]),
      hrefs,
      sizeLabel: Number.isFinite(diskGb) && diskGb > 0 ? `${diskGb} GB` : "",
      sizeBytes,
      extra,
      mounts: mountsOf(o),
      reach: ip || null,
    };
  }
  const name = str(o.name ?? o.unit ?? o.container).trim();
  if (!name) return null;
  const status = str(o.status);
  const size = Number(o.size);
  const imageSize = Number(o.imageSize);
  const extra = [
    Number.isFinite(imageSize) && imageSize > 0 ? `img ${fmtBytes(imageSize)}` : "",
    o.layers != null && Number(o.layers) > 0 ? `${o.layers} layers` : "",
    str(o.created),
  ].filter(Boolean);
  return {
    key: `${name}-${i}`,
    status,
    tone: statusTone(status) ?? "dim",
    name,
    id: str(o.image),
    ports: nums([o.port, o.ports]),
    hrefs,
    sizeLabel: fmtBytes(size),
    sizeBytes: Number.isFinite(size) && size > 0 ? size : 0,
    extra,
    mounts: mountsOf(o),
  };
}

function StatusDot({ tone, title }: { tone: StatusTone; title?: string }) {
  const cls =
    tone === "ok"
      ? "bg-emerald-500"
      : tone === "warn"
        ? "bg-amber-500"
        : tone === "error"
          ? "bg-red-500"
          : "bg-neutral-400";
  return <span title={title} className={cn("inline-block h-2 w-2 rounded-full shrink-0", cls)} />;
}

export function PortLinks({ ports, reachHost }: { ports: number[]; reachHost?: string | null }) {
  if (!ports.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-x-1.5">
      {ports.map((p) => {
        const href = portHref(reachHost, p);
        const label = `:${p}`;
        return href ? (
          <a key={p} href={href} target="_blank" rel="noreferrer" className="text-primary hover:underline">
            {label}
          </a>
        ) : (
          <span key={p}>{label}</span>
        );
      })}
    </span>
  );
}

type SortKey = "name" | "status" | "id" | "size";

export function AttrListValue({
  attrKey,
  value,
  reachHost,
  label,
}: {
  attrKey: string;
  value: unknown;
  reachHost?: string | null;
  label?: string;
}) {
  const items = parseArray(value);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState(true);
  const rows = useMemo(() => {
    if (!items) return [];
    const list = items.map((x, i) => rowFrom(attrKey, x, i, reachHost ?? null)).filter((r): r is TableRow => r != null);
    const dir = sort.dir;
    list.sort((a, b) => {
      if (sort.key === "size") return (a.sizeBytes - b.sizeBytes) * dir;
      const av = (sort.key === "name" ? a.name : sort.key === "id" ? a.id : a.status).toLowerCase();
      const bv = (sort.key === "name" ? b.name : sort.key === "id" ? b.id : b.status).toLowerCase();
      return av.localeCompare(bv) * dir;
    });
    return list;
  }, [items, attrKey, reachHost, sort]);

  if (!items) {
    return <span className="font-data min-w-0 break-all">{String(value)}</span>;
  }

  const toggle = (k: SortKey) => setSort((s) => (s.key === k ? { key: k, dir: s.dir === 1 ? -1 : 1 } : { key: k, dir: 1 }));
  const th = (k: SortKey, heading: string, extra = "") => (
    <th className={cn("text-left font-medium text-muted-foreground px-1.5 py-1 whitespace-nowrap", extra)}>
      <button type="button" className="hover:text-foreground" onClick={() => toggle(k)}>
        {heading}
        {sort.key === k ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );

  const table =
    rows.length === 0 ? (
      <span className="text-muted-foreground">none</span>
    ) : (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full text-[12px] leading-snug">
        <thead className="hidden sm:table-header-group">
          <tr>
            <th className="w-4 px-1.5 py-1" />
            {th("name", "Name")}
            {th("id", attrKey === "vms" || attrKey === "lxc" ? "Id" : attrKey === "databases" ? "Engine" : attrKey === "projects" ? "Kind" : "Image")}
            <th className="text-left font-medium text-muted-foreground px-1.5 py-1">Ports</th>
            {th("size", "Size")}
            <th className="text-left font-medium text-muted-foreground px-1.5 py-1">Extra</th>
          </tr>
        </thead>
        <tbody className="sm:divide-y sm:divide-border">
          {rows.map((r) => (
            <tr
              key={r.key}
              className="block sm:table-row mb-2 sm:mb-0 rounded-md border border-border sm:border-0 p-2 sm:p-0"
              style={r.fade != null && r.fade < 1 ? { opacity: Math.max(0.28, r.fade) } : undefined}
            >
              <td className="block sm:table-cell px-1.5 py-1 align-top sm:w-4" data-label="">
                <span className="inline-flex items-center gap-1.5">
                  <StatusDot tone={r.tone} title={r.status || undefined} />
                  <span className="sm:hidden font-medium" style={r.kindColor ? { color: r.kindColor } : undefined}>
                    {r.name}
                  </span>
                </span>
              </td>
              <td
                className="hidden sm:table-cell px-1.5 py-1 align-top font-medium"
                data-label="Name"
                style={r.kindColor ? { color: r.kindColor } : undefined}
              >
                {r.name}
              </td>
              <td className="block sm:table-cell px-1.5 py-1 align-top text-muted-foreground break-all" data-label="Id">
                {r.id || <span className="sm:hidden">—</span>}
              </td>
              <td className="block sm:table-cell px-1.5 py-1 align-top" data-label="Ports">
                <PortLinks ports={r.ports} reachHost={r.reach ?? reachHost} />
                {r.hrefs.length > 0 && (
                  <span className="inline-flex flex-col">
                    {r.hrefs.map((h) => (
                      <a key={h} href={h} target="_blank" rel="noreferrer" className="text-primary hover:underline truncate max-w-[16rem]">
                        {h.replace(/^https?:\/\//, "")}
                      </a>
                    ))}
                  </span>
                )}
              </td>
              <td className="block sm:table-cell px-1.5 py-1 align-top tabular-nums" data-label="Size">
                {r.sizeLabel}
              </td>
              <td className="block sm:table-cell px-1.5 py-1 align-top text-muted-foreground" data-label="Extra">
                <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                  {r.extra.map((e) => {
                    const ipLink = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(e) ? hostHref(e) : null;
                    return ipLink ? (
                      <a key={e} href={ipLink} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                        {e}
                      </a>
                    ) : (
                      <span key={e}>{e}</span>
                    );
                  })}
                </div>
                {r.mounts.length > 0 && (
                  <div className="mt-0.5">
                    <button
                      type="button"
                      className="text-[11px] text-primary hover:underline"
                      onClick={() => setOpen((o) => ({ ...o, [r.key]: !o[r.key] }))}
                    >
                      {r.mounts.length} mount{r.mounts.length === 1 ? "" : "s"}
                    </button>
                    {open[r.key] && (
                      <ul className="mt-0.5 space-y-0.5 text-[11px]">
                        {r.mounts.map((m) => (
                          <li key={`${m.source}->${m.dest}`}>
                            {m.source} → {m.dest}
                            {m.type ? ` (${m.type})` : ""}
                            {m.size ? ` ${attrKey === "vms" || attrKey === "lxc" ? fmtGibBytes(m.size) : fmtBytes(m.size)}` : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    );

  if (!COLLAPSE_KEYS.has(attrKey)) {
    if (!label) return table;
    return (
      <div className="min-w-0">
        <div className="mb-1 text-muted-foreground">{label}</div>
        {table}
      </div>
    );
  }

  const title = label ?? jsonListAttrLabel(attrKey) ?? attrKey;
  const worst = worstStatusTone(rows.map((r) => r.tone));
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={!collapsed}
        className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
        onClick={() => setCollapsed((c) => !c)}
      >
        {collapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
        {worst ? <StatusDot tone={worst} title={worst} /> : null}
        <span>{title}</span>
        <span className="tabular-nums">{rows.length}</span>
      </button>
      {!collapsed && <div className="mt-1">{table}</div>}
    </div>
  );
}
