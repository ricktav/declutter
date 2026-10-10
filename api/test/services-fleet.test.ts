import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  aggregateStatus,
  decodeEntities,
  groupWebServices,
  isJunkCell,
  matchMachine,
  parseFleetDocument,
  parseFleetDocumentWithMeta,
} from "../lib/servicesFleet";
import {
  countProjectsByKind,
  detectProjectKind,
  mergeProjectRecords,
  parseProjectsDocument,
  parseTokenCount,
  projectFade,
  projectMergeKey,
} from "../lib/servicesProjects";
import { pickReachHost, rewriteLocalHostUrl, statusTone, worstStatusTone } from "../lib/serviceUrls";

const snippet = readFileSync(path.join(import.meta.dirname, "fixtures/claudemux-fleet-snippet.html"), "utf8");
const projectsSnippet = readFileSync(path.join(import.meta.dirname, "fixtures/claude-projects-snippet.html"), "utf8");
const dbDirs = readFileSync(path.join(import.meta.dirname, "fixtures/claudemux-fleet-db-dirs.html"), "utf8");

describe("parseFleetDocument JSON", () => {
  it("reads a JSON array of hosts with docker lists", () => {
    const hosts = parseFleetDocument(
      JSON.stringify([
        { hostname: "dockermac-1", containers: [{ name: "nginx", status: "running", port: 80 }, "caddy"] },
        { host: "prodesk-rt1", docker: "homeassistant, mosquitto" },
      ]),
    );
    expect(hosts.map((h) => h.host)).toEqual(["dockermac-1", "prodesk-rt1"]);
    expect(hosts[0].containers.map((c) => c.name)).toEqual(["nginx", "caddy"]);
    expect(hosts[1].containers.map((c) => c.name)).toEqual(["homeassistant", "mosquitto"]);
  });

  it("reads host keys that map to container lists", () => {
    const hosts = parseFleetDocument(JSON.stringify({ fleet: { "mac-mini": { docker: ["syncthing"] } } }));
    expect(hosts.map((h) => h.host)).toEqual(["mac-mini"]);
    expect(hosts[0].containers.map((c) => c.name)).toEqual(["syncthing"]);
  });
});

