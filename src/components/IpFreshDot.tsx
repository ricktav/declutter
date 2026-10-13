/** Small green dot beside an IP that was written less than 24 hours ago. */
export function IpFreshDot({ recent }: { recent: boolean }) {
  if (!recent) return null;
  return (
    <span
      className="ml-1.5 inline-block h-2 w-2 shrink-0 rounded-full align-middle"
      style={{ background: "#22c55e" }}
      title="IP refreshed less than 24 hours ago"
      aria-label="IP refreshed less than 24 hours ago"
    />
  );
}
