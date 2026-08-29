import type { GitHubConfig } from "./GitHubConfig.ts";

export type MakeGitHubWebhookSourceOptions = GitHubConfig & {
  /** Source id used for ingress routing + dedupe. @default "github" */
  id?: string;
  /** Bounded ingress queue capacity. @default 256 */
  capacity?: number;
};
