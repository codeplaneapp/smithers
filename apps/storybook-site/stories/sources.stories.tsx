import type { Meta, StoryObj } from "@storybook/react-vite";
import { InlineCitation, Sources, Suggestion } from "@smthrs/ui";

const meta: Meta = {
  title: "Agentic/Sources & Citations",
};

export default meta;
type Story = StoryObj;

export const SourceList: Story = {
  render: () => (
    <div style={{ maxWidth: 560 }}>
      <Sources
        defaultOpen
        sources={[
          { id: "docs", label: "Smithers UI reference", href: "https://smithers.sh/reference/ui" },
          { id: "guide", label: "Custom workflow UIs", href: "https://smithers.sh/guides/custom-workflow-ui" },
          { id: "notes", label: "Local research notes" },
        ]}
      />
    </div>
  ),
};

export const InlineCitations: Story = {
  render: () => (
    <p style={{ maxWidth: 560, lineHeight: 1.6 }}>
      Smithers keeps durable run history
      <InlineCitation index={1} label="Run state reference" href="https://smithers.sh/runtime/run-state" />
      and resumes from checkpoints after a crash
      <InlineCitation index={2} label="Durability guide" />.
    </p>
  ),
};

export const Suggestions: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
      <Suggestion suggestion="Show the failing node" />
      <Suggestion suggestion="Retry with a bigger budget" />
      <Suggestion suggestion="Explain this error" />
    </div>
  ),
};
