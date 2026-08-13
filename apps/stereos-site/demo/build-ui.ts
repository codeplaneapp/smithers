/**
 * Bundle the embedded run UI into ui/dist, which guard.ts serves as static
 * files.
 *
 * The gateway bundles workflow UIs with `Bun.build` for the same reason this
 * does: every `smthrs/ui` and `smthrs/gateway-ui` component is self-styled and
 * carries no `.css` import, so a single JS bundle plus a one-line HTML shell is
 * the whole app. Nothing is fetched from a CDN at runtime.
 *
 * Run: bun build-ui.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const here = import.meta.dir;
const outdir = join(here, "ui", "dist");

await mkdir(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(here, "ui", "src", "main.jsx")],
  outdir,
  target: "browser",
  format: "esm",
  minify: true,
  naming: "[dir]/app.[ext]",
  define: { "process.env.NODE_ENV": '"production"' },
});

if (!result.success) {
  console.error(result.logs.map(String).join("\n"));
  process.exit(1);
}

await writeFile(
  join(outdir, "index.html"),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>stereOS demo runs</title>
<style>html,body{margin:0;background:transparent}</style>
</head>
<body>
<div id="root"></div>
<script type="module" src="./app.js"></script>
</body>
</html>
`,
);

const bytes = result.outputs.reduce((sum, output) => sum + output.size, 0);
console.log(`ui/dist: ${result.outputs.length} file(s), ${(bytes / 1024).toFixed(1)} KiB`);
