import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge, ModelBadge, ProviderBadge, StatusPill } from "@smthrs/ui";

const meta: Meta = {
  title: "Primitives/Badge",
};

export default meta;
type Story = StoryObj;

export const Variants: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
      <Badge>Default</Badge>
      <Badge variant="secondary">Secondary</Badge>
      <Badge variant="outline">Outline</Badge>
      <Badge variant="success">Success</Badge>
      <Badge variant="warning">Warning</Badge>
      <Badge variant="destructive">Destructive</Badge>
      <Badge variant="muted">Muted</Badge>
    </div>
  ),
};

export const StatusPills: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
      <StatusPill status="running" />
      <StatusPill status="complete" />
      <StatusPill status="failed" />
      <StatusPill status="pending" />
      <StatusPill status="waiting-approval" />
      <StatusPill status="cancelled" />
      <StatusPill status="complete" label="All 12 nodes done" />
      <StatusPill status="running" withDot={false} label="No dot" />
    </div>
  ),
};

export const ModelAndProvider: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
      <ModelBadge model="claude-fable-5" provider="anthropic" />
      <ModelBadge model="gpt-5.6" provider="openai" />
      <ModelBadge model="local-model" />
      <ProviderBadge provider="anthropic" />
      <ProviderBadge provider="openai" />
    </div>
  ),
};
