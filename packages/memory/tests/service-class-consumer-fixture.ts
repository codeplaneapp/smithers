import { Context } from "effect";
import { MemoryService, type MemoryServiceApi } from "@smithers-orchestrator/memory";

declare const service: MemoryServiceApi;

MemoryService.key satisfies "MemoryService";
const wrapped = MemoryService.of(service);
wrapped.getFact satisfies MemoryServiceApi["getFact"];
wrapped.saveNote satisfies MemoryServiceApi["saveNote"];
Context.make(MemoryService, service);

// @ts-expect-error the service key keeps its exact identifier
MemoryService.key satisfies "OtherMemoryService";
