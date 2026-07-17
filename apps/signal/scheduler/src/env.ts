import type { Runner } from "./runner";

export interface Env {
  RUNNER: DurableObjectNamespace<Runner>;
  SIGNAL_REPORTS: KVNamespace;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_KV_NAMESPACE_ID: string;
  CLOUDFLARE_R2_BUCKET: string;
  MANUAL_TRIGGER_SECRET: string;
  SIGNAL_ALERT_WEBHOOK_URL?: string;
}
