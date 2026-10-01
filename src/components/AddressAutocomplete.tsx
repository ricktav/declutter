import { useEffect, useRef, useState } from "react";
import { searchAddress, type AddressSuggestion } from "@/lib/pdok";
import { MapPin, ChevronDown } from "lucide-react";

const DEFAULT_ROWS = 10;
const EXPANDED_ROWS = 40;

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
  const [focused, setFocused] = useState(false);
  const [rows, setRows] = useState(DEFAULT_ROWS);
  const [highlighted, setHighlighted] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // picking a suggestion sets `value` via the parent (to the picked label),
  // which would otherwise re-trigger the search effect below and pop the
  // list straight back open even though the field never actually lost
  // focus - skip exactly one effect run when that's what just happened
  const justPickedRef = useRef(false);

  // typing something new starts over at the default page size
  useEffect(() => {
    setRows(DEFAULT_ROWS);
  }, [value]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (justPickedRef.current) {
      justPickedRef.current = false;
      return;
    }
    // only search while the field is actually focused - otherwise a
    // pre-filled value (editing an existing house) would pop the suggestion
    // list open on mount, before the user touched anything
    if (!focused || value.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const results = await searchAddress(value, rows);
        setSuggestions(results);
        setHighlighted(-1);
        setOpen(true);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, focused, rows]);

  const pick = (s: AddressSuggestion) => {
    justPickedRef.current = true;
    onSelect(s);
    setOpen(false);
    setSuggestions([]);
    setHighlighted(-1);
  };

  return (
    <div className="relative">
      <input
        className="w-full rounded-md border border-input bg-white px-2 py-1.5 text-[13px]"
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => {
          setFocused(true);
          if (suggestions.length > 0) setOpen(true);
        }}
        onBlur={() => {
          setFocused(false);
          setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={(e) => {
          if (!open || suggestions.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlighted((i) => {
              const next = Math.min(i + 1, suggestions.length - 1);
              listRef.current?.children[next]?.scrollIntoView({ block: "nearest" });
              return next;
            });
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlighted((i) => {
              const next = Math.max(i - 1, 0);
              listRef.current?.children[next]?.scrollIntoView({ block: "nearest" });
              return next;
            });
          } else if (e.key === "Enter") {
            const s = suggestions[highlighted] ?? (suggestions.length === 1 ? suggestions[0] : undefined);
            if (s) {
              e.preventDefault();
              pick(s);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && (loading || suggestions.length > 0) && (
        <div className="absolute z-10 mt-1 w-full rounded-md border border-border bg-white shadow-md max-h-56 overflow-y-auto">
          {loading && <div className="px-3 py-2 text-[12px] text-muted-foreground">Searching…</div>}
          {!loading && (
            <div ref={listRef}>
              {suggestions.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-accent/60 ${
                    i === highlighted ? "bg-accent/60" : ""
                  }`}
                  onMouseEnter={() => setHighlighted(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(s);
                  }}
                >
                  <MapPin className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="truncate">{s.label}</span>
                </button>
              ))}
            </div>
          )}
          {!loading && suggestions.length >= rows && (
            <button
              type="button"
              className="flex w-full items-center justify-center gap-1 px-3 py-1.5 text-[12px] text-primary hover:bg-accent/60 border-t border-border"
              onMouseDown={(e) => {
                e.preventDefault();
                setRows(EXPANDED_ROWS);
              }}
            >
              <ChevronDown className="h-3 w-3" /> Show more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
