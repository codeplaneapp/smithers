import { SandboxEntityExecutor, SandboxTransport } from "@smithers-orchestrator/sandbox";

const entityExecutorTag = new SandboxEntityExecutor();
const transportTag = new SandboxTransport();

entityExecutorTag satisfies InstanceType<typeof SandboxEntityExecutor>;
transportTag satisfies InstanceType<typeof SandboxTransport>;

// @ts-expect-error service tag constructors do not accept runtime configuration
new SandboxTransport("bubblewrap");
