import type { ImpactLevel } from "./assessChangeImpact";

export function shouldAutoQuiz(level: ImpactLevel): boolean {
  return level === "high" || level === "critical";
}
