import { getDb } from "../api/queries/connection";
import { areas, items } from "./schema";
import { eq } from "drizzle-orm";

async function seed() {
  const db = getDb();

  const existing = await db.select().from(areas);
  if (existing.length) {
    console.log(`Areas already seeded (${existing.length}), skipping.`);
    return;
  }

  const areaDefs = [
    {
      slug: "computers",
      name: "Computers",
      icon: "laptop",
      color: "#3b82f6",
      description: "All IT gear: computers, NAS, network, peripherals, software and services.",
      attributeDefs: [
        { key: "role", label: "Role", type: "select" as const, options: ["laptop", "desktop", "server", "nas", "network", "peripheral", "software", "service"] },
        { key: "cpu", label: "CPU", type: "text" as const },
        { key: "ram_gb", label: "RAM (GB)", type: "number" as const },
        { key: "storage_gb", label: "Storage (GB)", type: "number" as const },
        { key: "os", label: "OS", type: "text" as const },
        { key: "location", label: "Location", type: "text" as const },
        { key: "status_note", label: "Status note", type: "text" as const },
      ],
      sortOrder: 0,
    },
    { slug: "garage", name: "Garage", icon: "wrench", color: "#f59e0b", description: "Tools, bikes, car stuff, storage boxes.", attributeDefs: null, sortOrder: 1 },
    { slug: "house", name: "House", icon: "home", color: "#10b981", description: "Furniture, appliances, maintenance.", attributeDefs: null, sortOrder: 2 },
    { slug: "kitchen", name: "Kitchen", icon: "chef-hat", color: "#ef4444", description: "Cupboards, pantry, appliances.", attributeDefs: null, sortOrder: 3 },
    { slug: "garden", name: "Garden", icon: "leaf", color: "#22c55e", description: "Plants, tools, outdoor projects.", attributeDefs: null, sortOrder: 4 },
    { slug: "work", name: "Work", icon: "briefcase", color: "#8b5cf6", description: "Work equipment and accounts.", attributeDefs: null, sortOrder: 5 },
    { slug: "schedule", name: "Schedule", icon: "calendar", color: "#06b6d4", description: "Recurring maintenance and appointments.", attributeDefs: null, sortOrder: 6 },
  ];

  for (const a of areaDefs) {
    await db.insert(areas).values(a);
  }

  const computers = await db.query.areas.findFirst({ where: eq(areas.slug, "computers") });
  if (computers) {
    await db.insert(items).values([
      {
        areaId: computers.id,
        name: "ThinkPad X1 Carbon",
        description: "Main daily laptop.",
        attributes: { role: "laptop", cpu: "Intel i7-1260P", ram_gb: 32, storage_gb: 1024, os: "Fedora 40", location: "desk" },
      },
      {
        areaId: computers.id,
        name: "Synology DS923+",
        description: "Main NAS. Runs Plex, backups, photo library.",
        attributes: { role: "nas", cpu: "Ryzen R1600", ram_gb: 8, storage_gb: 16384, os: "DSM 7.2", location: "utility closet" },
      },
      {
        areaId: computers.id,
        name: "Old Desktop (i5-8400)",
        description: "Retired gaming rig, currently unused.",
        attributes: { role: "desktop", cpu: "Intel i5-8400", ram_gb: 16, storage_gb: 512, os: "Windows 10", location: "attic", status_note: "candidate to repurpose or sell" },
      },
    ]);
  }

  console.log("Seeded areas + sample items.");
}

seed().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
