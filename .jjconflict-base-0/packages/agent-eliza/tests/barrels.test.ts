/**
 * Barrel-import coverage: ensures the package entry points (`src/index.js`
 * and `src/conventions/index.js`) are loaded and their re-exports resolve.
 */

import { describe, expect, test } from "bun:test";

import { ElizaAgent } from "../src/index.js";
import * as conventions from "../src/conventions/index.js";

describe("package barrels", () => {
  test("root index re-exports ElizaAgent", () => {
    expect(typeof ElizaAgent).toBe("function");
  });

  test("conventions index re-exports the authoring surface", () => {
    expect(typeof conventions.parseWorkflowFrontmatter).toBe("function");
    expect(typeof conventions.stripFrontmatter).toBe("function");
    expect(typeof conventions.serializeWorkflowFile).toBe("function");
    expect(typeof conventions.serializeWorkflowFrontmatter).toBe("function");
    expect(typeof conventions.defineWorkflow).toBe("function");
    expect(typeof conventions.defineWorkflowPlugin).toBe("function");
    expect(typeof conventions.loadWorkflowsFromDir).toBe("function");
    expect(typeof conventions.loadWorkflows).toBe("function");
    expect(typeof conventions.formatWorkflowsForPrompt).toBe("function");
    expect(typeof conventions.registerWorkflows).toBe("function");
    expect(typeof conventions.toSkill).toBe("function");
    expect(typeof conventions.pluginToElizaPlugin).toBe("function");
  });
});
