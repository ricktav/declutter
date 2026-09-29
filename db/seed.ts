import { getDb } from "../api/queries/connection";
import { areas } from "./schema";
import { eq } from "drizzle-orm";

async function seed() {
  const db = getDb();

  const existing = await db.select().from(areas);

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
    if (existing.some((e) => e.slug === a.slug)) continue; // idempotent: never duplicate areas
    await db.insert(areas).values(a);
  }

  console.log("Areas in place (no sample items — this is your inventory).");

  // self-healing: make sure the computers area carries the full attribute
  // schema (role/ip/network/purchase/warranty + generic spec fields)
  const COMPUTER_DEFS = [
    { key: "role", label: "Role", type: "select" as const, options: ["laptop", "desktop", "server", "nas", "network", "peripheral", "software", "service"] },
    { key: "hostname", label: "Hostname", type: "text" as const },
    { key: "ip", label: "IP address", type: "text" as const },
    { key: "mac", label: "MAC address", type: "text" as const },
    { key: "network", label: "Network / VLAN", type: "text" as const },
    { key: "cpu", label: "CPU", type: "text" as const },
    { key: "ram_gb", label: "RAM (GB)", type: "number" as const },
    { key: "storage_gb", label: "Storage (GB)", type: "number" as const },
    { key: "os", label: "OS", type: "text" as const },
    { key: "serial", label: "Serial number", type: "text" as const },
    { key: "purchase_date", label: "Purchased", type: "text" as const },
    { key: "warranty_until", label: "Warranty until", type: "text" as const },
    { key: "status_note", label: "Status note", type: "text" as const },
  ];
  // refresh from db so the self-heal below sees current rows
  const current = await db.select().from(areas);
  const computers = current.find((a) => a.slug === "computers");
  if (computers) {
    const hasIp = (computers.attributeDefs as { key: string }[] | null)?.some((d) => d.key === "ip");
    if (!hasIp) {
      await db.update(areas).set({ attributeDefs: COMPUTER_DEFS }).where(eq(areas.id, computers.id));
      console.log("Updated 'computers' attribute schema (ip, hostname, network, warranty, …).");
    }
  }
}

seed().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
