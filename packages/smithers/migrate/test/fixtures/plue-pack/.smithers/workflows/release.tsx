// .smithers/workflows/release.tsx
import { Workflow, Task, Parallel, on } from "@smithers-ai/workflow";
import { $ } from "bun";

export default (ctx) => (
  <Workflow
    name="Release"
    triggers={[on.push({ tags: ["v*"] })]}
  >
    <Parallel>
      <Task id="build-linux-amd64">
        {async () => {
          await $`cd apps/cli && bun install`;
          await $`bun build apps/cli/src/main.ts --compile --target=bun-linux-x64 --outfile smithers`;
          await $`tar czf smithers-\${SMITHERS_REF_NAME}-linux-amd64.tar.gz smithers`;
        }}
      </Task>
      <Task id="build-linux-arm64">
        {async () => {
          await $`cd apps/cli && bun install`;
          await $`bun build apps/cli/src/main.ts --compile --target=bun-linux-arm64 --outfile smithers`;
          await $`tar czf smithers-\${SMITHERS_REF_NAME}-linux-arm64.tar.gz smithers`;
        }}
      </Task>
      <Task id="build-darwin-amd64">
        {async () => {
          await $`cd apps/cli && bun install`;
          await $`bun build apps/cli/src/main.ts --compile --target=bun-darwin-x64 --outfile smithers`;
          await $`tar czf smithers-\${SMITHERS_REF_NAME}-darwin-amd64.tar.gz smithers`;
        }}
      </Task>
      <Task id="build-darwin-arm64">
        {async () => {
          await $`cd apps/cli && bun install`;
          await $`bun build apps/cli/src/main.ts --compile --target=bun-darwin-arm64 --outfile smithers`;
          await $`tar czf smithers-\${SMITHERS_REF_NAME}-darwin-arm64.tar.gz smithers`;
        }}
      </Task>
    </Parallel>

    <Task id="package">
      {async () => {
        await $`echo 'All platform builds complete. Artifacts ready for release upload.'`;
      }}
    </Task>
  </Workflow>
);
