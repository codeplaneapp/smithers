/**
 * Stage the marketing site into `dist/` for the static Cloudflare deploy.
 * Copies index.html and the assets/ directory (demo GIFs). Mirrors the gil
 * microsite, extended to carry the assets folder.
 */
import { rm, mkdir, copyFile, cp } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = dirname(fileURLToPath(import.meta.url));
const out = resolve(root, "dist");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await copyFile(resolve(root, "index.html"), resolve(out, "index.html"));

const assets = resolve(root, "assets");
if (existsSync(assets)) {
  await cp(assets, resolve(out, "assets"), { recursive: true });
}

console.log(`build: staged ${out} (index.html + assets)`);
