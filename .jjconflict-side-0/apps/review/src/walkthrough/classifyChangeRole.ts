const testDirPattern = /(^|\/)(tests?|__tests__|e2e|spec)\//;
const testNamePattern = /(\.(test|spec|e2e)\.[a-z]+|_test\.[a-z]+|_spec\.[a-z]+)$/;
const docsDirPattern = /(^|\/)(docs?|specs)\//;
const docsExtPattern = /\.(md|mdx|txt|rst|adoc)$/;
const configNamePattern = /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lock|bun\.lockb|tsconfig[^/]*\.json|dockerfile|makefile|justfile)$/;
const configExtPattern = /\.(ya?ml|toml|ini|lock|env)$/;

/** Coarse role of a changed file, used to order the deterministic fallback story. */
export function classifyChangeRole(path: string): "code" | "config" | "tests" | "docs" {
  const lower = path.toLowerCase();
  const name = lower.split("/").pop() ?? lower;
  if (docsDirPattern.test(lower) || docsExtPattern.test(name)) return "docs";
  if (testDirPattern.test(lower) || testNamePattern.test(name)) return "tests";
  if (lower.startsWith(".github/")) return "config";
  if (name.startsWith(".") || configNamePattern.test(name) || configExtPattern.test(name)) return "config";
  if (/\.config\.[a-z]+$/.test(name)) return "config";
  return "code";
}
