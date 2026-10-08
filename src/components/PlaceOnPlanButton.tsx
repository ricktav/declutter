import { Link } from "react-router";
import { Loader2, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Icon-only "place on the plan" control. Title + aria-label carry the
 * wording; native title is the tooltip. Behaviour is the caller's.
 */
export function PlaceOnPlanButton({
  title,
  to,
  onClick,
  disabled,
  pending,
  active,
  className,
}: {
  title: string;
  to?: string;
  onClick?: () => void;
  disabled?: boolean;
  pending?: boolean;
  active?: boolean;
  className?: string;
}) {
  const cls = cn(
    "inline-flex shrink-0 items-center justify-center rounded-md border border-input",
    "h-10 w-10 sm:h-8 sm:w-8",
    active ? "bg-primary text-primary-foreground border-primary" : "bg-background text-foreground hover:bg-accent",
    disabled && "pointer-events-none opacity-50",
    className,
  );
  const inner = pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <MapPin className="h-4 w-4" aria-hidden />;
  const control =
    to && !disabled ? (
      <Link to={to} className={cls} title={title} aria-label={title} onClick={onClick}>
        {inner}
      </Link>
    ) : (
      <button type="button" className={cls} title={title} aria-label={title} disabled={disabled} onClick={onClick}>
        {inner}
      </button>
    );
  // a disabled button has pointer-events: none, so the title lives on a wrapper
  if (disabled) return <span className="inline-flex shrink-0" title={title}>{control}</span>;
  return control;
}
