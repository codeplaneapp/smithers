import { expect, onTestFinished, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATED_INIT_TEMPLATES } from "../src/init-templates.generated.js";
import {
  INIT_TEMPLATE_OUTPUT,
  INIT_TEMPLATE_ROOT,
  INIT_TEMPLATE_SPECS,
  buildInitTemplates,
  generateInitTemplates,
  renderInitTemplatesModule,
  runInitTemplateGenerator,
} from "../../../scripts/generate-init-templates.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

test("generated init templates match their canonical files byte-for-byte", () => {
  expect(GENERATED_INIT_TEMPLATES).toHaveLength(INIT_TEMPLATE_SPECS.length);
  for (const file of GENERATED_INIT_TEMPLATES) {
    const source = readFileSync(resolve(INIT_TEMPLATE_ROOT, file.sourcePath), "utf8");
    expect(file.contents, `${file.path} is stale — re-run: bun scripts/generate-init-templates.ts`).toBe(source);
  }
});

test("the init template generator emits the committed module deterministically", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "smithers-init-template-generator-"));
  onTestFinished(() => rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = join(tempDir, "init-templates.generated.js");

  const built = buildInitTemplates();
  expect(renderInitTemplatesModule(built)).toBe(readFileSync(INIT_TEMPLATE_OUTPUT, "utf8"));

  const generated = generateInitTemplates({ outputFile });
  expect(generated.files).toEqual(built);
  expect(generated.outputFile).toBe(outputFile);
  expect(readFileSync(outputFile, "utf8")).toBe(readFileSync(INIT_TEMPLATE_OUTPUT, "utf8"));

  const messages = [];
  const run = runInitTemplateGenerator({ outputFile }, (message) => messages.push(message));
  expect(run.output).toBe(generated.output);
  expect(messages).toEqual([expect.stringContaining("[generate-init-templates] wrote 18 template(s)")]);
});

test("placeholder templates remain readable source files", () => {
  const gateway = readFileSync(resolve(REPO_ROOT, "apps/cli/templates/init-pack/gateway.ts.tmpl"), "utf8");
  const agents = readFileSync(resolve(REPO_ROOT, "apps/cli/templates/init-pack/agents/index.ts.tmpl"), "utf8");
  expect(gateway).toContain("/* {{MOUNTS}} */");
  expect(agents).toContain("/* {{CUSTOM_AGENT_EXPORT}} */");
});
