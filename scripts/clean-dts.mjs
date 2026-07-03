#!/usr/bin/env node
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? "src";

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

clean(root);
