import { z } from "zod";
import { generateObject } from "ai";
import { isNetworkRole, isPeripheralRole, MACHINE_ROLES, normRole, TYPE_TREE } from "@db/taxonomy";
import { getModel } from "./ai";
import { DEFAULT_TOPIC_SLUG } from "./defaultTopic";

/**
 * Propose a Topic for a Thing that sits in the default bucket "Things".
 *
 * Two steps, cheapest first. A rule decides when the Thing's `role` or `type`
 * says what it is, or when a word of its name ends in a known head noun
 * ("laptoptas" is a bag, "hoekslaapbank" a sofa, "nachtkastje" a cabinet).
 * Only when no rule fires is the configured model asked, with the Topics that
 * exist as the only allowed answers; a missing or failing provider gives null.
 * Nothing here writes: the caller applies a suggestion with `items.update`.
 */

export type TopicCandidate = { id: number; slug: string; name: string; description: string | null };

export type TopicSuggestion = {
  areaId: number;
  slug: string;
  name: string;
  reason: string;
  source: "rule" | "ai";
};

type ThingFacts = {
  name: string;
  description?: string | null;
  attributes?: Record<string, unknown> | null;
};

/** Head nouns (Dutch and English) per Topic slug. A word of the name that ends in one of these decides. */
// (The lists mirror how Rick files Things today; `scripts/` has no copy, keep them here.)
const HEAD_NOUNS: Record<string, string[]> = {
  // Rick files everything with a chip or a plug that belongs to the lab under
  // Computers: machines, drives, monitors, keyboards, printers, hubs, tablets.
  computers: [
    "laptop", "macbook", "imac", "server", "nas", "desktop", "computer", "raspberry", "pi", "chromebook", "monitor",
    "beeldscherm", "scherm", "display", "projector", "toetsenbord", "keyboard", "muis", "mouse", "printer", "scanner",
    "tablet", "ipad", "telefoon", "phone", "iphone", "harddisk", "schijf", "drive", "ssd", "nvme",
    "dock", "hub", "reader", "modem", "nuc", "mini",
  ],
  network: ["switch", "router", "accesspoint", "patchpanel", "firewall", "gateway", "deco"],
  electronics: [
    "tv", "televisie", "speaker", "luidspreker", "adapter", "console", "controller", "camera", "kabel", "cable", "lader",
    "charger", "oplader", "koptelefoon",
    "headphone", "headphones", "headset", "beugel", "strip", "stekkerdoos", "powerstrip", "afstandsbediening", "remote",
    "batterij", "battery", "powerbank",
  ],
  smarthome: ["hue", "sensor", "thermostaat", "thermostat", "plug", "stekker", "zigbee", "deurbel", "doorbell", "rookmelder", "bridge"],
  appliances: [
    "koelkast", "fridge", "refrigerator", "vriezer", "freezer", "magnetron", "microwave", "oven", "fornuis", "stove", "kookplaat",
    "wasmachine", "washer", "droger", "dryer", "vaatwasser", "dishwasher", "ventilator", "fan", "stofzuiger", "vacuum",
    "espressomachine", "koffiezetapparaat", "koffiemachine", "waterkoker", "kettle", "weegschaal", "scale", "strijkijzer",
    "iron", "airco", "kachel", "heater", "blender", "mixer", "broodrooster", "toaster", "airfryer", "friteuse", "boiler",
    "sink", "wastafel", "bathtub", "bad", "toilet", "douche", "shower",
  ],
  furniture: [
    "bank", "sofa", "couch", "stoel", "chair", "tafel", "table", "bed", "kast", "kasten", "cabinet", "cupboard", "wardrobe",
    "dresser", "closet", "bureau", "desk", "rek", "shelf", "shelves", "stelling", "stellingkast", "kruk", "stool", "kapstok",
    "droogrek", "meubel", "nightstand", "bookcase", "bookshelf", "ottoman", "bench", "spiegelkast", "commode", "ladekast",
  ],
  decor: [
    "lamp", "light", "spiegel", "mirror", "schilderij", "painting", "poster", "lijst", "frame", "plant", "boompje", "pothos",
    "vaas", "vase", "klok", "clock", "kaars", "candle", "ballon", "balloon", "print", "beeld", "statue", "standaard", "tekenpop",
    "lichtletters", "slinger", "garland", "kunst", "panel", "paneel",
  ],
  kitchen: [
    "pan", "pot", "kom", "kommen", "bowl", "bord", "borden", "plate", "bestek", "cutlery", "mes", "messen", "knife", "snijplank",
    "dienblad", "tray", "glas", "glazen", "glass", "mok", "mug", "beker", "cup", "theedoek", "keukengerei", "schaal", "wok",
    "kan", "pitcher", "fles", "bottle", "servies",
  ],
  textiles: [
    "deken", "blanket", "plaid", "kussen", "pillow", "cushion", "handdoek", "towel", "doekjes", "kleding", "clothes", "shirt",
    "hoodie", "jas", "jacket", "vest", "broek", "trousers", "pants", "pantoffels", "slippers", "sokken", "socks", "gordijn",
    "curtain", "laken", "sheet", "dekbed", "duvet", "trui", "sweater", "jurk", "dress", "schoenen", "shoes", "sjaal", "scarf",
  ],
  toys: [
    "speelgoed", "toy", "toys", "knuffel", "knuffels", "plush", "teddybeer", "teddy", "duplo", "lego", "spel", "spellen",
    "bordspellen", "game", "puzzel", "puzzle", "pop", "doll", "loopauto", "speeltipi", "tipi", "speelgoedvrachtwagen",
    "speelgoedkrat", "speelgoedtas", "blokken", "blocks",
  ],
  sports: [
    "dumbbell", "dumbbells", "hexdumbbells", "halter", "halterstang", "halterschijf", "halterschijven", "barbell", "kettlebell",
    "yogamat", "mat", "trainingsbank", "rack", "sporttas", "boksbroek", "bokshandschoenen", "gloves", "foamrollers",
    "foamroller", "weerstandsbanden", "band", "slambal", "bal", "ball", "fiets", "bike", "crossover", "schijvenstandaard",
    "dumbbellrek", "dumbbellstang", "gewichten", "weights", "springtouw", "rope", "racket", "ski",
  ],
  containers: [
    "tas", "bag", "koffer", "suitcase", "kinderkoffer", "doos", "dozen", "verhuisdozen", "box", "boxes", "krat", "crate",
    "mand", "basket", "bak", "bakje", "bin", "emmer", "bucket", "pedaalemmer", "afvalbak", "prullenbak", "kist", "chest",
    "pakket", "parcel", "opbergdoos", "container", "trolley", "rugzak", "backpack",
  ],
  verzorging: [
    "parfum", "perfume", "cosmetica", "cosmetics", "make-up", "makeup", "shampoo", "zeep", "soap", "tandenborstel",
    "toothbrush", "föhn", "haardroger", "hairdryer", "scheerapparaat", "razor", "crème", "cream", "deodorant", "nagellak",
    "tondeuse", "trimmer", "verzorging",
  ],
};

