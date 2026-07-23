import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Progress,
  Skeleton,
  Spinner,
  StageStrip,
} from "@smithers-orchestrator/ui";

const meta: Meta = {
  title: "Primitives/Feedback",
};

export default meta;
type Story = StoryObj;

export const Alerts: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "1rem", maxWidth: 560 }}>
      <Alert>
        <AlertTitle>Run resumed</AlertTitle>
        <AlertDescription>The engine picked up from the last checkpoint.</AlertDescription>
      </Alert>
      <Alert variant="warning">
        <AlertTitle>Quota near limit</AlertTitle>
        <AlertDescription>The 5-hour window is at 92% utilization.</AlertDescription>
      </Alert>
      <Alert variant="destructive">
        <AlertTitle>Task failed</AlertTitle>
        <AlertDescription>review-gate exhausted its retry budget.</AlertDescription>
      </Alert>
    </div>
  ),
};

export const ProgressBar: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "1rem", maxWidth: 420 }}>
      <Progress value={25} />
      <Progress value={66} />
      <Progress value={100} />
    </div>
  ),
};

export const Spinners: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
      <Spinner size="sm" />
      <Spinner />
      <Spinner size="lg" />
    </div>
  ),
};

export const Skeletons: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "0.75rem", maxWidth: 420 }}>
      <Skeleton style={{ height: 20, width: "60%" }} />
      <Skeleton style={{ height: 20, width: "80%" }} />
      <Skeleton style={{ height: 96 }} />
    </div>
  ),
};

export const Stages: Story = {
  render: () => (
    <StageStrip
      showSummary
      stages={[
        { label: "Plan", status: "complete" },
        { label: "Implement", status: "complete" },
        { label: "Review", status: "running" },
        { label: "Gate", status: "pending" },
        { label: "Publish", status: "pending" },
      ]}
    />
  ),
};
