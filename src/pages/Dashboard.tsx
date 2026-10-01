import { Link, useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { trpc } from "@/providers/trpc";
import { CaptureBar } from "@/components/CaptureBar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { timeAgo } from "@/lib/format";
import { getLastLocation, setLastLocation } from "@/lib/lastLocation";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { FloorsEditor } from "@/components/FloorsEditor";
import { aerialThumbUrl, fetchParcelInfo, kadastraleKaartUrl, reverseGeocode, type AddressSuggestion, type ParcelInfo } from "@/lib/pdok";
import { ArrowRight, ExternalLink, Inbox, Lightbulb, ListChecks, Loader2, LocateFixed, MapPin, Package, Plus } from "lucide-react";
import {
  Laptop,
  Wrench,
  Home,
  ChefHat,
  Leaf,
  Briefcase,
  Calendar,
  Box,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

const AREA_ICONS: { key: string; label: string; icon: LucideIcon }[] = [
  { key: "laptop", label: "Computers", icon: Laptop },
  { key: "wrench", label: "Tools", icon: Wrench },
  { key: "home", label: "House", icon: Home },
  { key: "chef-hat", label: "Kitchen", icon: ChefHat },
  { key: "leaf", label: "Garden", icon: Leaf },
  { key: "briefcase", label: "Work", icon: Briefcase },
  { key: "calendar", label: "Schedule", icon: Calendar },
  { key: "box", label: "General", icon: Box },
];

const AREA_COLORS = ["#5b8c5a", "#282c20", "#6366f1", "#0891b2", "#d97706", "#dc2626", "#7c3aed"];

function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function AddAreaDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [icon, setIcon] = useState("box");
  const [color, setColor] = useState(AREA_COLORS[0]);
  const [description, setDescription] = useState("");
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const create = trpc.areas.create.useMutation({
    onSuccess: (area) => {
      utils.areas.list.invalidate();
      setOpen(false);
      setName(""); setSlug(""); setSlugTouched(false); setIcon("box"); setColor(AREA_COLORS[0]); setDescription("");
      if (area) navigate(`/areas/${area.slug}`);
    },
  });

  const effectiveSlug = slugTouched ? slug : slugify(name);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 text-[12px]">
          <Plus className="h-3.5 w-3.5 mr-1" /> New topic
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New topic</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block">
            <span className="micro-label text-muted-foreground">Name</span>
            <input
              className="mt-0.5 w-full rounded-md border border-input bg-white px-2 py-1.5 text-[13px]"
              placeholder="e.g. Server Closet"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
          <label className="block">
            <span className="micro-label text-muted-foreground">Slug (URL)</span>
            <input
              className="mt-0.5 w-full rounded-md border border-input bg-white px-2 py-1.5 text-[13px] font-data"
              value={effectiveSlug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
            />
          </label>
          <div>
            <span className="micro-label text-muted-foreground">Icon</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {AREA_ICONS.map((i) => (
                <button
                  key={i.key}
                  type="button"
                  title={i.label}
                  onClick={() => setIcon(i.key)}
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-md border",
                    icon === i.key
                      ? "border-primary bg-accent text-primary"
                      : "border-border bg-white text-muted-foreground hover:bg-accent"
                  )}
                >
                  <i.icon className="h-4 w-4" />
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="micro-label text-muted-foreground">Color</span>
            <div className="mt-1 flex gap-1.5">
              {AREA_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={cn(
                    "h-6 w-6 rounded-sm border-2",
                    color === c ? "border-primary" : "border-transparent"
                  )}
                  style={{ background: c }}
                />
              ))}
            </div>
          </div>
          <label className="block">
            <span className="micro-label text-muted-foreground">Description (optional)</span>
            <input
              className="mt-0.5 w-full rounded-md border border-input bg-white px-2 py-1.5 text-[13px]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div className="flex justify-end pt-1">
            <Button
              size="sm"
              className="h-8 text-[12px]"
              disabled={!name.trim() || !effectiveSlug.trim() || create.isPending}
              onClick={() =>
                create.mutate({
                  name: name.trim(),
                  slug: effectiveSlug.trim(),
                  icon,
                  color,
                  description: description.trim() || undefined,
                })
              }
            >
              {create.isPending ? "Creating…" : "Create topic"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface ResolvedAddress {
  address: string;
  lat: number | null;
  lng: number | null;
  bagId: string | null;
  parcel: ParcelInfo | null;
}

/** Address field shared by the new-house and edit-house dialogs: PDOK
 * autocomplete, plus a "use my location" button that reverse-geocodes the
 * browser's geolocation to the nearest Dutch address. */
function AddressWithParcelPicker({
  value,
  onResolve,
}: {
  value: ResolvedAddress;
  onResolve: (next: ResolvedAddress) => void;
}) {
  const [lookingUpParcel, setLookingUpParcel] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);

  const resolveFrom = async (s: AddressSuggestion) => {
    onResolve({ address: s.label, lat: s.lat, lng: s.lng, bagId: s.bagId, parcel: null });
    setLookingUpParcel(true);
    const info = await fetchParcelInfo(s).catch(() => null);
    setLookingUpParcel(false);
    onResolve({ address: s.label, lat: s.lat, lng: s.lng, bagId: s.bagId, parcel: info });
  };

  const useMyLocation = () => {
    setLocateError(null);
    if (!navigator.geolocation) {
      setLocateError("Geolocation not available in this browser");
      return;
    }
    if (!window.isSecureContext) {
      setLocateError("Browser location needs HTTPS (or localhost) - not available over plain http:// on the LAN");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const hit = await reverseGeocode(pos.coords.latitude, pos.coords.longitude).catch(() => null);
        setLocating(false);
        if (!hit) {
          setLocateError("Couldn't match that location to an address");
          return;
        }
        await resolveFrom(hit);
      },
      () => {
        setLocating(false);
        setLocateError("Location permission denied");
      },
      { timeout: 10_000 },
    );
  };

  return (
    <div>
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <AddressAutocomplete
            value={value.address}
            onChange={(v) => onResolve({ address: v, lat: null, lng: null, bagId: null, parcel: null })}
            onSelect={resolveFrom}
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 text-[12px] shrink-0"
          disabled={locating}
          onClick={useMyLocation}
          title="Use my current location"
        >
          {locating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LocateFixed className="h-3.5 w-3.5" />}
        </Button>
      </div>
      {lookingUpParcel && <p className="text-[11px] text-muted-foreground mt-1">Looking up parcel…</p>}
      {locateError && <p className="text-[11px] text-destructive mt-1">{locateError}</p>}
      {value.lat != null && !lookingUpParcel && (
        <p className="text-[11px] text-muted-foreground mt-1">
          Matched · {value.lat.toFixed(5)}, {value.lng!.toFixed(5)}
          {value.parcel ? ` · ${value.parcel.parcelId}` : ""}
        </p>
      )}
    </div>
  );
}

const EMPTY_ADDRESS: ResolvedAddress = { address: "", lat: null, lng: null, bagId: null, parcel: null };

function AddHouseDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (id: number) => void;
}) {
  const [name, setName] = useState("");
  const [addr, setAddr] = useState<ResolvedAddress>(EMPTY_ADDRESS);
  // most houses have at least a ground floor, so start with it pre-added
  // instead of making every new house re-click the same first pill
  const [floors, setFloors] = useState<string[] | null>(["ground"]);
  const utils = trpc.useUtils();
  const create = trpc.houses.create.useMutation({
    onSuccess: (house) => {
      utils.houses.list.invalidate();
      onOpenChange(false);
      setName("");
      setAddr(EMPTY_ADDRESS);
      setFloors(["ground"]);
      if (house) onCreated(house.id);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (v) {
          setName("");
          setAddr(EMPTY_ADDRESS);
          setFloors(["ground"]);
        }
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>New house</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block">
            <span className="micro-label text-muted-foreground">Name</span>
            <input
              className="mt-0.5 w-full rounded-md border border-input bg-white px-2 py-1.5 text-[13px]"
              placeholder="e.g. Home, Office"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
          <label className="block">
            <span className="micro-label text-muted-foreground">Address (optional)</span>
            <div className="mt-0.5">
              <AddressWithParcelPicker
                value={addr}
                onResolve={(next) => {
                  setAddr(next);
                  if (!name.trim() && next.address) setName(next.address.split(",")[0] ?? next.address);
                }}
              />
            </div>
          </label>
          <label className="block">
            <span className="micro-label text-muted-foreground">Floors (optional)</span>
            <div className="mt-0.5">
              <FloorsEditor value={floors} onChange={setFloors} />
            </div>
          </label>
          <div className="flex justify-end">
            <Button
              size="sm"
              className="h-8 text-[12px]"
              disabled={!name.trim() || create.isPending}
              onClick={() =>
                create.mutate({
                  name: name.trim(),
                  address: addr.address.trim() || undefined,
                  lat: addr.lat ?? undefined,
                  lng: addr.lng ?? undefined,
                  bagId: addr.bagId ?? undefined,
                  parcelId: addr.parcel?.parcelId || undefined,
                  parcelAreaM2: addr.parcel?.parcelAreaM2 ?? undefined,
                  floors: floors ?? undefined,
                })
              }
            >
              {create.isPending ? "Creating…" : "Create house"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Edit an existing house's name/address/parcel from the Dashboard - the
 * same fields Settings → Houses offers, surfaced where you're already
 * looking (the "Working in" bar) so switching house and fixing it up don't
 * require two different screens. */
interface EditableHouse {
  id: number;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  bagId?: string | null;
  parcelId?: string | null;
  parcelAreaM2?: number | null;
  floors?: string[] | null;
}

function houseToResolvedAddress(h: EditableHouse): ResolvedAddress {
  return {
    address: h.address ?? "",
    lat: h.lat,
    lng: h.lng,
    bagId: h.bagId ?? null,
    parcel: h.parcelId ? { parcelId: h.parcelId, parcelAreaM2: h.parcelAreaM2 ?? null } : null,
  };
}

function EditHouseDialog({
  house,
  open,
  onOpenChange,
  allHouses,
  onSwitchHouse,
  onRequestNew,
}: {
  house: EditableHouse;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  allHouses: { id: number; name: string }[];
  onSwitchHouse: (id: number) => void;
  onRequestNew: () => void;
}) {
  const [name, setName] = useState(house.name);
  const [addr, setAddr] = useState<ResolvedAddress>(() => houseToResolvedAddress(house));
  const [floors, setFloors] = useState<string[] | null>(house.floors ?? null);
  const utils = trpc.useUtils();
  const update = trpc.houses.update.useMutation({
    onSuccess: () => {
      utils.houses.list.invalidate();
      onOpenChange(false);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (v) {
          setName(house.name);
          setAddr(houseToResolvedAddress(house));
          setFloors(house.floors ?? null);
        }
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit house</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {allHouses.length > 0 && (
            <label className="block">
              <span className="micro-label text-muted-foreground">Switch house</span>
              <select
                className="mt-0.5 w-full rounded-md border border-input bg-white px-2 py-1.5 text-[13px]"
                value={house.id}
                onChange={(e) => {
                  if (e.target.value === "__new__") onRequestNew();
                  else onSwitchHouse(Number(e.target.value));
                }}
              >
                {allHouses.map((h) => (
                  <option key={h.id} value={h.id}>{h.name}</option>
                ))}
                <option value="__new__">+ New house…</option>
              </select>
            </label>
          )}
          <label className="block">
            <span className="micro-label text-muted-foreground">Name</span>
            <input
              className="mt-0.5 w-full rounded-md border border-input bg-white px-2 py-1.5 text-[13px]"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
          <label className="block">
            <span className="micro-label text-muted-foreground">Address</span>
            <div className="mt-0.5">
              <AddressWithParcelPicker value={addr} onResolve={setAddr} />
            </div>
            {addr.address && (
              <a
                href={kadastraleKaartUrl(addr.address)}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
              >
                View parcel <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </label>
          <label className="block">
            <span className="micro-label text-muted-foreground">Floors</span>
            <div className="mt-0.5">
              <FloorsEditor value={floors} onChange={setFloors} />
            </div>
          </label>
          <p className="text-[11px] text-muted-foreground">Notes can be edited in Settings → Houses.</p>
          <div className="flex justify-end">
            <Button
              size="sm"
              className="h-8 text-[12px]"
              disabled={!name.trim() || update.isPending}
              onClick={() =>
                update.mutate({
                  id: house.id,
                  name: name.trim(),
                  address: addr.address.trim() || null,
                  lat: addr.lat,
                  lng: addr.lng,
                  bagId: addr.bagId,
                  parcelId: addr.parcel?.parcelId ?? undefined,
                  parcelAreaM2: addr.parcel?.parcelAreaM2 ?? undefined,
                  floors,
                })
              }
            >
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Which house you're currently working in - collapsed to a small chip most
 * of the time, since switching house is occasional, not something that
 * deserves permanent dashboard real estate. Clicking it is the one entry
 * point for switching, editing, or adding a house - the dialog that opens
 * handles all three. Defaults to the last house confirmed anywhere in the
 * app (shared with Inbox's pin-location flow). */
function HouseSection({
  houseId,
  onSelectHouse,
}: {
  houseId: number | null;
  onSelectHouse: (id: number | null) => void;
}) {
  const houses = trpc.houses.list.useQuery();
  const [dialog, setDialog] = useState<"none" | "edit" | "add">("none");

  useEffect(() => {
    if (houseId == null && houses.data && houses.data.length > 0) {
      onSelectHouse(houses.data[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [houses.data, houseId]);

  const current = houses.data?.find((h) => h.id === houseId);

  return (
    <>
      <button
        type="button"
        className="rounded-lg border border-border bg-white px-3 py-2 flex items-center gap-2.5 hover:border-primary/50 transition-colors text-left"
        onClick={() => setDialog(current ? "edit" : "add")}
      >
        {current?.lat != null && current.lng != null ? (
          <img
            src={aerialThumbUrl(current.lat, current.lng)}
            alt=""
            className="h-8 w-8 rounded-md object-cover border border-border shrink-0"
          />
        ) : (
          <div className="h-8 w-8 rounded-md bg-accent flex items-center justify-center shrink-0">
            <Home className="h-4 w-4 text-muted-foreground" />
          </div>
        )}
        <div className="min-w-0">
          <div className="text-[13px] font-semibold truncate">{current?.name ?? "Add a house"}</div>
          {current && (
            <div className="font-data text-[11px] text-muted-foreground truncate">
              {current.itemCount} item{current.itemCount === 1 ? "" : "s"}
              {current.address ? ` · ${current.address}` : ""}
            </div>
          )}
        </div>
      </button>

      {current && (
        <EditHouseDialog
          key={current.id}
          house={current}
          open={dialog === "edit"}
          onOpenChange={(v) => setDialog(v ? "edit" : "none")}
          allHouses={houses.data ?? []}
          onSwitchHouse={(id) => onSelectHouse(id)}
          onRequestNew={() => setDialog("add")}
        />
      )}
      <AddHouseDialog
        open={dialog === "add"}
        onOpenChange={(v) => setDialog(v ? "add" : "none")}
        onCreated={(id) => {
          onSelectHouse(id);
          setDialog("none");
        }}
      />
    </>
  );
}

function LocationsSection({ houseId }: { houseId: number | null }) {
  const locations = trpc.map.listLocations.useQuery();
  const scoped = (locations.data ?? []).filter((l) => houseId == null || l.houseId === houseId);

  return (
    <section>
      <div className="flex items-center h-7 mb-2">
        <h2 className="micro-label text-muted-foreground">Locations</h2>
        <Link to="/map" className="ml-auto text-[12px] text-primary hover:underline">
          Map view →
        </Link>
      </div>
      <div className="rounded-lg border border-border bg-white divide-y divide-border">
        {scoped.length === 0 && (
          <div className="px-4 py-5 text-[13px] text-muted-foreground">
            No locations yet — set a room on an item, or confirm one while pinning from the Inbox.
          </div>
        )}
        {scoped.slice(0, 8).map((l) => {
          const key = `${l.houseId ?? "none"}|${l.floor ?? "none"}|${l.room}`;
          const to = `/items?houseId=${l.houseId ?? "none"}&floor=${encodeURIComponent(l.floor ?? "none")}&room=${encodeURIComponent(l.room)}`;
          return (
            <Link key={key} to={to} className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/40 transition-colors">
              <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-[13px] font-medium flex-1 truncate">
                {l.room}
                {(l.houseName || l.floor) && (
                  <span className="text-muted-foreground font-normal">
                    {" "}
                    · {[l.houseName, l.floor].filter(Boolean).join(" · ")}
                  </span>
                )}
              </span>
              <span className="font-data text-[12px] text-muted-foreground">{l.count}</span>
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export default function Dashboard() {
  const [houseId, setHouseId] = useState<number | null>(() => getLastLocation().houseId);
  const selectHouse = (id: number | null) => {
    setHouseId(id);
    setLastLocation({ ...getLastLocation(), houseId: id });
  };

  // Topics (and the Items stat, derived from them) are scoped to whichever
  // house is "working in" - the whole dashboard reflects that context, not
  // just the house chip itself
  const areas = trpc.areas.list.useQuery({ houseId });
  const inboxList = trpc.inbox.list.useQuery();
  const tasks = trpc.tasks.list.useQuery();
  const ideas = trpc.ideas.list.useQuery();
  const events = trpc.events.list.useQuery({ limit: 12 });

  const pending = (inboxList.data ?? []).filter((c) => c.status === "pending").length;
  const openTasks = (tasks.data ?? []).filter((t) => t.status !== "done").length;
  const newIdeas = (ideas.data ?? []).filter((i) => i.status === "new").length;
  const totalItems = (areas.data ?? []).reduce((s, a) => s + a.itemCount, 0);
  const firstArea = (areas.data ?? []).find((a) => a.itemCount > 0) ?? areas.data?.[0];

  const stats = [
    { label: "Items", value: totalItems, icon: Package, to: firstArea ? `/areas/${firstArea.slug}` : "/settings" },
    { label: "Inbox pending", value: pending, icon: Inbox, to: "/inbox" },
    { label: "New ideas", value: newIdeas, icon: Lightbulb, to: "/ideas" },
    { label: "Open tasks", value: openTasks, icon: ListChecks, to: "/tasks" },
  ];

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p className="text-sm text-muted-foreground mt-1">
        Capture first, structure later — everything flows through the inbox.
      </p>

      <div className="mt-5">
        <CaptureBar />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
        {stats.map((s) => (
          <Link
            key={s.label}
            to={s.to}
            className="rounded-lg border border-border bg-white px-4 py-3 hover:bg-accent/40 transition-colors"
          >
            <div className="flex items-center gap-2 text-muted-foreground">
              <s.icon className="h-4 w-4" />
              <span className="micro-label">{s.label}</span>
            </div>
            <div className="font-data text-3xl mt-1.5">{s.value}</div>
          </Link>
        ))}
      </div>

      <div className="mt-6">
        <HouseSection houseId={houseId} onSelectHouse={selectHouse} />
      </div>

      <div className="grid md:grid-cols-2 gap-6 mt-6">
        <section>
          <div className="flex items-center h-7 mb-2">
            <h2 className="micro-label text-muted-foreground">Topics</h2>
            <div className="ml-auto"><AddAreaDialog /></div>
          </div>
          <div className="rounded-lg border border-border bg-white divide-y divide-border">
            {(areas.data ?? []).length === 0 && (
              <div className="px-4 py-5 text-[13px] text-muted-foreground space-y-1">
                <p>No topics yet — create one with the button above.</p>
                <p className="text-[12px]">
                  Want a head start? Run <code className="font-data rounded bg-accent px-1">npx tsx db/seed.ts</code> to load the starter set
                  (computers, garage, house, kitchen, garden, work, schedule).
                </p>
              </div>
            )}
            {(areas.data ?? []).map((a) => (
              <Link
                key={a.id}
                to={`/areas/${a.slug}`}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/40 transition-colors"
              >
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: a.color }} />
                <span className="text-[13px] font-medium flex-1">{a.name}</span>
                <span className="font-data text-[12px] text-muted-foreground">{a.itemCount}</span>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
              </Link>
            ))}
          </div>
        </section>

        <LocationsSection houseId={houseId} />
      </div>

      <div className="mt-6">
        <section>
          <h2 className="micro-label text-muted-foreground mb-2">Recent activity</h2>
          <div className="rounded-lg border border-border bg-white divide-y divide-border">
            {(events.data ?? []).length === 0 && (
              <div className="px-4 py-6 text-[13px] text-muted-foreground">Nothing yet — capture something above.</div>
            )}
            {(events.data ?? []).map((e) => (
              <div key={e.id} className="px-4 py-2 flex items-baseline gap-2">
                <span
                  className={`micro-label shrink-0 ${
                    e.actor === "ai" ? "text-violet-600" : e.actor === "system" ? "text-sky-600" : "text-muted-foreground"
                  }`}
                >
                  {e.actor}
                </span>
                <span className="text-[13px] flex-1 min-w-0 truncate">{e.summary}</span>
                <span className="font-data text-[11px] text-muted-foreground shrink-0">
                  {timeAgo(e.createdAt)}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
