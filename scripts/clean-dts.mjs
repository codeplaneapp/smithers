#!/usr/bin/env node
// Delete declaration outputs before a `tsup` build so an existing `.d.ts` does
// not shadow its same-named JS entry and stale hashed chunks cannot survive.
// With no entries, every declaration under the root is removed. Packages that
// also ship hand-authored subpath declarations can name only generated entries:
//   node clean-dts.mjs src index BaseCliAgent/index
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const root = process.argv[2] ?? "src";
const entries = process.argv.slice(3);

function clean(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      clean(path);
    } else if (path.endsWith(".d.ts")) {
      rmSync(path);
    }
  }
}

function cleanEntry(entry) {
  const directory = join(root, dirname(entry));
  const name = basename(entry);
  const exact = join(directory, `${name}.d.ts`);
  if (existsSync(exact)) rmSync(exact);
  for (const file of readdirSync(directory)) {
    if (file.startsWith(`${name}-`) && file.endsWith(".d.ts")) {
      rmSync(join(directory, file));
    }
  }
}

if (entries.length > 0) {
  for (const entry of entries) cleanEntry(entry);
} else {
  clean(root);
}
