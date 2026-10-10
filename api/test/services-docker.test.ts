import { describe, expect, it } from "vitest";
import {
  dockerHealthStatus,
  enrichDockerContainers,
  extractPublishedPorts,
  parseDockerPs,
  parseDockerSizeField,
  parseDockerSystemDf,
} from "../lib/servicesDocker";

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
    expect(dockerHealthStatus("Exited (1) 3 days ago")).toBe("error");
  });

  it("parses docker ps --size and inspect/df extras", () => {
    expect(parseDockerSizeField("1.2MB (virtual 187MB)")).toEqual({ size: 1.2e6, imageSize: 187e6 });
    const rows = parseDockerPs("db\tpostgres:16\t127.0.0.1:5433->5432/tcp\tUp 1 hour\t1.2MB (virtual 187MB)");
    expect(rows[0].size).toBe(1.2e6);
    const df = parseDockerSystemDf(`Local Volumes space usage:\n\nVOLUME NAME     LINKS     SIZE\ndb-data         1         45.2MB\n`);
    expect(df.get("db-data")).toBeCloseTo(45.2e6, -3);
    const enriched = enrichDockerContainers(
      [{ name: "db", image: "postgres:16", port: 5433 }],
      [
        {
          Name: "/db",
          SizeRw: 1200,
          SizeRootFs: 187_000_000,
          Created: "2026-03-01T12:00:00Z",
          Mounts: [{ Type: "volume", Name: "db-data", Source: "/var/lib/docker/volumes/db-data/_data", Destination: "/var/lib/postgresql/data" }],
          Config: { Image: "postgres:16" },
        },
      ],
      [{ RepoTags: ["postgres:16"], Size: 187_000_000, Created: "2026-01-01T00:00:00Z", RootFS: { Layers: ["a", "b", "c"] } }],
      `Local Volumes space usage:\n\nVOLUME NAME     LINKS     SIZE\ndb-data         1         45MB\n`,
    );
    expect(enriched[0].layers).toBe(3);
    expect(enriched[0].created).toBe("2026-03-01");
    expect(enriched[0].mounts?.[0]).toEqual(expect.objectContaining({ dest: "/var/lib/postgresql/data", source: "db-data", size: 45e6 }));
  });
});
