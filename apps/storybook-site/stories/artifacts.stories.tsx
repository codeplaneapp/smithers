import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Commit,
  EnvironmentVariables,
  parseStackTrace,
  SecretField,
  StackTrace,
  TestResults,
} from "@smithers-orchestrator/ui";

const meta: Meta = {
  title: "Agentic/Coding Artifacts",
};

export default meta;
type Story = StoryObj;

export const CommitCard: Story = {
  render: () => (
    <div style={{ maxWidth: 640 }}>
      <Commit
        commit={{
          hash: "9b132abd4e7f21c0",
          message: "fix(engine): resume parked runs after quota reset",
          author: "will",
          timestampMs: Date.UTC(2026, 6, 22, 18, 30),
          files: [
            { path: "packages/engine/src/engine.js", status: "modified", additions: 24, deletions: 6 },
            { path: "packages/engine/tests/resume.test.js", status: "added", additions: 88, deletions: 0 },
            { path: "packages/engine/src/legacy-wake.js", status: "deleted" },
          ],
        }}
      />
    </div>
  ),
};

export const TestReport: Story = {
  render: () => (
    <div style={{ maxWidth: 640 }}>
      <TestResults
        suites={[
          {
            id: "unit",
            name: "unit",
            tests: [
              { id: "a", name: "adds numbers", status: "passed", durationMs: 12 },
              { id: "b", name: "handles overflow", status: "failed", durationMs: 840, errorText: "expected 3 got 4" },
              { id: "c", name: "todo later", status: "todo" },
            ],
          },
          {
            id: "e2e",
            name: "e2e",
            tests: [
              { id: "d", name: "logs in", status: "passed", durationMs: 1500 },
              { id: "e", name: "logs out", status: "skipped" },
            ],
          },
        ]}
      />
    </div>
  ),
};

export const Stack: Story = {
  render: () => (
    <div style={{ maxWidth: 640 }}>
      <StackTrace
        defaultOpen
        frames={parseStackTrace(
          [
            "Error: TOOL_COMMAND_FAILED: bun test exited 1",
            "    at runTask (/repo/packages/engine/src/engine.js:412:19)",
            "    at /repo/packages/driver/src/WorkflowDriver.js:88:11",
          ].join("\n"),
        )}
      />
    </div>
  ),
};

export const EnvVars: Story = {
  render: () => (
    <div style={{ maxWidth: 560 }}>
      <EnvironmentVariables
        variables={[
          { name: "NODE_ENV", value: "production" },
          { name: "ANTHROPIC_API_KEY", value: "sk-ant-…", secret: true },
          { name: "UNSET_VAR" },
        ]}
      />
    </div>
  ),
};

export const Secret: Story = {
  render: () => (
    <div style={{ maxWidth: 360 }}>
      <SecretField value="super-secret-value" onCopy={() => {}} />
    </div>
  ),
};
