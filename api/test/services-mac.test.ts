import { describe, expect, it } from "vitest";
import {
  assembleMacReport,
  isDeniedListener,
  isLoopbackAddr,
  keepLaunchdJob,
  keepSqlitePath,
  launchdStatus,
  macCollectorEnabled,
  parseCaddyAdapt,
  parseCaddyfile,
  parseLaunchctlList,
  parseLaunchctlPrint,
  parseLaunchctlPrintDetails,
  parseLaunchdPlist,
  parseLsofListen,
  parseMysqlUrlPublic,
  parsePsPidPpid,
  prefixLaunchdLabels,
  descendantPids,
  postgresFromDocker,
} from "../../scripts/collectors/services/servicesMac";

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>nl.homebase.workbench</string>
  <key>WorkingDirectory</key>
  <string>/Volumes/T7/declutter</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>dist/boot.js</string>
  </array>
</dict>
</plist>`;

const launchctlRunning = `
gui/501/nl.homebase.workbench = {
	state = running
	program = /usr/local/bin/node
	pid = 4242
	last exit code = 0
}
`;

const launchctlFailed = `
gui/501/nl.ricktav.old = {
	state = waiting
	pid = 0
	last exit code = 1
}
`;

const lsof = `COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node     4242 rick   23u  IPv4 0x1      0t0  TCP *:3001 (LISTEN)
node     4242 rick   24u  IPv6 0x2      0t0  TCP [::1]:3001 (LISTEN)
mysqld   9999 rick   10u  IPv4 0x3      0t0  TCP 127.0.0.1:3306 (LISTEN)
caddy    7777 rick    8u  IPv4 0x4      0t0  TCP *:443 (LISTEN)
com.dock 1111 rick   12u  IPv4 0x5      0t0  TCP *:8001 (LISTEN)
python   5555 rick    5u  IPv4 0x6      0t0  TCP *:8765 (LISTEN)
`;

const ps = `
    1     0
 4242     1
 4243  4242
 5555     1
 7777     1
 9999     1
 1111     1
`;

describe("launchd plist / print", () => {
  it("reads Label, ProgramArguments[0] and WorkingDirectory", () => {
    const job = parseLaunchdPlist(plist, "~/Library/LaunchAgents/nl.homebase.workbench.plist");
    expect(job).toEqual({
      label: "nl.homebase.workbench",
      program: "/usr/local/bin/node",
      cwd: "/Volumes/T7/declutter",
      plistPath: "~/Library/LaunchAgents/nl.homebase.workbench.plist",
    });
    expect(keepLaunchdJob(job!)).toBe(true);
    expect(keepLaunchdJob({ label: "com.example.no-program" })).toBe(false);
    expect(keepLaunchdJob({ label: "com.google.chrome", program: "/opt/google/chrome" })).toBe(true);
  });

  it("maps launchctl print + ports to status", () => {
    expect(parseLaunchctlPrint(launchctlRunning)).toEqual({ state: "running", pid: 4242, lastExit: 0 });
    expect(launchdStatus(parseLaunchctlPrint(launchctlRunning), [3001])).toBe("ok");
    expect(launchdStatus(parseLaunchctlPrint(launchctlRunning), [])).toBe("warn");
    expect(launchdStatus(parseLaunchctlPrint(launchctlFailed), [])).toBe("error");
    expect(launchdStatus({ state: "waiting" }, [])).toBe("stopped");
  });

  it("reads path / cwd from launchctl print and prefix labels from list", () => {
    const printed = `
gui/501/nl.ricktav.declutter-focus-test = {
	path = /Volumes/T7/declutter-workbench/scripts/launchd/nl.ricktav.declutter-focus-test.plist
	state = running
	program = /usr/local/bin/node
	working directory = /Volumes/T7/declutter-workbench
	pid = 3002
	last exit code = (never exited)
}
`;
    expect(parseLaunchctlPrintDetails(printed)).toEqual(
      expect.objectContaining({
        label: "nl.ricktav.declutter-focus-test",
        program: "/usr/local/bin/node",
        cwd: "/Volumes/T7/declutter-workbench",
        plistPath: "/Volumes/T7/declutter-workbench/scripts/launchd/nl.ricktav.declutter-focus-test.plist",
        pid: 3002,
        state: "running",
      }),
    );
    const listed = parseLaunchctlList(`PID	Status	Label
