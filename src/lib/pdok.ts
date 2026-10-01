/** Dutch address lookup against PDOK's free public APIs (Locatieserver +
 * BRK Kadastrale Kaart) - the same endpoints the standalone kadastrale-kaart
 * viewer (http://10.50.0.102/grokbot/kadastrale-kaart/) uses client-side.
 * No key, no backend proxy needed. */

export interface AddressSuggestion {
  id: string;
  label: string;
  lat: number | null;
  lng: number | null;
  bagId: string | null;
  /** "<gemeentecode>-<sectie>-<perceelnummer>", for the parcel lookup below */
  parcelCode: string | null;
}

export interface ParcelInfo {
  parcelId: string;
  parcelAreaM2: number | null;
}

function parsePoint(wkt: string | undefined): { lat: number; lng: number } | null {
  const m = wkt?.match(/POINT\(([-\d.]+) ([-\d.]+)\)/);
  if (!m) return null;
  return { lng: Number(m[1]), lat: Number(m[2]) };
}

export async function searchAddress(query: string, rows = 10): Promise<AddressSuggestion[]> {
  if (!query.trim()) return [];
  const url =
    `https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?rows=${rows}&q=` + encodeURIComponent(query);
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  const docs: Record<string, unknown>[] = data?.response?.docs ?? [];
  return docs
    .filter((d) => d.type === "adres")
    .map((d) => {
      const ll = parsePoint(d.centroide_ll as string | undefined);
      const parcel = (d.gekoppeld_perceel as string[] | undefined)?.[0] ?? null;
      return {
        id: d.id as string,
        label: d.weergavenaam as string,
        lat: ll?.lat ?? null,
        lng: ll?.lng ?? null,
        bagId: (d.adresseerbaarobject_id as string | undefined) ?? null,
        parcelCode: parcel,
      };
    });
}

/** Reverse-geocode a lat/lng (e.g. from browser geolocation) to the nearest
 * Dutch address, same PDOK reverse call kadastrale-kaart uses. */
export async function reverseGeocode(lat: number, lng: number): Promise<AddressSuggestion | null> {
  const fl = "id,type,weergavenaam,nummeraanduiding_id,adresseerbaarobject_id,centroide_ll,gekoppeld_perceel";
  const url =
    `https://api.pdok.nl/bzk/locatieserver/search/v3_1/reverse?lat=${lat}&lon=${lng}` +
    `&rows=1&fl=${encodeURIComponent(fl)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const doc = data?.response?.docs?.[0];
  if (!doc) return null;
  const ll = parsePoint(doc.centroide_ll as string | undefined);
  const parcel = (doc.gekoppeld_perceel as string[] | undefined)?.[0] ?? null;
  return {
    id: doc.id as string,
    label: doc.weergavenaam as string,
    lat: ll?.lat ?? lat,
    lng: ll?.lng ?? lng,
    bagId: (doc.adresseerbaarobject_id as string | undefined) ?? null,
    parcelCode: parcel,
  };
}

export async function fetchParcelInfo(suggestion: AddressSuggestion): Promise<ParcelInfo | null> {
  let filter: string | null = null;
  if (suggestion.parcelCode?.includes("-")) {
    const [gemeente, sectie, perceelnummer] = suggestion.parcelCode.split("-");
    filter = `akr_kadastrale_gemeente_code_waarde='${gemeente}' AND sectie='${sectie}' AND perceelnummer=${perceelnummer}`;
  }
  let feat: Record<string, unknown> | null = null;
  if (filter) {
    const url =
      "https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1/collections/perceel/items?limit=1&filter=" +
      encodeURIComponent(filter);
    const res = await fetch(url);
    if (res.ok) feat = ((await res.json())?.features ?? [])[0] ?? null;
  }
  if (!feat && suggestion.lat != null && suggestion.lng != null) {
    const d = 0.0002;
    const bbox = `${suggestion.lng - d},${suggestion.lat - d},${suggestion.lng + d},${suggestion.lat + d}`;
    const url = `https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1/collections/perceel/items?limit=1&bbox=${bbox}`;
    const res = await fetch(url);
    if (res.ok) feat = ((await res.json())?.features ?? [])[0] ?? null;
  }
  if (!feat) return null;
  const p = feat.properties as Record<string, unknown>;
  const parcelId = `${p.akr_kadastrale_gemeente_code_waarde ?? ""} ${p.sectie ?? ""} ${p.perceelnummer ?? ""}`.trim();
  return {
    parcelId,
    parcelAreaM2: typeof p.kadastrale_grootte_waarde === "number" ? p.kadastrale_grootte_waarde : null,
  };
}

/** Deep-link into the standalone kadastrale-kaart viewer, which already
 * reads `?q=` on load and runs the same free-text search. */
export function kadastraleKaartUrl(address: string): string {
  return "http://10.50.0.102/grokbot/kadastrale-kaart/?q=" + encodeURIComponent(address);
}

/** PDOK aerial-photo WMTS tile covering a point, for use as a house card thumbnail. */
export function aerialThumbUrl(lat: number, lng: number, zoom = 18): string {
  const n = 2 ** zoom;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return `https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_ortho25/EPSG:3857/${zoom}/${x}/${y}.jpeg`;
}
