import { useEffect, useState } from "react";
import { Camera, Cpu, Inbox, MapPin, Scale, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { HouseSwitcher } from "@/components/HouseSwitcher";
import { FlowProvider, useFlow } from "./context";
import { LocationSheet } from "./LocationSheet";
import { SnapTab } from "./SnapTab";
import { SortTab } from "./SortTab";
import { useSortCards } from "./queue";
import { ActTab } from "./ActTab";
import { FindTab } from "./FindTab";
import { placeLabel } from "./data";
import { backupState, inLab, needsLabDetails } from "./lenses";
import { ScreenBoundary } from "./ui";

type Tab = "snap" | "sort" | "act" | "find";
const TABS: { key: Tab; label: string; icon: typeof Camera }[] = [
  { key: "snap", label: "Snap", icon: Camera },
  { key: "sort", label: "Sort", icon: Inbox },
  { key: "act", label: "Act", icon: Scale },
  { key: "find", label: "Find", icon: Search },
];

const tabFromHash = (): Tab => {
  const h = location.hash.replace("#", "");
  return TABS.some((t) => t.key === h) ? (h as Tab) : "snap";
};

export function FlowApp() {
  return (
    <FlowProvider>
      <Shell />
    </FlowProvider>
  );
}

/**
 * Register now, act later. Snap puts things in without questions; Sort
 * finishes each record (what, right, where); Act decides keep / sell /
 * donate / toss when you are ready; Find answers "where is it?".
 */
function Shell() {
  const { here, setHere, locations, lens, setLens } = useFlow();
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [hereOpen, setHereOpen] = useState(false);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const go = (t: Tab) => {
    history.replaceState(null, "", `#${t}`);
    setTab(t);
    window.scrollTo({ top: 0 });
  };

  const sortCount = useSortCards().length;

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <header className="sticky top-0 z-30 bg-[#282c20] pt-[env(safe-area-inset-top)] text-[#f4f4ed]">
        <div className="mx-auto flex h-12 max-w-md items-center gap-3 px-4">
          <span className="font-data text-[14px] font-semibold">⌂ Flow</span>
          <button
            onClick={() => setLens(lens === "lab" ? null : "lab")}
            aria-pressed={lens === "lab"}
            title="Computer lab lens"
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 font-data text-[12px]",
              lens === "lab" ? "bg-[#d2ff00] font-semibold text-[#282c20]" : "bg-[#3a3f2e] text-[#b4b8a5]",
            )}
          >
            <Cpu className="h-3.5 w-3.5" /> Lab
          </button>
          <button
            onClick={() => setHereOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-full bg-[#3a3f2e] px-3 py-1 text-left text-[12px]"
          >
            <MapPin className="h-3.5 w-3.5 shrink-0 text-[#d2ff00]" />
            <span className="truncate">{here.roomId != null ? placeLabel(here.roomId, locations) : "Where are you?"}</span>
          </button>
          <HouseSwitcher />
          <a href="/" aria-label="Workbench" title="Workbench" className="shrink-0 text-[12px] text-[#b4b8a5] hover:text-[#f4f4ed]">
            <span className="hidden min-[430px]:inline">Workbench </span>↗
          </a>
        </div>
      </header>

      <main className="mx-auto w-full max-w-md px-4 pt-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))]">
        {lens === "lab" && <LabBand onGoSort={() => go("sort")} />}
        <ScreenBoundary key={tab}>
          {tab === "snap" && <SnapTab onChangeHere={() => setHereOpen(true)} onGoSort={() => go("sort")} />}
          {tab === "sort" && <SortTab />}
          {tab === "act" && <ActTab />}
          {tab === "find" && <FindTab />}
        </ScreenBoundary>
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-white pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto grid max-w-md grid-cols-4">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => go(t.key)}
              className={cn(
                "relative flex flex-col items-center gap-0.5 py-2.5 font-data text-[11px]",
                tab === t.key ? "bg-[#d2ff00] font-semibold text-[#282c20]" : "text-muted-foreground",
              )}
              aria-current={tab === t.key ? "page" : undefined}
            >
              <t.icon className="h-5 w-5" />
              {t.label}
              {t.key === "sort" && sortCount > 0 && (
                <span className="absolute right-[22%] top-1.5 rounded-full bg-[#AD432B] px-1.5 text-[10px] leading-4 text-white">{sortCount}</span>
              )}
            </button>
          ))}
        </div>
      </nav>

      {hereOpen && <LocationSheet title="Where are you?" value={here} onPick={setHere} onClose={() => setHereOpen(false)} allowClear />}
    </div>
  );
}

/** With the lab lens on: how far the lab is - devices, backups, missing details. */
function LabBand({ onGoSort }: { onGoSort: () => void }) {
  const { items, backups } = useFlow();
  const lab = items.filter((it) => it.status === "active" && it.verificationStatus !== "rejected" && inLab(it));
  const states = lab.map((it) => backupState(it, backups));
  const needBackup = states.filter((s) => s !== "n/a").length;
  const covered = states.filter((s) => s === "covered" || s === "none-needed").length;
  const noRole = lab.filter(needsLabDetails).length;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-[#282c20]/15 bg-[#d2ff00]/25 px-3 py-2 text-[12px]">
      <span className="font-data font-semibold">Computer lab</span>
      <span className="font-data tabular-nums">{lab.length} things</span>
      <span className="font-data tabular-nums">
        {covered}/{needBackup} backed up
      </span>
      {noRole > 0 && (
        <button onClick={onGoSort} className="font-data tabular-nums text-[#AD432B] underline">
          {noRole} without a role
        </button>
      )}
    </div>
  );
}
