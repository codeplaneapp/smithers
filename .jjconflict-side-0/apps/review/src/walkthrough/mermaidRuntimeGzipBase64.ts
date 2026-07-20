import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

let cached: string | null = null;

/**
 * The Mermaid runtime, gzipped and base64-encoded, inlined into walkthroughs
 * that contain diagram blocks (and only those). The page decodes it at load
 * via DecompressionStream, keeping the HTML self-contained (renders from
 * file:// with no network) at roughly a quarter of the raw ~3.5MB runtime.
 */
export function mermaidRuntimeGzipBase64(): string {
  if (cached === null) {
    const source = readFileSync(require.resolve("mermaid/dist/mermaid.min.js"));
    cached = gzipSync(source, { level: 9 }).toString("base64");
  }
  return cached;
}