-	0	com.apple.Safari
3002	0	nl.ricktav.declutter-focus-test
4242	0	nl.homebase.workbench
`);
    expect(prefixLaunchdLabels(listed)).toEqual(["nl.ricktav.declutter-focus-test", "nl.homebase.workbench"]);
  });
});

describe("lsof / ps", () => {
  it("parses listen rows and children", () => {
    const rows = parseLsofListen(lsof);
    expect(rows.find((r) => r.port === 3001 && r.address === "*")).toMatchObject({ pid: 4242, command: "node" });
    expect(isLoopbackAddr("127.0.0.1")).toBe(true);
    expect(isLoopbackAddr("::1")).toBe(true);
    expect(isLoopbackAddr("*")).toBe(false);
    const kids = parsePsPidPpid(ps);
    expect(descendantPids(4242, kids)).toEqual([4243]);
  });

  it("drops macOS/app listeners and keeps node/python/ollama", () => {
    expect(isDeniedListener("ControlCenter")).toBe(true);
    expect(isDeniedListener("ControlCe")).toBe(true);
    expect(isDeniedListener("rapportd")).toBe(true);
    expect(isDeniedListener("EEventManager")).toBe(true);
    expect(isDeniedListener("Spotify")).toBe(true);
    expect(isDeniedListener("sharingd")).toBe(true);
    expect(isDeniedListener("AirPlayXPC")).toBe(true);
    expect(isDeniedListener("node")).toBe(false);
    expect(isDeniedListener("python3")).toBe(false);
    expect(isDeniedListener("ollama")).toBe(false);
    expect(isDeniedListener("docker")).toBe(false);
    expect(isDeniedListener("weirdapp", ["weirdapp"])).toBe(true);
  });
});

describe("macCollectorEnabled", () => {
  it("defaults to darwin and honors HOMEBASE_MAC=0 / --no-mac", () => {
    expect(macCollectorEnabled({ platform: "darwin", env: {} })).toBe(true);
    expect(macCollectorEnabled({ platform: "linux", env: {} })).toBe(false);
    expect(macCollectorEnabled({ platform: "darwin", env: { HOMEBASE_MAC: "0" } })).toBe(false);
    expect(macCollectorEnabled({ platform: "darwin", env: {}, noMac: true })).toBe(false);
    expect(macCollectorEnabled({ platform: "linux", env: { HOMEBASE_MAC: "1" } })).toBe(true);
    expect(macCollectorEnabled({ platform: "linux", env: {}, flag: true })).toBe(true);
  });
});

describe("mysql URL / sqlite / postgres", () => {
  it("exposes host and database only", () => {
    expect(parseMysqlUrlPublic("mysql://rick:s3cret@10.50.0.10:3306/declutter")).toEqual({
      host: "10.50.0.10",
      port: 3306,
      database: "declutter",
    });
    const raw = JSON.stringify(parseMysqlUrlPublic("mysql://rick:s3cret@10.50.0.10:3306/declutter"));
    expect(raw).not.toMatch(/s3cret|rick:/);
  });

  it("keeps allowlisted sqlite roots and drops system/app dbs", () => {
    expect(keepSqlitePath("/Volumes/T7/declutter/data/app.db").keep).toBe(true);
    expect(keepSqlitePath("/Volumes/T7/declutter/app.db").keep).toBe(true);
    expect(keepSqlitePath("/Volumes/T7/declutter/node_modules/x.db").keep).toBe(false);
    expect(keepSqlitePath("/Users/rick/Documents/notes.db", "/Users/rick").keep).toBe(true);
    expect(keepSqlitePath("/Users/rick/code/app.db", "/Users/rick").keep).toBe(true);
    expect(keepSqlitePath("/Users/rick/.claudemux/store.db", "/Users/rick").keep).toBe(true);
    expect(keepSqlitePath("/Users/rick/Library/Caches/foo.db", "/Users/rick").keep).toBe(false);
    expect(keepSqlitePath("/Users/rick/Pictures/foo.db", "/Users/rick").keep).toBe(false);
    expect(keepSqlitePath("/Users/rick/src/notes.db", "/Users/rick").keep).toBe(false);
    expect(keepSqlitePath("/Users/rick/termsessions/sess.db", "/Users/rick").keep).toBe(true);
    expect(keepSqlitePath("/Volumes/T7/foo/keychain-2.db").keep).toBe(false);
    expect(keepSqlitePath("/Volumes/T7/foo/com.apple.foo.db").keep).toBe(false);
    expect(keepSqlitePath("/Volumes/T7/foo/Finance.db").keep).toBe(false);
    expect(keepSqlitePath("/Volumes/T7/declutter/README.md").keep).toBe(false);
    expect(keepSqlitePath("/opt/extra/proj.db", "/Users/rick", ["/opt/extra"]).keep).toBe(true);
  });

  it("lifts postgres containers", () => {
    expect(
      postgresFromDocker([
        { name: "gmailprune-dev-db", image: "postgres:16-alpine", status: "ok", port: 5433, mounts: [{ source: "db-data", dest: "/var/lib/postgresql/data", size: 45e6 }] },
        { name: "web", image: "caddy:2", status: "ok", port: 443 },
      ]),
    ).toEqual([
      expect.objectContaining({ name: "gmailprune-dev-db", engine: "postgres", port: 5433, size: 45e6, target: "localhost:5433" }),
    ]);
  });
});

describe("caddy", () => {
  it("reads Caddyfile reverse_proxy ports", () => {
    expect(
      parseCaddyfile(`home.example {\n  reverse_proxy 127.0.0.1:3001\n}\n`),
    ).toEqual([{ host: "home.example", port: 3001 }]);
  });

  it("reads caddy adapt JSON", () => {
    const json = {
      apps: {
        http: {
          servers: {
            srv0: {
              routes: [
                {
                  match: [{ host: ["photos.example"] }],
                  handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:8001" }] }],
                },
              ],
            },
          },
        },
      },
    };
    expect(parseCaddyAdapt(json)).toEqual([{ host: "photos.example", port: 8001 }]);
  });
});

describe("assembleMacReport", () => {
  it("writes services/web/databases and notes loopback-only listeners", () => {
    const kids = parsePsPidPpid(ps);
    const out = assembleMacReport({
      jobs: [
        { ...parseLaunchdPlist(plist)!, ...parseLaunchctlPrint(launchctlRunning) },
        { label: "nl.ricktav.old", program: "/bin/false", ...parseLaunchctlPrint(launchctlFailed) },
      ],
      listeners: parseLsofListen(lsof),
      children: kids,
      hostIp: "10.50.0.102",
      dockerPorts: [8001],
      sqlite: [{ path: "/Volumes/T7/declutter/data/app.db", size: 1200 }],
      postgres: [{ name: "gmailprune-dev-db", engine: "postgres", port: 5433, status: "ok" }],
      mysql: { name: "declutter", engine: "mysql", target: "10.50.0.10:3306", status: "ok", size: 9e6 },
      caddy: [{ host: "home.example", port: 3001 }],
    });
    expect(out.services.map((s) => s.name)).toEqual(["nl.homebase.workbench", "nl.ricktav.old"]);
    expect(out.services[0]).toMatchObject({
      status: "ok",
      image: "/usr/local/bin/node",
      cwd: "/Volumes/T7/declutter",
      port: 3001,
      url: "http://10.50.0.102:3001/",
    });
    expect(out.services[1].status).toBe("error");
    const wb = out.web.find((w) => w.label === "nl.homebase.workbench");
    expect(wb).toMatchObject({ port: 3001, public: true, host: "home.example", status: "ok" });
    expect(wb?.urls).toEqual(expect.arrayContaining(["http://10.50.0.102:3001/", "https://home.example/"]));
    expect(out.web.find((w) => w.label === "python:8765")).toMatchObject({ port: 8765, status: "ok" });
    const noisy = assembleMacReport({
      jobs: [],
      listeners: parseLsofListen(`${lsof}\nControlCe  88 rick  8u  IPv4 0x  0t0  TCP *:5000 (LISTEN)\nSpotify   89 rick  8u  IPv4 0x  0t0  TCP *:57621 (LISTEN)\n`),
      children: new Map(),
      hostIp: "10.50.0.102",
    });
    expect(noisy.web.some((w) => /Control|Spotify/i.test(w.label))).toBe(false);
    expect(noisy.web.find((w) => w.label === "python:8765")).toBeTruthy();
    expect(out.web.some((w) => w.port === 8001)).toBe(false);
    expect(out.web.some((w) => w.port === 3306)).toBe(false);
    expect(out.loopbackNotes.some((n) => n.includes("3306"))).toBe(true);
    expect(out.databases.map((d) => d.engine)).toEqual(["mysql", "postgres", "sqlite"]);
  });
});
