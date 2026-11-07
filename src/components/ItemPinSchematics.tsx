import { useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { aspectOf, usePhotoUrls } from "@/hooks/use-photo-urls";
import { PhotoSchematic } from "@/components/PhotoSchematic";
import { EMPTY_SCHEMA_FILTER, isFramed, type SchemaPin } from "@/lib/schemaFilter";

/**
 * For each Photo this Thing is pinned in (and that has a room), a small
 * schematic of that Photo: this Thing's block outlined, the others dimmed.
 * A click opens the room page's Schema view with this Thing selected.
 */
export function ItemPinSchematics({ itemId }: { itemId: number }) {
  const { data: rows = [] } = trpc.pins.forItemPhotos.useQuery({ itemId });
  const cards: Array<{ photoId: number; roomId: number; title: string | null; storageKey: string; pins: SchemaPin[] }> = [];
  for (const pin of rows) {
    let card = cards.find((c) => c.photoId === pin.photoId);
    if (!card) {
      card = { photoId: pin.photoId, roomId: pin.roomId, title: pin.photoTitle, storageKey: pin.photoStorageKey, pins: [] };
      cards.push(card);
    }
    card.pins.push(pin);
  }
  const { byKey } = usePhotoUrls(cards.map((c) => c.storageKey));
  if (!cards.length) return null;
  return (
    <div className="mt-2 grid grid-cols-2 gap-2" data-testid="item-pin-schematics">
      {cards.map((c) => (
        <PinSchematicCard key={c.photoId} itemId={itemId} card={c} aspect={aspectOf(byKey.get(c.storageKey)) ?? 4 / 3} />
      ))}
    </div>
  );
}

function PinSchematicCard({
  itemId,
  card,
  aspect,
}: {
  itemId: number;
  aspect: number;
  card: { photoId: number; roomId: number; title: string | null; storageKey: string; pins: SchemaPin[] };
}) {
  const navigate = useNavigate();
  const own = card.pins.find((p) => p.itemId === itemId);
  // an unframed pin of this Thing still shows, as a point
  const showPoints = own != null && !isFramed(own);
  const to = `/rooms/${card.roomId}?schema=1&thing=${itemId}`;
  return (
    <div className="min-w-0" data-photo-id={card.photoId}>
      {aspect != null ? (
        <div
          className="cursor-pointer"
          data-schematic-for={card.photoId}
          title="Open the room's Schema view"
          onClickCapture={(e) => {
            e.preventDefault();
            e.stopPropagation();
            navigate(to);
          }}
        >
          {/* the others dimmed: everything but this Thing's own pin */}
          <style>{`[data-schematic-for="${card.photoId}"] [data-pin-id]${own ? `:not([data-pin-id="${own.id}"])` : ""}{opacity:.35}`}</style>
          <PhotoSchematic
            pins={card.pins}
            aspect={aspect}
            filter={EMPTY_SCHEMA_FILTER}
            showPoints={showPoints}
            selectedItemId={itemId}
            onPick={() => navigate(to)}
          />
        </div>
      ) : (
        <div className="aspect-[4/3] w-full rounded border border-dashed border-border" />
      )}
      <button
        type="button"
        className="mt-0.5 block w-full truncate text-left text-[10px] text-muted-foreground hover:text-primary"
        onClick={() => navigate(to)}
      >
        {card.title ?? `Photo #${card.photoId}`} · Schema
      </button>
    </div>
  );
}