const DIMINUTIVES = ["je", "tje", "pje", "etje", "kje"];

function words(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .split(/[^a-zà-ÿ-]+/)
    .flatMap((w) => w.split("-"))
    .filter((w) => w.length >= 2);
}

function rootType(type: string): string {
  let t = type;
  for (let i = 0; i < 10 && Object.hasOwn(TYPE_TREE, t) && TYPE_TREE[t] != null; i++) t = TYPE_TREE[t]!;
  return t;
}

const TYPE_ROOT_TOPIC: Record<string, string> = {
  computer: "computers",
  network: "network",
  display: "computers",
  input: "computers",
  storage: "computers",
  phone: "computers",
  meter: "smarthome",
};

/**
 * The rule step. Returns the Topic slug and why, or null when no rule fires.
 * `role` and `type` win over the name; in the name the longest matching head
 * noun wins, and between equals the last word (the head of a noun phrase).
 */
export function ruleTopicSlug(facts: ThingFacts, slugs: ReadonlySet<string>): { slug: string; reason: string } | null {
  const attrs = facts.attributes ?? {};
  const role = typeof attrs.role === "string" ? normRole(attrs.role) : "";
  if (role) {
    if (MACHINE_ROLES.has(role) && slugs.has("computers")) return { slug: "computers", reason: `role ${role}` };
    if (isNetworkRole(role) && slugs.has("network")) return { slug: "network", reason: `role ${role}` };
    if (isPeripheralRole(role) && slugs.has("computers")) return { slug: "computers", reason: `role ${role}` };
    if (role === "meter" && slugs.has("smarthome")) return { slug: "smarthome", reason: `role ${role}` };
  }
  const type = typeof attrs.type === "string" ? attrs.type.toLowerCase() : "";
  if (type && Object.hasOwn(TYPE_TREE, type)) {
    const slug = TYPE_ROOT_TOPIC[rootType(type)];
    if (slug && slugs.has(slug)) return { slug, reason: `type ${type}` };
  }

  type Hit = { slug: string; noun: string; pos: number };
  let best: Hit | null = null;
  const ws = words(facts.name);
  for (let pos = 0; pos < ws.length; pos++) {
    const w = ws[pos];
    // "kastje" → kast, "boompje" → boom, "tafeltje" → tafel: try every ending, the noun list decides
    const forms = [w];
    for (const end of DIMINUTIVES) {
      if (w.endsWith(end) && w.length - end.length >= 3) forms.push(w.slice(0, -end.length));
    }
    for (const [slug, nouns] of Object.entries(HEAD_NOUNS)) {
      if (!slugs.has(slug)) continue;
      for (const noun of nouns) {
        const hit = forms.some((f) => f === noun || (noun.length >= 3 && f.endsWith(noun) && f.length - noun.length >= 2));
        if (!hit) continue;
        if (!best || noun.length > best.noun.length || (noun.length === best.noun.length && pos >= best.pos)) {
          best = { slug, noun, pos };
        }
      }
    }
  }
  if (!best) return null;
  const found: Hit = best;
  return { slug: found.slug, reason: `name has "${found.noun}"` };
}

