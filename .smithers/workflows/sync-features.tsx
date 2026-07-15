// smithers-display-name: Sync Features
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod/v4";
import { agents } from "../agents";
import SyncFeaturesScanPrompt from "../prompts/sync-features-scan.mdx";
import SyncFeaturesRefinePrompt from "../prompts/sync-features-refine.mdx";
import SyncFeaturesWritePrompt from "../prompts/sync-features-write.mdx";

const memoryNamespace = { kind: "workflow", id: "sync-features" } as const;

const bootstrapSchema = z.looseObject({
  exists: z.boolean(),
  existingFeatures: z.record(z.string(), z.array(z.string())).nullable(),
  lastCommitHash: z.string().nullable(),
  currentHead: z.string(),
  codebaseSummary: z.string(),
});

const featureScanSchema = z.looseObject({
  featureGroups: z.record(z.string(), z.array(z.string())).default({}),
  totalFeatures: z.number().int().default(0),
  lastCommitHash: z.string().nullable().optional(),
  markdownBody: z.string(),
});

const writeResultSchema = z.looseObject({
  filePath: z.string(),
  commitHash: z.string(),
  totalGroups: z.number().int(),
  totalFeatures: z.number().int(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  bootstrap: bootstrapSchema,
  featureScan: featureScanSchema,
  writeResult: writeResultSchema,
});

function filesBelow(root: string, accept: (path: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(path, accept));
    else if (entry.isFile() && accept(path)) files.push(path);
  }
  return files.sort();
}

function repoPaths(cwd: string, files: string[], limit = Number.POSITIVE_INFINITY): string {
  return files
    .slice(0, limit)
    .map((file) => relative(cwd, file).split(sep).join("/"))
    .join("\n");
}

