import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@smithers-orchestrator/ui";

const meta = {
  title: "Primitives/Button",
  component: Button,
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: "Launch run",
  },
};

export const Variants: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
      <Button>Default</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="destructive">Destructive</Button>
      <Button variant="link">Link</Button>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
      <Button size="sm">Small</Button>
      <Button size="default">Default</Button>
      <Button size="lg">Large</Button>
    </div>
  ),
};

export const Disabled: Story = {
  args: {
    children: "Cancel run",
    disabled: true,
  },
};
