import type { SandboxProviderRequest } from "../SandboxProvider.ts";
import type { SandboxSession } from "./SandboxSession.ts";
export type SandboxProviderCommandOptions = {
  id: string;
  command?: string;
  workdir?: string;
  requestFile?: string;
  resultFile?: string;
  env?: Record<string, string>;
  cleanup?: "destroy" | "keep";
  createSession: (request: SandboxProviderRequest) => Promise<SandboxSession> | SandboxSession;
};
