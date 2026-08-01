import { Context } from "effect";
import { SandboxTransport } from "@smithers-orchestrator/sandbox";

type SandboxTransportService = Context.Service.Shape<typeof SandboxTransport>;

declare const service: SandboxTransportService;

SandboxTransport.key satisfies "SandboxTransport";
const wrapped = SandboxTransport.of(service);
wrapped.create satisfies SandboxTransportService["create"];
wrapped.cleanup satisfies SandboxTransportService["cleanup"];
Context.make(SandboxTransport, service);

// @ts-expect-error the service key keeps its exact identifier
SandboxTransport.key satisfies "OtherTransport";
