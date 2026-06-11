import { readFileSync } from "node:fs";

let cached: string | null = null;

/**
 * The Mermaid runtime source, inlined into walkthroughs that contain diagram
 * blocks (and only those — it is ~3MB) so the HTML stays self-contained and
 * renders from file:// with no network.
 */
export function mermaidRuntime(): string {
  if (cached === null) {
    cached = readFileSync(require.resolve("mermaid/dist/mermaid.min.js"), "utf8");
  }
  return cached;
}
