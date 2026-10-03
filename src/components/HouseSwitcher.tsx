import { useId } from "react";
import { Home } from "lucide-react";
import { useHouse } from "@/context/house";

/** The one place a session changes building. Rendered in both shells. */
export function HouseSwitcher({ dark = false }: { dark?: boolean }) {
  const id = useId();
  const { houseId, setHouseId, houses } = useHouse();
  if (houses.length === 0) return null;
  return (
    <label className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] ${dark ? "bg-[#32361f] text-[#e0e0d0]" : "bg-muted"}`}>
      <Home className="h-4 w-4 shrink-0 opacity-70" />
      <select
        id={id}
        aria-label="Current house"
        className="min-w-0 flex-1 bg-transparent outline-none"
        value={houseId ?? ""}
        onChange={(e) => setHouseId(e.target.value ? Number(e.target.value) : null)}
      >
        {houses.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name}
          </option>
        ))}
      </select>
    </label>
  );
}
