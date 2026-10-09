import { describe, expect, it } from "vitest";
import { matchMachine, parseFleetDocument } from "../lib/servicesFleet";

describe("parseFleetDocument", () => {
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
    expect(hosts).toEqual([
      { host: "mac-mini", containers: [{ name: "syncthing" }], node: [], web: [] },
    ]);
  });

  it("reads an HTML table of host + containers", () => {
    const html = `
      <table>
        <tr><th>Host</th><th>Containers</th></tr>
        <tr><td>nas-1</td><td>plex, backup</td></tr>
      </table>`;
    const hosts = parseFleetDocument(html);
    expect(hosts[0]).toMatchObject({ host: "nas-1" });
    expect(hosts[0].containers.map((c) => c.name)).toEqual(["plex", "backup"]);
  });
});

describe("matchMachine", () => {
  const machines = [
    { id: 1, name: "Docker Mac", hostname: "dockermac-1", ip: "10.50.0.10" },
    { id: 2, name: "Mac mini", hostname: "mac-mini.local", ip: "10.50.0.20" },
  ];
  it("matches hostname ignoring .local and punctuation", () => {
    expect(matchMachine("dockermac-1", machines)?.id).toBe(1);
    expect(matchMachine("mac-mini", machines)?.id).toBe(2);
    expect(matchMachine("10.50.0.10", machines)?.id).toBe(1);
  });
  it("returns null when nothing is close", () => {
    expect(matchMachine("toaster", machines)).toBeNull();
  });
});
