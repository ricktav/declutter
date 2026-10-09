/** Parse `docker ps` JSON or TSV into container records for services.report. */

export type DockerContainer = {
  name: string;
  status?: string;
  image?: string;
  port?: number;
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
  if (/\b(exited|stopped|dead|paused)\b/i.test(blob)) return "stopped";
  if (/^up\b/i.test(status.trim()) || /\brunning\b/i.test(blob)) return "ok";
  return blob.slice(0, 32);
}

function recFromFields(nameRaw: string, imageRaw: string, portsRaw: string, statusRaw: string, stateRaw?: string): DockerContainer | null {
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
  return recFromFields(name, image, ports, status, state);
}

function parseTsvLine(line: string): DockerContainer | null {
  const cols = line.split("\t");
  if (cols.length < 2) return null;
  const [name, image, ports, status] = cols;
  if (/^names$/i.test(name.trim())) return null;
  return recFromFields(name, image ?? "", ports ?? "", status ?? "");
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

export function dockerPathEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = env.HOME ?? env.USERPROFILE ?? "";
  const extra = home ? `${home}/.orbstack/bin` : "";
  const path = [extra, env.PATH ?? ""].filter(Boolean).join(":");
  return { ...env, PATH: path };
}
