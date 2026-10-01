import { useEffect, useRef, useState } from "react";
import { searchAddress, type AddressSuggestion } from "@/lib/pdok";
import { MapPin } from "lucide-react";

/** Free-text Dutch address input backed by PDOK Locatieserver - type a
 * street+number, postcode+number, or a place name and pick a match. */
export function AddressAutocomplete({
  value,
  onChange,
  onSelect,
  placeholder = "Address, e.g. 1521HB 76b",
  autoFocus,
}: {
  value: string;
  onChange: (text: string) => void;
  onSelect: (suggestion: AddressSuggestion) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const results = await searchAddress(value);
        setSuggestions(results);
        setOpen(true);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value]);

  return (
    <div className="relative">
      <input
        className="w-full rounded-md border border-input bg-white px-2 py-1.5 text-[13px]"
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (loading || suggestions.length > 0) && (
        <div className="absolute z-10 mt-1 w-full rounded-md border border-border bg-white shadow-md max-h-56 overflow-y-auto">
          {loading && <div className="px-3 py-2 text-[12px] text-muted-foreground">Searching…</div>}
          {!loading &&
            suggestions.map((s) => (
              <button
                key={s.id}
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-accent/60"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(s);
                  setOpen(false);
                }}
              >
                <MapPin className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="truncate">{s.label}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
