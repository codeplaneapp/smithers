import { OmpAgent } from "@smithers-orchestrator/agents";

const command = await new OmpAgent({ mode: "rpc" }).buildCommand({ prompt: "x", cwd: "/tmp", options: {} });
const outputFormat: "text" | "json" | "rpc" = command.outputFormat;
void outputFormat;
