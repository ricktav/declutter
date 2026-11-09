import { beforeEach, describe, expect, it } from "vitest";
import { areas, houses, items } from "@db/schema";
import { ruleTopicSlug, suggestTopic, type TopicCandidate } from "../lib/suggestTopic";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

const SLUGS = new Set([
  "computers", "network", "electronics", "smarthome", "appliances", "furniture", "decor", "kitchen", "textiles", "toys",
  "sports", "containers", "verzorging",
]);
const rule = (name: string, attributes: Record<string, unknown> = {}) => ruleTopicSlug({ name, attributes }, SLUGS);

describe("ruleTopicSlug", () => {
  it("lets role and Type decide before the name", () => {
    expect(rule("Zwarte doos", { role: "laptop" })).toEqual({ slug: "computers", reason: "role laptop" });
    expect(rule("Ding", { role: "switch" })?.slug).toBe("network");
    // peripherals, drives and displays are filed under Computers (the lab), like Rick does
    expect(rule("Ding", { role: "monitor" })?.slug).toBe("computers");
    expect(rule("Ding", { type: "raspberry-pi" })).toEqual({ slug: "computers", reason: "type raspberry-pi" });
    expect(rule("Ding", { type: "mouse" })?.slug).toBe("computers");
    expect(rule("Sony Bravia 65\" LED TV")?.slug).toBe("electronics");
  });

  it("reads the head noun of a Dutch compound, the last word of a phrase, and a diminutive", () => {
    expect(rule("Zwarte laptoptas")).toEqual({ slug: "containers", reason: 'name has "tas"' });
    expect(rule("Grijze hoekslaapbank")?.slug).toBe("furniture");
    expect(rule("Wit kubusnachtkastje")?.slug).toBe("furniture");
    expect(rule("Zwart tv-meubel")?.slug).toBe("furniture");
    expect(rule("Eetkamerstoel (west)")?.slug).toBe("furniture");
    expect(rule("Roze opbergmand met luiaard")?.slug).toBe("containers");
    expect(rule("Paar hexdumbbells 10 kg")?.slug).toBe("sports");
    expect(rule("Zwart power rack")?.slug).toBe("sports");
    expect(rule("Parfum en cosmetica")?.slug).toBe("verzorging");
    expect(rule("Storage box")?.slug).toBe("containers");
    // the longest head noun wins; between equals the last word
    expect(rule("Witte keukenonderkasten met spoelbak en kraan")?.slug).toBe("furniture");
    expect(rule("TV Cupboard")?.slug).toBe("furniture");
    expect(rule("Tower power strip with 6 outlets")?.slug).toBe("electronics");
    expect(rule("Tulip stained glass window panel")?.slug).toBe("decor");
  });

  it("only proposes Topics that exist, and nothing for an unknown name", () => {
    expect(ruleTopicSlug({ name: "Zwarte laptoptas" }, new Set(["furniture"]))).toBeNull();
    expect(rule("Xyzzy")).toBeNull();
    expect(rule("Ding", { role: "laptop" })?.slug).toBe("computers");
    expect(ruleTopicSlug({ name: "Ding", attributes: { role: "laptop" } }, new Set(["decor"]))).toBeNull();
  });
});

describe("suggestTopic", () => {
  const topics: TopicCandidate[] = [
    { id: 1, slug: "things", name: "Things", description: null },
    { id: 2, slug: "furniture", name: "Furniture", description: null },
  ];

  it("never proposes the default bucket and returns the Topic row", async () => {
    expect(await suggestTopic({ name: "Eiken eettafel" }, topics)).toEqual({
      areaId: 2, slug: "furniture", name: "Furniture", reason: 'name has "tafel"', source: "rule",
    });
  });

  it("is null without a rule hit when no model is configured (the test environment)", async () => {
    expect(await suggestTopic({ name: "Xyzzy" }, topics)).toBeNull();
    expect(await suggestTopic({ name: "Eiken eettafel" }, topics.slice(0, 1))).toBeNull();
  });
});

describe("items.suggestTopic and items.queue toTopic", () => {
  let h1: number;
  let thingsId: number;
  let furnitureId: number;

  beforeEach(async () => {
    await resetTestDb();
    const db = getTestDb();
    [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
    [{ id: thingsId }] = await db.insert(areas).values({ slug: "things", name: "Things" }).$returningId();
    [{ id: furnitureId }] = await db.insert(areas).values({ slug: "furniture", name: "Furniture" }).$returningId();
  });

  it("proposes without writing, and the queue lists the Thing until it has a Topic", async () => {
    const db = getTestDb();
    const [{ id }] = await db.insert(items).values({ areaId: thingsId, houseId: h1, name: "Grijze bank" }).$returningId();
    const [{ id: detected }] = await db
      .insert(items)
      .values({ areaId: thingsId, houseId: h1, name: "Stoel", verificationStatus: "detected" })
      .$returningId();
    const caller = callerFor(h1);

    expect((await caller.items.queue()).toTopic).toEqual([id]);
    expect((await caller.items.queue()).counts.toTopic).toBe(1);
    expect((await caller.items.queue()).toCheck).toEqual([detected]);

    const s = await caller.items.suggestTopic({ id });
    expect(s).not.toBeNull();
    expect(s!).toMatchObject({ areaId: furnitureId, slug: "furniture", source: "rule" });
    expect((await caller.items.get({ id }))?.areaId).toBe(thingsId);

    await caller.items.update({ id, areaId: furnitureId });
    expect((await caller.items.queue()).toTopic).toEqual([]);
    await expect(caller.items.suggestTopic({ id: 999_999 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