export default smithers((ctx) => {
  const bootstrap = ctx.outputMaybe("bootstrap", { nodeId: "bootstrap" });

  return (
    <Workflow name="sync-features">
      {/* Step 1: Gather codebase state via compute — no LLM needed */}
      <Task id="bootstrap" output={outputs.bootstrap}>
        {async () => {
          const cwd = process.cwd();
          const featuresPath = resolve(cwd, ".smithers/specs/features.ts");
          const exists = existsSync(featuresPath);

          let existingFeatures: Record<string, string[]> | null = null;
          if (exists) {
            const content = readFileSync(featuresPath, "utf-8");
            existingFeatures = {};
            const groupRegex = /(\w+):\s*\[([^\]]*)\]/gs;
            let match;
            while ((match = groupRegex.exec(content)) !== null) {
              const groupName = match[1];
              const featuresStr = match[2];
              const features = [...featuresStr.matchAll(/"([^"]+)"/g)].map(
                (m) => m[1],
              );
              if (features.length > 0) {
                existingFeatures[groupName] = features;
              }
            }
          }

          const currentHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();

          // Build a codebase summary for the agent to analyze
          const parts: string[] = [];

          // Source tree structure
          const tree = repoPaths(cwd, filesBelow(join(cwd, "src"), (file) => file.endsWith(".ts")));
          parts.push("=== SOURCE FILES (src/) ===", tree);

          // Components
          const components = repoPaths(cwd, filesBelow(join(cwd, "src/components"), (file) => file.endsWith(".ts")));
          if (components) parts.push("\n=== COMPONENTS ===", components);

          // Agents
          const agentFiles = repoPaths(cwd, filesBelow(join(cwd, "src/agents"), (file) => file.endsWith(".ts")));
          if (agentFiles) parts.push("\n=== AGENTS ===", agentFiles);

          // CLI commands
          const cliFiles = repoPaths(cwd, filesBelow(join(cwd, "src/cli"), (file) => file.endsWith(".ts")));
          if (cliFiles) parts.push("\n=== CLI ===", cliFiles);

          // Memory
          const memoryFiles = repoPaths(cwd, filesBelow(join(cwd, "src/memory"), (file) => file.endsWith(".ts")));
          if (memoryFiles) parts.push("\n=== MEMORY ===", memoryFiles);

          // Exports from index
          const indexPath = join(cwd, "src/index.ts");
          const indexExports = existsSync(indexPath)
            ? readFileSync(indexPath, "utf8").split(/\r?\n/).filter((line) => line.startsWith("export")).join("\n")
            : "";
          if (indexExports) parts.push("\n=== PUBLIC API (src/index.ts) ===", indexExports);

          // Examples
          const examples = repoPaths(cwd, filesBelow(join(cwd, "examples"), (file) => file.endsWith(".tsx")), 20);
          if (examples) parts.push("\n=== EXAMPLES ===", examples);

          // Workflows
          const workflows = repoPaths(cwd, filesBelow(join(cwd, ".smithers/workflows"), (file) => file.endsWith(".tsx")));
          if (workflows)
            parts.push("\n=== WORKFLOW PACK (.smithers/workflows/) ===", workflows);

          // Reusable components
          const wfComponents = repoPaths(cwd, filesBelow(join(cwd, ".smithers/components"), (file) => file.endsWith(".tsx")));
          if (wfComponents) parts.push("\n=== WORKFLOW COMPONENTS ===", wfComponents);

          // Docs
          const docs = repoPaths(cwd, filesBelow(join(cwd, "docs"), (file) => file.endsWith(".mdx")), 40);
          if (docs) parts.push("\n=== DOCUMENTATION ===", docs);

          // Tests
          const tests = repoPaths(cwd, filesBelow(join(cwd, "tests"), (file) => /\.test\.[^/\\]+$/.test(file)), 30);
          if (tests) parts.push("\n=== TESTS ===", tests);

          // package.json
          const packagePath = join(cwd, "package.json");
          const pkg = existsSync(packagePath) ? readFileSync(packagePath, "utf8").trim() : "";
          if (pkg) parts.push("\n=== PACKAGE.JSON ===", pkg);

          // Recent commits (for delta mode)
          const lastCommitHash: string | null = null;

          const codebaseSummary = parts.join("\n");

          return {
            exists,
            existingFeatures,
            lastCommitHash,
            currentHead,
            codebaseSummary,
          };
        }}
      </Task>

      {/* Step 2: Agent analyzes the collected info — no file I/O needed */}
      {bootstrap && !bootstrap.exists ? (
        <Task
          id="scan"
          output={outputs.featureScan}
          agent={agents.research}
          heartbeatTimeoutMs={300000}
          memory={{
            remember: {
              namespace: memoryNamespace,
              key: "feature-scan",
            },
          }}
        >
          <SyncFeaturesScanPrompt
            currentHead={bootstrap.currentHead}
            codebaseSummary={bootstrap.codebaseSummary}
          />
        </Task>
      ) : null}

      {bootstrap && bootstrap.exists ? (
        <Task
          id="scan"
          output={outputs.featureScan}
          agent={agents.research}
          heartbeatTimeoutMs={300000}
          memory={{
            recall: {
              namespace: memoryNamespace,
              query: "feature inventory feature groups",
              topK: 3,
            },
            remember: {
              namespace: memoryNamespace,
              key: "feature-scan",
            },
          }}
        >
          <SyncFeaturesRefinePrompt
            lastCommitHash={bootstrap.lastCommitHash}
            existingFeatures={bootstrap.existingFeatures}
            codebaseSummary={bootstrap.codebaseSummary}
            currentHead={bootstrap.currentHead}
          />
        </Task>
      ) : null}

      {/* Step 3: Write the TypeScript file */}
      <Task
        id="write-features"
        output={outputs.writeResult}
        agent={agents.implement}
        heartbeatTimeoutMs={300000}
        memory={{
          remember: {
            namespace: memoryNamespace,
            key: "last-sync",
          },
        }}
        deps={{ scan: outputs.featureScan }}
      >
        {(deps) => (
          <SyncFeaturesWritePrompt
            lastCommitHash={deps.scan.lastCommitHash}
            featureGroups={deps.scan.featureGroups}
          />
        )}
      </Task>
    </Workflow>
  );
});
