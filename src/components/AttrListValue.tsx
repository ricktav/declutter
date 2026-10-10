import { cn } from "@/lib/utils";
import { rewriteLocalHostUrl, statusTone, type StatusTone } from "../../api/lib/serviceUrls";

const LIST_KEYS = new Set(["containers", "docker", "node", "web", "vms", "lxc", "services"]);

export function isJsonListAttr(key: string): boolean {
  return LIST_KEYS.has(key);
}

const LIST_LABELS: Record<string, string> = {
  containers: "Containers",
  docker: "Containers",
  web: "Web",
  node: "Node",
  vms: "VMs",
  lxc: "LXC",
  services: "Services",
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

type Row = {
  name: string;
  bits: string[];
  hrefs?: string[];
  tone?: StatusTone;
};

function asRec(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return v == null || v === "" ? "" : String(v);
}

function portsOf(o: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (n: unknown) => {
    const v = Number(n);
    if (Number.isInteger(v) && v > 0) out.push(`:${v}`);
  };
  add(o.port);
  if (Array.isArray(o.ports)) for (const p of o.ports) add(p);
  return [...new Set(out)];
}

function urlsOf(o: Record<string, unknown>, reach: string | null): string[] {
  const out: string[] = [];
  const add = (u: unknown) => {
    const raw = str(u).trim();
    const s = raw && /^https?:\/\//i.test(raw) ? rewriteLocalHostUrl(raw, reach) : "";
    if (s && !out.includes(s)) out.push(s);
  };
  add(o.url);
  if (Array.isArray(o.urls)) for (const u of o.urls) add(u);
  return out;
}

function diskBit(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? `${n} GB` : "";
}

function rowsFor(key: string, items: unknown[], reach: string | null): Row[] {
  return items
    .map((x): Row | null => {
      if (typeof x === "string" || typeof x === "number") {
        const name = String(x).trim();
        return name ? { name, bits: [] } : null;
      }
      const o = asRec(x);
      if (!o) return null;
      if (key === "web") {
        const name = str(o.label ?? o.name).trim();
        if (!name) return null;
        const bits = [...portsOf(o), str(o.status)].filter(Boolean);
        const hrefs = urlsOf(o, reach);
        return { name, bits, hrefs, tone: statusTone(str(o.status)) };
      }
      if (key === "vms" || key === "lxc") {
        const vmid = o.vmid != null ? String(o.vmid) : "";
        const name = str(o.name).trim() || vmid;
        if (!name) return null;
        const bits = [
          vmid && name !== vmid ? `#${vmid}` : "",
          str(o.status),
          o.memMb != null ? `${o.memMb} MB` : "",
          diskBit(o.diskGb),
          o.template === true || o.template === 1 ? "template" : "",
        ].filter(Boolean);
        const status = str(o.status);
        const tone = o.template === true || o.template === 1 ? "dim" : statusTone(status);
        return { name, bits, tone };
      }
      const name = str(o.name ?? o.unit ?? o.container).trim();
      if (!name) return null;
      const bits = [str(o.image), ...portsOf(o), str(o.status)].filter(Boolean);
      return { name, bits, hrefs: urlsOf(o, reach), tone: statusTone(str(o.status)) };
    })
    .filter((r): r is Row => r != null);
}

export function AttrListValue({
  attrKey,
  value,
  reachHost,
}: {
  attrKey: string;
  value: unknown;
  reachHost?: string | null;
}) {
  const items = parseArray(value);
  if (!items) {
    return <span className="font-data min-w-0 break-all">{String(value)}</span>;
  }
  const rows = rowsFor(attrKey, items, reachHost ?? null);
  if (rows.length === 0) {
    return <span className="text-muted-foreground">none</span>;
  }
  return (
    <ul className="min-w-0 w-full space-y-1">
      {rows.map((r, i) => (
        <li
          key={`${r.name}-${i}`}
          className={cn(
            "flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px] leading-snug",
            r.tone === "dim" && "opacity-50",
          )}
        >
          <span className="font-medium text-foreground">{r.name}</span>
          {r.bits.map((b) => (
            <span
              key={b}
              className={cn(
                "text-muted-foreground",
                r.tone === "warn" && /amber|warn|unhealthy|restarting|degraded/i.test(b) && "text-amber-700",
                r.tone === "error" && /red|error|down|fail/i.test(b) && "text-red-700",
              )}
            >
              {b}
            </span>
          ))}
          {(r.hrefs ?? []).map((href) => (
            <a
              key={href}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline truncate max-w-[16rem]"
            >
              {href.replace(/^https?:\/\//, "")}
            </a>
          ))}
        </li>
      ))}
    </ul>
  );
}
