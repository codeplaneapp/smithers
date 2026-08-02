import type { Meta, StoryObj } from "@storybook/react-vite";
import { Attachment, Bubble, ChatMessage, ChatTranscript, Marker, Shimmer } from "@smthrs/ui";

const meta: Meta = {
  title: "Chat/Transcript",
};

export default meta;
type Story = StoryObj;

export const Transcript: Story = {
  render: () => (
    <ChatTranscript pending pendingLabel="Agent is working" style={{ maxWidth: 640 }}>
      <ChatMessage role="user">Please inspect the parser and fix the failing test.</ChatMessage>
      <ChatMessage role="assistant">Reading tests/parser.test.ts to find the failing assertion.</ChatMessage>
      <ChatMessage role="assistant" variant="terminal" label="Shell">
        $ bun test tests/parser.test.ts
      </ChatMessage>
    </ChatTranscript>
  ),
};

export const Bubbles: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "0.75rem", maxWidth: 640 }}>
      <Bubble variant="user">Ship the release notes for 0.30.0.</Bubble>
      <Bubble variant="assistant">
        Drafted. The changelog covers 34 commits; the highlights lead with the new approval surface.
      </Bubble>
      <Bubble variant="system">Run resumed from checkpoint 12.</Bubble>
    </div>
  ),
};

export const Markers: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "1rem", maxWidth: 640 }}>
      <Marker>Earlier messages</Marker>
      <Marker variant="note">Context compacted</Marker>
      <Marker variant="status" live shimmer>
        Searching sources
      </Marker>
    </div>
  ),
};

export const Streaming: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <Shimmer>Generating response</Shimmer>
      <Shimmer active={false}>Finished text keeps plain styling</Shimmer>
    </div>
  ),
};

export const Attachments: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
      <Attachment name="report.pdf" state="uploading" sizeBytes={81920} progress={48} onRemove={() => {}} />
      <Attachment name="trace.json" state="processing" sizeBytes={2048} progress={null} />
      <Attachment name="screenshot.png" state="ready" sizeBytes={523000} mediaType="image/png" onRemove={() => {}} />
      <Attachment name="core.dump" state="error" />
    </div>
  ),
};
