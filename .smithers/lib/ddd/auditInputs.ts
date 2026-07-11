import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { dddRoot } from "./dddRoot.ts";

/**
 * Prints the bounded set of files an auditor should read for a
 * docs-driven-development round, so audits do not wander the whole repo:
 * features.json, the editable overview + reference/derived content, the
 * installed DDD sources, common repository manifests, and a listing of the
 * latest artifacts directory. Every entry is optional so this works across
 * JavaScript, Rust, Python, Go, JVM, Ruby, PHP, .NET, and mixed repositories.
 */
const FIXED_INPUTS = [
  ".smithers/spec/features.json",
  ".smithers/spec/content/overview.md",
  ".smithers/workflows/docs-driven-development.tsx",
  ".smithers/ui/docs-driven-development.tsx",
  ".smithers/ui/ddd-shared.tsx",
  ".smithers/ui/ddd-SpecsTab.tsx",
  ".smithers/ui/ddd-FeaturesTab.tsx",
  ".smithers/ui/ddd-AuditTab.tsx",
  ".smithers/ui/ddd-LiveTab.tsx",
  ".smithers/ui/ddd-TicketsTab.tsx",
  ".smithers/ui/ddd-StartPane.tsx",
  ".smithers/ui/ddd-Tutorial.tsx",
  "README.md",
  "README.rst",
  "README.txt",
  "package.json",
  "bun.lock",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "deno.json",
  "Cargo.toml",
  "Cargo.lock",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
  "go.mod",
  "go.sum",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "global.json",
  "Makefile",
  "Justfile",
  "Dockerfile",
];

const LISTED_DIRS = [
  ".smithers/spec/content/reference",
  ".smithers/spec/content/features",
  ".smithers/lib/ddd",
  ".smithers/docs-driven-development/artifacts",
  ".github/workflows",
];
const MAX_ARTIFACT_FILES = 64;

export function collectAuditInputs(root: string = dddRoot()): string[] {
  const out: string[] = [];
  for (const rel of FIXED_INPUTS) {
    if (existsSync(resolve(root, rel))) out.push(rel);
  }
  for (const dir of LISTED_DIRS) {
    const full = resolve(root, dir);
    if (!existsSync(full) || !statSync(full).isDirectory()) continue;
    const entries = readdirSync(full).map((entry) => {
      const entryPath = resolve(full, entry);
      return { entry, entryPath, stat: statSync(entryPath) };
    });
    const isArtifacts = dir === ".smithers/docs-driven-development/artifacts";
    const sorted = entries
      .filter((entry) => entry.stat.isFile() && entry.stat.size <= 256_000)
      .sort((left, right) => {
        if (isArtifacts) {
          return right.stat.mtimeMs - left.stat.mtimeMs || left.entry.localeCompare(right.entry);
        }
        return left.entry.localeCompare(right.entry);
      })
      .slice(0, isArtifacts ? MAX_ARTIFACT_FILES : undefined);
    for (const entry of sorted) {
      if (entry.stat.size <= 256_000) {
        out.push(`${dir}/${entry.entry}`);
      }
    }
  }
  return [...new Set(out)];
}

if (import.meta.main) {
  console.log(JSON.stringify({ files: collectAuditInputs() }, null, 2));
}
