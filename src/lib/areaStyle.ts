import {
  Box,
  Cpu,
  Shirt,
  UtensilsCrossed,
  Wrench,
  BookOpen,
  Film,
  Laptop,
  Home,
  ChefHat,
  Leaf,
  Briefcase,
  Calendar,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/** Every icon key a topic can carry. Topics store the key, so a key stays
 * here as long as any row may still use it, even when no picker offers it. */
export const AREA_ICONS: { key: string; label: string; icon: LucideIcon }[] = [
  { key: "box", label: "General", icon: Box },
  { key: "laptop", label: "Computers", icon: Laptop },
  { key: "cpu", label: "Electronics", icon: Cpu },
  { key: "wrench", label: "Tools", icon: Wrench },
  { key: "home", label: "House", icon: Home },
  { key: "chef-hat", label: "Kitchen", icon: ChefHat },
  { key: "utensils", label: "Tableware", icon: UtensilsCrossed },
  { key: "leaf", label: "Garden", icon: Leaf },
  { key: "shirt", label: "Clothes", icon: Shirt },
  { key: "book", label: "Books", icon: BookOpen },
  { key: "film", label: "Media", icon: Film },
  { key: "briefcase", label: "Work", icon: Briefcase },
  { key: "calendar", label: "Schedule", icon: Calendar },
];

const ICON_BY_KEY = new Map(AREA_ICONS.map((i) => [i.key, i.icon]));

export function areaIcon(key: string | null | undefined): LucideIcon {
  return (key && ICON_BY_KEY.get(key)) || Box;
}

export const AREA_COLORS = [
  "#5b8c5a",
  "#282c20",
  "#6366f1",
  "#0891b2",
  "#d97706",
  "#dc2626",
  "#7c3aed",
];
