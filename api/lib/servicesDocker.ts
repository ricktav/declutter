/** Parse `docker ps` JSON or TSV into container records for services.report. */

export type DockerMount = {
  source: string;
  dest: string;
  type?: string;
  size?: number;
};

export type DockerContainer = {
  name: string;
  status?: string;
  image?: string;
  port?: number;
  ports?: number[];
  size?: number;
  imageSize?: number;
  layers?: number;
  created?: string;
  mounts?: DockerMount[];
};

/** Host ports published on the container (`8001` from `0.0.0.0:8001->8000`). */
export function extractPublishedPorts(raw: string): number[] {
  const s = String(raw ?? "");
  const seen = new Set<number>();
  const add = (n: number) => {
    if (Number.isInteger(n) && n > 0 && n <= 65535) seen.add(n);
  };
  for (const m of s.matchAll(/:(\d{2,5})->/g)) add(Number(m[1]));
  if (seen.size === 0) {
    for (const m of s.matchAll(/:(\d{2,5})\b/g)) add(Number(m[1]));
  }
  return [...seen];
}

/** Map docker Status/State to a short Systems status. Unhealthy → warn. */
export function dockerHealthStatus(status: string, state?: string): string | undefined {
  const blob = `${state ?? ""} ${status ?? ""}`.trim();
  if (!blob) return undefined;
  if (/\bunhealthy\b/i.test(blob)) return "warn";
  if (/\bhealthy\b/i.test(blob)) return "ok";
  if (/\brestarting\b/i.test(blob)) return "warn";
  const exited = blob.match(/\bexited\s*\((\d+)\)/i);
  if (exited) return exited[1] === "0" ? "stopped" : "error";
  if (/\b(exited|stopped|dead|paused)\b/i.test(blob)) return "stopped";
  if (/^up\b/i.test(status.trim()) || /\brunning\b/i.test(blob)) return "ok";
  return blob.slice(0, 32);
}

/** `1.084kB (virtual 187MB)` from `docker ps --size` → writable bytes + image bytes. */
export function parseDockerSizeField(raw: string): { size?: number; imageSize?: number } {
  const parts = String(raw ?? "").match(/([\d.]+)\s*([KMGT]i?B)/gi) ?? [];
  const nums = parts.map((p) => {
    const m = p.match(/([\d.]+)\s*([KMGT]i?B)/i);
    if (!m) return undefined;
    const n = Number(m[1]);
    const u = m[2].toUpperCase();
    const mul = u.startsWith("K") ? 1e3 : u.startsWith("M") ? 1e6 : u.startsWith("G") ? 1e9 : u.startsWith("T") ? 1e12 : 1;
    return Number.isFinite(n) ? n * mul : undefined;
  }).filter((n): n is number => n != null && n > 0);
  if (!nums.length) return {};
  const size = nums[0];
  const imageSize = nums[1] != null && nums[1] > size ? nums[1] : undefined;
  return { ...(size ? { size } : {}), ...(imageSize ? { imageSize } : {}) };
}

function recFromFields(nameRaw: string, imageRaw: string, portsRaw: string, statusRaw: string, stateRaw?: string, sizeRaw?: string): DockerContainer | null {
  const name = String(nameRaw ?? "")
    .replace(/^\//, "")
    .split(",")[0]
    .trim();
  if (!name) return null;
  const image = String(imageRaw ?? "").trim().slice(0, 128);
  const status = dockerHealthStatus(String(statusRaw ?? ""), stateRaw);
  const ports = extractPublishedPorts(String(portsRaw ?? ""));
  const rec: DockerContainer = { name: name.slice(0, 64) };
  if (status) rec.status = status;
  if (image) rec.image = image;
  if (ports[0] != null) rec.port = ports[0];
  if (ports.length > 1) rec.ports = ports;
  const sizes = parseDockerSizeField(sizeRaw ?? "");
  if (sizes.size) rec.size = sizes.size;
  if (sizes.imageSize) rec.imageSize = sizes.imageSize;
  return rec;
}

function parseJsonLine(line: string): DockerContainer | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const name = String(o.Names ?? o.names ?? o.Name ?? "");
  const image = String(o.Image ?? o.image ?? "");
  const ports = String(o.Ports ?? o.ports ?? o.Publishers ?? "");
  const status = String(o.Status ?? o.status ?? "");
  const state = o.State != null ? String(o.State) : undefined;
  const size = o.Size != null ? String(o.Size) : undefined;
  return recFromFields(name, image, ports, status, state, size);
}

function parseTsvLine(line: string): DockerContainer | null {
  const cols = line.split("\t");
  if (cols.length < 2) return null;
  const [name, image, ports, status, size] = cols;
  if (/^names$/i.test(name.trim())) return null;
  return recFromFields(name, image ?? "", ports ?? "", status ?? "", undefined, size);
}

/** One container per line: docker JSON (`{{json .}}`) or TSV Names/Image/Ports/Status. */
export function parseDockerPs(text: string): DockerContainer[] {
  const seen = new Set<string>();
  const out: DockerContainer[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const rec = t.startsWith("{") ? parseJsonLine(t) : parseTsvLine(t);
    if (!rec) continue;
    const k = rec.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(rec);
  }
  return out;
}

function asRec(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function createdDay(raw: unknown): string | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s.slice(0, 32);
}

