import type { Meta, StoryObj } from "@storybook/react-vite";
import { DiffHunks, FileTree, parseUnifiedFile } from "@smithers-orchestrator/ui";

const SAMPLE_PATCH = `diff --git a/src/auth/session.ts b/src/auth/session.ts
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -41,5 +41,6 @@ export function createSession(user: User) {
   const id = randomId();
-  const token = signLegacy(id);
+  const token = sign(id);
+  audit("session.created", id);
   store.set(id, token);
   return id;
@@ -88,4 +89,5 @@ export function revokeSession(id: string) {
   store.delete(id);
+  audit("session.revoked", id);
   return true;
 }
`;

const meta: Meta = {
  title: "Primitives/Diff & Files",
};

export default meta;
type Story = StoryObj;

export const Diff: Story = {
  render: () => (
    <div style={{ maxWidth: 720 }}>
      <DiffHunks file={parseUnifiedFile(SAMPLE_PATCH)} />
    </div>
  ),
};

export const Tree: Story = {
  render: () => (
    <div style={{ maxWidth: 360 }}>
      <FileTree
        nodes={["src/app/main.ts", "src/app/util/helpers.ts", "src/index.ts", "tests/main.test.ts", "README.md"]}
      />
    </div>
  ),
};
