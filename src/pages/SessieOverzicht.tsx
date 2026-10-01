import { useState } from "react";
import { Link } from "react-router";
import {
  Home,
  Layers,
  MapPin,
  Inbox,
  Package,
  Image as ImageIcon,
  Tag,
  ArrowRight,
  ArrowDown,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type EntityKey = "house" | "floor" | "location" | "capture" | "item" | "photo" | "topic";

interface Step {
  label: string;
  detail: string;
  to?: string;
  where?: string;
}

interface Workflow {
  label: string;
  icon: LucideIcon;
  color: string;
  summary: string;
  steps: Step[];
  notes?: string[];
}

const WORKFLOWS: Record<EntityKey, Workflow> = {
  house: {
    label: "House",
    icon: Home,
    color: "#0891b2",
    summary: "The top of the location hierarchy — where you're physically working, and the context everything else (floors, rooms, items) hangs off.",
    steps: [
      { label: "Created", detail: "Name it, optionally search a real address via PDOK — auto-fills lat/lng, BAG id, parcel size.", to: "/", where: "Dashboard → New house" },
      { label: "Geocoded", detail: "Once an address is picked, the house gets a parcel link out to the cadastral map viewer and an aerial thumbnail.", to: "/" },
      { label: "Floors set up", detail: "Pick common floors as pills, or mark it as having none at all — a one-level building skips the floor question everywhere else.", to: "/settings", where: "Settings → Houses" },
      { label: "Selected as context", detail: "The \"Working in\" house is remembered across the app (localStorage) as your default when pinning or filtering.", to: "/" },
      { label: "Edited any time", detail: "Rename, re-geocode, or change its floor list later — nothing else needs to be redone.", to: "/", where: "Dashboard → pencil icon" },
    ],
  },
  floor: {
    label: "Floor",
    icon: Layers,
    color: "#7c3aed",
    summary: "Not its own database table — just a label a house carries, used to group rooms. Can be generic, customized, or turned off entirely.",
    steps: [
      { label: "Not customized", detail: "No floors set yet (null) — the generic default list applies: basement, ground, 1, 2, 3, attic.", where: "default for every new house until touched" },
      { label: "Customized", detail: "Pick your own set of floor names as pills (any order, reorder with the arrows) — only this house uses that list.", to: "/settings", where: "Settings → Houses, or the house dialogs" },
      { label: "Marked \"no floors\"", detail: "Remove every pill and the house explicitly has none — the floor field disappears everywhere this house is picked (item location, Inbox pinning, …).", where: "RoomPicker hides the field" },
    ],
  },
  location: {
    label: "Location / Room",
    icon: MapPin,
    color: "#d97706",
    summary: "A house + floor + room combination — discovered from whatever items and photos already reference it, not a table of its own.",
    steps: [
      { label: "First referenced", detail: "An item gets a room typed in, or a photo gets pinned to a place before any item exists for it yet.", to: "/map", where: "Map, or an item's Location field" },
      { label: "Appears in Locations", detail: "Shows up on the Dashboard and Map once at least one item or photo references it, with a running count.", to: "/map" },
      { label: "Browsed", detail: "Click through from the Dashboard, sidebar, or Map to see every photo and item filed under that room.", to: "/map" },
      { label: "Gets its own photos", detail: "A location can hold photos that aren't pinned to any item yet — the raw context shot of the room.", to: "/photos" },
    ],
  },
  capture: {
    label: "Inbox capture",
    icon: Inbox,
    color: "#5b8c5a",
    summary: "Anything dropped into the Inbox — a photo, a note, a link — starts here before it becomes a real item.",
    steps: [
      { label: "Pending", detail: "Just captured (camera, upload, Telegram, paste) — sitting in the inbox, untouched.", to: "/inbox", where: "Inbox → Pending" },
      { label: "AI triage", detail: "Suggests a topic and item name; detect-objects can find several items in one photo at once.", to: "/inbox" },
      { label: "Accepted", detail: "Confirming triage creates the item (if new) and carries the photo over as its attachment. Status → triaged.", to: "/inbox" },
      { label: "Dismissed", detail: "Not useful — hidden from Processed entirely rather than lingering greyed out.", to: "/inbox" },
      { label: "Duplicate check", detail: "Byte-identical captures get hard-deleted (keeping the oldest) — or dismissed instead, if already pinned to an item.", to: "/inbox", where: "Inbox → Merge duplicates" },
    ],
  },
  item: {
    label: "Item",
    icon: Package,
    color: "#dc2626",
    summary: "A real-world thing you own — the unit everything else (photos, location, relations, tasks) attaches to.",
    steps: [
      { label: "Created", detail: "From an accepted inbox capture, a detected object, or typed in by hand.", to: "/items" },
      { label: "Detected, unreviewed", detail: "Auto-detected items start as \"detected\" — confirm or reject before they're treated as real.", to: "/items" },
      { label: "Filed", detail: "Gets a topic, a house/floor/room, attributes, and any number of photos/notes/links.", to: "/items" },
      { label: "Related", detail: "Linked to other items (related-to, part-of, …), suggested automatically or added by hand.", to: "/items" },
      { label: "Archived / restored", detail: "Taken out of the active count without deleting it — shown with a clear badge on its own page.", to: "/items" },
      { label: "Deleted", detail: "Permanent — removes the item and its attachments.", to: "/items" },
    ],
  },
  photo: {
    label: "Photo",
    icon: ImageIcon,
    color: "#2563eb",
    summary: "The thing with the most lifecycle of all: it can belong to an item, a location, or nothing yet — and move between those freely.",
    steps: [
      { label: "Raw capture", detail: "Not yet an attachment — still just an inbox photo. Shows in the Photos catalog as \"not pinned yet\".", to: "/photos" },
      { label: "Pinned to an item", detail: "Objects annotated/cropped from it become the item's own photo (cutout or full frame).", to: "/annotate/1", where: "the annotate canvas" },
      { label: "Pinned to a location", detail: "Confirmed to a house/floor/room without needing an item yet — the \"location photo\" case.", to: "/map" },
      { label: "Unlinked", detail: "Removing it from an item just un-pins it — it goes back to the pool, keeping the item's old location, not deleted.", to: "/items" },
      { label: "Deleted", detail: "Only for notes/links, or a photo nobody holds a reference to any more — a real, permanent removal.", to: "/items" },
      { label: "Deduplicated", detail: "Identical photos collapse to one (oldest kept) unless a surviving duplicate is already pinned elsewhere.", to: "/inbox" },
    ],
  },
  topic: {
    label: "Topic (Area)",
    icon: Tag,
    color: "#282c20",
    summary: "What kind of thing it is (Computers, Kitchen, …) — orthogonal to where it physically is.",
    steps: [
      { label: "Created", detail: "Name, color, icon — a simple label items get grouped under.", to: "/" },
      { label: "Assigned", detail: "Every item belongs to exactly one topic, set at creation or changed later.", to: "/items" },
      { label: "Browsed", detail: "Dashboard and sidebar list topics with live item counts.", to: "/" },
    ],
  },
};

const ORDER: EntityKey[] = ["house", "floor", "location", "capture", "item", "photo", "topic"];

function RelationshipMap() {
  const boxes: { key: EntityKey; label: string }[] = [
    { key: "house", label: "House" },
    { key: "floor", label: "Floor" },
    { key: "location", label: "Room" },
    { key: "item", label: "Item" },
  ];
  return (
    <div className="rounded-lg border border-border bg-white p-4">
      <div className="micro-label text-muted-foreground mb-3">How the entities relate</div>
      <div className="flex flex-wrap items-center gap-2">
        {boxes.map((b, i) => (
          <div key={b.key} className="flex items-center gap-2">
            <span
              className="rounded-md border px-3 py-1.5 text-[13px] font-medium"
              style={{ borderColor: WORKFLOWS[b.key].color, color: WORKFLOWS[b.key].color }}
            >
              {b.label}
            </span>
            {i < boxes.length - 1 && <ArrowRight className="h-4 w-4 text-muted-foreground" />}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-3">
        <ArrowDown className="h-4 w-4 text-muted-foreground ml-1" />
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-1">
        <span
          className="rounded-md border px-3 py-1.5 text-[13px] font-medium"
          style={{ borderColor: WORKFLOWS.photo.color, color: WORKFLOWS.photo.color }}
        >
          Photo
        </span>
        <ArrowRight className="h-4 w-4 text-muted-foreground rotate-180" />
        <span
          className="rounded-md border px-3 py-1.5 text-[13px] font-medium"
          style={{ borderColor: WORKFLOWS.capture.color, color: WORKFLOWS.capture.color }}
        >
          Inbox capture
        </span>
        <span className="text-[12px] text-muted-foreground ml-2">— a photo can be pinned to an Item, a Room, or sit unlinked</span>
      </div>
      <div className="flex items-center gap-2 mt-3">
        <span
          className="rounded-md border px-3 py-1.5 text-[13px] font-medium"
          style={{ borderColor: WORKFLOWS.topic.color, color: WORKFLOWS.topic.color }}
        >
          Topic
        </span>
        <ArrowRight className="h-4 w-4 text-muted-foreground" />
        <span
          className="rounded-md border px-3 py-1.5 text-[13px] font-medium"
          style={{ borderColor: WORKFLOWS.item.color, color: WORKFLOWS.item.color }}
        >
          Item
        </span>
        <span className="text-[12px] text-muted-foreground ml-2">— "what kind of thing", independent of where it is</span>
      </div>
    </div>
  );
}

export default function SessieOverzicht() {
  const [selected, setSelected] = useState<EntityKey>("house");
  const wf = WORKFLOWS[selected];

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Session overview</h1>
      <p className="text-sm text-muted-foreground mt-1">
        How each kind of thing in HomeBase moves through its lifecycle — pick one to see its workflow.
      </p>

      <div className="mt-5">
        <RelationshipMap />
      </div>

      <div className="flex flex-wrap gap-2 mt-6">
        {ORDER.map((key) => {
          const w = WORKFLOWS[key];
          const active = key === selected;
          return (
            <button
              key={key}
              onClick={() => setSelected(key)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors",
                active ? "text-white" : "border-border bg-white text-muted-foreground hover:bg-accent/60",
              )}
              style={active ? { background: w.color, borderColor: w.color } : undefined}
            >
              <w.icon className="h-3.5 w-3.5" />
              {w.label}
            </button>
          );
        })}
      </div>

      <div className="mt-5 rounded-lg border border-border bg-white p-5">
        <div className="flex items-center gap-2">
          <wf.icon className="h-5 w-5" style={{ color: wf.color }} />
          <h2 className="text-lg font-semibold">{wf.label}</h2>
        </div>
        <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">{wf.summary}</p>

        <div className="mt-5 flex flex-wrap items-stretch gap-2">
          {wf.steps.map((s, i) => {
            const card = (
              <div
                className="flex-1 min-w-[180px] rounded-lg border border-border bg-white p-3 hover:border-primary/50 transition-colors"
                style={{ borderTopColor: wf.color, borderTopWidth: 2 }}
              >
                <div className="text-[13px] font-semibold">{s.label}</div>
                <div className="text-[12px] text-muted-foreground mt-1">{s.detail}</div>
                {s.where && (
                  <div className="font-data text-[10px] text-muted-foreground mt-1.5 uppercase tracking-wide">{s.where}</div>
                )}
              </div>
            );
            return (
              <div key={s.label} className="flex items-stretch gap-2 flex-1 min-w-[180px]">
                {s.to ? (
                  <Link to={s.to} className="flex-1">
                    {card}
                  </Link>
                ) : (
                  card
                )}
                {i < wf.steps.length - 1 && (
                  <div className="hidden sm:flex items-center text-muted-foreground shrink-0">
                    <ArrowRight className="h-4 w-4" />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {wf.notes && wf.notes.length > 0 && (
          <div className="mt-4 space-y-1">
            {wf.notes.map((n) => (
              <div key={n} className="text-[12px] text-muted-foreground">
                • {n}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
