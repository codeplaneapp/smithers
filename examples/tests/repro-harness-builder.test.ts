import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const Prompt = () => "test prompt";
for (const name of ["analyze", "plan", "build", "validate"]) {
  mock.module(`../prompts/repro-harness-builder/${name}.mdx`, () => ({ default: Prompt }));
}

test("covers repro-harness-builder", async () => {
  const result = await coverExample("../repro-harness-builder.jsx", {
    input: { issue: "crashes on startup", language: "node" },
    mocks: {
      analyze: {
        title: "startup crash", language: "node", dependencies: ["zod"],
        errorSignature: "boom", minimalSteps: ["start"], summary: "repro",
      },
      build: {
        baseImage: "node:20-alpine", dockerfile: "FROM node:20-alpine",
        reproScript: "throw new Error('boom')", reproFiles: [],
        runCommand: "docker run repro", summary: "built",
      },
      validate: {
        reproduced: true, exitCode: 1, stdout: "", stderr: "boom",
        artifact: "repro:latest", summary: "reproduced",
      },
    },
    expectedNodes: ["analyze", "build", "validate"],
  });

  expect(result.executed).toEqual(["analyze", "build", "validate"]);
  expect(result.taskOutputs.validate[0]).toMatchObject({ reproduced: true, exitCode: 1 });
});
