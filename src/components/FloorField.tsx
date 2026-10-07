import { floorDatalist } from "@/lib/floors";

export function FloorField({
  value,
  onChange,
  existing,
  id = "room-floor",
}: {
  value: string;
  onChange: (v: string) => void;
  existing: string[];
  id?: string;
}) {
  const options = floorDatalist(existing);
  const listId = `${id}-suggestions`;
  return (
    <>
      <input
        id={id}
        list={listId}
        className="mt-1 w-full rounded border border-input px-2 py-1.5 text-[13px]"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="begane grond, 1ste verdieping, zolder…"
      />
      <datalist id={listId}>
        {options.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
    </>
  );
}
