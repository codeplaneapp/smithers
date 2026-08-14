import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  ApprovalCard,
  Checkpoint,
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
  ContextUsage,
} from "@smthrs/ui";

const meta: Meta = {
  title: "Agentic/Approvals & Checkpoints",
};

export default meta;
type Story = StoryObj;

export const Approval: Story = {
  render: () => (
    <div style={{ maxWidth: 560 }}>
      <ApprovalCard
        title="Delete database?"
        state="requested"
        summary="This drops the staging database."
        risk="high"
        proposedActions={["DROP DATABASE staging", "Notify #ops"]}
        resources={[{ id: "db", label: "staging-db", kind: "postgres", href: "https://example.com/db" }]}
      />
    </div>
  ),
};

export const ConfirmationLifecycle: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "1rem", maxWidth: 560 }}>
      {(["requested", "approved", "denied"] as const).map((state) => (
        <Confirmation key={state} state={state}>
          <ConfirmationTitle>Deploy to production?</ConfirmationTitle>
          <ConfirmationRequest>Rolls out image tag 9b132abd to the cluster.</ConfirmationRequest>
          <ConfirmationActions>
            <ConfirmationAction decision="approve" />
            <ConfirmationAction decision="deny" />
          </ConfirmationActions>
          <ConfirmationAccepted />
          <ConfirmationRejected />
        </Confirmation>
      ))}
    </div>
  ),
};

export const Checkpoints: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "0.5rem", maxWidth: 560 }}>
      <Checkpoint
        current
        checkpoint={{
          id: "cp-1",
          label: "Before refactor",
          frameNo: 12,
          timestampMs: Date.UTC(2026, 6, 22, 3, 4, 5),
          messageCount: 8,
        }}
      />
      <Checkpoint checkpoint={{ id: "cp-2", label: "After review fixes", frameNo: 9 }} />
      <Checkpoint checkpoint={{ id: "cp-3" }} />
    </div>
  ),
};

export const TokenUsage: Story = {
  render: () => (
    <div style={{ maxWidth: 360 }}>
      <ContextUsage
        defaultOpen
        usage={{
          modelId: "claude-fable-5",
          usedTokens: 8000,
          maxTokens: 32000,
          inputTokens: 5000,
          outputTokens: 3000,
          costUsd: 0.42,
        }}
      />
    </div>
  ),
};
