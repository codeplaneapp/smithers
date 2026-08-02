import { fileURLToPath } from "node:url";

/**
 * Resolve the real `@smthrs/cli` entry point to spawn for
 * subcommands (`gateway`, `hijack`). Priority:
 *   1. `SMITHERS_CLI` — set by the CLI when it launches the TUI, the exact entry
 *      the user invoked.
 *   2. The installed `@smthrs/cli` package's `.` entry, resolved
 *      from disk so published `smithers-mon` installs work too.
 *
 * We resolve the package's ENTRY (`import.meta.resolve("@smthrs/cli")`)
 * rather than its `package.json`: the CLI package's `exports` map does not
 * declare `"./package.json"`, and its `"./*"` wildcard would resolve a
 * `package.json` request to a non-existent `src/package.json.js`, so a
 * `package.json` lookup is not portable across installs. The `.` export points
 * straight at `src/index.js`, which is exactly what callers spawn.
 *
 * Returns null when neither is available. Callers MUST NOT fall back to
 * `process.argv[1]` (that is the TUI itself — spawning it would recurse) or to a
 * bare `smithers` on PATH (unpredictable / possibly stale); they should surface
 * a clear error or disable the action instead.
 */
export function resolveCliEntry(
  // Injectable module resolver so the not-installed fallback (resolution
  // throwing → null) is exercisable in an environment where the CLI package
  // *is* resolvable. Production callers pass nothing and get the real
  // `import.meta.resolve`.
  resolveModule: (specifier: string) => string = (specifier) => import.meta.resolve(specifier),
): string | null {
  const fromEnv = process.env.SMITHERS_CLI;
  if (fromEnv) return fromEnv;
  try {
    const entryUrl = resolveModule("@smthrs/cli");
    return fileURLToPath(entryUrl);
  } catch {
    return null;
  }
}
