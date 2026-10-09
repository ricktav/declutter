import { describe, expect, it } from "vitest";
import { dockerHealthStatus, extractPublishedPorts, parseDockerPs } from "../lib/servicesDocker";

const tsv = `twin-homebase\tlidarventory:homebase\t0.0.0.0:8001->8000/tcp\tUp 2 hours
flamboyant_kirch\tlidarventory\t0.0.0.0:8000->8000/tcp\tUp 5 days
objective_nobel\tesphome:stable\t\tUp 13 days (unhealthy)
gmailprune-dev-db\tpostgres:16-alpine\t127.0.0.1:5433->5432/tcp\tUp 4 days
immich-ml-m4\timmich-machine-learning\t0.0.0.0:3003->3003/tcp\tUp 8 hours
apache-php\tapache-php:8.2-mysqlnd\t0.0.0.0:80->80/tcp\tUp 3 days`;

describe("parseDockerPs", () => {
  it("reads TSV Names/Image/Ports/Status including unhealthy → warn", () => {
    const rows = parseDockerPs(tsv);
    expect(rows.map((c) => c.name)).toEqual([
      "twin-homebase",
      "flamboyant_kirch",
      "objective_nobel",
      "gmailprune-dev-db",
      "immich-ml-m4",
      "apache-php",
    ]);
    expect(rows.find((c) => c.name === "twin-homebase")).toEqual({
      name: "twin-homebase",
      image: "lidarventory:homebase",
      port: 8001,
      status: "ok",
    });
    expect(rows.find((c) => c.name === "objective_nobel")).toEqual({
      name: "objective_nobel",
      image: "esphome:stable",
      status: "warn",
    });
    expect(rows.find((c) => c.name === "gmailprune-dev-db")?.port).toBe(5433);
    expect(rows.find((c) => c.name === "immich-ml-m4")?.port).toBe(3003);
    expect(rows.find((c) => c.name === "apache-php")?.port).toBe(80);
  });

  it("reads docker JSON lines", () => {
    const rows = parseDockerPs(
      JSON.stringify({ Names: "/twin-homebase", Image: "lidarventory:homebase", Ports: "0.0.0.0:8001->8000/tcp", Status: "Up 2 hours", State: "running" }),
    );
    expect(rows).toEqual([{ name: "twin-homebase", image: "lidarventory:homebase", port: 8001, status: "ok" }]);
  });
});

describe("extractPublishedPorts / health", () => {
  it("takes the host side of published mappings", () => {
    expect(extractPublishedPorts("0.0.0.0:8001->8000/tcp")).toEqual([8001]);
    expect(extractPublishedPorts(":8000->8000")).toEqual([8000]);
    expect(extractPublishedPorts(":3003")).toEqual([3003]);
    expect(extractPublishedPorts("")).toEqual([]);
  });

  it("maps unhealthy to warn", () => {
    expect(dockerHealthStatus("Up 13 days (unhealthy)")).toBe("warn");
    expect(dockerHealthStatus("Up 2 hours (healthy)")).toBe("ok");
    expect(dockerHealthStatus("Exited (0) 3 days ago")).toBe("stopped");
  });
});