const aiSchema = z.object({ slug: z.string(), reason: z.string().max(200) });

async function aiTopicSlug(facts: ThingFacts, candidates: TopicCandidate[]): Promise<{ slug: string; reason: string } | null> {
  let model: Awaited<ReturnType<typeof getModel>>;
  try {
    model = await getModel();
  } catch {
    return null;
  }
  const attrs = facts.attributes ?? {};
  const lines = [
    `Thing: ${facts.name}`,
    facts.description ? `Description: ${facts.description}` : null,
    typeof attrs.type === "string" ? `Type: ${attrs.type}` : null,
    typeof attrs.role === "string" ? `Role: ${attrs.role}` : null,
    typeof attrs.brand === "string" ? `Brand: ${attrs.brand}` : null,
    typeof attrs.tags === "string" ? `Tags: ${attrs.tags}` : null,
  ].filter(Boolean);
  const prompt = [
    "Pick the one Topic (browsing bucket) for this household Thing. Names may be Dutch.",
    "Answer with the Topic's slug exactly as listed, and one short reason. Use slug \"none\" when none fits.",
    "",
    ...lines,
    "",
    "Topics:",
    ...candidates.map((c) => `- ${c.slug}: ${c.name}${c.description ? ` — ${c.description}` : ""}`),
  ].join("\n");
  try {
    const { object } = await generateObject({ model, schema: aiSchema, prompt });
    const slug = object.slug.trim().toLowerCase();
    if (!candidates.some((c) => c.slug === slug)) return null;
    return { slug, reason: object.reason.trim() || "model" };
  } catch {
    return null;
  }
}

export async function suggestTopic(facts: ThingFacts, topics: TopicCandidate[]): Promise<TopicSuggestion | null> {
  const candidates = topics.filter((t) => t.slug !== DEFAULT_TOPIC_SLUG);
  if (!candidates.length) return null;
  const slugs = new Set(candidates.map((c) => c.slug));
  const bySlug = new Map(candidates.map((c) => [c.slug, c]));
  const rule = ruleTopicSlug(facts, slugs);
  const hit = rule ? { ...rule, source: "rule" as const } : null;
  const ai = hit ? null : await aiTopicSlug(facts, candidates);
  const pick = hit ?? (ai ? { ...ai, source: "ai" as const } : null);
  if (!pick) return null;
  const topic = bySlug.get(pick.slug)!;
  return { areaId: topic.id, slug: topic.slug, name: topic.name, reason: pick.reason, source: pick.source };
}
