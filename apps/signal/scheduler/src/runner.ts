import { Container } from "@cloudflare/containers";
import type { Env } from "./env";

/** Durable Object binding for apps/signal/runner's Docker image (built from ../../runner/Dockerfile). */
export class Runner extends Container<Env> {
  defaultPort = 8080;
  // A full pipeline run (fetch -> classify -> compose -> verify -> render -> publish) can take
  // several minutes end to end; keep the container warm well past the slowest expected run.
  sleepAfter = "20m";
  envVars = {
    // Optional: SIGNAL_MODEL_PROVIDER's auto mode (default) probes whichever of
    // these are non-empty at run start and falls back in order anthropic ->
    // openai -> gemini (see .smithers/lib/daily-ceo-intel/modelProvider.ts).
    ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY ?? "",
    OPENAI_API_KEY: this.env.OPENAI_API_KEY ?? "",
    GEMINI_API_KEY: this.env.GEMINI_API_KEY ?? "",
    CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_KV_NAMESPACE_ID: this.env.CLOUDFLARE_KV_NAMESPACE_ID,
    CLOUDFLARE_R2_BUCKET: this.env.CLOUDFLARE_R2_BUCKET,
    SIGNAL_PUBLISH_MODE: "auto",
  };

  override onError(error: unknown): never {
    console.error("[signal-runner-do] container error:", error);
    throw error;
  }
}
