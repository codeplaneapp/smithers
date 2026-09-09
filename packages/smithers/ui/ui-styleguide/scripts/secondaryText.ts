import { contrastRatio as contrast } from "../src/contrastRatio.ts";
import { mixColors as mix } from "../src/mixColors.ts";

/** Mix toward a foreground only if every surface can meet the requested target. */
export function secondaryText(
  text: string,
  bg: string,
  backgrounds: string[],
  initialAmount: number,
  target: number,
  context: { palette: string; mode: "light" | "dark"; token: string },
): string {
  let amount = initialAmount;
  let value = amount === 0 ? bg : mix(text, bg, amount);
  while (amount < 1 && backgrounds.some((background) => contrast(value, background) < target)) {
    amount = Math.min(1, amount + 0.01);
    value = mix(text, bg, amount);
  }
  const achieved = Math.min(...backgrounds.map((background) => contrast(value, background)));
  if (achieved < target) {
    throw new Error(
      `${context.palette}/${context.mode}/${context.token}: target ${target}:1, achieved ${achieved.toFixed(4)}:1`,
    );
  }
  return value;
}
