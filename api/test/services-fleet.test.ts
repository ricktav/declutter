import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  decodeEntities,
  isJunkCell,
  matchMachine,
  parseFleetDocument,
  parseFleetDocumentWithMeta,
} from "../lib/servicesFleet";

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
  it("reads section.host projects + services and skips matrix, cron, unreachable, external routes", () => {
    const { hosts, skippedUnreachable } = parseFleetDocumentWithMeta(snippet);
    expect(hosts.map((h) => h.host).sort()).toEqual(["dockermac", "macmini-m4"]);
    expect(skippedUnreachable).toEqual(["macbook-air-m2"]);

    const mini = hosts.find((h) => h.host === "macmini-m4")!;
    expect(mini.ip).toBe("10.50.0.102");
    expect(mini.containers).toEqual([]);
    expect(mini.web.map((w) => w.label)).toEqual(["Workbench", "HomeBase", "Flow", "Photos", "Ping"]);
    expect(mini.web).toHaveLength(5);

    const dock = hosts.find((h) => h.host === "dockermac")!;
    expect(dock.ip).toBe("10.50.0.10");
    expect(dock.containers.map((c) => c.name)).toEqual(["nginx", "caddy", "homeassistant"]);
    expect(dock.containers[0].port).toBe(80);
    expect(dock.web.map((w) => w.label)).toEqual(["Fleet", "Plugwise"]);

    const names = hosts.flatMap((h) => [h.host, ...h.containers.map((c) => c.name)]);
    expect(names).not.toEqual(expect.arrayContaining(["ls", "echo", "docker", "plugwise", "crontab"]));
    expect(hosts.some((h) => h.web.some((w) => w.label === "Public site"))).toBe(false);
    expect(hosts.some((h) => h.web.some((w) => w.label === "should-not-import"))).toBe(false);
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
});
