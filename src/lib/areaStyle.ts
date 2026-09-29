import {
  Box,
  Cpu,
  Shirt,
  UtensilsCrossed,
  Wrench,
  BookOpen,
  Film,
  LucideIcon,
} from "lucide-react";

export const AREA_ICONS: { key: string; label: string; icon: LucideIcon }[] = [
  { key: "box", label: "Box", icon: Box },
  { key: "cpu", label: "Computers", icon: Cpu },
  { key: "shirt", label: "Clothes", icon: Shirt },
  { key: "utensils", label: "Kitchen", icon: UtensilsCrossed },
  { key: "wrench", label: "Tools", icon: Wrench },
  { key: "book", label: "Books", icon: BookOpen },
  { key: "film", label: "Media", icon: Film },
];

export const AREA_COLORS = [
  "#5b8c5a",
  "#282c20",
  "#6366f1",
  "#0891b2",
  "#d97706",
  "#dc2626",
  "#7c3aed",
];
