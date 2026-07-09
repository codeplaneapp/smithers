import type { HeroTabId } from "@/lib/landing/types";

export const HERO_TABS: {
  id: HeroTabId;
  label: string;
  hint: string;
}[] = [
  { id: "talk", label: "Talk to your agent", hint: "You describe outcomes in chat" },
  { id: "run", label: "See a background run", hint: "Steps, retries, resume" },
];
