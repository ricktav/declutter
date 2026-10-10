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
import { pickReachHost, rewriteLocalHostUrl, statusTone } from "../lib/serviceUrls";

const snippet = readFileSync(path.join(import.meta.dirname, "fixtures/claudemux-fleet-snippet.html"), "utf8");

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

    const dock = hosts.find((h) => h.host === "dockermac")!;
    expect(dock.ip).toBe("10.50.0.10");
    expect(dock.containers).toHaveLength(23);
    expect(dock.containers[0]).toEqual({ name: "nginx", port: 80 });
    expect(snippet.match(/class="cname[^"]*">nginx/g)?.length).toBe(2);
    expect(dock.web).toHaveLength(20);

    const pro = hosts.find((h) => h.host === "prodesk-rt1")!;
    expect(pro.ip).toBe("10.50.0.142");
    expect(pro.containers).toHaveLength(14);
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
});

describe("localhost URLs and fleet status", () => {
  it("rewrites localhost / 127.0.0.1 / 0.0.0.0 to the machine IP", () => {
    expect(rewriteLocalHostUrl("http://localhost:3002/", "10.50.0.102")).toBe("http://10.50.0.102:3002/");
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
    expect(aggregateStatus(["ok", "amber"])).toBe("ok");
    expect(aggregateStatus(["amber", "red"])).toBe("red");
    expect(aggregateStatus(["amber"])).toBe("amber");
  });
});
