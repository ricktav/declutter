/** Parse a claudemux (or similar) fleet HTML/JSON snapshot into per-host container lists. */

export type FleetContainer = {
  name: string;
  status?: string;
  image?: string;
  port?: number;
  url?: string;
};

export type FleetHost = {
  host: string;
  containers: FleetContainer[];
  node: FleetContainer[];
  web: { label: string; url?: string; port?: number }[];
};

export type MachineHint = {
  id: number;
  name: string;
  hostname?: string | null;
  host?: string | null;
  ip?: string | null;
};

function asRecord(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function str(x: unknown): string | null {
  if (x == null) return null;
  const s = String(x).trim();
  return s ? s : null;
}

function portOf(x: unknown): number | undefined {
  if (x == null || x === "") return undefined;
  if (typeof x === "number" && Number.isFinite(x) && x > 0 && x <= 65535) return x;
  const s = String(x);
  const m = s.match(/(?:[:\s,]|^)(\d{2,5})(?:\/tcp|\/udp)?(?:\s|$|,)/i);
  const n = Number(m?.[1] ?? s);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
}

function asContainer(x: unknown): FleetContainer | null {
  if (typeof x === "string" || typeof x === "number") {
    const name = String(x).trim().replace(/^\//, "");
    return name ? { name } : null;
  }
  const o = asRecord(x);
  if (!o) return null;
  const name = str(o.name ?? o.Names ?? o.container ?? o.id ?? o.Id)?.replace(/^\//, "");
  if (!name) return null;
  const status = str(o.status ?? o.State ?? o.Status ?? o.state);
  const image = str(o.image ?? o.Image);
  const url = str(o.url);
  const port = portOf(o.port ?? o.Ports ?? o.ports);
  return { name, ...(status ? { status } : {}), ...(image ? { image } : {}), ...(port != null ? { port } : {}), ...(url ? { url } : {}) };
}

function asWeb(x: unknown): { label: string; url?: string; port?: number } | null {
  if (typeof x === "number") return { label: `:${x}`, port: x };
  if (typeof x === "string") {
    const s = x.trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return { label: s.replace(/^https?:\/\//i, "").slice(0, 40), url: s };
    return { label: s };
  }
  const o = asRecord(x);
  if (!o) return null;
  const url = str(o.url);
  const port = portOf(o.port);
  const label = str(o.label ?? o.name ?? (port != null ? `:${port}` : url));
  if (!label) return null;
  return { label, ...(url ? { url } : {}), ...(port != null ? { port } : {}) };
}

function listOf(x: unknown): unknown[] {
  if (x == null || x === "") return [];
  if (Array.isArray(x)) return x;
  if (typeof x === "string") {
    const t = x.trim();
    if (t.startsWith("[")) {
      try {
        const v = JSON.parse(t) as unknown;
        return Array.isArray(v) ? v : [v];
      } catch {
        /* split */
      }
    }
    return t.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof x === "object") return [x];
  return [x];
}

function hostNameOf(o: Record<string, unknown>): string | null {
  return str(o.host ?? o.hostname ?? o.machine ?? o.name ?? o.Name ?? o.item);
}

function pickLists(o: Record<string, unknown>): Pick<FleetHost, "containers" | "node" | "web"> {
  const containers = [
    ...listOf(o.containers),
    ...listOf(o.docker),
    ...listOf(o.services),
    ...listOf(o.compose),
  ]
    .map(asContainer)
    .filter((c): c is FleetContainer => c != null);
  const node = listOf(o.node ?? o.nodes ?? o.processes)
    .map(asContainer)
    .filter((c): c is FleetContainer => c != null);
  const web = listOf(o.web ?? o.pwa ?? o.urls ?? o.pages)
    .map(asWeb)
    .filter((w): w is NonNullable<typeof w> => w != null);
  const seen = new Set<string>();
  const uniq = (xs: FleetContainer[]) =>
    xs.filter((c) => {
      const k = c.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  return { containers: uniq(containers), node: uniq(node), web };
}

function pushHost(out: FleetHost[], host: string, lists: Pick<FleetHost, "containers" | "node" | "web">) {
  if (!lists.containers.length && !lists.node.length && !lists.web.length) return;
  const prev = out.find((h) => normHost(h.host) === normHost(host));
  if (prev) {
    prev.containers.push(...lists.containers);
    prev.node.push(...lists.node);
    prev.web.push(...lists.web);
    return;
  }
  out.push({ host, ...lists });
}

function walk(x: unknown, out: FleetHost[], depth: number) {
  if (depth > 6 || x == null) return;
  if (Array.isArray(x)) {
    for (const el of x) walk(el, out, depth + 1);
    return;
  }
  const o = asRecord(x);
  if (!o) return;
  const host = hostNameOf(o);
  const lists = pickLists(o);
  if (host && (lists.containers.length || lists.node.length || lists.web.length)) {
    pushHost(out, host, lists);
  }
  for (const [k, v] of Object.entries(o)) {
    if (["containers", "docker", "services", "compose", "node", "nodes", "web", "pwa", "urls", "pages"].includes(k)) continue;
    if (Array.isArray(v) || (v && typeof v === "object")) {
      const nested = asRecord(v);
      if (nested && !hostNameOf(nested) && (pickLists(nested).containers.length || pickLists(nested).node.length)) {
        pushHost(out, k, pickLists(nested));
      } else {
        walk(v, out, depth + 1);
      }
    }
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseHtmlTables(html: string): FleetHost[] {
  const out: FleetHost[] = [];
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  for (const table of tables) {
    const rows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
    if (rows.length < 2) continue;
    const cell = (row: string) =>
      [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
        decodeEntities(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()),
      );
    const headers = cell(rows[0]).map((h) => h.toLowerCase());
    const hostIdx = headers.findIndex((h) => /host|machine|name|node/.test(h) && !/container/.test(h));
    const contIdx = headers.findIndex((h) => /container|docker|service|compose/.test(h));
    if (hostIdx < 0) continue;
    for (const row of rows.slice(1)) {
      const cols = cell(row);
      const host = cols[hostIdx];
      if (!host) continue;
      const raw = contIdx >= 0 ? cols[contIdx] : cols.filter((_, i) => i !== hostIdx).join(", ");
      const containers = raw
        .split(/[\n,;|]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((name) => ({ name }));
      if (containers.length) pushHost(out, host, { containers, node: [], web: [] });
    }
  }
  return out;
}

function extractJsonBlobs(text: string): unknown[] {
  const blobs: unknown[] = [];
  const tryParse = (raw: string) => {
    try {
      blobs.push(JSON.parse(raw) as unknown);
    } catch {
      /* ignore */
    }
  };
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) tryParse(trimmed);
  for (const m of text.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    tryParse(m[1].trim());
  }
  for (const m of text.matchAll(/(?:window\.)?(?:FLEET|fleetData|FLEET_DATA|hosts)\s*=\s*(\{[\s\S]*?\}|\[[\s\S]*?\]);/g)) {
    tryParse(m[1]);
  }
  return blobs;
}

export function parseFleetDocument(text: string): FleetHost[] {
  const out: FleetHost[] = [];
  for (const blob of extractJsonBlobs(text)) walk(blob, out, 0);
  if (out.length === 0 && /<table/i.test(text)) {
    for (const h of parseHtmlTables(text)) pushHost(out, h.host, h);
  }
  for (const h of out) {
    const seen = new Set<string>();
    h.containers = h.containers.filter((c) => {
      const k = c.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return out.filter((h) => h.containers.length || h.node.length || h.web.length);
}

export function normHost(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\.local$/, "")
    .replace(/\.(lan|home|internal)$/, "")
    .replace(/[^a-z0-9]+/g, "");
}

/** First machine whose name, hostname, host or IP matches the fleet host label. */
export function matchMachine(host: string, machines: MachineHint[]): MachineHint | null {
  const n = normHost(host);
  if (!n) return null;
  const score = (m: MachineHint) => {
    const keys = [m.name, m.hostname, m.host, m.ip].filter(Boolean).map((x) => normHost(String(x)));
    if (keys.includes(n)) return 2;
    if (keys.some((k) => k.includes(n) || n.includes(k))) return 1;
    return 0;
  };
  let best: MachineHint | null = null;
  let bestScore = 0;
  for (const m of machines) {
    const s = score(m);
    if (s > bestScore) {
      best = m;
      bestScore = s;
    }
  }
  return bestScore > 0 ? best : null;
}
