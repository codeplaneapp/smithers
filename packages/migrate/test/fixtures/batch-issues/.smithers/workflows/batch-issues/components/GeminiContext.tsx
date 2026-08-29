import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { Task, outputs } from "../smithers";
import { gemini } from "../agents";
import GeminiContextPrompt from "../prompts/gemini-context.mdx";

const REPO_ROOT = resolve(new URL("../../..", import.meta.url).pathname);

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return `[Could not read ${path}]`;
  }
}

function readAllSpecs(): string {
  const specsDir = resolve(REPO_ROOT, "docs/specs");
  const parts: string[] = [];

  try {
    const files = readdirSync(specsDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const content = readFile(join(specsDir, file));
      parts.push(`### docs/specs/${file}\n\n${content}`);
    }
  } catch {
    parts.push("[Could not read docs/specs/ directory]");
  }

  // Also include PRODUCT_DESIGN.md and CLAUDE.md
  parts.push(`### PRODUCT_DESIGN.md\n\n${readFile(resolve(REPO_ROOT, "PRODUCT_DESIGN.md"))}`);
  parts.push(`### CLAUDE.md\n\n${readFile(resolve(REPO_ROOT, "CLAUDE.md"))}`);

  return parts.join("\n\n---\n\n");
}

async function getCommitHistory(): Promise<string> {
  const result = await Bun.$`jj log --limit 100 -r 'ancestors(main, 100)'`.cwd(REPO_ROOT).text().catch(() => "");
  return result || "[Could not read commit history]";
}

export function GeminiContext() {
  return (
    <Task id="gemini-context" output={outputs.geminiContext} agent={gemini}>
      {async () => {
        const specsContent = readAllSpecs();
        const commitHistory = await getCommitHistory();

        return (
          <GeminiContextPrompt
            specsContent={specsContent}
            commitHistory={commitHistory}
          />
        );
      }}
    </Task>
  );
}
