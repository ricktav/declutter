import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, desc, or, and, asc, ne, isNull } from "drizzle-orm";
import { generateObject } from "ai";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { areas, items, photos, itemLinks, relations, tasks, ideaItems, ideas, events, houses, rooms, ITEM_DECISIONS, type ItemPos } from "@db/schema";
import { logEvent } from "../lib/events";
import { deleteItemTx, releaseStoredFiles } from "../lib/entities";
import { getModel } from "../lib/ai";
import { roomSummary, setItemLocation } from "../lib/location";
import { coverPhotos, linkAsLegacy, photoAsLegacy } from "../lib/photos";
import { placementFor, placementSummaryFor } from "../lib/placement";
import { snapPosToWalls } from "../lib/snapToWall";
import { commonIpv4Prefix, identityEntries, identityKind } from "../lib/identityAttrs";

/** crude name-similarity: shared significant tokens */
function nameScore(a: string, b: string): number {
  const tok = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2),
    );
  const A = tok(a);
  const B = tok(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / Math.min(A.size, B.size);
}

export const itemsRouter = createRouter({
  listByArea: procedure
    .input(z.object({ areaId: z.number(), includeArchived: z.boolean().default(false) }))
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db
        .select()
        .from(items)
        .where(
          input.includeArchived
            ? eq(items.areaId, input.areaId)
            : and(eq(items.areaId, input.areaId), eq(items.status, "active")),
        )
        .orderBy(desc(items.updatedAt));
      const covers = await coverPhotos(db, rows.map((r) => r.id));
      return rows.map((r) => ({ ...r, imageKey: covers.get(r.id)?.storageKey ?? null }));
    }),

  /** Every active item across every area, for the cross-area browser (search/sort by area or location). */
  listAll: procedure
    .input(
      z.object({
        includeArchived: z.boolean().default(false),
        houseId: z.number().nullable().optional(),
        roomId: z.number().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const houseId = input.houseId !== undefined ? input.houseId : ctx.houseId;
      const db = getDb();
      const rows = await db
        .select()
        .from(items)
        .where(
          and(
            input.includeArchived ? undefined : eq(items.status, "active"),
            houseId != null ? eq(items.houseId, houseId) : undefined,
            input.roomId != null ? eq(items.roomId, input.roomId) : undefined,
          ),
        )
        .orderBy(desc(items.updatedAt));
      const allAreas = await db.select().from(areas);
      const areaById = new Map(allAreas.map((a) => [a.id, a]));
      const roomsById = await roomSummary(db, rows.map((r) => r.roomId).filter((x): x is number => x != null));
      const covers = await coverPhotos(db, rows.map((r) => r.id));
      return rows.map((r) => ({
        ...r,
        imageKey: covers.get(r.id)?.storageKey ?? null,
        areaName: areaById.get(r.areaId)?.name ?? null,
        areaSlug: areaById.get(r.areaId)?.slug ?? null,
        room: r.roomId != null ? (roomsById.get(r.roomId) ?? null) : null,
      }));
    }),

  get: procedure.input(z.object({ id: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const item = await db.query.items.findFirst({ where: eq(items.id, input.id) });
    if (!item) return null;
    const area = await db.query.areas.findFirst({ where: eq(areas.id, item.areaId) });
    const house = item.houseId
      ? await db.query.houses.findFirst({ where: eq(houses.id, item.houseId) })
      : null;
    const room = item.roomId != null ? ((await roomSummary(db, [item.roomId])).get(item.roomId) ?? null) : null;
    const itemPhotos = await db.select().from(photos).where(eq(photos.itemId, item.id)).orderBy(desc(photos.createdAt));
    const itemLinkRows = await db.select().from(itemLinks).where(eq(itemLinks.itemId, item.id)).orderBy(desc(itemLinks.createdAt));
    const rels = await db
      .select()
      .from(relations)
      .where(or(eq(relations.fromItemId, item.id), eq(relations.toItemId, item.id)))
      .orderBy(desc(relations.createdAt));
    const otherIds = [...new Set(rels.flatMap((r) => [r.fromItemId, r.toItemId]))].filter(
      (x) => x !== item.id,
    );
    const others = otherIds.length
      ? await db.select().from(items).where(or(...otherIds.map((i) => eq(items.id, i))))
      : [];
    const nameMap = new Map(others.map((o) => [o.id, o.name]));
    // attach the LLM's "why" for AI-suggested links from the event log
    const linkEvents = await db
      .select()
      .from(events)
      .where(and(eq(events.entityType, "item"), eq(events.entityId, item.id), eq(events.action, "links-suggested")))
      .orderBy(desc(events.createdAt));
    const reasonMap = new Map<number, string>();
    for (const ev of linkEvents) {
      const payload = ev.payload as { links?: { itemId: number; reason: string }[] } | null;
      for (const l of payload?.links ?? []) {
        if (!reasonMap.has(l.itemId)) reasonMap.set(l.itemId, l.reason);
      }
    }
    const itemTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.itemId, item.id))
      .orderBy(desc(tasks.createdAt));
    const children = await db
      .select()
      .from(items)
      .where(eq(items.parentId, item.id))
      .orderBy(asc(items.name));
    const links = await db.select().from(ideaItems).where(eq(ideaItems.itemId, item.id));
    const itemIdeas = links.length
      ? await db
          .select()
          .from(ideas)
          .where(or(...links.map((l) => eq(ideas.id, l.ideaId))))
      : [];
    return {
      ...item,
      area,
      house,
      room,
      photos: itemPhotos,
      links: itemLinkRows,
      attachments: [...itemPhotos.map(photoAsLegacy), ...itemLinkRows.map(linkAsLegacy)].sort((a, b) => +b.createdAt - +a.createdAt || b.id - a.id), // DEPRECATED alias field for external callers; link ids are negated
      relations: rels.map((r) => ({
        ...r,
        otherItemId: r.fromItemId === item.id ? r.toItemId : r.fromItemId,
        otherItemName: nameMap.get(r.fromItemId === item.id ? r.toItemId : r.fromItemId) ?? "?",
        direction: r.fromItemId === item.id ? ("out" as const) : ("in" as const),
        reason: r.origin === "ai" && r.status === "suggested"
          ? (reasonMap.get(r.fromItemId === item.id ? r.toItemId : r.fromItemId) ?? null)
          : null,
      })),
      tasks: itemTasks,
      ideas: itemIdeas,
      children,
    };
  }),

  /** Where a Thing is placed: confirmed pins, on the plan (= in 3D), and
   * the photos of its room it could still be pinned in. */
  placement: procedure.input(z.object({ itemId: z.number() })).query(({ input }) => placementFor(getDb(), input.itemId)),

  /** Pin count and on-plan flag for many Things (tile badges), in two queries. */
  placementSummary: procedure
    .input(z.object({ itemIds: z.array(z.number()).min(1).max(500) }))
    .query(({ input }) => placementSummaryFor(getDb(), input.itemIds)),

  create: procedure
    .input(
      z.object({
        areaId: z.number(),
        name: z.string().min(1),
        description: z.string().optional(),
        attributes: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
        parentId: z.number().nullable().optional(),
        roomId: z.number().nullable().optional(),
        houseId: z.number().nullable().optional(),
        // defaults to "confirmed": a human calling this procedure (via the UI)
        // already made the decision. Automated filers (normalizer, bot
        // preprocessing) pass "detected" explicitly.
        verificationStatus: z.enum(["detected", "confirmed", "rejected"]).optional(),
        // default true. Importers and collectors pass false: no name-based
        // suggestions, no LLM call and no "links-suggested" event.
        suggestLinks: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      // insert + location + event are atomic: a bad roomId must not leave an orphan item
      const id = await db.transaction(async (tx) => {
        const [{ id: newId }] = await tx
          .insert(items)
          .values({
            areaId: input.areaId,
            name: input.name,
            description: input.description ?? null,
            attributes: input.attributes ?? null,
            parentId: input.parentId ?? null,
            houseId: input.houseId ?? ctx.houseId ?? null,
            roomId: null,
            verificationStatus: input.verificationStatus ?? "confirmed",
          })
          .$returningId();
        if (input.roomId != null) await setItemLocation(tx, newId, { roomId: input.roomId });
        await logEvent(
          {
            entityType: "item",
            entityId: newId,
            action: "created",
            summary: `Item "${input.name}" created`,
            payload: { areaId: input.areaId, attributes: input.attributes },
          },
          tx,
        );
        return newId;
      });
      if (input.suggestLinks === false) return { id, suggestedRelations: 0, suggestedLinks: [] };

      // name-based suggestions run regardless; the LLM adds semantic matches
      // from the same area (it only sees same-area items, so links are scoped)
      const siblings = await db
        .select()
        .from(items)
        .where(and(eq(items.status, "active"), eq(items.areaId, input.areaId)));
      const suggestions: number[] = [];
      for (const s of siblings) {
        if (s.id === id) continue;
        if (nameScore(input.name, s.name) >= 0.5) {
          await db.insert(relations).values({
            fromItemId: id,
            toItemId: s.id,
            type: "related-to",
            origin: "ai",
            status: "suggested",
          });
          suggestions.push(s.id);
        }
      }
      if (suggestions.length) {
        await logEvent({
          entityType: "item",
          entityId: id,
          action: "links-suggested",
          summary: `Auto-suggested ${suggestions.length} possible relation(s) for "${input.name}"`,
          actor: "ai",
          payload: { suggestedItemIds: suggestions },
        });
      }

      // LLM: semantic suggested-links to existing items in this area. This runs after
      // the response: with the Claude CLI provider one call takes many seconds, and the
      // Workbench spun on every accepted pin waiting for it. The relations and the
      // "links-suggested" event land when the model answers; nothing reads them from
      // this response, so suggestedLinks is reported as empty here.
      const suggestedLinks: { itemId: number; reason: string }[] = [];
      void (async () => {
        // LLM: semantic suggested-links to existing items in this area
        const otherSiblings = siblings.filter((s) => s.id !== id);
        if (otherSiblings.length > 0) {
          try {
            const model = await getModel();
            const linksSchema = z.object({
              links: z.array(
                z.object({
                  itemId: z.number().describe("id of the existing item to link to"),
                  reason: z.string().describe("one short sentence: why they belong together"),
                }),
              ),
            });
            const { object } = await generateObject({
              model,
              schema: linksSchema,
              messages: [
                {
                  role: "user",
                  content: `A new item was just added to a home inventory.\n\nNEW ITEM (area: ${input.name}'s area, name: "${input.name}"${input.description ? `, description: "${input.description}"` : ""}).\n\nEXISTING ITEMS IN THE SAME AREA (id — name${input.description ? " — description" : ""}):\n${otherSiblings
                    .slice(0, 100)
                    .map((s) => `- ${s.id} — ${s.name}${s.description ? ` — ${s.description.slice(0, 120)}` : ""}`)
                    .join("\n")}\n\nWhich of these existing items does the new item have a HIGH likelihood of being related to? Suggest only links you are fairly confident about (same setup, accessory of, part of, replacement for, used together, depends on). Return an empty list if nothing is clearly related. For each suggested link give a one-sentence reason.`,
                },
              ],
            });
            const valid = new Set(otherSiblings.map((s) => s.id));
            for (const l of object.links) {
              if (!valid.has(l.itemId) || suggestions.includes(l.itemId)) continue;
              await db.insert(relations).values({
                fromItemId: id,
                toItemId: l.itemId,
                type: "related-to",
                origin: "ai",
                status: "suggested",
              });
              suggestions.push(l.itemId);
              suggestedLinks.push({ itemId: l.itemId, reason: l.reason });
            }
            if (suggestedLinks.length) {
              await logEvent({
                entityType: "item",
                entityId: id,
                action: "links-suggested",
                summary: `LLM suggested ${suggestedLinks.length} semantic link(s) for "${input.name}"`,
                actor: "ai",
                payload: { links: suggestedLinks },
              });
            }
          } catch {
            // AI suggestions are best-effort — creation must never fail on them
          }
        }
      })();
      return { id, suggestedRelations: suggestions.length, suggestedLinks };
    }),

  update: procedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        areaId: z.number().optional(),
        attributes: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
        roomId: z.number().nullable().optional(),
        houseId: z.number().nullable().optional(),
        pos: z
          .object({
            xM: z.number(),
            yM: z.number(),
            wM: z.number(),
            dM: z.number(),
            rotDeg: z.number(),
            baseM: z.number().optional(),
            hM: z.number().optional(),
          })
          .nullable()
          .optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, attributes, pos, roomId, houseId, ...rest } = input;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
      if (attributes !== undefined) patch.attributes = attributes;
      if (pos !== undefined) patch.pos = pos as ItemPos | null;

      // fetch the pre-update row so the history entry can name what actually
      // changed (e.g. "renamed from X to Y") instead of just listing which
      // field keys were touched
      const before = await db.query.items.findFirst({ where: eq(items.id, id) });
      const beforeRoomId = before?.roomId ?? null;
      const beforeHouseId = before?.houseId ?? null;
      // houseId alone moves the item, unplaced, into ANOTHER house; for the
      // house it is already in it changes nothing (it does not unplace it)
      const moves = roomId !== undefined || (houseId !== undefined && houseId !== beforeHouseId);
      const nextRoomId = roomId !== undefined ? roomId : moves ? null : beforeRoomId;
      // a position is in the old room's frame: meaningless once the item leaves that room
      if (nextRoomId !== beforeRoomId && pos === undefined) patch.pos = null;
      await db.transaction(async (tx) => {
        if (Object.keys(patch).length) await tx.update(items).set(patch).where(eq(items.id, id));
        if (moves) {
          if (roomId != null) await setItemLocation(tx, id, { roomId });
          else await setItemLocation(tx, id, { roomId: null, houseId: houseId !== undefined ? houseId : beforeHouseId });
        }
      });

      const subject = before?.name ?? `#${id}`;
      const parts: string[] = [];
      if (patch.name !== undefined && patch.name !== before?.name) {
        parts.push(`renamed from "${before?.name ?? "?"}" to "${patch.name}"`);
      }
      if (moves) {
        const after = await db.query.items.findFirst({ where: eq(items.id, id) });
        const label = after?.roomId != null ? ((await roomSummary(db, [after.roomId])).get(after.roomId)?.name ?? `room #${after.roomId}`) : after?.houseId != null ? "unplaced in house" : "none";
        if (after?.roomId !== before?.roomId || after?.houseId !== before?.houseId) parts.push(`location set to ${label}`);
      }
      if (patch.description !== undefined) parts.push("description updated");
      if (patch.areaId !== undefined && patch.areaId !== before?.areaId) parts.push("topic changed");
      if (patch.attributes !== undefined) parts.push("attributes updated");
      if (patch.pos !== undefined) parts.push("position updated");

      await logEvent({
        entityType: "item",
        entityId: id,
        action: "updated",
        summary: parts.length
          ? `Item "${subject}" ${parts.join(", ")}`
          : `Item "${subject}" updated (no changes)`,
        payload: patch as Record<string, unknown>,
      });
      return { ok: true };
    }),

  /**
   * Snap to wall: an explicit, per-Thing action (never automatic). A LiDAR
   * scan sees a cabinet's front, not its back, so wall-backed furniture
   * lands 0.2-0.36 m off the wall, or partly through it. This moves the
   * Thing's footprint flush against the nearest axis-aligned wall within
   * 0.5 m of the room it belongs to directly; only xM/yM change.
   */
  snapToWall: procedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const [it] = await db.select().from(items).where(eq(items.id, input.id));
    if (!it) throw new TRPCError({ code: "NOT_FOUND", message: "Thing not found." });
    const pos = it.pos as ItemPos | null;
    if (it.roomId == null || !pos) throw new TRPCError({ code: "NOT_FOUND", message: "This Thing has no place on a plan." });
    // the Thing's own room, never rooms.get's rollup: a Thing shown in a
    // parent's overview has its pos in its own (child) room's frame
    const [room] = await db.select().from(rooms).where(eq(rooms.id, it.roomId));
    if (!room) throw new TRPCError({ code: "NOT_FOUND", message: "The Thing's room no longer exists." });
    if (!room.walls?.length && (room.widthM == null || room.depthM == null)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "The Thing's room has no plan to snap to." });
    }
    const snap = snapPosToWalls(pos, room.walls, room.widthM, room.depthM);
    if (!snap) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No wall within 0.5 m" });
    const wall = { kind: snap.kind, side: snap.side };
    // already flush: nothing to write, nothing to log
    const mm = (n: number) => Math.round(n * 1000) / 1000;
    if (mm(snap.pos.xM) === mm(pos.xM) && mm(snap.pos.yM) === mm(pos.yM)) return { pos, movedM: 0, wall };
    await db.transaction(async (tx) => {
      await tx.update(items).set({ pos: snap.pos }).where(eq(items.id, it.id));
      await logEvent(
        {
          entityType: "item",
          entityId: it.id,
          action: "moved",
          summary: `Snapped to the ${snap.side} wall (${snap.movedM} m)`,
          payload: { posBefore: pos, posAfter: snap.pos, wall },
        },
        tx,
      );
    });
    return { pos: snap.pos, movedM: snap.movedM, wall };
  }),

  /**
   * The verification gate: distinguishes an item a human actually looked at
   * from one an AI/scan pipeline auto-filed. Mirrors photoPins'
   * origin/status pattern. Separate from setArchived's lifecycle status —
   * an item can be confirmed-and-archived, or detected-and-active.
   */
  setVerification: procedure
    .input(
      z.object({
        id: z.number(),
        verificationStatus: z.enum(["detected", "confirmed", "rejected"]),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      await db
        .update(items)
        .set({ verificationStatus: input.verificationStatus })
        .where(eq(items.id, input.id));
      await logEvent({
        entityType: "item",
        entityId: input.id,
        action: `verification:${input.verificationStatus}`,
        summary: `Item #${input.id} marked ${input.verificationStatus}`,
        actor: input.verificationStatus === "detected" ? "system" : "user",
      });
      return { ok: true };
    }),

  setArchived: procedure
    .input(z.object({ id: z.number(), archived: z.boolean() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db
        .update(items)
        .set({
          status: input.archived ? "archived" : "active",
          archivedAt: input.archived ? new Date() : null,
        })
        .where(eq(items.id, input.id));
      await logEvent({
        entityType: "item",
        entityId: input.id,
        action: input.archived ? "archived" : "restored",
        summary: `Item #${input.id} ${input.archived ? "archived" : "restored"}`,
      });
      return { ok: true };
    }),

  /** Keep / sell / donate / toss / later - or null to undo the decision. */
  setDecision: procedure
    .input(z.object({ id: z.number(), decision: z.enum(ITEM_DECISIONS).nullable() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const item = await db.query.items.findFirst({ where: eq(items.id, input.id) });
      if (!item) throw new Error("Item not found.");
      await db
        .update(items)
        .set({ decision: input.decision, decidedAt: input.decision ? new Date() : null })
        .where(eq(items.id, input.id));
      await logEvent({
        entityType: "item",
        entityId: input.id,
        action: input.decision ? `decision:${input.decision}` : "decision:cleared",
        summary: input.decision
          ? `Item "${item.name}" marked ${input.decision}`
          : `Item "${item.name}" decision cleared (was ${item.decision ?? "none"})`,
      });
      return { ok: true };
    }),

  /**
   * Set or clear single attribute keys without resending the whole map -
   * null or "" removes a key. Descriptive fields use plain keys (model,
   * serial); workflow state uses a prefix (sell.ask_price, lab.wiped_at).
   */
  patchAttributes: procedure
    .input(
      z.object({
        id: z.number(),
        set: z.record(z.string().min(1).max(64), z.union([z.string().max(500), z.number(), z.null()])),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const item = await db.query.items.findFirst({ where: eq(items.id, input.id) });
      if (!item) throw new Error("Item not found.");
      const next: Record<string, string | number> = { ...(item.attributes ?? {}) };
      const changed: string[] = [];
      for (const [key, value] of Object.entries(input.set)) {
        if (value === null || value === "") {
          if (key in next) {
            delete next[key];
            changed.push(`${key} removed`);
          }
        } else if (next[key] !== value) {
          next[key] = value;
          changed.push(`${key} = ${value}`);
        }
      }
      if (changed.length > 0) {
        await db
          .update(items)
          .set({ attributes: Object.keys(next).length > 0 ? next : null })
          .where(eq(items.id, input.id));
        await logEvent({
          entityType: "item",
          entityId: input.id,
          action: "updated",
          summary: `Item "${item.name}" details: ${changed.join(", ")}`,
          payload: input.set,
        });
      }
      return { ok: true, attributes: next };
    }),

  /**
   * Attribute keys (and their values) already used on active Things in a
   * topic, most common first. ItemDetail's "add attribute" picklist uses this.
   */
  attributeKeysForTopic: procedure
    .input(z.object({ areaId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db
        .select({ attributes: items.attributes })
        .from(items)
        .where(and(eq(items.areaId, input.areaId), eq(items.status, "active")));
      const keys = new Map<string, { count: number; values: Map<string, number> }>();
      const ipValues: string[] = [];
      for (const row of rows) {
        const attrs = row.attributes;
        if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) continue;
        for (const [rawKey, rawVal] of Object.entries(attrs)) {
          const key = rawKey.trim();
          if (!key) continue;
          let rec = keys.get(key);
          if (!rec) {
            rec = { count: 0, values: new Map() };
            keys.set(key, rec);
          }
          rec.count += 1;
          const value = rawVal == null ? "" : String(rawVal).trim();
          const kind = identityKind(key);
          // Identity values must not be picklist choices (that invites
          // duplicates). IP is the exception: only the common /24 prefix.
          if (kind === "ip" && value) ipValues.push(value);
          if (kind) continue;
          if (value) rec.values.set(value, (rec.values.get(value) ?? 0) + 1);
        }
      }
      const ipPrefix = commonIpv4Prefix(ipValues);
      return [...keys.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
        .slice(0, 100)
        .map(([key, rec]) => ({
          key,
          count: rec.count,
          values:
            identityKind(key) === "ip" && ipPrefix
              ? [{ value: ipPrefix, count: rec.count }]
              : identityKind(key)
                ? []
                : [...rec.values.entries()]
                    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                    .slice(0, 40)
                    .map(([value, count]) => ({ value, count })),
        }));
    }),

  /**
   * Soft uniqueness check for serial / MAC / IP / hostname (and key variants)
   * in the item's house. Does not block a save — existing data may already clash.
   */
  findAttributeDuplicates: procedure
    .input(
      z.object({
        itemId: z.number(),
        attributes: z.record(z.string().min(1).max(64), z.string().max(500)).optional(),
      }),
    )
    .query(async ({ input }) => {
      const db = getDb();
      const item = await db.query.items.findFirst({ where: eq(items.id, input.itemId) });
      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Item not found." });
      const houseRows = await db
        .select({
          id: items.id,
          name: items.name,
          attributes: items.attributes,
          status: items.status,
          areaId: items.areaId,
        })
        .from(items)
        .where(and(
          ne(items.id, item.id),
          item.houseId != null ? eq(items.houseId, item.houseId) : isNull(items.houseId),
        ));
      const index = new Map<string, { id: number; name: string; key: string; value: string; status: string }[]>();
      const houseIps: string[] = [];
      for (const row of houseRows) {
        for (const e of identityEntries(row.attributes)) {
          const k = `${e.kind}:${e.normalized}`;
          const list = index.get(k) ?? [];
          list.push({ id: row.id, name: row.name, key: e.key, value: e.value, status: row.status });
          index.set(k, list);
          if (e.kind === "ip") houseIps.push(e.value);
        }
      }
      for (const e of identityEntries(item.attributes)) {
        if (e.kind === "ip") houseIps.push(e.value);
      }
      let ipPrefix = commonIpv4Prefix(houseIps);
      if (!ipPrefix) {
        const topicRows = await db
          .select({ attributes: items.attributes })
          .from(items)
          .where(and(eq(items.areaId, item.areaId), eq(items.status, "active")));
        const topicIps: string[] = [];
        for (const row of topicRows) {
          for (const e of identityEntries(row.attributes)) {
            if (e.kind === "ip") topicIps.push(e.value);
          }
        }
        ipPrefix = commonIpv4Prefix(topicIps);
      }
      const mine = identityEntries(input.attributes ?? item.attributes);
      const kindOrder = ["serial", "mac", "ip", "hostname"] as const;
      const clashes = mine
        .map((e) => {
          const others = (index.get(`${e.kind}:${e.normalized}`) ?? []).slice(0, 8);
          return others.length === 0 ? null : { kind: e.kind, key: e.key, value: e.value, others };
        })
        .filter((c): c is NonNullable<typeof c> => c != null)
        .sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind));
      return { clashes, ipPrefix };
    }),

  /** Every relation of one type (for example "backs-up"), for views that need all links at once. */
  listRelations: procedure
    .input(z.object({ type: z.string().min(1).max(64) }))
    .query(async ({ input }) => getDb().select().from(relations).where(eq(relations.type, input.type))),

  /** Move and/or retopic many Things in one go (All items batch bar). */
  updateMany: procedure
    .input(
      z.object({
        ids: z.array(z.number()).min(1).max(200),
        roomId: z.number().nullable().optional(),
        areaId: z.number().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      if (input.roomId === undefined && input.areaId === undefined) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Pass roomId and/or areaId." });
      }
      const db = getDb();
      const uniqueIds = [...new Set(input.ids)];
      if (input.areaId != null) {
        const area = await db.query.areas.findFirst({ where: eq(areas.id, input.areaId) });
        if (!area) throw new TRPCError({ code: "BAD_REQUEST", message: "Topic not found." });
      }
      await db.transaction(async (tx) => {
        for (const id of uniqueIds) {
          const before = await tx.query.items.findFirst({ where: eq(items.id, id) });
          if (!before) continue;
          if (input.areaId != null && input.areaId !== before.areaId) {
            await tx.update(items).set({ areaId: input.areaId }).where(eq(items.id, id));
          }
          if (input.roomId !== undefined && input.roomId !== before.roomId) {
            if (input.roomId != null) await setItemLocation(tx, id, { roomId: input.roomId });
            else await setItemLocation(tx, id, { roomId: null, houseId: before.houseId });
            await tx.update(items).set({ pos: null }).where(eq(items.id, id));
          }
          await logEvent(
            {
              entityType: "item",
              entityId: id,
              action: "updated",
              summary: `Item "${before.name}" batch updated`,
              payload: { roomId: input.roomId, areaId: input.areaId },
            },
            tx,
          );
        }
      });
      return { ok: true as const, count: uniqueIds.length };
    }),

  /** Hard-delete many Things. Refuses the whole batch if any still has sub-objects. */
  removeMany: procedure
    .input(z.object({ ids: z.array(z.number()).min(1).max(200) }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const uniqueIds = [...new Set(input.ids)];
      const blocked: string[] = [];
      for (const id of uniqueIds) {
        const item = await db.query.items.findFirst({ where: eq(items.id, id) });
        const children = await db.select({ id: items.id }).from(items).where(eq(items.parentId, id));
        if (children.length > 0) blocked.push(`"${item?.name ?? `#${id}`}" (${children.length} sub-object${children.length === 1 ? "" : "s"})`);
      }
      if (blocked.length) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Cannot delete until sub-objects are moved or deleted: ${blocked.join(", ")}`,
        });
      }
      const files: string[] = [];
      await db.transaction(async (tx) => {
        for (const id of uniqueIds) files.push(...(await deleteItemTx(tx, id)));
      });
      await releaseStoredFiles(db, files);
      return { ok: true as const, count: uniqueIds.length };
    }),

  remove: procedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const item = await db.query.items.findFirst({ where: eq(items.id, input.id) });
    const children = await db
      .select({ id: items.id })
      .from(items)
      .where(eq(items.parentId, input.id));
    if (children.length > 0) {
      return {
        ok: false as const,
        error: `Cannot delete "${item?.name ?? "item"}" — ${children.length} sub-object(s) are attached to it. Delete or move those first.`,
      };
    }
    const files = await db.transaction((tx) => deleteItemTx(tx, input.id));
    await releaseStoredFiles(db, files);
    return { ok: true as const };
  }),

  /** attach/detach a sub-object (set → mouse, cupboard → shelf) */
  setParent: procedure
    .input(z.object({ id: z.number(), parentId: z.number().nullable() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      if (input.parentId) {
        if (input.parentId === input.id) {
          return { ok: false as const, error: "An item cannot contain itself." };
        }
        // prevent cycles: walk up the chain from the new parent
        let cursor = input.parentId;
        const visited = new Set<number>();
        for (let i = 0; i < 50; i++) {
          if (visited.has(cursor)) break;
          visited.add(cursor);
          if (cursor === input.id) {
            return { ok: false as const, error: "That would create a loop (an object cannot contain itself, directly or indirectly)." };
          }
          const p = await db.query.items.findFirst({ where: eq(items.id, cursor) });
          if (!p?.parentId) break;
          cursor = p.parentId;
        }
      }
      await db.update(items).set({ parentId: input.parentId }).where(eq(items.id, input.id));
      await logEvent({
        entityType: "item",
        entityId: input.id,
        action: input.parentId ? "attached" : "detached",
        summary: input.parentId ? `Item #${input.id} attached under #${input.parentId}` : `Item #${input.id} detached from its parent`,
      });
      return { ok: true as const };
    }),

  // ---- relations ----
  addRelation: procedure
    .input(
      z.object({
        fromItemId: z.number(),
        toItemId: z.number(),
        type: z.string().default("related-to"),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [{ id }] = await db
        .insert(relations)
        .values({ ...input, origin: "user", status: "confirmed" })
        .$returningId();
      await logEvent({
        entityType: "relation",
        entityId: id,
        action: "created",
        summary: `Relation "${input.type}" created between items #${input.fromItemId} and #${input.toItemId}`,
      });
      return { id };
    }),

  resolveRelation: procedure
    .input(z.object({ id: z.number(), confirm: z.boolean() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      if (input.confirm) {
        await db.update(relations).set({ status: "confirmed" }).where(eq(relations.id, input.id));
      } else {
        await db.delete(relations).where(eq(relations.id, input.id));
      }
      await logEvent({
        entityType: "relation",
        entityId: input.id,
        action: input.confirm ? "confirmed" : "rejected",
        summary: `Suggested relation #${input.id} ${input.confirm ? "confirmed" : "rejected"}`,
      });
      return { ok: true };
    }),

  removeRelation: procedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    await db.delete(relations).where(eq(relations.id, input.id));
    await logEvent({
      entityType: "relation",
      entityId: input.id,
      action: "deleted",
      summary: `Relation #${input.id} removed`,
    });
    return { ok: true };
  }),

  /** lightweight search for pickers / auto-linking */
  search: procedure.input(z.object({ q: z.string() })).query(async ({ input }) => {
    const db = getDb();
    const all = await db.select().from(items).where(eq(items.status, "active"));
    const q = input.q.toLowerCase();
    return all
      .filter((i) => i.name.toLowerCase().includes(q))
      .slice(0, 10)
      .map((i) => ({ id: i.id, name: i.name, areaId: i.areaId }));
  }),
});
