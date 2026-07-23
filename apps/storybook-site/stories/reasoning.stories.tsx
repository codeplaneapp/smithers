import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  ChainOfThought,
  CodeBlock,
  Markdown,
  Reasoning,
  ToolCall,
} from "@smithers-orchestrator/ui";

const meta: Meta = {
  title: "Agentic/Reasoning & Tools",
};

export default meta;
type Story = StoryObj;

export const ReasoningBlock: Story = {
  render: () => (
    <div style={{ maxWidth: 640 }}>
      <Reasoning duration={72} defaultOpen>
        <Markdown content={"The failing test pins the **old** parser output. The fix is to update the fixture, not the parser."} />
      </Reasoning>
    </div>
  ),
};

export const ReasoningStreaming: Story = {
  render: () => (
    <div style={{ maxWidth: 640 }}>
      <Reasoning streaming>
        <Markdown content="Comparing the fixture against the new emitter output…" />
      </Reasoning>
    </div>
  ),
};

export const ChainOfThoughtSteps: Story = {
  render: () => (
    <div style={{ maxWidth: 640 }}>
      <ChainOfThought
        streaming
        steps={[
          { id: "inspect", label: "Inspect the parser", status: "done" },
          { id: "patch", label: "Apply the fix", status: "active", detail: "Editing parser.ts" },
          { id: "test", label: "Run tests", status: "pending" },
        ]}
      />
    </div>
  ),
};

export const ToolCallStates: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "0.75rem", maxWidth: 640 }}>
      <ToolCall name="search" state="input-streaming" argsText={'{"query": "run sta'} />
      <ToolCall name="search" state="running" args={{ query: "run status" }} />
      <ToolCall
        name="search"
        state="output-available"
        args={{ query: "run status" }}
        result={{ matches: 3 }}
      />
      <ToolCall
        name="bash"
        state="approval-requested"
        args={{ command: "rm -rf build" }}
      />
      <ToolCall
        name="bash"
        state="output-error"
        args={{ command: "bun test" }}
        resultText="1 test failed: parser emits trailing newline"
      />
      <ToolCall name="write_file" state="output-denied" args={{ path: "/etc/hosts" }} />
    </div>
  ),
};

export const Code: Story = {
  render: () => (
    <div style={{ maxWidth: 640 }}>
      <CodeBlock
        code={'export function greet(name: string) {\n  return `Hello, ${name}!`;\n}'}
        language="typescript"
        showLineNumbers
        onCopyCode={() => {}}
      />
    </div>
  ),
};
