import type { ImpactLevel } from "./assessChangeImpact.ts";

export function shouldAutoQuiz(level: ImpactLevel): boolean {
  return level === "high" || level === "critical";
}
