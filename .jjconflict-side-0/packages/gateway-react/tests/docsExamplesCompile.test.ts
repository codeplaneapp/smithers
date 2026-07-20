import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// These tests cover the doc-rot vector where a guide or example snippet stops
// matching the real package types (e.g. `listApprovals` returning an array
// instead of `{ approvals: [...] }`). We extract the first code block from the
// MDX file, drop it into a temp project that aliases the same `paths` the docs
// snippets import (`smithers-orchestrator/gateway-react`,
// `smithers-orchestrator/gateway-client`), and shell out to `tsc --noEmit`.
//
// If you update an example, run the test — a type error here means the snippet
// no longer compiles against the real packages.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const TSC = resolve(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");

function extractFirstCodeBlock(mdx: string, lang: string): string {
  const fence = "```" + lang;
  const start = mdx.indexOf(fence);
  if (start < 0) throw new Error(`no \`\`\`${lang} block in mdx`);
  const after = mdx.indexOf("\n", start) + 1;
  const end = mdx.indexOf("\n```", after);
  if (end < 0) throw new Error(`unterminated ${lang} block in mdx`);
  return mdx.slice(after, end);
}

function compile(opts: {
  source: string;
  fileName: string;
  jsx: boolean;
}): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "smithers-docs-typecheck-"));
  writeFileSync(join(dir, opts.fileName), opts.source);
  const tsconfig = {
    compilerOptions: {
      ignoreDeprecations: "6.0",
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      lib: ["ES2022", "DOM", "DOM.AsyncIterable"],
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      jsx: opts.jsx ? "react-jsx" : undefined,
      // TS 6 deprecates baseUrl (TS5101); use absolute paths entries instead.
      paths: {
        "smithers-orchestrator/gateway-react": [resolve(REPO_ROOT, "packages/gateway-react/src/index.ts")],
        "smithers-orchestrator/gateway-client": [resolve(REPO_ROOT, "packages/gateway-client/src/index.ts")],
      },
      typeRoots: [resolve(REPO_ROOT, "node_modules", "@types")],
    },
    include: [opts.fileName],
  };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  const out = spawnSync(process.execPath, [TSC, "-p", join(dir, "tsconfig.json")], {
    encoding: "utf8",
  });
  return { ok: out.status === 0, output: (out.stdout ?? "") + (out.stderr ?? "") };
}

describe("docs custom-workflow-ui examples", () => {
  test("workflow-ui-react.mdx first tsx block compiles against real packages", () => {
    const mdx = readFileSync(
      resolve(REPO_ROOT, "docs/examples/workflow-ui-react.mdx"),
      "utf8",
    );
    const source = extractFirstCodeBlock(mdx, "tsx");
    const result = compile({ source, fileName: "snippet.tsx", jsx: true });
    if (!result.ok) {
      throw new Error(`docs/examples/workflow-ui-react.mdx snippet failed tsc:\n${result.output}`);
    }
    expect(result.ok).toBe(true);
  }, 20_000);

  test("workflow-ui-vanilla.mdx first ts block compiles against real packages", () => {
    const mdx = readFileSync(
      resolve(REPO_ROOT, "docs/examples/workflow-ui-vanilla.mdx"),
      "utf8",
    );
    const source = extractFirstCodeBlock(mdx, "ts");
    const result = compile({ source, fileName: "snippet.ts", jsx: false });
    if (!result.ok) {
      throw new Error(`docs/examples/workflow-ui-vanilla.mdx snippet failed tsc:\n${result.output}`);
    }
    expect(result.ok).toBe(true);
  }, 20_000);
});
