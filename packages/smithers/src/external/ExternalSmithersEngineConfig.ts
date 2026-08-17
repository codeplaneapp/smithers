import type { AgentLike } from "@smthrs/agents/AgentLike";
import type { OpenSmithersBackendOptions } from "../OpenSmithersBackendOptions.ts";
import type { z } from "zod";

export type SmithersEngineLogLevel = "debug" | "info" | "warn" | "error";

export type SmithersEngineLogRecord = {
  readonly level: SmithersEngineLogLevel;
  readonly message: string;
  readonly timestamp: Date;
  readonly annotations: Record<string, unknown>;
  readonly spans: readonly string[];
};

export type SmithersEngineLogger = (record: SmithersEngineLogRecord) => void;

export type ExternalSmithersEngineConfig<S extends Record<string, z.ZodObject<z.ZodRawShape>>> =
  OpenSmithersBackendOptions & {
    schemas: S;
    agents: Record<string, AgentLike>;
    /** `false` silences engine logs; a callback routes structured records to the host. */
    logger?: SmithersEngineLogger | false;
  };
