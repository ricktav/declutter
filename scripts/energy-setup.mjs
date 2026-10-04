#!/usr/bin/env node
// One-off energy setup (spec §1): the 7 missing rooms, 29 Plugwise plug items,
// the grid meter and the inverter, and the certain "powers" links.
// Dry run by default; --apply writes. Re-running is a no-op: rooms, items
// (by mac or name) and links are looked up before anything is created.
const HB = process.env.HOMEBASE_URL ?? "http://10.50.0.102:3001";
const PW = "http://10.50.0.147:8000/pw-control.json";
const APPLY = process.argv.includes("--apply");
const HOUSE = "Thuis RT";
const LINKS = [
  ["000D6F0002786CEF", 53], // Espresso plug -> Espresso Apparaat Krups
  ["000D6F00004BE875", 56], // Vaatwasser plug -> AEG built-in dishwasher
];

const enc = (o) => encodeURIComponent(JSON.stringify({ json: o }));
async function q(path, input = {}) {
  const r = await fetch(`${HB}/api/trpc/${path}?input=${enc(input)}`);
  const b = await r.json();
  if (b.error) throw new Error(`${path}: ${b.error.json?.message}`);
  return b.result.data.json;
}
async function m(path, input) {
  const r = await fetch(`${HB}/api/trpc/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ json: input }) });
  const b = await r.json();
  if (b.error) throw new Error(`${path}: ${b.error.json?.message}`);
  return b.result.data.json;
}

const pw = await (await fetch(PW)).json();
const circles = [...(pw.dynamic ?? []), ...(pw.static ?? [])].filter((c, i, a) => a.findIndex((x) => x.mac === c.mac) === i);
const house = (await q("houses.list")).find((h) => h.name === HOUSE);
if (!house) throw new Error(`house "${HOUSE}" not found`);
const area = (await q("areas.list")).find((a) => a.slug === "smarthome");
if (!area) throw new Error("area smarthome not found");
let rooms = (await q("rooms.list")).filter((r) => r.houseId === house.id);
const items = await q("items.listAll", { includeArchived: true, houseId: null });
const rels = await q("items.listRelations", { type: "powers" });

const plan = [];
const plannedRooms = new Set();
const roomId = async (name) => {
  let r = rooms.find((x) => x.name === name);
  if (!r && !plannedRooms.has(name)) {
    plannedRooms.add(name);
    plan.push(`room: create "${name}"`);
    if (APPLY) {
      await m("rooms.ensure", { name, houseId: house.id });
      rooms = (await q("rooms.list")).filter((x) => x.houseId === house.id);
      r = rooms.find((x) => x.name === name);
    }
  }
  return r?.id ?? null;
};
const want = [
  ...circles.map((c) => ({
    key: c.mac,
    name: `Plugwise – ${c.name === "circle+" ? "Circle+" : c.name}`,
    room: c.location,
    attributes: { role: "meter", meter_kind: "plug", brand: "Plugwise", model: c.name === "circle+" ? "Circle+" : "Circle", mac: c.mac },
  })),
  { key: "grid", name: "Slimme meter", room: "Meterkast", attributes: { role: "meter", meter_kind: "grid" } },
  { key: "solar", name: "SolarEdge omvormer", room: "Washok", attributes: { role: "meter", meter_kind: "solar", brand: "SolarEdge", solaredge_site: "181945" } },
];
const byKey = new Map();
for (const w of want) {
  const found = items.find((i) => (w.attributes.mac && i.attributes?.mac === w.attributes.mac) || (!w.attributes.mac && i.attributes?.meter_kind === w.attributes.meter_kind && i.name === w.name));
  if (found) {
    byKey.set(w.key, found.id);
    continue;
  }
  const rid = await roomId(w.room);
  plan.push(`item: create "${w.name}" in ${w.room} ${JSON.stringify(w.attributes)}`);
  if (APPLY) {
    const created = await m("items.create", { areaId: area.id, houseId: house.id, roomId: rid, name: w.name, attributes: w.attributes, verificationStatus: "confirmed", suggestLinks: false });
    byKey.set(w.key, created.id);
  }
}
for (const [mac, to] of LINKS) {
  const from = byKey.get(mac);
  if (from != null && rels.some((r) => r.fromItemId === from && r.toItemId === to)) continue;
  const target = items.find((i) => i.id === to);
  plan.push(`link: ${mac} powers #${to} ${target?.name ?? "?"}`);
  if (APPLY && from != null) await m("items.addRelation", { fromItemId: from, toItemId: to, type: "powers" });
}
console.log(plan.length ? plan.join("\n") : "nothing to do");
console.log(APPLY ? `applied ${plan.length} changes` : `dry run: ${plan.length} changes (add --apply to write)`);
