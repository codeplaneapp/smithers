import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderMdx } from "smithers";

const REPO_ROOT = resolve(new URL("../../..", import.meta.url).pathname);
const PROMPTS = resolve(new URL("./prompts", import.meta.url).pathname);

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return `[Could not read ${path}]`;
  }
}

const productSpec = readFile(resolve(REPO_ROOT, "docs/specs/product.md"));
const designSpec = readFile(resolve(REPO_ROOT, "docs/specs/design.md"));
const engineeringSpec = readFile(resolve(REPO_ROOT, "docs/specs/engineering.md"));
const productDesign = readFile(resolve(REPO_ROOT, "PRODUCT_DESIGN.md"));
const claudeMd = readFile(resolve(REPO_ROOT, "CLAUDE.md"));

const specsContext = `
## CLAUDE.md (Project Rules)
${claudeMd}

## Product Spec (docs/specs/product.md)
${productSpec}

## Design Spec (docs/specs/design.md)
${designSpec}

## Engineering Spec (docs/specs/engineering.md)
${engineeringSpec}

## Master Decisions (PRODUCT_DESIGN.md)
${productDesign}
`;

const Specs = () => specsContext;

import SystemPromptMdx from "./prompts/system-prompt.mdx";

export const SYSTEM_PROMPT = renderMdx(SystemPromptMdx, {
  components: {
    Specs,
  },
});
