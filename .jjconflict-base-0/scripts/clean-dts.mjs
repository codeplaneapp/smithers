#!/usr/bin/env node
// Recursively delete every `.d.ts` under a root (default `src`) so a subsequent
// `tsup` declaration build starts clean. Without this, a renamed/removed source
// module leaves its stale `.d.ts` behind (tsup only writes, never prunes), which
// the check-dts freshness gate would then miss. Usage: `node clean-dts.mjs [dir]`.
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
