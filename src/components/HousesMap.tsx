import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { trpc } from "@/providers/trpc";
import { setLastLocation, getLastLocation } from "@/lib/lastLocation";

// Leaflet's default marker icon references image files by relative URL,
// which breaks under a bundler - point it at the package's own assets.
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

// L.Icon.Default.mergeOptions alone isn't enough under a bundler - Leaflet
// still runs its own CSS-based path auto-detection for anything it doesn't
// recognize as explicitly overridden, which (with a bundler-resolved URL
// already in play) produces a doubled, broken path. Build a fully explicit
// icon instead of touching the Default icon at all.
const pinIcon = L.icon({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

/** Every house with a known address, pinned on an actual map - clicking a
 * pin makes that house the Dashboard's "Working in" context, since that's
 * the most useful thing to do with "where is this house" at a glance. */
export function HousesMap() {
  const houses = trpc.houses.list.useQuery();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { scrollWheelZoom: false }).setView([52.1, 5.1], 7);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !houses.data) return;
    const located = houses.data.filter((h) => h.lat != null && h.lng != null);
    const markers: L.Marker[] = located.map((h) => {
      const marker = L.marker([h.lat!, h.lng!], { icon: pinIcon }).addTo(map);
      marker.bindPopup(
        `<b>${h.name}</b>${h.address ? `<br>${h.address}` : ""}<br>${h.itemCount} item${h.itemCount === 1 ? "" : "s"}`,
      );
      marker.on("click", () => {
        setLastLocation({ ...getLastLocation(), houseId: h.id });
        navigate("/");
      });
      return marker;
    });
    if (located.length > 0) {
      const bounds = L.latLngBounds(located.map((h) => [h.lat!, h.lng!] as [number, number]));
      map.fitBounds(bounds.pad(0.3), { maxZoom: 15 });
    }
    return () => {
      markers.forEach((m) => m.remove());
    };
  }, [houses.data, navigate]);

  const locatedCount = (houses.data ?? []).filter((h) => h.lat != null && h.lng != null).length;
  const unlocatedCount = (houses.data ?? []).length - locatedCount;

  return (
    <div className="rounded-lg border border-border bg-white overflow-hidden">
      <div ref={containerRef} className="h-64 w-full" />
      {unlocatedCount > 0 && (
        <div className="px-3 py-1.5 text-[11px] text-muted-foreground border-t border-border">
          {unlocatedCount} house{unlocatedCount === 1 ? "" : "s"} without a geocoded address not shown - add one in Settings → Houses.
        </div>
      )}
    </div>
  );
}
