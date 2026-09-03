/** @jsxImportSource react */
import { createPipelineUi } from "./pipelines-shared";

createPipelineUi({
  workflowKey: "pipelines-ci-fast",
  title: "Plue Pipeline CI Fast",
  nodes: ["fast-tier", "receipt", "fail-if-red"],
});
