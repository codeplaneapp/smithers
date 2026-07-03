import { defineConfig } from "tsup";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

function declarationEntries() {
  const sourceRoot = "src";
  const entries: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (path.endsWith(".d.ts") || (!path.endsWith(".js") && !path.endsWith(".ts"))) {
        continue;
      }
      const relativePath = relative(sourceRoot, path).split(sep).join("/");
      const key = relativePath.replace(/\.(js|ts)$/, "");
      entries[key] = `${sourceRoot}/${relativePath}`;
    }
  };
  walk(sourceRoot);
  return entries;
}

export default defineConfig({
  entry: declarationEntries(),
  dts: { only: true, resolve: false },
  outDir: "src",
  clean: false,
  format: ["esm"],
  silent: true,
});