export function parseDockerInspect(json: unknown): Map<string, Partial<DockerContainer>> {
  const rows = Array.isArray(json) ? json : json ? [json] : [];
  const out = new Map<string, Partial<DockerContainer>>();
  for (const row of rows) {
    const o = asRec(row);
    if (!o) continue;
    const name = String(o.Name ?? o.Names ?? "")
      .replace(/^\//, "")
      .split(",")[0]
      .trim();
    if (!name) continue;
    const cfg = asRec(o.Config);
    const image = String(cfg?.Image ?? o.Image ?? "").trim() || undefined;
    const mounts: DockerMount[] = [];
    const rawMounts = Array.isArray(o.Mounts) ? o.Mounts : [];
    for (const m of rawMounts) {
      const mo = asRec(m);
      if (!mo) continue;
      const dest = String(mo.Destination ?? mo.Target ?? "").trim();
      const source = String(mo.Name ?? mo.Source ?? "").trim();
      if (!dest && !source) continue;
      const type = String(mo.Type ?? "").trim() || undefined;
      mounts.push({ source: (source || dest).slice(0, 255), dest: (dest || source).slice(0, 255), ...(type ? { type } : {}) });
    }
    const size = typeof o.SizeRw === "number" && o.SizeRw > 0 ? o.SizeRw : undefined;
    const imageSize = typeof o.SizeRootFs === "number" && o.SizeRootFs > 0 ? o.SizeRootFs : undefined;
    out.set(name.toLowerCase(), {
      ...(image ? { image: image.slice(0, 128) } : {}),
      ...(size ? { size } : {}),
      ...(imageSize ? { imageSize } : {}),
      ...(createdDay(o.Created) ? { created: createdDay(o.Created) } : {}),
      ...(mounts.length ? { mounts } : {}),
    });
  }
  return out;
}

export function parseDockerImageInspect(json: unknown): Map<string, { imageSize?: number; layers?: number; created?: string }> {
  const rows = Array.isArray(json) ? json : json ? [json] : [];
  const out = new Map<string, { imageSize?: number; layers?: number; created?: string }>();
  for (const row of rows) {
    const o = asRec(row);
    if (!o) continue;
    const root = asRec(o.RootFS);
    const layers = Array.isArray(root?.Layers) ? root.Layers.length : undefined;
    const imageSize = typeof o.Size === "number" && o.Size > 0 ? o.Size : undefined;
    const created = createdDay(o.Created);
    const tags = Array.isArray(o.RepoTags) ? o.RepoTags.map((t) => String(t)) : [];
    const id = String(o.Id ?? "").replace(/^sha256:/, "").slice(0, 12);
    const keys = [...tags, id].filter(Boolean);
    const rec = { ...(imageSize ? { imageSize } : {}), ...(layers ? { layers } : {}), ...(created ? { created } : {}) };
    for (const k of keys) out.set(k, rec);
  }
  return out;
}

/** `docker system df -v` Local Volumes table → volume name → bytes. */
export function parseDockerSystemDf(text: string): Map<string, number> {
  const out = new Map<string, number>();
  let inVols = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^local volumes/i.test(line.trim())) {
      inVols = true;
      continue;
    }
    if (inVols && /^[A-Z].+:/.test(line.trim()) && !/^VOLUME/i.test(line)) {
      inVols = false;
    }
    if (!inVols) continue;
    if (/^VOLUME NAME/i.test(line) || !line.trim()) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3) continue;
    const name = cols[0];
    const sizeRaw = cols[cols.length - 1];
    const parsed = parseDockerSizeField(sizeRaw).size;
    if (name && parsed) out.set(name, parsed);
  }
  return out;
}

export function enrichDockerContainers(
  containers: DockerContainer[],
  inspect?: unknown,
  images?: unknown,
  dfText?: string,
): DockerContainer[] {
  const byName = inspect != null ? parseDockerInspect(inspect) : new Map();
  const byImage = images != null ? parseDockerImageInspect(images) : new Map();
  const volSize = dfText ? parseDockerSystemDf(dfText) : new Map();
  return containers.map((c) => {
    const extra = byName.get(c.name.toLowerCase()) ?? {};
    const imgKey = c.image ?? extra.image;
    const img = imgKey
      ? byImage.get(imgKey) ??
        [...byImage.entries()].find(([k]) => k === imgKey || k.startsWith(`${imgKey}:`) || k.endsWith(`/${imgKey}`))?.[1]
      : undefined;
    const mounts = (extra.mounts ?? c.mounts ?? []).map((m: DockerMount) => {
      const size = m.size ?? (m.source ? volSize.get(m.source) : undefined);
      return size ? { ...m, size } : m;
    });
    return {
      ...c,
      ...extra,
      ...(img?.imageSize ? { imageSize: img.imageSize } : {}),
      ...(img?.layers ? { layers: img.layers } : {}),
      ...(img?.created && !extra.created && !c.created ? { created: img.created } : {}),
      ...(mounts.length ? { mounts } : {}),
    };
  });
}

export function dockerPathEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = env.HOME ?? env.USERPROFILE ?? "";
  const extra = home ? `${home}/.orbstack/bin` : "";
  const path = [extra, env.PATH ?? ""].filter(Boolean).join(":");
  return { ...env, PATH: path };
}
