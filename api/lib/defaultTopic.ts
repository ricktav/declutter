import { eq } from "drizzle-orm";
import { areas } from "@db/schema";
import type { getDb } from "../queries/connection";

type Db = ReturnType<typeof getDb>;

/** Topic for a Thing created without one; found by slug, so it is per database, not per settings file. */
export const DEFAULT_TOPIC_SLUG = "things";

export async function defaultAreaId(db: Db): Promise<number> {
  const found = await db.query.areas.findFirst({ where: eq(areas.slug, DEFAULT_TOPIC_SLUG) });
  if (found) return found.id;
  try {
    const [{ id }] = await db
      .insert(areas)
      .values({ slug: DEFAULT_TOPIC_SLUG, name: "Things", icon: "box", description: "Things without a topic yet." })
      .$returningId();
    return id;
  } catch (err) {
    // a concurrent first create won the unique slug
    const again = await db.query.areas.findFirst({ where: eq(areas.slug, DEFAULT_TOPIC_SLUG) });
    if (again) return again.id;
    throw err;
  }
}