describe("claudemux HTML fixture", () => {
  it("reads span.hname, mtx services-table, and every div.pd-row container", () => {
    const { hosts, skippedUnreachable } = parseFleetDocumentWithMeta(snippet);
    expect(hosts.map((h) => h.host).sort()).toEqual(["dockermac", "dockermac-2", "macmini-m4", "prodesk-rt1"]);
    expect(skippedUnreachable).toEqual(["macbook-air-m2", "mba-m4", "mbp"]);

    const mini = hosts.find((h) => h.host === "macmini-m4")!;
    expect(mini.ip).toBe("10.50.0.102");
    expect(mini.containers).toEqual([]);
    expect(mini.node.map((c) => c.name)).toEqual(["ls", "echo"]);
    expect(mini.web.map((w) => w.label)).toEqual(["Workbench", "HomeBase", "Flow", "Photos", "Ping"]);
    expect(mini.web).toHaveLength(5);

    const d2 = hosts.find((h) => h.host === "dockermac-2")!;
    expect(d2.ip).toBe("10.50.0.109");
    expect(d2.containers.map((c) => c.name)).toEqual([
      "caddy",
      "uptime-kuma",
      "ntfy",
      "authentik",
      "minio",
      "gitea",
      "changedetection",
    ]);
    expect(d2.web).toHaveLength(6);
    expect(d2.node.map((c) => c.name)).toEqual(["ls", "docker"]);

    const dock = hosts.find((h) => h.host === "dockermac")!;
    expect(dock.ip).toBe("10.50.0.10");
    expect(dock.containers).toHaveLength(23);
    expect(dock.containers[0]).toEqual({ name: "nginx", port: 80 });
    expect(snippet.match(/class="cname[^"]*">nginx/g)?.length).toBe(2);
    expect(dock.web).toHaveLength(20);
    expect(dock.databases).toEqual([expect.objectContaining({ name: "declutter", engine: "mysql" })]);

    expect(dock.node.map((c) => c.name)).toEqual(["ls", "docker", "plugwise"]);

    const pro = hosts.find((h) => h.host === "prodesk-rt1")!;
    expect(pro.ip).toBe("10.50.0.142");
    expect(pro.containers).toHaveLength(14);
    expect(pro.node.map((c) => c.name)).toEqual(["echo", "docker"]);
    expect(pro.web.map((w) => w.label)).toEqual([
      "portal/clawdy-portal",
      "caddy",
      "grafana",
      "home-assistant",
      "MQTT",
      "Plex",
      "SSH",
      "port:18790",
      "rick:8768",
    ]);
    expect(pro.web).toHaveLength(9);
    const portal = pro.web.find((w) => w.label === "portal/clawdy-portal")!;
    expect(portal.ports).toEqual([80, 443, 3463, 3466, 3473, 3476]);
    expect(portal.status).toBe("ok");
    expect(pro.web.find((w) => w.label === "caddy")?.ports).toEqual([80, 443]);
    expect(pro.web.find((w) => w.label === "grafana")?.ports).toEqual([3000, 8086]);
    expect(pro.web.find((w) => w.label === "home-assistant")?.ports).toEqual([8123, 8199]);
    expect(pro.web.find((w) => w.label === "home-assistant")?.status).toBe("ok");
    expect(pro.projects).toEqual([]);
    expect(pro.web.map((w) => w.label)).toContain("portal/clawdy-portal");

    const names = hosts.flatMap((h) => [h.host, ...h.containers.map((c) => c.name)]);
    expect(names).not.toEqual(expect.arrayContaining(["ls", "echo", "docker", "plugwise", "crontab"]));
    expect(hosts.some((h) => h.web.some((w) => w.label === "Public site"))).toBe(false);
    expect(hosts.some((h) => h.web.some((w) => w.label === "should-not-import"))).toBe(false);
  });

  it("falls back to the first span in .hh-l when span.hname is missing", () => {
    const html = `
      <section class="host">
        <div class="hh"><div class="hh-l"><span class="mono">lonely-box</span> host-9 · 10.50.0.9:8766 · responded</div></div>
        <table class="mtx services-table">
          <tr><th>label</th><th>url</th></tr>
          <tr><td>Ping</td><td>http://10.50.0.9:1</td></tr>
        </table>
      </section>`;
    const hosts = parseFleetDocument(html);
    expect(hosts).toEqual([
      expect.objectContaining({ host: "lonely-box", ip: "10.50.0.9", web: [expect.objectContaining({ label: "Ping" })] }),
    ]);
  });

  it("falls back to the first container in tr.pdrow when there are no div.pd-row", () => {
    const html = `
      <section class="host">
        <div class="hh"><div class="hh-l"><span class="hname mono">old-box</span> 10.9.9.9:8766</div></div>
        <table class="projects">
          <tr class="pdrow"><td><span class="pd-k">container</span> <span class="cname">alpha</span></td></tr>
          <tr class="pdrow"><td><span class="pd-k">ports</span> 80</td></tr>
          <tr class="pdrow"><td><span class="pd-k">container</span> <span class="cname">beta</span> <span class="port">:81</span></td></tr>
        </table>
      </section>`;
    expect(parseFleetDocument(html)[0].containers.map((c) => c.name)).toEqual(["alpha", "beta"]);
  });

  it("groups service rows by base label and lists nameless listeners last", () => {
    const grouped = groupWebServices([
      { label: "portal/clawdy-portal", url: "http://10.50.0.142:3463", port: 3463, status: "up" },
      { label: "portal/clawdy-portal", url: "http://10.50.0.142:3466", port: 3466, status: "up" },
      { label: "portal/clawdy-portal", url: "http://10.50.0.142:3473", port: 3473, status: "down" },
      { label: "portal/clawdy-portal", url: "http://10.50.0.142:3476", port: 3476, status: "up" },
      { label: "portal/clawdy-portal", url: "https://10.50.0.142:443", port: 443, status: "up" },
      { label: "portal/clawdy-portal", url: "http://10.50.0.142:80", port: 80, status: "up" },
      { label: "caddy/caddy:443", url: "https://10.50.0.142/", port: 443, status: "up" },
      { label: "caddy:80", url: "http://10.50.0.142/", port: 80, status: "up" },
      { label: "grafana:3000", url: "http://10.50.0.142:3000", port: 3000, status: "up" },
      { label: "grafana:8086", url: "http://10.50.0.142:8086", port: 8086, status: "up" },
      { label: "home-assistant:8123", url: "http://10.50.0.142:8123", port: 8123, status: "up" },
      { label: "home-assistant:8199", url: "http://10.50.0.142:8199", port: 8199, status: "down" },
      { label: "port:18790", url: "http://10.50.0.142:18790", port: 18790, status: "up" },
      { label: "rick:8768", url: "http://10.50.0.142:8768", port: 8768, status: "up" },
    ]);
    expect(grouped.map((w) => w.label)).toEqual([
      "portal/clawdy-portal",
      "caddy",
      "grafana",
      "home-assistant",
      "port:18790",
      "rick:8768",
    ]);
    expect(grouped[0].ports).toEqual([80, 443, 3463, 3466, 3473, 3476]);
    expect(grouped[0].urls).toHaveLength(6);
    expect(grouped[0].status).toBe("ok");
    expect(grouped.find((w) => w.label === "caddy")?.ports).toEqual([80, 443]);
    expect(grouped.at(-2)?.label).toBe("port:18790");
    expect(grouped.at(-1)?.label).toBe("rick:8768");
  });

  it("does not treat a generic Host/Containers table as the fleet", () => {
    const html = `
      <table>
        <tr><th>Host</th><th>Containers</th></tr>
        <tr><td>ls</td><td>crontab</td></tr>
      </table>`;
    expect(parseFleetDocument(html)).toEqual([]);
  });
});

describe("decodeEntities / junk cells", () => {
  it("decodes ndash and check marks and drops mark-only cells", () => {
    expect(decodeEntities("a &ndash; b")).toBe("a – b");
    expect(decodeEntities("&#x2713;")).toBe("✓");
    expect(decodeEntities("&#10003;")).toBe("✓");
    expect(isJunkCell("&#x2713;")).toBe(true);
    expect(isJunkCell("&ndash;")).toBe(true);
    expect(isJunkCell("nginx")).toBe(false);
  });
});

describe("matchMachine", () => {
  const machines = [
    { id: 1, name: "Docker Mac", hostname: "dockermac-1", ip: "10.50.0.10" },
    { id: 2, name: "Mac mini", hostname: "macmini-m4", ip: "10.50.0.102" },
    { id: 3, name: "Echo Dot", hostname: "echo-dot", ip: "10.50.0.50" },
    { id: 4, name: "smart display", hostname: "ls-display", ip: "10.50.0.60" },
    { id: 5, name: "rpi-plugwise", hostname: "rpi-plugwise", ip: "10.50.0.147" },
  ];

  it("matches hostname ignoring .local, not as a substring", () => {
    expect(matchMachine("macmini-m4", machines)?.id).toBe(2);
    expect(matchMachine("macmini-m4.local", machines)?.id).toBe(2);
    expect(matchMachine("docker", machines)).toBeNull();
    expect(matchMachine("echo", machines)).toBeNull();
    expect(matchMachine("ls", machines)).toBeNull();
    expect(matchMachine("plugwise", machines)).toBeNull();
  });

  it("uses exact IP only after hostname, so .102 does not hit .10", () => {
    expect(matchMachine({ host: "macmini-m4", ip: "10.50.0.102" }, machines)?.id).toBe(2);
    expect(matchMachine({ host: "unknown-box", ip: "10.50.0.102" }, machines)?.id).toBe(2);
    expect(matchMachine({ host: "unknown-box", ip: "10.50.0.10" }, machines)?.id).toBe(1);
    expect(matchMachine("10.50.0.102", machines)?.id).toBe(2);
    expect(matchMachine("10.50.0.10", machines)?.id).toBe(1);
  });

  it("prefers hostname over IP when they would disagree", () => {
    expect(matchMachine({ host: "macmini-m4", ip: "10.50.0.10" }, machines)?.id).toBe(2);
  });

  it("maps fleet hostname dockermac to dockermac-1 by exact IP", () => {
    expect(matchMachine({ host: "dockermac", ip: "10.50.0.10" }, machines)?.id).toBe(1);
  });

  it("matches host_alias / aliases after stripping .local, not hostname substrings", () => {
    const withAlias = [
      ...machines,
      { id: 233, name: "2014 MBP", hostname: "Ricks-MBP2014", ip: "10.50.0.201", hostAlias: "mbp" },
      { id: 9, name: "Air", hostname: "mba-m4", aliases: "mba, macbook-air-m2.local" },
    ];
    expect(matchMachine("mbp", withAlias)?.id).toBe(233);
    expect(matchMachine("mbp.local", withAlias)?.id).toBe(233);
    expect(matchMachine("Ricks-MBP2014.local", withAlias)?.id).toBe(233);
    expect(matchMachine("mba", withAlias)?.id).toBe(9);
    expect(matchMachine("macbook-air-m2", withAlias)?.id).toBe(9);
    expect(matchMachine("mbp", machines)).toBeNull();
  });
});

describe("localhost URLs and fleet status", () => {
  it("rewrites localhost / 127.0.0.1 / 0.0.0.0 to the machine IP", () => {
    expect(rewriteLocalHostUrl("http://localhost:3002/", "10.50.0.102")).toBe("http://10.50.0.102:3002/");
    expect(statusTone("exited (1)")).toBe("error");
    expect(statusTone("running")).toBe("ok");
    expect(rewriteLocalHostUrl("http://127.0.0.1:8001/x", "10.50.0.102")).toBe("http://10.50.0.102:8001/x");
    expect(rewriteLocalHostUrl("https://0.0.0.0:8443", "mini")).toBe("https://mini:8443/");
    expect(rewriteLocalHostUrl("http://10.50.0.10:3000/", "10.50.0.102")).toBe("http://10.50.0.10:3000/");
    expect(pickReachHost("10.50.0.102", "macmini-m4")).toBe("10.50.0.102");
    expect(pickReachHost(null, "macmini-m4")).toBe("macmini-m4");
    expect(pickReachHost("127.0.0.1", "macmini-m4")).toBe("macmini-m4");
  });

  it("rewrites localhost service URLs when parsing a host with an IP", () => {
    const html = `
      <section class="host">
        <div class="hh"><div class="hh-l"><span class="hname mono">macmini-m4</span> 10.50.0.102:8766</div></div>
        <table class="mtx services-table">
          <tr><th>label</th><th>url</th><th>status</th></tr>
          <tr><td>Workbench</td><td>http://localhost:3002/</td><td>ok</td></tr>
          <tr><td>Ping</td><td>http://127.0.0.1:3001/api/trpc/ping</td><td>amber</td></tr>
        </table>
      </section>`;
    const hosts = parseFleetDocument(html);
    expect(hosts[0].web.map((w) => w.url)).toEqual(["http://10.50.0.102:3002/", "http://10.50.0.102:3001/api/trpc/ping"]);
    expect(hosts[0].web.find((w) => w.label === "Ping")?.status).toBe("amber");
  });

  it("maps fleet ok / amber / red and keeps amber below red", () => {
    expect(statusTone("ok")).toBe("ok");
    expect(statusTone("amber")).toBe("warn");
    expect(statusTone("red")).toBe("error");
    expect(statusTone("unhealthy")).toBe("warn");
    expect(statusTone("stopped")).toBe("dim");
    expect(worstStatusTone(["ok", "dim", "warn"])).toBe("warn");
    expect(worstStatusTone(["ok", "error", "warn"])).toBe("error");
    expect(worstStatusTone(["dim", "ok"])).toBe("ok");
    expect(aggregateStatus(["ok", "amber"])).toBe("ok");
    expect(aggregateStatus(["amber", "red"])).toBe("red");
    expect(aggregateStatus(["amber"])).toBe("amber");
  });
});

describe("databases and coding-agent projects", () => {
  it("keeps mtx databases-table and does not lift web labels into projects", () => {
    const html = `
      <section class="host">
        <div class="hh"><div class="hh-l"><span class="hname mono">macmini-m4</span> 10.50.0.102:8766</div></div>
        <table class="mtx services-table">
          <tr><th>label</th><th>url</th><th>status</th></tr>
          <tr><td>Grok build</td><td>http://localhost:8787/</td><td>ok</td></tr>
          <tr><td>Hermes agent</td><td>http://10.50.0.102:8811/</td><td>ok</td></tr>
          <tr><td>OpenClaw</td><td>http://10.50.0.102:3463/</td><td>amber</td></tr>
          <tr><td>Threesum-grok/threesum-grok-threesum-tg-1</td><td>http://10.50.0.102:9001/</td><td>ok</td></tr>
          <tr><td>Workbench</td><td>http://10.50.0.102:3002/</td><td>ok</td></tr>
        </table>
        <table class="mtx databases-table">
          <tr><th>db</th><th>engine</th><th>status</th><th>port</th></tr>
          <tr><td>declutter</td><td>mysql</td><td>ok</td><td>3306</td></tr>
          <tr><td>grafana</td><td>postgres</td><td>ok</td><td>5432</td></tr>
        </table>
      </section>`;
    const hosts = parseFleetDocument(html);
    expect(hosts[0].databases).toEqual([
      expect.objectContaining({ name: "declutter", engine: "mysql", status: "ok", port: 3306 }),
      expect.objectContaining({ name: "grafana", engine: "postgres", port: 5432 }),
    ]);
    expect(hosts[0].projects).toEqual([]);
    expect(hosts[0].web.map((w) => w.label)).toEqual(
      expect.arrayContaining(["Grok build", "Hermes agent", "OpenClaw", "Threesum-grok/threesum-grok-threesum-tg-1", "Workbench"]),
    );
  });

  it("imports per-host project directory tables and skips container project tables", () => {
    const html = `
      <section class="host">
        <div class="hh"><div class="hh-l"><span class="hname mono">dockermac-2</span> 10.50.0.109:8766</div></div>
        <table class="projects">
          <tr class="pdrow"><td><span class="pd-k">container</span> <span class="cname">caddy</span></td></tr>
        </table>
        <table class="mtx projects-table">
          <tr><th>path</th><th>kind</th></tr>
          <tr><td>/Volumes/T7/declutter</td><td>claude</td></tr>
          <tr><td>/Users/rick/openclaw</td></tr>
        </table>
      </section>`;
    const { hosts, skippedProjectTables } = parseFleetDocumentWithMeta(html);
    expect(hosts[0].containers.map((c) => c.name)).toEqual(["caddy"]);
    expect(hosts[0].projects).toEqual([
      expect.objectContaining({ name: "declutter", path: "/Volumes/T7/declutter", kind: "claude" }),
      expect.objectContaining({ name: "openclaw", path: "/Users/rick/openclaw", kind: "unknown" }),
    ]);
    expect(skippedProjectTables).toEqual([]);
  });

  it("reports a Projects table that is not directories instead of importing it", () => {
    const html = `
      <section class="host">
        <div class="hh"><div class="hh-l"><span class="hname mono">dockermac</span> 10.50.0.10:8766</div></div>
        <table class="mtx services-table">
          <tr><th>label</th><th>url</th></tr>
          <tr><td>Ping</td><td>http://10.50.0.10/ping</td></tr>
        </table>
        <table class="mtx">
          <caption>Projects</caption>
          <tr><th>project</th><th>detail</th></tr>
          <tr><td>compose</td><td>stack notes</td></tr>
        </table>
      </section>`;
    const { hosts, skippedProjectTables } = parseFleetDocumentWithMeta(html);
    expect(hosts[0].projects).toEqual([]);
    expect(skippedProjectTables).toEqual([
      expect.objectContaining({
        host: "dockermac",
        reason: "project-looking table is not directory rows",
        headers: ["project", "detail"],
        sample: ["compose", "stack notes"],
      }),
    ]);
  });

  it("parses a /projects/ JSON page per host", () => {
    const hosts = parseProjectsDocument(
      JSON.stringify({
        hosts: [
          {
            host: "macmini-m4",
            ip: "10.50.0.102",
            projects: [
              { name: "declutter", tokens: "1.2M", size: "48 MB", updatedAt: "2h ago", status: "active" },
              { name: "old-lab", tokens: 8000, updatedAt: "40 days ago" },
            ],
          },
        ],
      }),
    );
    expect(hosts).toHaveLength(1);
    expect(hosts[0].projects[0]).toEqual(
      expect.objectContaining({ name: "declutter", kind: "claude", tokens: 1.2e6, status: "active" }),
    );
    expect(hosts[0].projects[1].name).toBe("old-lab");
    expect(projectFade("active", "2h ago")).toBe(1);
    expect(projectFade("stale", "40 days ago")).toBeLessThan(0.6);
    expect(parseTokenCount("12k")).toBe(12000);
    expect(detectProjectKind("portal/clawdy-portal")).toBe("openclaw");
  });

  it("parses a /projects/ HTML table and ignores fleet container tables", () => {
    const html = `
      <section class="host">
        <span class="hname">dockermac</span> 10.50.0.10
        <table class="projects-table">
          <tr><th>project</th><th>tokens</th><th>size</th><th>updated</th><th>kind</th></tr>
          <tr><td>homebase</td><td>80k</td><td>12 MB</td><td>now</td><td>claude</td></tr>
          <tr><td>grokbot</td><td>2.1M</td><td>90 MB</td><td>3 days ago</td><td>grok</td></tr>
        </table>
        <table class="projects">
          <tr class="pdrow"><td><span class="pd-k">container</span> <span class="cname">nginx</span></td></tr>
        </table>
      </section>`;
    const hosts = parseProjectsDocument(html);
    expect(hosts[0].host).toBe("dockermac");
    expect(hosts[0].projects.map((p) => p.name)).toEqual(["homebase", "grokbot"]);
    expect(hosts[0].projects.find((p) => p.name === "grokbot")?.kind).toBe("grok");
    expect(hosts[0].projects.find((p) => p.name === "homebase")?.tokens).toBe(80000);
  });

  it("reads the Claude projects HTML fixture per machine", () => {
    const hosts = parseProjectsDocument(projectsSnippet);
    expect(hosts.map((h) => h.host).sort()).toEqual(["dockermac", "macmini-m4"]);
    const mini = hosts.find((h) => h.host === "macmini-m4")!;
    expect(mini.projects.map((p) => p.name)).toEqual(["declutter", "photos-review"]);
    expect(mini.projects[0]).toEqual(expect.objectContaining({ kind: "claude", tokens: 1.2e6, status: "active" }));
    expect(hosts.find((h) => h.host === "dockermac")?.projects).toEqual([
      expect.objectContaining({ name: "openclaw-bridge", kind: "openclaw", status: "active" }),
    ]);
  });
});

describe("realistic fleet databases-table + directory tables", () => {
  it("maps kind/label/target headers, skips the header row, and uniques by kind+label+target", () => {
    const { hosts } = parseFleetDocumentWithMeta(dbDirs);
    const counts = Object.fromEntries(hosts.map((h) => [h.host, h.databases.length]));
    expect(counts).toEqual({ "dockermac-2": 5, dockermac: 9, "prodesk-rt1": 19, "macmini-m4": 0 });
    const names = hosts.flatMap((h) => h.databases.map((d) => d.name));
    expect(names).not.toContain("kind");
    expect(names).not.toContain("label");
    const d2 = hosts.find((h) => h.host === "dockermac-2")!;
    expect(d2.databases[0]).toEqual(
      expect.objectContaining({ name: "gitea", engine: "sqlite", target: "/var/lib/gitea/gitea.db", status: "ok" }),
    );
    const pro = hosts.find((h) => h.host === "prodesk-rt1")!;
    expect(pro.databases.filter((d) => d.engine === "sqlite" && d.name === "clawd")).toHaveLength(8);
    expect(new Set(pro.databases.map((d) => `${d.engine}:${d.name}:${d.target}`)).size).toBe(19);
  });

  it("imports directory pd-rows and lists a non-dir Projects table in skippedProjectTables", () => {
    const { hosts, skippedProjectTables } = parseFleetDocumentWithMeta(dbDirs);
    const byHost = Object.fromEntries(hosts.map((h) => [h.host, h.projects.length]));
    expect(byHost["macmini-m4"]).toBe(4);
    expect(byHost["dockermac-2"]).toBe(3);
    expect(byHost.dockermac).toBe(3);
    expect(byHost["prodesk-rt1"]).toBe(3);
    const mini = hosts.find((h) => h.host === "macmini-m4")!;
    expect(mini.projects.find((p) => p.path === "/Volumes/T7/declutter")).toEqual(
      expect.objectContaining({ name: "declutter", kind: "claude", tokens: 1.2e6 }),
    );
    expect(mini.databases).toEqual([]);
    expect(hosts.find((h) => h.host === "dockermac-2")?.containers.map((c) => c.name)).toEqual(["caddy"]);
    expect(skippedProjectTables).toEqual([
      expect.objectContaining({
        host: "prodesk-rt1",
        reason: "project-looking table is not directory rows",
        headers: ["project", "detail"],
      }),
    ]);
    expect(countProjectsByKind(mini.projects)).toEqual({ claude: 2, openclaw: 1, hermes: 1 });
  });

  it("never silently drops a directory-looking table", () => {
    const { hosts, skippedProjectTables } = parseFleetDocumentWithMeta(dbDirs);
    const imported = new Set(hosts.flatMap((h) => h.projects.map((p) => p.path ?? p.name)));
    expect(imported.has("/Volumes/T7/declutter")).toBe(true);
    expect(imported.has("/home/rick/clawd")).toBe(true);
    expect(skippedProjectTables.some((s) => s.host === "prodesk-rt1")).toBe(true);
    expect(skippedProjectTables.some((s) => /container/i.test(s.reason))).toBe(false);
  });
});

describe("project merge key", () => {
  it("treats the same path as one project and keeps the richer tokens / updatedAt", () => {
    expect(projectMergeKey({ name: "declutter", path: "/Volumes/T7/declutter/" })).toBe(
      projectMergeKey({ name: "declutter", path: "/Volumes/T7/declutter", kind: "claude" }),
    );
    const merged = mergeProjectRecords(
      { name: "declutter", path: "/Volumes/T7/declutter", kind: "unknown" },
      { name: "declutter", path: "/Volumes/T7/declutter", kind: "claude", tokens: 1.2e6, updatedAt: "2h ago" },
    );
    expect(merged).toEqual(
      expect.objectContaining({ name: "declutter", path: "/Volumes/T7/declutter", kind: "claude", tokens: 1.2e6 }),
    );
  });
});
